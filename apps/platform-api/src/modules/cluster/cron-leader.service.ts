import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { randomBytes } from 'crypto';
import { hostname } from 'os';
import { MetricsService } from '../health/metrics.service';
import { RedisService } from '../redis/redis.service';

/**
 * `leader` runs the scheduled jobs, `follower` holds them paused, `standalone`
 * means the election is switched off and every process runs its own jobs — the
 * behaviour of a deployment that predates this service.
 */
export type CronRole = 'leader' | 'follower' | 'standalone';

export const CRON_LEADER_KEY = 'basefyio:cron-leader';

/**
 * Take the lease if nobody holds it, extend it if it is ours, otherwise leave
 * it alone. One script, so there is no window between "is it free?" and
 * "take it" in which two replicas both answer yes.
 */
const ACQUIRE_OR_RENEW = `
local v = redis.call('GET', KEYS[1])
if not v then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 1
end
if v == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0`;

/** Give the lease up only while it is still ours; never delete a successor's. */
const RELEASE_IF_OWNED = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

const positiveIntFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Elects the one process that runs the `@Cron` jobs.
 *
 * Every API replica renews a short Redis lease; whoever holds it starts the
 * jobs in Nest's SchedulerRegistry, everyone else stops them. The decorated
 * services are untouched — the registry already knows every job, including
 * the ones registered without a name — so a job added anywhere in the code
 * base is governed automatically.
 *
 * Failure modes, decided in favour of what a one-container deployment did
 * before this existed:
 *  - Redis unreachable for less than one lease TTL: nobody changes role. A
 *    blip must not stop the leader's jobs or start a follower's.
 *  - Redis unreachable for longer: CRON_LEADER_WHEN_REDIS_DOWN decides. The
 *    default `run` prefers a duplicate job to a missed backup; `pause` keeps
 *    everything stopped until Redis is back.
 *  - CRON_LEADER_ELECTION=false: the registry is never touched.
 *
 * A job already executing when its process loses the lease is not interrupted;
 * `stop()` only prevents the next tick. The new leader fires it at its next
 * scheduled time, so a long nightly base backup finishes where it started.
 */
@Injectable()
export class CronLeaderService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CronLeaderService.name);

  /** Container hostname plus a nonce, so two replicas on one host still differ. */
  private readonly instanceId = `${hostname()}-${randomBytes(4).toString('hex')}`;

  private readonly enabled = process.env.CRON_LEADER_ELECTION !== 'false';
  private readonly ttlMs = positiveIntFromEnv('CRON_LEADER_TTL_MS', 30_000);
  private readonly renewMs = positiveIntFromEnv('CRON_LEADER_RENEW_MS', 10_000);
  private readonly whenRedisDown: 'run' | 'pause' =
    process.env.CRON_LEADER_WHEN_REDIS_DOWN === 'pause' ? 'pause' : 'run';

  private role: CronRole = 'standalone';
  private redisDownSince: number | null = null;
  private degradedLogged = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly redis: RedisService,
    private readonly registry: SchedulerRegistry,
    private readonly metrics: MetricsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.metrics.setGauge(
      'basefyio_build_info',
      'The image this process runs, by instance.',
      `instance_id="${this.instanceId}",image_tag="${process.env.IMAGE_TAG || 'unknown'}"`,
      1,
    );

    if (!this.enabled) {
      this.publishRole('standalone');
      this.logger.log(
        `Cron leader election disabled (CRON_LEADER_ELECTION=false): every scheduled job runs on ${this.instanceId}`,
      );
      return;
    }

    // The scheduler mounts its jobs in its own bootstrap hook, and Nest gives
    // no ordering guarantee between modules' hooks. Yield once so the registry
    // is populated, decide immediately, then re-check a second later to catch
    // a late mount — cron jobs tick on minute boundaries, so a follower that
    // was briefly active has almost certainly fired nothing.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await this.tick();

    const recheck = setTimeout(() => void this.tick(), 1_000);
    recheck.unref?.();
    this.timer = setInterval(() => void this.tick(), this.renewMs);
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.role !== 'leader') return;
    // Hand over promptly: a sibling can take the lease on its next renew
    // instead of waiting for the TTL to run out.
    try {
      await this.redis
        .getDurableClient()
        .eval(RELEASE_IF_OWNED, 1, CRON_LEADER_KEY, this.instanceId);
    } catch (err: any) {
      this.logger.debug(`Could not release the cron lease on shutdown: ${err?.message}`);
    }
  }

  getRole(): CronRole {
    return this.role;
  }

  /** True when scheduled jobs run on this process — leader or standalone. */
  isLeader(): boolean {
    return this.role !== 'follower';
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  /** One election round: renew or acquire, then make the registry match. */
  private async tick(): Promise<void> {
    let leader: boolean;
    try {
      leader = await this.tryLease();
      if (this.redisDownSince !== null) {
        this.logger.log('Redis reachable again; cron leadership is elected normally');
      }
      this.redisDownSince = null;
      this.degradedLogged = false;
    } catch (err: any) {
      this.redisDownSince ??= Date.now();
      const downForMs = Date.now() - this.redisDownSince;
      if (downForMs < this.ttlMs) {
        leader = this.role === 'leader';
      } else {
        leader = this.whenRedisDown === 'run';
        if (!this.degradedLogged) {
          this.degradedLogged = true;
          this.logger.warn(
            `Redis unreachable for ${Math.round(downForMs / 1000)}s (${err?.message}); ` +
              (leader
                ? 'running scheduled jobs on this process without an election'
                : 'keeping scheduled jobs paused until Redis is back'),
          );
        }
      }
    }
    this.apply(leader ? 'leader' : 'follower');
  }

  private async tryLease(): Promise<boolean> {
    const result = await this.redis
      .getDurableClient()
      .eval(ACQUIRE_OR_RENEW, 1, CRON_LEADER_KEY, this.instanceId, String(this.ttlMs));
    return Number(result) === 1;
  }

  /**
   * Make every registered cron job match the role. Idempotent on purpose: it
   * runs on each tick, so a job mounted late or added by a module loaded later
   * is governed too.
   */
  private apply(role: 'leader' | 'follower'): void {
    const jobs = this.registry.getCronJobs();
    let toggled = 0;
    for (const job of jobs.values()) {
      if (role === 'leader' && !job.isActive) {
        job.start();
        toggled++;
      } else if (role === 'follower' && job.isActive) {
        void job.stop();
        toggled++;
      }
    }
    if (role !== this.role) {
      this.logger.log(
        `Scheduled jobs: ${this.role} -> ${role} on ${this.instanceId} (${jobs.size} job(s), ${toggled} toggled)`,
      );
      this.publishRole(role);
    }
  }

  private publishRole(role: CronRole): void {
    this.role = role;
    this.metrics.setGauge(
      'basefyio_cron_leader',
      'Whether this process runs the scheduled jobs (1) or defers to another replica (0).',
      `instance_id="${this.instanceId}"`,
      role === 'follower' ? 0 : 1,
    );
  }
}
