import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

/** A month's MAU sets outlive it a little so the month can still be closed late. */
const MAU_TTL_SECONDS = 40 * 24 * 60 * 60;
/** Users already recorded this month by this process; bounds memory, not correctness. */
const SEEN_MAX = 100_000;

/** `YYYY-MM` of a date, in UTC: the calendar month a monthly active user is counted in. */
export function mauMonth(at: Date = new Date()): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The month before `at`, in UTC. */
export function previousMauMonth(at: Date = new Date()): string {
  return mauMonth(new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 1, 1)));
}

export function mauKey(realm: string, month: string): string {
  return `usage:mau:realm:${realm}:${month}`;
}

/** The `sub` claim of a JWT the platform just received from its own identity server. */
export function subjectOfToken(token: string | null | undefined): string | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const json = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof json?.sub === 'string' && json.sub ? json.sub : null;
  } catch {
    return null;
  }
}

/**
 * Monthly active users: the distinct end users of a project's realm who signed
 * in, refreshed a session or called the API with a verified user token in a
 * calendar month (UTC). Kept as one HyperLogLog per realm and month on the
 * durable Redis (12 KB at most each, about 0.8% error at large counts, exact
 * enough for a plan limit), so counting costs no database write at all. A
 * process remembers whom it already counted this month, so a busy user costs
 * one Redis call per process per month, not one per request.
 *
 * Never in a request's way: every call is fire-and-forget and swallows errors.
 */
@Injectable()
export class MauTracker {
  private readonly logger = new Logger(MauTracker.name);
  private readonly seen = new Set<string>();

  constructor(private readonly redis: RedisService) {}

  /** Count `sub` as active in `realm` this month. */
  record(realm: string | null | undefined, sub: string | null | undefined, at: Date = new Date()): void {
    if (!realm || !sub) return;
    const month = mauMonth(at);
    const memo = `${month}|${realm}|${sub}`;
    if (this.seen.has(memo)) return;
    if (this.seen.size >= SEEN_MAX) this.seen.clear();
    this.seen.add(memo);
    const key = mauKey(realm, month);
    void (async () => {
      try {
        const client = this.redis.getDurableClient();
        await client.pfadd(key, sub);
        await client.expire(key, MAU_TTL_SECONDS);
      } catch (err: any) {
        // Forget it, so the next request of this user tries again.
        this.seen.delete(memo);
        this.logger.debug(`MAU record failed for ${realm}: ${err?.message ?? err}`);
      }
    })();
  }

  /** Count the user behind a token the identity server just issued. */
  recordFromAccessToken(realm: string | null | undefined, accessToken: string | null | undefined): void {
    this.record(realm, subjectOfToken(accessToken));
  }

  /** Distinct active users over these realms in `month` (realms never share users). */
  async count(realms: string[], month: string = mauMonth()): Promise<number> {
    const keys = Array.from(new Set(realms.filter(Boolean))).map((r) => mauKey(r, month));
    if (keys.length === 0) return 0;
    const n = await this.redis.getDurableClient().pfcount(...keys);
    return Number(n) || 0;
  }
}
