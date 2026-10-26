import { CallHandler, ExecutionContext, ForbiddenException, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * A FROZEN organization (unpaid after the retries) may still sign in, read
 * its organizations and settle its bill, but nothing else: project data,
 * storage, SQL, exports and the rest answer 403 ACCOUNT_FROZEN until the
 * payment goes through.
 *
 * This used to be a global guard. Global guards run before the route's own
 * guards, so request.user was never set when it looked and it let every
 * request through. An interceptor runs after the guards, so the user is
 * known here. The status is cached a minute per user: one query per minute
 * instead of one per request, and a database hiccup never locks anyone out.
 */
export const FROZEN_ALLOWED_PREFIXES = [
  '/api/auth',
  '/api/billing',
  '/api/stripe',
  '/api/teams',
  '/api/organizations',
  '/api/features',
  '/api/health',
  '/api/feedback',
  '/api/platform-status',
  '/api/realtime/stream',
];

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 10_000;

export function isFrozenAllowedPath(path: string): boolean {
  return FROZEN_ALLOWED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`));
}

@Injectable()
export class FrozenAccountInterceptor implements NestInterceptor {
  private readonly cache = new Map<string, { frozen: boolean; until: number }>();

  constructor(private readonly prisma: PrismaService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest();
    const userId: string | undefined = request?.user?.sub;
    // Only dashboard sessions carry an account; API-key traffic is governed by the project's own status.
    if (!userId || request.apiKeyPayload) return next.handle();
    const path: string = request.path ?? request.url ?? '';
    if (isFrozenAllowedPath(path)) return next.handle();
    if (await this.isFrozen(userId)) {
      throw new ForbiddenException({ code: 'ACCOUNT_FROZEN', message: 'Account is suspended. Please update your payment method.' });
    }
    return next.handle();
  }

  /** Forget a user's cached status, e.g. right after a payment lifts the freeze. */
  forget(userId: string): void {
    this.cache.delete(userId);
  }

  private async isFrozen(userId: string): Promise<boolean> {
    const now = Date.now();
    const hit = this.cache.get(userId);
    if (hit && hit.until > now) return hit.frozen;
    let frozen = false;
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { activeTeam: { select: { accountStatus: true } } },
      });
      frozen = user?.activeTeam?.accountStatus === 'FROZEN';
    } catch {
      frozen = false;
    }
    if (this.cache.size >= CACHE_MAX_ENTRIES) this.cache.clear();
    this.cache.set(userId, { frozen, until: now + CACHE_TTL_MS });
    return frozen;
  }
}
