import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import { RedisService } from '../redis/redis.service';
import type { FanoutMessage } from './realtime-data.types';

export type LocalDeliverer = (msg: FanoutMessage) => void;

/** How long a PUBSUB NUMSUB answer stands in for "does any instance care". */
const REMOTE_INTEREST_TTL_MS = 5_000;
const SUBSCRIBER_RETRY_MS = 2_000;

/**
 * Fans realtime messages out to every API instance.
 *
 * Each instance delivers to its own SSE subscribers; Redis pub/sub carries a
 * message to the other instances. The rule that keeps delivery exactly-once is
 * the `origin` field: the publishing instance delivers locally first and tags
 * the message with its own id, and every instance drops incoming messages that
 * carry its own id. A single instance therefore behaves exactly as it did
 * before Redis was involved, with or without Redis reachable.
 *
 * One channel per project (`rt:<projectId>`), subscribed only while this
 * instance has a local subscriber for that project, so idle projects cost
 * nothing on the wire.
 */
@Injectable()
export class RealtimeFanoutService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeFanoutService.name);
  readonly instanceId = randomUUID();

  private readonly enabled: boolean;
  private sub: Redis | null = null;
  private subRetry: ReturnType<typeof setTimeout> | null = null;
  private deliverer: LocalDeliverer | null = null;
  /** projectId → number of local subscribers. */
  private readonly localCounts = new Map<string, number>();

  /** Subscribers this process holds across every project; the metrics scrape reads it. */
  localSubscriberTotal(): number {
    let n = 0;
    for (const v of this.localCounts.values()) n += v;
    return n;
  }
  /** projectId → cached NUMSUB answer. */
  private readonly remoteInterest = new Map<string, { n: number; at: number }>();

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.enabled = (config.get<string>('REALTIME_FANOUT') ?? 'redis') !== 'off';
  }

  onModuleInit(): void {
    if (this.enabled) this.ensureSubscriber();
  }

  onModuleDestroy(): void {
    if (this.subRetry) clearTimeout(this.subRetry);
    try {
      this.sub?.disconnect();
    } catch {
      /* noop */
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** The service that owns the SSE connections registers its deliverer here. */
  setLocalDeliverer(fn: LocalDeliverer): void {
    this.deliverer = fn;
  }

  channelFor(projectId: string): string {
    return `rt:${projectId}`;
  }

  /** Deliver locally, then to every other instance through Redis. */
  publish(msg: Omit<FanoutMessage, 'v' | 'origin'>): void {
    const full: FanoutMessage = { ...msg, v: 1, origin: this.instanceId };
    this.deliverLocal(full);
    if (!this.enabled || !this.redis.isReady()) return;
    this.redis
      .publish(this.channelFor(msg.projectId), JSON.stringify(full))
      .catch((err: any) => this.logger.debug(`publish failed: ${err?.message}`));
  }

  /** Deliver to this instance only (presence sync for one subscriber). */
  publishLocal(msg: Omit<FanoutMessage, 'v' | 'origin'>): void {
    this.deliverLocal({ ...msg, v: 1, origin: this.instanceId });
  }

  /**
   * Whether any instance has a subscriber for the project. Local subscribers
   * answer immediately; otherwise Redis is asked how many connections listen on
   * the project's channel, and that answer is cached briefly. With Redis off or
   * unreachable the answer is the local one, as before.
   */
  async hasAnySubscribers(projectId: string): Promise<boolean> {
    if ((this.localCounts.get(projectId) ?? 0) > 0) return true;
    if (!this.enabled || !this.redis.isReady()) return false;

    const now = Date.now();
    const cached = this.remoteInterest.get(projectId);
    if (cached && now - cached.at < REMOTE_INTEREST_TTL_MS) return cached.n > 0;

    try {
      const res = (await this.redis
        .getClient()
        .pubsub('NUMSUB', this.channelFor(projectId))) as Array<string | number>;
      const n = Number(res?.[1] ?? 0) || 0;
      this.remoteInterest.set(projectId, { n, at: now });
      return n > 0;
    } catch (err: any) {
      this.logger.debug(`NUMSUB failed: ${err?.message}`);
      return false;
    }
  }

  onLocalSubscriberAdded(projectId: string): void {
    const n = (this.localCounts.get(projectId) ?? 0) + 1;
    this.localCounts.set(projectId, n);
    if (n === 1 && this.enabled) {
      this.ensureSubscriber();
      this.subscribeChannel(projectId);
    }
  }

  onLocalSubscriberRemoved(projectId: string): void {
    const n = (this.localCounts.get(projectId) ?? 0) - 1;
    if (n <= 0) {
      this.localCounts.delete(projectId);
      if (this.enabled) this.unsubscribeChannel(projectId);
    } else {
      this.localCounts.set(projectId, n);
    }
  }

  localSubscriberCount(projectId: string): number {
    return this.localCounts.get(projectId) ?? 0;
  }

  /** A message arriving from Redis. Public so a test can feed one in. */
  handleRemoteMessage(raw: string): void {
    let msg: FanoutMessage | null = null;
    try {
      msg = JSON.parse(raw) as FanoutMessage;
    } catch {
      return;
    }
    if (!msg || msg.v !== 1 || typeof msg.projectId !== 'string') return;
    // Our own publish was delivered locally already.
    if (msg.origin === this.instanceId) return;
    this.deliverLocal(msg);
  }

  private deliverLocal(msg: FanoutMessage): void {
    if (!this.deliverer) return;
    try {
      this.deliverer(msg);
    } catch (err: any) {
      this.logger.warn(`local delivery failed: ${err?.message}`);
    }
  }

  // ── Subscriber connection ────────────────────────────────

  private ensureSubscriber(): void {
    if (this.sub) return;
    try {
      const sub = this.redis.createSubscriber();
      this.sub = sub;
      sub.on('message', (_channel: string, message: string) => this.handleRemoteMessage(message));
      sub.on('ready', () => {
        // ioredis re-subscribes on its own after a reconnect; this covers a
        // connection that was created while Redis was still unreachable.
        for (const projectId of this.localCounts.keys()) this.subscribeChannel(projectId);
      });
      sub.on('error', (err: any) => this.logger.debug(`subscriber error: ${err?.message}`));
    } catch (err: any) {
      // RedisService has not created its client yet (module init order) —
      // try again shortly.
      this.logger.debug(`subscriber not ready: ${err?.message}`);
      if (!this.subRetry) {
        this.subRetry = setTimeout(() => {
          this.subRetry = null;
          this.ensureSubscriber();
        }, SUBSCRIBER_RETRY_MS);
        (this.subRetry as any).unref?.();
      }
    }
  }

  private subscribeChannel(projectId: string): void {
    if (!this.sub) return;
    this.sub
      .subscribe(`rt:${projectId}`)
      .catch((err: any) => this.logger.debug(`subscribe failed: ${err?.message}`));
  }

  private unsubscribeChannel(projectId: string): void {
    if (!this.sub) return;
    this.sub
      .unsubscribe(`rt:${projectId}`)
      .catch((err: any) => this.logger.debug(`unsubscribe failed: ${err?.message}`));
  }
}
