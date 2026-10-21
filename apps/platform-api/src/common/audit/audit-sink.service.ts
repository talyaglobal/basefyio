import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditEvent } from './audit-event';
import { AuditSinkConfig, readAuditSinkConfig } from './audit-sink.config';
import { AuditTarget, isNonRetryable } from './targets/audit-target';
import { SyslogAuditTarget } from './targets/syslog-audit-target';
import { WebhookAuditTarget } from './targets/webhook-audit-target';

/** Injection token tests use to hand the service their own targets; never provided in production. */
export const AUDIT_TARGETS = Symbol('AUDIT_TARGETS');

export interface AuditTargetStats {
  name: string;
  target: string;
  inFlight: boolean;
  sent: number;
  failed: number;
  lastSuccessAt: string | null;
  lastError: { at: string; message: string } | null;
}

export interface AuditSinkStats {
  enabled: boolean;
  problems: string[];
  targets: AuditTargetStats[];
  queue: { depth: number; max: number };
  counters: { enqueued: number; dropped: number };
  batchSize: number;
  flushMs: number;
}

interface TargetState {
  target: AuditTarget;
  chain: Promise<void>;
  inFlight: boolean;
  sent: number;
  failed: number;
  lastSuccessAt: Date | null;
  lastError: { at: Date; message: string } | null;
  lastWarnAt: number;
}

const WARN_INTERVAL_MS = 60_000;

/**
 * Forwards audit records to the configured destinations without ever standing
 * in a request's way.
 *
 * `enqueue` is synchronous and O(1): it appends to a bounded array and, at
 * most, schedules a flush on the next tick. Sending happens on a timer, one
 * batch in flight per target, with a short retry ladder; a batch that still
 * fails is dropped and counted. When the queue is full the oldest event is
 * dropped and counted, so a dead receiver costs memory up to the cap and no
 * more. The `audit_logs` row written before `enqueue` stays the durable record.
 *
 * With no `AUDIT_*` variable set the service is inert: no timer, no socket,
 * `enqueue` returns immediately.
 */
@Injectable()
export class AuditSinkService implements OnModuleDestroy {
  private readonly logger = new Logger('AuditSink');
  readonly config: AuditSinkConfig;
  readonly problems: string[];
  readonly enabled: boolean;

