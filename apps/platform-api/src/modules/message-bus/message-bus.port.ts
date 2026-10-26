/**
 * The message bus as the rest of the API sees it. Producers and consumers
 * depend on this port only; the AMQP implementation behind it can be swapped
 * (ADR 0003 keeps Kafka as the documented exit) without touching them.
 */
export const MESSAGE_BUS = Symbol('MESSAGE_BUS');

/** Durable work queues. Each is a quorum queue with a delivery limit and a dead-letter queue. */
export const JOB_QUEUES = [
  'jobs.provisioning',
  'jobs.migration',
  'jobs.webhooks',
  'jobs.async-requests',
  'jobs.notifications',
  'jobs.usage',
] as const;
export type JobQueue = (typeof JOB_QUEUES)[number];

/** Delays a failed job waits before its next attempt, by attempt number (1-based). */
export const RETRY_DELAYS_MS = [10_000, 60_000, 300_000, 1_800_000] as const;
export const MAX_ATTEMPTS = 5;

export interface MessageEnvelope<T = unknown> {
  /** UUID; also the AMQP messageId, and the idempotency key consumers dedupe on. */
  id: string;
  kind: string;
  projectId?: string | null;
  teamId?: string | null;
  actorUserId?: string | null;
  traceId?: string | null;
  /** 1 on first delivery; incremented by the retry path. */
  attempt: number;
  createdAt: string;
  /** References only — never a secret; consumers resolve credentials from the encrypted store. */
  payload: T;
}

export interface PublishJobOptions {
  id?: string;
  kind?: string;
  projectId?: string | null;
  teamId?: string | null;
  actorUserId?: string | null;
  traceId?: string | null;
  priority?: number;
  headers?: Record<string, string | number>;
}

export interface PlatformEvent<T = unknown> {
  type: string;
  projectId?: string | null;
  teamId?: string | null;
  actorUserId?: string | null;
  occurredAt?: string;
  data: T;
}

export interface ConsumeOptions {
  /** Unacked messages a consumer holds at once. */
  prefetch?: number;
}

export type JobHandler<T = unknown> = (envelope: MessageEnvelope<T>) => Promise<void>;

export interface MessageBus {
  /** True when a broker is configured and the connection is up. */
  isConnected(): boolean;
  /** True when a broker is configured at all (MESSAGE_BUS_URL set). */
  isEnabled(): boolean;
  publishJob<T>(queue: JobQueue, payload: T, opts?: PublishJobOptions): Promise<string>;
  publishEvent<T>(topic: string, event: PlatformEvent<T>): Promise<void>;
  consumeJob<T>(queue: JobQueue, handler: JobHandler<T>, opts?: ConsumeOptions): Promise<void>;
}

/** Retry delay for a failed attempt, or null when the attempts are exhausted. */
export function retryDelayFor(attempt: number): number | null {
  if (attempt >= MAX_ATTEMPTS) return null;
  return RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
}

/** The retry queue that holds a message for a given delay. */
export function retryQueueFor(delayMs: number): string {
  return `retry.${delayMs}`;
}

export function dlqFor(queue: JobQueue): string {
  return `dlq.${queue}`;
}

/** Everything the broker must hold, in one place, declared idempotently at boot. */
export const TOPOLOGY = {
  exchanges: {
    jobs: 'basefyio.jobs',
    events: 'basefyio.events',
    dlx: 'basefyio.dlx',
    retry: 'basefyio.retry',
  },
  queues: JOB_QUEUES,
  retryDelaysMs: RETRY_DELAYS_MS,
} as const;
