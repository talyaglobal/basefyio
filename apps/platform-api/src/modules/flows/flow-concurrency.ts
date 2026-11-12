import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

/**
 * Slots for running flows, so one busy flow or project cannot hold every
 * worker while the rest of the platform waits.
 *
 * Each limit is a Redis sorted set of the run ids holding a slot, scored by
 * when they took it. Taking a slot and checking the count is one Lua script,
 * so two workers cannot both take the last slot. A run that dies without
 * releasing (a killed container) does not leak its slot for ever: entries
 * older than STALE_MS — longer than any run may last — are swept on the next
 * acquire.
 *
 * Limits are fairness, not security. If Redis cannot be asked, the run goes
 * ahead rather than stalling every flow on the platform.
 */

const ACQUIRE = `
local now = tonumber(ARGV[1])
local stale = tonumber(ARGV[2])
local member = ARGV[3]
local n = #KEYS
for i = 1, n do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now - stale)
  if redis.call('ZSCORE', KEYS[i], member) == false then
    local limit = tonumber(ARGV[3 + i])
    if limit > 0 and redis.call('ZCARD', KEYS[i]) >= limit then
      return 0
    end
  end
end
for i = 1, n do
  redis.call('ZADD', KEYS[i], now, member)
  redis.call('PEXPIRE', KEYS[i], stale)
end
return 1`;

/** Longer than the longest run allowed (FLOW_LIMITS.maxDurationMs.max) plus slack. */
export const STALE_MS = 20 * 60_000;

export interface SlotRequest {
  runId: string;
  projectId: string;
  flowId: string;
  /** Per-flow cap from the flow's options; undefined = no per-flow cap. */
  flowLimit?: number;
}

const positiveIntFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

@Injectable()
export class FlowConcurrencyService {
  private readonly logger = new Logger(FlowConcurrencyService.name);

  /** Runs of one project that may execute at once, across all replicas. */
  readonly projectLimit = positiveIntFromEnv('FLOW_PROJECT_MAX_CONCURRENCY', 5);

  constructor(private readonly redis: RedisService) {}

  private keys(req: SlotRequest): { keys: string[]; limits: number[] } {
    const keys = [`basefyio:flow-slots:project:${req.projectId}`];
    const limits = [this.projectLimit];
    if (req.flowLimit && req.flowLimit > 0) {
      keys.push(`basefyio:flow-slots:flow:${req.flowId}`);
      limits.push(req.flowLimit);
    }
    return { keys, limits };
  }

  /** true = the run holds its slots and may start; false = try again later. */
  async acquire(req: SlotRequest): Promise<boolean> {
    const { keys, limits } = this.keys(req);
    try {
      const result = await this.redis
        .getClient()
        .eval(ACQUIRE, keys.length, ...keys, String(Date.now()), String(STALE_MS), req.runId, ...limits.map(String));
      return Number(result) === 1;
    } catch (err: any) {
      this.logger.warn(`Flow concurrency check skipped (${err?.message}); running without a slot`);
      return true;
    }
  }

  async release(req: SlotRequest): Promise<void> {
    const { keys } = this.keys(req);
    try {
      const client = this.redis.getClient();
      await Promise.all(keys.map((k) => client.zrem(k, req.runId)));
    } catch (err: any) {
      this.logger.debug(`Could not release flow slot for run ${req.runId}: ${err?.message}`);
    }
  }
}