  private readonly queue: AuditEvent[] = [];
  private readonly targets: TargetState[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushScheduled = false;
  private enqueued = 0;
  private dropped = 0;
  private closed = false;

  constructor(
    @Optional() config?: ConfigService,
    /** Tests inject their own targets; production builds them from the config. */
    @Optional() @Inject(AUDIT_TARGETS) targets?: AuditTarget[],
  ) {
    const read = readAuditSinkConfig(config ?? { get: (k: string) => process.env[k] });
    this.config = read.config;
    this.problems = read.problems;
    for (const p of this.problems) this.logger.warn(p);

    const fromConfig: AuditTarget[] = [];
    if (this.config.webhook) fromConfig.push(new WebhookAuditTarget(this.config.webhook));
    if (this.config.syslog) fromConfig.push(new SyslogAuditTarget(this.config.syslog));
    const built: AuditTarget[] = targets ?? fromConfig;

    for (const target of built) {
      this.targets.push({
        target,
        chain: Promise.resolve(),
        inFlight: false,
        sent: 0,
        failed: 0,
        lastSuccessAt: null,
        lastError: null,
        lastWarnAt: 0,
      });
    }
    this.enabled = this.targets.length > 0;

    if (this.enabled) {
      this.timer = setInterval(() => void this.flush(), this.config.flushMs);
      this.timer.unref();
      this.logger.log(
        `Audit forwarding on: ${this.targets.map((t) => `${t.target.name} → ${t.target.description}`).join(', ')}`,
      );
    }
  }

  /** Never throws, never awaits. */
  enqueue(event: AuditEvent): void {
    if (!this.enabled || this.closed) return;
    try {
      this.enqueued += 1;
      this.queue.push(event);
      while (this.queue.length > this.config.queueMax) {
        this.queue.shift();
        this.dropped += 1;
      }
      if (this.queue.length >= this.config.batchSize && !this.flushScheduled) {
        this.flushScheduled = true;
        setImmediate(() => {
          this.flushScheduled = false;
          void this.flush();
        });
      }
    } catch (err: any) {
      this.logger.warn(`enqueue failed: ${err?.message || err}`);
    }
  }

  /**
   * Hands the next batch to every target. Resolves once each target has either
   * delivered it or given up on it; never rejects.
   */
  async flush(): Promise<void> {
    if (!this.enabled || this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.config.batchSize);
    await Promise.all(this.targets.map((state) => this.dispatch(state, batch)));
  }

  /** Drains the queue completely (shutdown and the console's test action). */
  async drain(): Promise<void> {
    while (this.enabled && this.queue.length > 0) {
      await this.flush();
    }
  }

  private dispatch(state: TargetState, batch: AuditEvent[]): Promise<void> {
    state.chain = state.chain
      .then(() => this.sendWithRetry(state, batch))
      .catch(() => undefined);
    return state.chain;
  }

  private async sendWithRetry(state: TargetState, batch: AuditEvent[]): Promise<void> {
    state.inFlight = true;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await state.target.send(batch);
          state.sent += batch.length;
          state.lastSuccessAt = new Date();
          return;
        } catch (err: any) {
          const message = err?.message || String(err);
          state.lastError = { at: new Date(), message };
          if (isNonRetryable(err) || attempt >= this.config.retries) {
            state.failed += batch.length;
            this.warnRateLimited(state, `dropped ${batch.length} event(s): ${message}`);
            return;
          }
          await this.sleep(1000 * 2 ** attempt);
        }
      }
    } finally {
      state.inFlight = false;
    }
  }

  private warnRateLimited(state: TargetState, text: string) {
    const now = Date.now();
    if (now - state.lastWarnAt < WARN_INTERVAL_MS) return;
    state.lastWarnAt = now;
    this.logger.warn(`${state.target.name} (${state.target.description}): ${text}`);
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
  }

  stats(): AuditSinkStats {
    return {
      enabled: this.enabled,
      problems: [...this.problems],
      targets: this.targets.map((s) => ({
        name: s.target.name,
        target: s.target.description,
        inFlight: s.inFlight,
        sent: s.sent,
        failed: s.failed,
        lastSuccessAt: s.lastSuccessAt ? s.lastSuccessAt.toISOString() : null,
        lastError: s.lastError ? { at: s.lastError.at.toISOString(), message: s.lastError.message } : null,
      })),
      queue: { depth: this.queue.length, max: this.config.queueMax },
      counters: { enqueued: this.enqueued, dropped: this.dropped },
      batchSize: this.config.batchSize,
      flushMs: this.config.flushMs,
    };
  }

  /**
   * Sends one synthetic event and reports, per target, whether it arrived.
   * Used by the root console to confirm a new destination works.
   */
  async sendTestEvent(event: AuditEvent, capMs = 6_000): Promise<{
    ok: boolean;
    targets: Array<{ name: string; ok: boolean; error: string | null }>;
  }> {
    if (!this.enabled) return { ok: false, targets: [] };
    const before = this.targets.map((s) => ({ sent: s.sent, failed: s.failed }));
    this.enqueue(event);
    await Promise.race([this.drain(), this.sleep(capMs)]);
    const targets = this.targets.map((s, i) => {
      const delivered = s.sent > before[i].sent;
      return {
        name: s.target.name,
        ok: delivered,
        error: delivered ? null : s.lastError?.message || (s.failed > before[i].failed ? 'send failed' : 'timed out'),
      };
    });
    return { ok: targets.every((t) => t.ok), targets };
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.enabled) return;
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await Promise.race([this.drain(), this.sleep(2_000)]);
    const left = this.queue.length;
    if (left > 0) this.logger.warn(`shutting down with ${left} audit event(s) unsent`);
    await Promise.all(this.targets.map((s) => s.target.close().catch(() => undefined)));
  }
}
