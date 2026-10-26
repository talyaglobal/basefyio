import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hostname } from 'os';
import { randomBytes } from 'crypto';
import type Redis from 'ioredis';
import { RedisService } from '../../modules/redis/redis.service';
import { RealtimeEventEnvelope } from './realtime-events.types';
import { RealtimeStreamService } from './realtime-stream.service';

/** One channel for every dashboard event; each replica subscribes once. */
export const DASHBOARD_FANOUT_CHANNEL = 'rt-dash';

interface FanoutMessage {
  v: 1;
  origin: string;
  event: RealtimeEventEnvelope;
}

/**
 * Carries dashboard events (project created, import finished, member joined)
 * between API replicas.
 *
 * The SSE connections live in the process that accepted them, so an event
 * published by another replica never reached them: a user whose stream was
 * served by replica A saw nothing of what replica B did for their team. Each
 * replica now delivers locally first, then publishes the envelope on Redis
 * tagged with its own id, and ignores its own messages when they come back.
 *
 * One instance per process (provided by the global cluster module); the
 * stream service, which several modules instantiate, reaches it through a
 * module-level registration rather than injection.
 */
@Injectable()
export class DashboardFanoutService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DashboardFanoutService.name);
  private readonly instanceId = `${hostname()}-${randomBytes(4).toString('hex')}`;
  private readonly enabled: boolean;
  private sub: Redis | null = null;
  private retry?: NodeJS.Timeout;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    // The same switch the customer stream's fan-out honours.
    this.enabled = (config.get<string>('REALTIME_FANOUT') ?? 'redis') !== 'off';
  }

  onModuleInit(): void {
    RealtimeStreamService.setFanout(this);
    if (this.enabled) this.ensureSubscriber();
  }

  onModuleDestroy(): void {
    if (this.retry) clearTimeout(this.retry);
    RealtimeStreamService.setFanout(null);
    try {
      this.sub?.disconnect();
    } catch {
      /* noop */
    }
  }

  /** Called by the stream service after it has delivered to its own clients. */
  publishRemote(event: RealtimeEventEnvelope): void {
    if (!this.enabled || !this.redis.isReady()) return;
    const msg: FanoutMessage = { v: 1, origin: this.instanceId, event };
    this.redis
      .publish(DASHBOARD_FANOUT_CHANNEL, JSON.stringify(msg))
      .catch((err: any) => this.logger.debug(`dashboard fan-out publish failed: ${err?.message}`));
  }

  /** What arrives from the other replicas; own messages are dropped. */
  handleMessage(raw: string): void {
    let msg: FanoutMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || msg.v !== 1 || msg.origin === this.instanceId || !msg.event) return;
    RealtimeStreamService.deliverLocal(msg.event);
  }

  private ensureSubscriber(): void {
    try {
      this.sub = this.redis.createSubscriber();
    } catch (err: any) {
      this.logger.debug(`dashboard fan-out subscriber not ready (${err?.message}); retrying`);
      this.retry = setTimeout(() => this.ensureSubscriber(), 2_000);
      this.retry.unref?.();
      return;
    }
    this.sub.on('message', (channel: string, raw: string) => {
      if (channel === DASHBOARD_FANOUT_CHANNEL) this.handleMessage(raw);
    });
    this.sub.on('error', (err: any) => this.logger.debug(`dashboard fan-out subscriber error: ${err?.message}`));
    this.sub
      .subscribe(DASHBOARD_FANOUT_CHANNEL)
      .then(() => this.logger.log('Dashboard realtime fan-out across replicas: on'))
      .catch((err: any) => this.logger.warn(`dashboard fan-out subscribe failed: ${err?.message}`));
  }
}
