import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import type { KeySource } from './providers/disclosure';

/** Default daily platform-key tokens per project. */
export const DEFAULT_PROJECT_MAX_DAILY_TOKENS = 1_000_000;
/** Counters live two days so yesterday's usage is still readable. */
const COUNTER_TTL_SECONDS = 48 * 60 * 60;
/** A counter read slower than this is treated as an outage (fail open). */
const REDIS_TIMEOUT_MS = 500;
/** At most one "counter unavailable" warning per this interval. */
const WARN_INTERVAL_MS = 5 * 60 * 1000;

/** `emb:usage:project:<projectId>:<YYYY-MM-DD>` (UTC day). */
export function projectUsageKey(projectId: string, now: Date = new Date()): string {
  return `emb:usage:project:${projectId}:${now.toISOString().slice(0, 10)}`;
}

/** Start of the next UTC day: when today's counter stops counting. */
export function nextUtcMidnight(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/** Rough token estimate for a request (about four characters per token). */
export function estimateTokens(texts: string[]): number {
  let chars = 0;
  for (const t of texts) chars += t.length;
  return Math.ceil(chars / 4);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Redis did not answer within ${ms} ms`)), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Per-project daily cap on embedding tokens paid with the platform's key.
 *
 * Shared by every per-project embedding path (pgvector store / search /
 * re-embed, Data Engine platform vectors). A project that brings its own key
 * is never limited. The counter is the same Redis the platform-wide cap in
 * EmbeddingService uses; when Redis cannot be reached the check fails open
 * (one warning) so a counter outage never blocks customers.
 */
@Injectable()
export class EmbeddingBudgetService {
  private readonly logger = new Logger(EmbeddingBudgetService.name);
  private lastWarnAt = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  /** The daily limit, or null when unlimited (0 or negative). */
  limit(): number | null {
    const raw = this.config.get<number>('embedding.projectMaxDailyTokens');
    const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULT_PROJECT_MAX_DAILY_TOKENS;
    return n > 0 ? Math.floor(n) : null;
  }

  /** Only requests paid with the platform's key are limited. */
  applies(keySource: KeySource): boolean {
    return keySource === 'platform' && this.limit() !== null;
  }

  /** Today's usage, or null when the counter cannot be read. */
  async used(projectId: string): Promise<number | null> {
    try {
      const raw = await withTimeout(this.redis.get(projectUsageKey(projectId)), REDIS_TIMEOUT_MS);
      const n = parseInt(raw ?? '0', 10);
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch (err: any) {
      this.warn(`read: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * 429 EMBEDDING_DAILY_LIMIT when the project has used its platform-key
   * tokens for today, or when this request (estimated) would go past them.
   */
  async assertWithinBudget(projectId: string, keySource: KeySource, estimatedTokens = 0): Promise<void> {
    if (!this.applies(keySource)) return;
    const limit = this.limit()!;
    const used = await this.used(projectId);
    if (used === null) return; // fail open
    const estimate = Math.max(0, Math.floor(estimatedTokens));
    if (used < limit && used + estimate <= limit) return;

    const remaining = Math.max(0, limit - used);
    const resetsAt = nextUtcMidnight().toISOString();
    const fmt = (n: number) => n.toLocaleString('en-US');
    const tail =
      used < limit
        ? `This request needs about ${fmt(estimate)} tokens; ${fmt(remaining)} are left.`
        : 'No tokens are left for today.';
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: 'EMBEDDING_DAILY_LIMIT',
        message:
          `This project has used ${fmt(used)} of its ${fmt(limit)} daily embedding tokens on the platform key. ` +
          `${tail} The limit resets at ${resetsAt} (00:00 UTC). ` +
          'Set the project\'s own provider key to embed without this limit.',
        limit,
        used,
        remaining,
        resetsAt,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /** Add the provider's token count to today's counter (platform key only). Never throws. */
  async record(projectId: string, tokens: number, keySource: KeySource = 'platform'): Promise<void> {
    if (keySource !== 'platform') return;
    const n = Math.max(0, Math.round(tokens));
    if (!n) return;
    const key = projectUsageKey(projectId);
    try {
      await withTimeout(this.redis.incrby(key, n), REDIS_TIMEOUT_MS);
      await withTimeout(this.redis.expire(key, COUNTER_TTL_SECONDS), REDIS_TIMEOUT_MS);
    } catch (err: any) {
      this.warn(`write: ${err?.message ?? err}`);
    }
  }

  private warn(detail: string): void {
    const now = Date.now();
    if (now - this.lastWarnAt < WARN_INTERVAL_MS) return;
    this.lastWarnAt = now;
    this.logger.warn(`Per-project embedding counter unavailable, not enforcing the daily limit (${detail})`);
  }
}
