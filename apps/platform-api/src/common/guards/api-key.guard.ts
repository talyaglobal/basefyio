import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import * as jwt from 'jsonwebtoken';
import jwksClient, { JwksClient } from 'jwks-rsa';
import { PrismaService } from '../../prisma/prisma.service';
import {
  API_KEY_SCOPE_KEY,
  ApiKeyScope,
} from '../decorators/api-key-scope.decorator';

export type PgRequestRole = 'anon' | 'authenticated' | 'service_role';

export interface ApiKeyPayload {
  projectId: string;
  /** Legacy role used by controllers for the "service-key-only" permission check. */
  role: 'anon' | 'service';
  /** PostgreSQL role to SET LOCAL before running a query (RLS). */
  dbRole: PgRequestRole;
  /** Verified JWT claims when the caller sent an Authorization: Bearer <jwt> alongside the anon key. */
  jwtClaims?: Record<string, unknown>;
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);
  private readonly jwksByRealm = new Map<string, JwksClient>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const headerKey = request.headers['apikey'];
    // A browser following a link — an email verification button, an EventSource
    // subscription — cannot set headers, so the key may arrive in the query
    // string instead. Only the anon key is honoured there (checked below), since
    // URLs end up in logs, history and referrers.
    const queryKey =
      typeof request.query?.apikey === 'string' ? request.query.apikey : undefined;
    const apiKey = headerKey || queryKey;

    if (!apiKey) {
      throw new UnauthorizedException('Missing apikey');
    }

    const project = await this.prisma.project.findFirst({
      where: {
        OR: [{ anonKey: apiKey }, { serviceKey: apiKey }],
        status: 'ACTIVE',
      },
      select: { id: true, anonKey: true, serviceKey: true, keycloakRealm: true },
    });

    if (!project) {
      throw new UnauthorizedException('Invalid API key');
    }

    const isService = project.serviceKey === apiKey;

    // The service key bypasses RLS, so it must never be accepted from a URL.
    if (!headerKey && isService) {
      throw new UnauthorizedException(
        'The service key must be sent in the apikey header, not the query string',
      );
    }

    this.assertKeyMatchesTargetProject(request, project.id, isService);
    let dbRole: PgRequestRole = isService ? 'service_role' : 'anon';
    let jwtClaims: Record<string, unknown> | undefined;

    // Anon apikey + Bearer JWT = authenticated user context.
    // Service-role apikey always stays service_role (bypasses RLS) — we
    // ignore any Bearer header in that case to keep semantics obvious.
    if (!isService) {
      const authHeader = (request.headers['authorization'] || request.headers['Authorization']) as
        | string
        | undefined;
      if (authHeader && /^bearer /i.test(authHeader)) {
        const token = authHeader.replace(/^bearer /i, '').trim();
        // Many SDKs mirror the apikey into the Authorization header by default.
        // When the Bearer token is just the project key (not a user JWT), treat
        // the caller as anon instead of rejecting it as an invalid access token.
        if (token === apiKey || token === project.anonKey || token === project.serviceKey) {
          return this.admit(context, request, {
            projectId: project.id,
            role: isService ? 'service' : 'anon',
            dbRole,
            jwtClaims: undefined,
          });
        }
        const claims = await this.verifyProjectJwt(token, project.keycloakRealm);
        if (claims) {
          jwtClaims = claims;
          dbRole = 'authenticated';
        } else {
          // Unknown or unsigned JWT → caller is trying to assume an identity
          // they cannot prove. Reject instead of silently demoting to anon,
          // otherwise the policy engine would see a request with no Bearer
          // header and possibly grant broader access than the forged one.
          throw new UnauthorizedException('Invalid or expired access token');
        }
      }
    }

    return this.admit(context, request, {
      projectId: project.id,
      role: isService ? 'service' : 'anon',
      dbRole,
      jwtClaims,
    });
  }

  /**
   * The single exit from canActivate: publish the payload, then check it
   * against the route's declared scope.
   *
   * Both steps belong together. There are two ways out of the key-resolution
   * logic above — the mirrored-key shortcut and the normal path — and a scope
   * check written at only one of them is a hole that reads as covered.
   */
  private admit(context: ExecutionContext, request: any, payload: ApiKeyPayload): boolean {
    request.apiKeyPayload = payload;
    this.assertScope(context, request, payload);
    return true;
  }

  /**
   * Refuse a key that does not carry the authority the route asks for.
   *
   * An unmarked route keeps its present behaviour: this closes the holes it is
   * pointed at without changing every caller at once. Marking a controller
   * 'service' covers the routes written on it later too, which is the point —
   * the dangerous default is the one that has to be stated.
   */
  private assertScope(context: ExecutionContext, request: any, payload: ApiKeyPayload): void {
    const scope = this.reflector.getAllAndOverride<ApiKeyScope>(API_KEY_SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!scope || scope === 'anon') return;
    if (payload.role === 'service') return;

    if (scope === 'authenticated' && payload.dbRole === 'authenticated') return;

    const route = `${request.method} ${request.originalUrl ?? request.url ?? ''}`.split('?')[0];

    if (scope === 'authenticated') {
      // An app that writes with a bare anon key and no signed-in user stops
      // working the moment this is enforced. That is the point, but a
      // self-hosted operator who knows they have such an app needs a way to
      // keep it running while they fix it, so the tier can be put in
      // log-only mode. The default is to refuse.
      if (this.config.get<string>('ANON_WRITE_BINDING') === 'log') {
        this.logger.warn(
          `ANON WRITE: project ${payload.projectId} used its public anon key on ${route}, which requires a signed-in user — allowed because ANON_WRITE_BINDING=log`,
        );
        return;
      }
      this.logger.warn(
        `Refused anon key of project ${payload.projectId} on a route requiring a signed-in user (${route})`,
      );
      throw new ForbiddenException(
        'This route requires a signed-in user. Send the end user\'s access token as a Bearer token alongside the anon key, or call it with the service key from your server.',
      );
    }

    this.logger.warn(
      `Refused anon key of project ${payload.projectId} on a service-key route (${route})`,
    );
    throw new ForbiddenException(
      'This route requires the service key and must be called from your server, never from a browser. The anon key is public and cannot be used here.',
    );
  }

  /**
   * Refuse a key used against a project other than its own.
   *
   * A key identifies exactly one project, but most routes also name a project —
   * in the path, the body or the query — and the services act on the one named.
   * Their access check only runs for a dashboard user, so with a key the named
   * project was never compared with the key's. Any project's anon key, which
   * ships inside every browser app and comes free with a sign-up, therefore
   * opened every other project: owner-level SQL, storage, the user directory.
   *
   * Every place a project can be named is checked, not just the first one
   * found, because routes disagree about where they read it from: a path
   * naming the caller's own project with a body naming a victim's must not pass
   * on the strength of the path.
   *
   * Both keys are refused. The anon key always was: it is public, so no
   * legitimate caller holds another project's. The service key was only
   * logged at first, in case an internal tool held one key for several
   * projects — over the days that followed, prod recorded no such caller, so
   * it is refused now too. Set SERVICE_KEY_PROJECT_BINDING=log to go back to
   * logging if a self-hosted deployment turns out to have one.
   */
  private assertKeyMatchesTargetProject(
    request: any,
    keyProjectId: string,
    isService: boolean,
  ): void {
    const named = [
      request.params?.projectId,
      request.body && typeof request.body === 'object' ? request.body.projectId : undefined,
      request.query?.projectId,
    ].filter((v): v is string => typeof v === 'string' && v.length > 0);

    const foreign = named.find((id) => id !== keyProjectId);
    if (!foreign) return;

    const route = `${request.method} ${request.originalUrl ?? request.url ?? ''}`.split('?')[0];

    if (!isService) {
      this.logger.warn(
        `Refused anon key of project ${keyProjectId} used against project ${foreign} (${route})`,
      );
      throw new ForbiddenException('This API key does not belong to the requested project');
    }

    if (this.config.get<string>('SERVICE_KEY_PROJECT_BINDING') === 'log') {
      this.logger.warn(
        `CROSS-PROJECT SERVICE KEY: key of project ${keyProjectId} used against project ${foreign} (${route}) — allowed because SERVICE_KEY_PROJECT_BINDING=log`,
      );
      return;
    }

    this.logger.warn(
      `Refused service key of project ${keyProjectId} used against project ${foreign} (${route})`,
    );
    throw new ForbiddenException('This API key does not belong to the requested project');
  }

  /**
   * Verifies an RS256 JWT against the project's Keycloak realm JWKS. Returns
   * the decoded payload on success, `null` on any failure (bad signature,
   * expired, wrong realm, malformed, etc.).
   *
   * We verify rather than just decode because RLS policies read claims like
   * `auth.uid()` straight from the token — an attacker with a leaked anon key
   * could otherwise mint `{sub: "victim-user-id"}` and impersonate anyone.
   */
  private async verifyProjectJwt(
    token: string,
    realm: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const client = this.getJwksClient(realm);
      const expectedIssuer = this.expectedIssuer(realm);

      const payload = await new Promise<Record<string, unknown>>((resolve, reject) => {
        jwt.verify(
          token,
          (header, cb) => {
            if (!header.kid) {
              cb(new Error('JWT missing kid'));
              return;
            }
            client
              .getSigningKey(header.kid)
              .then((key) => cb(null, key.getPublicKey()))
              .catch((err) => cb(err));
          },
          {
            algorithms: ['RS256'],
            issuer: expectedIssuer,
          },
          (err, decoded) => {
            if (err) return reject(err);
            if (!decoded || typeof decoded !== 'object') {
              return reject(new Error('Empty or malformed JWT payload'));
            }
            resolve(decoded as Record<string, unknown>);
          },
        );
      });

      return payload;
    } catch (err: any) {
      this.logger.debug(`JWT verification failed (realm=${realm}): ${err.message}`);
      return null;
    }
  }

  private getJwksClient(realm: string): JwksClient {
    const existing = this.jwksByRealm.get(realm);
    if (existing) return existing;

    const base = this.config.get<string>('keycloak.url') || 'http://localhost:8080';
    const jwksUri = `${base.replace(/\/$/, '')}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/certs`;

    const client = jwksClient({
      jwksUri,
      cache: true,
      cacheMaxAge: 10 * 60 * 1000, // 10 minutes
      rateLimit: true,
      jwksRequestsPerMinute: 10,
      timeout: 5000,
    });

    this.jwksByRealm.set(realm, client);
    return client;
  }

  private expectedIssuer(realm: string): string {
    // Keycloak stamps `iss` using its *public* URL (what the browser sees),
    // which may differ from the internal container URL we use to fetch JWKS.
    const publicBase =
      this.config.get<string>('keycloak.publicUrl') ||
      this.config.get<string>('keycloak.url') ||
      'http://localhost:8080';
    return `${publicBase.replace(/\/$/, '')}/realms/${realm}`;
  }
}
