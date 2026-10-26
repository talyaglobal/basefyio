import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import { randomUUID } from 'crypto';
import { RedisService } from '../redis/redis.service';
import { MetricsService } from '../health/metrics.service';
import {
  ConsumeOptions,
  JobHandler,
  JobQueue,
  JOB_QUEUES,
  MAX_ATTEMPTS,
  MessageBus,
  MessageEnvelope,
  PlatformEvent,
  PublishJobOptions,
  RETRY_DELAYS_MS,
  TOPOLOGY,
  dlqFor,
  retryDelayFor,
  retryQueueFor,
} from './message-bus.port';

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** A message id is remembered for a day so a redelivery after an ack race is not executed twice. */
const DEDUPE_TTL_SECONDS = 86_400;

interface ConsumerRegistration {
  queue: JobQueue;
  handler: JobHandler<any>;
  prefetch: number;
}

/**
 * RabbitMQ behind the MessageBus port, on amqplib: one connection per process,
 * a confirm channel for publishing, one channel per consumer, reconnect with
 * exponential backoff, and the topology declared idempotently at connect.
 * Inert when no URL is configured: every method is a no-op that reports so.
 */
@Injectable()
export class AmqpMessageBus implements MessageBus, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AmqpMessageBus.name);
  private readonly url: string;
  private connection: amqp.ChannelModel | null = null;
  private publisher: amqp.ConfirmChannel | null = null;
  private readonly consumers: ConsumerRegistration[] = [];
  private readonly consumerChannels: amqp.Channel[] = [];
  private closing = false;
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
  ) {
    this.url = (this.config.get<string>('messageBus.url') || '').trim();
  }

  isEnabled(): boolean {
    return this.url.length > 0;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async onModuleInit(): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.log('Message bus disabled (MESSAGE_BUS_URL unset)');
      return;
    }
    void this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      await this.connection?.close();
    } catch {
      /* already gone */
    }
  }

  // ── Connection ───────────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    if (this.closing) return;
    try {
      const connection = await amqp.connect(this.url, { clientProperties: { connection_name: `basefyio-api ${process.env.IMAGE_TAG || 'dev'}` } });
      connection.on('error', (err: Error) => this.logger.warn(`Bus connection error: ${err.message}`));
      connection.on('close', () => {
        this.connected = false;
        this.publisher = null;
        this.consumerChannels.length = 0;
        this.metrics.setGauge('basefyio_bus_up', 'Whether the message bus connection is open.', '', 0);
        if (!this.closing) {
          this.logger.warn(`Bus connection closed; reconnecting in ${this.reconnectDelay} ms`);
          this.scheduleReconnect();
        }
      });
      this.connection = connection;
      await this.declareTopology(connection);
      this.publisher = await connection.createConfirmChannel();
      for (const reg of this.consumers) await this.startConsumer(reg);
      this.connected = true;
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.metrics.setGauge('basefyio_bus_up', 'Whether the message bus connection is open.', '', 1);
      this.logger.log(`Message bus connected (${this.consumers.length} consumer(s))`);
    } catch (err: any) {
      this.logger.warn(`Bus connect failed: ${err?.message ?? err}; retrying in ${this.reconnectDelay} ms`);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closing || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(RECONNECT_MAX_MS, this.reconnectDelay * 2);
      void this.connect();
    }, this.reconnectDelay);
    this.reconnectTimer.unref?.();
  }

  /** Exchanges, the work queues (quorum, dead-lettered), the retry queues and the DLQs. Safe to repeat. */
  private async declareTopology(connection: amqp.ChannelModel): Promise<void> {
    const ch = await connection.createChannel();
    try {
      const { exchanges } = TOPOLOGY;
      await ch.assertExchange(exchanges.jobs, 'direct', { durable: true });
      await ch.assertExchange(exchanges.events, 'topic', { durable: true });
      await ch.assertExchange(exchanges.dlx, 'direct', { durable: true });
      await ch.assertExchange(exchanges.retry, 'direct', { durable: true });
      for (const queue of JOB_QUEUES) {
        await ch.assertQueue(queue, {
          durable: true,
          arguments: {
            'x-queue-type': 'quorum',
            'x-delivery-limit': MAX_ATTEMPTS,
            'x-dead-letter-exchange': exchanges.dlx,
            'x-dead-letter-routing-key': dlqFor(queue),
          },
        });
        await ch.bindQueue(queue, exchanges.jobs, queue);
        await ch.assertQueue(dlqFor(queue), { durable: true, arguments: { 'x-queue-type': 'quorum' } });
        await ch.bindQueue(dlqFor(queue), exchanges.dlx, dlqFor(queue));
      }
      // A retry queue per delay: messages wait there, expire, and dead-letter back to the jobs
      // exchange under their original routing key.
      for (const delay of RETRY_DELAYS_MS) {
        const name = retryQueueFor(delay);
        await ch.assertQueue(name, {
          durable: true,
          arguments: { 'x-message-ttl': delay, 'x-dead-letter-exchange': exchanges.jobs },
        });
        await ch.bindQueue(name, exchanges.retry, name);
      }
    } finally {
      await ch.close().catch(() => {});
    }
  }

  // ── Publishing ───────────────────────────────────────────────────────────

  private envelope<T>(payload: T, opts: PublishJobOptions & { kind: string }): MessageEnvelope<T> {
    return {
      id: opts.id ?? randomUUID(),
      kind: opts.kind,
      projectId: opts.projectId ?? null,
      teamId: opts.teamId ?? null,
      actorUserId: opts.actorUserId ?? null,
      traceId: opts.traceId ?? null,
      attempt: 1,
      createdAt: new Date().toISOString(),
      payload,
    };
  }

  private async publish(exchange: string, routingKey: string, envelope: MessageEnvelope, opts: { priority?: number; headers?: Record<string, string | number> } = {}): Promise<void> {
    if (!this.isEnabled()) throw new Error('Message bus is not configured');
    const ch = this.publisher;
    if (!ch) throw new Error('Message bus is not connected');
    const body = Buffer.from(JSON.stringify(envelope));
    await new Promise<void>((resolve, reject) => {
      const ok = ch.publish(
        exchange,
        routingKey,
        body,
        {
          persistent: true,
          contentType: 'application/json',
          messageId: envelope.id,
          timestamp: Math.floor(Date.now() / 1000),
          type: envelope.kind,
          priority: opts.priority,
          headers: { ...(opts.headers ?? {}), 'x-attempt': envelope.attempt },
        },
        (err) => (err ? reject(err) : resolve()),
      );
      if (!ok) this.logger.debug('Bus publisher channel is applying back-pressure');
    });
  }

  async publishJob<T>(queue: JobQueue, payload: T, opts: PublishJobOptions = {}): Promise<string> {
    const envelope = this.envelope(payload, { ...opts, kind: opts.kind ?? queue });
    await this.publish(TOPOLOGY.exchanges.jobs, queue, envelope, { priority: opts.priority, headers: opts.headers });
    this.metrics.increment(`bus_published_${queue}`);
    return envelope.id;
  }

  async publishEvent<T>(topic: string, event: PlatformEvent<T>): Promise<void> {
    const envelope = this.envelope(event.data, {
      kind: event.type,
      projectId: event.projectId,
      teamId: event.teamId,
      actorUserId: event.actorUserId,
    });
    await this.publish(TOPOLOGY.exchanges.events, topic, envelope);
    this.metrics.increment('bus_events_published');
  }

  // ── Consuming ────────────────────────────────────────────────────────────

  async consumeJob<T>(queue: JobQueue, handler: JobHandler<T>, opts: ConsumeOptions = {}): Promise<void> {
    const reg: ConsumerRegistration = { queue, handler, prefetch: opts.prefetch ?? 8 };
    this.consumers.push(reg);
    if (this.connection && this.connected) await this.startConsumer(reg);
  }

  private async startConsumer(reg: ConsumerRegistration): Promise<void> {
    if (!this.connection) return;
    const ch = await this.connection.createChannel();
    this.consumerChannels.push(ch);
    await ch.prefetch(reg.prefetch);
    await ch.consume(reg.queue, (msg) => {
      if (!msg) return;
      void this.handle(ch, reg, msg);
    });
  }

  /** Parse, dedupe, run, ack — or route to a retry queue, or to the DLQ once attempts are exhausted. */
  private async handle(ch: amqp.Channel, reg: ConsumerRegistration, msg: amqp.ConsumeMessage): Promise<void> {
    let envelope: MessageEnvelope;
    try {
      envelope = JSON.parse(msg.content.toString('utf8')) as MessageEnvelope;
      if (!envelope || typeof envelope.id !== 'string') throw new Error('no envelope id');
    } catch (err: any) {
      this.logger.warn(`Unreadable message on ${reg.queue} sent to the DLQ: ${err?.message ?? err}`);
      ch.nack(msg, false, false);
      return;
    }
    const attempt = Number(msg.properties.headers?.['x-attempt'] ?? envelope.attempt ?? 1);
    envelope.attempt = attempt;

    // Idempotent by id: a message delivered twice (ack lost, consumer restarted) runs once.
    const doneKey = `bus:done:${envelope.id}`;
    try {
      const first = await this.redis.getDurableClient().set(doneKey, '1', 'EX', DEDUPE_TTL_SECONDS, 'NX');
      if (first === null) {
        ch.ack(msg);
        this.metrics.increment(`bus_duplicate_${reg.queue}`);
        return;
      }
    } catch {
      /* Redis down: run the handler; at-least-once beats never */
    }

    const started = Date.now();
    try {
      await reg.handler(envelope);
      ch.ack(msg);
      this.metrics.increment(`bus_consumed_${reg.queue}`);
      this.metrics.observeRequest('BUS', 200, Date.now() - started, 'other');
    } catch (err: any) {
      // The run failed: forget the dedupe mark so the retry may execute.
      await this.redis.getDurableClient().del(doneKey).catch(() => {});
      const delay = retryDelayFor(attempt);
      this.metrics.increment(`bus_failed_${reg.queue}`);
      if (delay === null || !this.publisher) {
        this.logger.warn(`Job ${envelope.id} on ${reg.queue} failed ${attempt}×, to the DLQ: ${err?.message ?? err}`);
        ch.nack(msg, false, false);
        return;
      }
      this.logger.warn(`Job ${envelope.id} on ${reg.queue} failed (attempt ${attempt}); retry in ${delay} ms: ${err?.message ?? err}`);
      try {
        const next: MessageEnvelope = { ...envelope, attempt: attempt + 1 };
        await new Promise<void>((resolve, reject) =>
          this.publisher!.publish(
            TOPOLOGY.exchanges.retry,
            retryQueueFor(delay),
            Buffer.from(JSON.stringify(next)),
            {
              persistent: true,
              contentType: 'application/json',
              messageId: next.id,
              type: next.kind,
              headers: { ...(msg.properties.headers ?? {}), 'x-attempt': next.attempt, 'x-original-routing-key': reg.queue },
            },
            (e) => (e ? reject(e) : resolve()),
          ),
        );
        ch.ack(msg);
      } catch (publishErr: any) {
        this.logger.warn(`Could not schedule the retry for ${envelope.id}; requeueing: ${publishErr?.message ?? publishErr}`);
        ch.nack(msg, false, true);
      }
    }
  }
}
