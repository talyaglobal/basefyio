/**
 * A per-process concurrency gate with a bounded FIFO wait queue: the HTTP-layer
 * queue that keeps the database from seeing more than it can serve. Up to
 * `maxInflight` requests run; the next `maxWaiting` wait their turn in order;
 * anything beyond that, or a wait longer than `maxWaitMs`, is shed at once so
 * the client gets a fast, honest answer instead of a slow one.
 *
 * Pure and synchronous apart from the wait promise, so it is testable without
 * a server and cheap enough to sit in front of every request.
 */
export interface GateOptions {
  maxInflight: number;
  maxWaiting: number;
  maxWaitMs: number;
}

export type GateDecision = 'admit' | 'queued' | 'shed_full' | 'shed_timeout';

export interface GateStats {
  inflight: number;
  waiting: number;
  admitted: number;
  queued: number;
  shed: number;
  maxInflight: number;
  maxWaiting: number;
}

interface Waiter {
  resolve: (decision: 'admit' | 'shed_timeout') => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ConcurrencyGate {
  private inflight = 0;
  private readonly waiters: Waiter[] = [];
  private admitted = 0;
  private queued = 0;
  private shed = 0;

  constructor(private opts: GateOptions) {}

  configure(opts: Partial<GateOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  /**
   * Ask for a slot. Resolves with the decision and, when admitted, a release
   * function the caller must invoke exactly once when the request finishes.
   */
  async acquire(): Promise<{ decision: GateDecision; waitedMs: number; release: () => void }> {
    const started = Date.now();
    if (this.inflight < this.opts.maxInflight) {
      this.inflight++;
      this.admitted++;
      return { decision: 'admit', waitedMs: 0, release: this.releaser() };
    }
    if (this.waiters.length >= this.opts.maxWaiting) {
      this.shed++;
      return { decision: 'shed_full', waitedMs: 0, release: () => {} };
    }
    this.queued++;
    const decision = await new Promise<'admit' | 'shed_timeout'>((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve('shed_timeout');
        }, this.opts.maxWaitMs),
      };
      this.waiters.push(waiter);
    });
    const waitedMs = Date.now() - started;
    if (decision === 'admit') {
      this.admitted++;
      return { decision: 'queued', waitedMs, release: this.releaser() };
    }
    this.shed++;
    return { decision: 'shed_timeout', waitedMs, release: () => {} };
  }

  /**
   * Log mode: admit at once (nothing may wait or be shed while we only
   * observe) but report what the gate would have decided, so the counters
   * show the shape of the traffic before enforcement is switched on.
   */
  admitForLogging(): { wouldBe: GateDecision; release: () => void } {
    let wouldBe: GateDecision = 'admit';
    if (this.inflight >= this.opts.maxInflight) {
      wouldBe = this.inflight - this.opts.maxInflight >= this.opts.maxWaiting ? 'shed_full' : 'queued';
    }
    this.inflight++;
    this.admitted++;
    return { wouldBe, release: this.releaser() };
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.inflight = Math.max(0, this.inflight - 1);
      this.wakeNext();
    };
  }

  /** Hand the freed slot to the oldest waiter; the slot count stays the same. */
  private wakeNext(): void {
    while (this.inflight < this.opts.maxInflight) {
      const next = this.waiters.shift();
      if (!next) return;
      clearTimeout(next.timer);
      this.inflight++;
      next.resolve('admit');
    }
  }

  stats(): GateStats {
    return {
      inflight: this.inflight,
      waiting: this.waiters.length,
      admitted: this.admitted,
      queued: this.queued,
      shed: this.shed,
      maxInflight: this.opts.maxInflight,
      maxWaiting: this.opts.maxWaiting,
    };
  }
}
