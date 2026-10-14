import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';

/** The only configuration: the sha256 (hex) of the token tsmart presents. */
export const TSMART_TOKEN_HASH_ENV = 'TSMART_INTEGRATION_TOKEN_SHA256';

/** Longer bearer values are refused before they are hashed. */
export const TSMART_MAX_TOKEN_LENGTH = 256;

const SHA256_HEX = /^[0-9a-f]{64}$/i;

export type TsmartIntegrationState =
  | { enabled: true }
  | { enabled: false; reason: 'unset' | 'malformed'; length: number };

/**
 * Whether the integration is switched on, read from the environment on every
 * call so a test (or a future hot reload) sees the current value.
 *
 * Anything other than exactly 64 hex characters leaves it off — a value with a
 * stray space or a CR from a Windows-edited .env must not half-enable it.
 */
export function tsmartIntegrationState(): TsmartIntegrationState {
  const raw = process.env[TSMART_TOKEN_HASH_ENV];
  if (raw === undefined || raw === '') {
    return { enabled: false, reason: 'unset', length: 0 };
  }
  if (!SHA256_HEX.test(raw)) {
    return { enabled: false, reason: 'malformed', length: raw.length };
  }
  return { enabled: true };
}

/**
 * Machine-to-machine access for tsmart.ai, which bills companies per basefyio
 * project.
 *
 * basefyio keeps only the sha256 of the token, never the token itself, so a
 * leaked environment or database dump does not hand out read access to every
 * project. The token is never logged.
 *
 * - Feature off (hash unset or malformed): 404 for every request, whatever it
 *   carries, so a disabled install looks like one without the route.
 * - Missing, non-bearer, oversized or wrong token: 401 with one generic message,
 *   so the response does not say which check failed.
 *
 * No Keycloak JWT is involved: the app has no global JWT guard (JwtAuthGuard is
 * applied per controller), so this guard alone decides. The global guards still
 * run first — ProxyThrottlerGuard rate-limits by client IP, FrozenAccountGuard
 * passes requests without a signed-in user.
 */
@Injectable()
export class TsmartIntegrationGuard implements CanActivate {
  private readonly logger = new Logger(TsmartIntegrationGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();

    const state = tsmartIntegrationState();
    if (!state.enabled) {
      // The same message Nest gives for a route that does not exist.
      const method = req?.method ?? 'GET';
      const url = req?.originalUrl ?? req?.url ?? '';
      throw new NotFoundException(`Cannot ${method} ${url}`);
    }

    const token = this.extractBearer(req?.headers?.authorization);
    if (token === null) {
      this.logger.debug('Refused a tsmart integration request without a usable bearer token');
      throw this.unauthorized();
    }

    if (!this.matches(token, (process.env[TSMART_TOKEN_HASH_ENV] as string).toLowerCase())) {
      this.logger.warn('Refused a tsmart integration request with a wrong token');
      throw this.unauthorized();
    }

    return true;
  }

  /** The token after "Bearer ", or null when absent, malformed or too long. */
  private extractBearer(header: unknown): string | null {
    if (typeof header !== 'string') return null;
    // Bound the work before trimming or hashing anything.
    if (header.length > 'Bearer '.length + TSMART_MAX_TOKEN_LENGTH + 16) return null;
    if (!/^bearer /i.test(header)) return null;
    const token = header.slice('Bearer '.length).trim();
    if (token.length === 0 || token.length > TSMART_MAX_TOKEN_LENGTH) return null;
    return token;
  }

  /** Constant-time comparison of two 64-character lowercase hex digests. */
  private matches(token: string, expectedHex: string): boolean {
    const presented = Buffer.from(createHash('sha256').update(token, 'utf8').digest('hex'), 'utf8');
    const expected = Buffer.from(expectedHex, 'utf8');
    // Both are 64 bytes once the state check passed; the length test only keeps
    // timingSafeEqual from throwing if that ever changes.
    if (presented.length !== expected.length) return false;
    return timingSafeEqual(presented, expected);
  }

  private unauthorized(): UnauthorizedException {
    return new UnauthorizedException('Unauthorized');
  }
}
