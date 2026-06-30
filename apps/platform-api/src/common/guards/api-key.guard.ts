import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import jwksClient, { JwksClient } from 'jwks-rsa';
import { PrismaService } from '../../prisma/prisma.service';

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
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const apiKey = request.headers['apikey'];

    if (!apiKey) {
      throw new UnauthorizedException('Missing apikey header');
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

    request.apiKeyPayload = {
      projectId: project.id,
      role: isService ? 'service' : 'anon',
      dbRole,
      jwtClaims,
    } as ApiKeyPayload;

    return true;
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
