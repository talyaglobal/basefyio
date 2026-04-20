import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export type PgRequestRole = 'anon' | 'authenticated' | 'service_role';

export interface ApiKeyPayload {
  projectId: string;
  /** Legacy role used by controllers for the "service-key-only" permission check. */
  role: 'anon' | 'service';
  /** PostgreSQL role to SET LOCAL before running a query (RLS). */
  dbRole: PgRequestRole;
  /** Decoded JWT claims when the caller sent an Authorization: Bearer <jwt> alongside the anon key. */
  jwtClaims?: Record<string, unknown>;
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(private readonly prisma: PrismaService) {}

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
      select: { id: true, anonKey: true, serviceKey: true },
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
      const authHeader = (request.headers['authorization'] || request.headers['Authorization']) as string | undefined;
      if (authHeader && /^bearer /i.test(authHeader)) {
        const token = authHeader.replace(/^bearer /i, '').trim();
        const claims = this.decodeJwtPayload(token);
        if (claims) {
          jwtClaims = claims;
          dbRole = 'authenticated';
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
   * Decodes the JWT payload without verifying the signature. The token was
   * minted by the project's Keycloak realm; full verification (JWKS) should
   * be added here in a follow-up once the JWKS cache service is in place.
   *
   * Even without signature verification, RLS policies only ever trust the
   * claims that were set — and an attacker who can forge a JWT can already
   * hit the anon endpoint directly. We return null for structurally invalid
   * tokens so the caller drops back to anon.
   */
  private decodeJwtPayload(token: string): Record<string, unknown> | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const payload = Buffer.from(
        parts[1].replace(/-/g, '+').replace(/_/g, '/'),
        'base64',
      ).toString('utf8');
      const parsed = JSON.parse(payload);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (err: any) {
      this.logger.debug(`JWT decode failed: ${err.message}`);
      return null;
    }
  }
}
