import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { MetricsService } from '../health/metrics.service';
import { drainState } from '../../common/utils/drain-state';
import { ConcurrencyGate, GateDecision } from './concurrency-gate';
import { MemoryTokenBucket, TOKEN_BUCKET_LUA, BucketLimits, BucketResult, parseBucketReply } from './token-bucket';
import { AdmissionConfig, DASHBOARD_USER_LIMITS, admissionConfig, limitsForPlan } from './admission-limits';

export type Lane = 'customer' | 'dashboard' | 'anonymous';

export interface AdmissionRequestFacts {
  path: string;
  method: string;
  projectId: string | null;
  userId: string | null;
}

export interface AdmissionOutcome {
  /** What happened (or, in log mode, what would have happened). */
  decision: 'admit' | 'queued' | 'overloaded' | 'rate_limited' | 'draining';
  lane: Lane;
  enforced: boolean;
  waitedMs: number;
  bucket: BucketResult | null;
  /** Call exactly once when the request finishes; a no-op for rejected requests. */
  release: () => void;
}

const PLAN_CACHE_MS = 60_000;
const LOG_SAMPLE = 50;

/**
 * Admission control: bounded, shaped, shed. One concurrency gate per lane
 * (customer traffic through API keys, dashboard sessions through JWT, the
 * rest) with a bounded wait line, and a token bucket per project sized by its
 * plan. `ADMISSION_MODE=log` observes and counts without touching a request;
 * `enforce` rejects with 503 overloaded / 429 rate_limited and Retry-After.
 */
@Injectable()
export class AdmissionService {
  private readonly logger = new Logger(AdmissionService.name);
  private config: AdmissionConfig = admissionConfig();
  private readonly gates: Record<Lane, ConcurrencyGate>;
  private readonly memoryBucket = new MemoryTokenBucket();
  private readonly planCache = new Map<string, { at: number; limits: BucketLimits }>();
  private redisBucketBroken = 0;
  private sampleCounter = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
  ) {
    const c = this.config;
    const dash = Math.max(1, Math.round(c.maxInflight * c.dashboardShare));
    const cust = Math.max(1, c.maxInflight - dash);
    this.gates = {
      customer: new ConcurrencyGate({ maxInflight: cust, maxWaiting: Math.round(c.maxWaiting * (1 - c.dashboardShare)), maxWaitMs: c.maxWaitMs }),
      dashboard: new ConcurrencyGate({ maxInflight: dash, maxWaiting: Math.round(c.maxWaiting * c.dashboardShare), maxWaitMs: c.maxWaitMs }),
      // Unauthenticated routes (sign-in, public plans, webhooks) share the customer line's size but their own counter.
      anonymous: new ConcurrencyGate({ maxInflight: cust, maxWaiting: Math.round(c.maxWaiting * (1 - c.dashboardShare)), maxWaitMs: c.maxWaitMs }),
    };
  }

  mode(): AdmissionConfig['mode'] {
    return this.config.mode;
  }

  /** Re-read the environment (tests, and a future settings flip without restart). */
  reconfigure(): void {
    this.config = admissionConfig();
  }

  laneFor(facts: AdmissionRequestFacts): Lane {
    if (facts.projectId) return 'customer';
    if (facts.userId) return 'dashboard';
    return 'anonymous';
  }

  async admit(facts: AdmissionRequestFacts): Promise<AdmissionOutcome> {
    const mode = this.config.mode;
    const lane = this.laneFor(facts);
    if (mode === 'off') return { decision: 'admit', lane, enforced: false, waitedMs: 0, bucket: null, release: () => {} };
    const enforced = mode === 'enforce';

    // A draining process takes no new work; the load balancer is told so by /api/health/ready too.
    if (drainState.isDraining()) {
      this.count('draining', lane, enforced);
      if (enforced) return { decision: 'draining', lane, enforced, waitedMs: 0, bucket: null, release: () => {} };
    }

    // 1. the per-project (or per-user) token bucket
    const bucket = await this.takeToken(facts, lane);
    if (bucket && !bucket.allowed) {
      this.count('rate_limited', lane, enforced);
      this.sampleLog(`rate limit ${lane} ${facts.projectId ?? facts.userId} ${facts.method} ${facts.path} (retry ${bucket.retryAfterMs} ms)`, enforced);
      if (enforced) return { decision: 'rate_limited', lane, enforced, waitedMs: 0, bucket, release: () => {} };
    }

    // 2. the per-process concurrency gate for this lane
    const gate = this.gates[lane];
    if (!enforced) {
      const { wouldBe, release } = gate.admitForLogging();
      this.count(wouldBe === 'admit' ? 'admit' : wouldBe === 'queued' ? 'queued' : 'overloaded', lane, enforced);
      if (wouldBe !== 'admit') this.sampleLog(`gate ${lane} would ${wouldBe} ${facts.method} ${facts.path} (inflight ${gate.stats().inflight})`, enforced);
      this.publishGauges();
      return { decision: 'admit', lane, enforced, waitedMs: 0, bucket, release: this.wrapRelease(release) };
    }
    const result = await gate.acquire();
    const decision = this.mapDecision(result.decision);
    this.count(decision, lane, enforced);
    this.publishGauges();
    if (decision === 'overloaded') {
      this.sampleLog(`shed ${lane} ${facts.method} ${facts.path} after ${result.waitedMs} ms (${result.decision})`, enforced);
      return { decision, lane, enforced, waitedMs: result.waitedMs, bucket, release: () => {} };
    }
    return { decision, lane, enforced, waitedMs: result.waitedMs, bucket, release: this.wrapRelease(result.release) };
  }

  gateStats() {
    return { customer: this.gates.customer.stats(), dashboard: this.gates.dashboard.stats(), anonymous: this.gates.anonymous.stats() };
  }

  // ── Token bucket ─────────────────────────────────────────────────────────

  private async takeToken(facts: AdmissionRequestFacts, lane: Lane): Promise<BucketResult | null> {
    let key: string;
    let limits: BucketLimits;
    if (lane === 'customer' && facts.projectId) {
      key = `adm:p:${facts.projectId}`;
      limits = await this.limitsForProject(facts.projectId);
    } else if (lane === 'dashboard' && facts.userId) {
      key = `adm:u:${facts.userId}`;
      limits = DASHBOARD_USER_LIMITS;
    } else {
      return null;
    }
    const now = Date.now();
    // After a Redis failure, stay on the in-memory bucket for 30 s instead of paying a timeout per request.
    if (this.redisBucketBroken > now) return this.memoryBucket.take(key, limits, now);
    try {
      const reply = await this.redis.getClient().eval(TOKEN_BUCKET_LUA, 1, key, limits.rate, limits.burst, now, 1);
      return parseBucketReply(reply, limits);
    } catch (err: any) {
      this.redisBucketBroken = now + 30_000;
      this.logger.warn(`Token bucket on Redis failed, using the in-memory bucket for 30 s: ${err?.message ?? err}`);
      return this.memoryBucket.take(key, limits, now);
    }
  }

  /** The project's plan limits, cached a minute: the plan does not change under a request. */
  async limitsForProject(projectId: string): Promise<BucketLimits> {
    const cached = this.planCache.get(projectId);
    if (cached && Date.now() - cached.at < PLAN_CACHE_MS) return cached.limits;
    let limits = limitsForPlan(null);
    try {
      const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { teamId: true } });
      if (project) {
        const sub = await this.prisma.subscription.findUnique({
          where: { teamId: project.teamId },
          select: { plan: { select: { name: true, features: true } } },
        });
        limits = limitsForPlan(sub?.plan?.name, (sub?.plan?.features as Record<string, unknown> | null) ?? null);
      }
    } catch (err: any) {
      this.logger.warn(`Plan lookup for ${projectId} failed, using free limits: ${err?.message ?? err}`);
    }
    this.planCache.set(projectId, { at: Date.now(), limits });
    if (this.planCache.size > 5000) this.planCache.delete(this.planCache.keys().next().value as string);
    return limits;
  }

  // ── Bookkeeping ──────────────────────────────────────────────────────────

  private mapDecision(d: GateDecision): AdmissionOutcome['decision'] {
    if (d === 'admit') return 'admit';
    if (d === 'queued') return 'queued';
    return 'overloaded';
  }

  private count(decision: AdmissionOutcome['decision'] | 'draining', lane: Lane, enforced: boolean): void {
    // Counter names render as basefyio_events_total{event="<name>"}; one name per series.
    this.metrics.increment(`admission_${enforced ? '' : 'would_'}${decision}_${lane}`);
  }

  private publishGauges(): void {
    for (const lane of ['customer', 'dashboard', 'anonymous'] as Lane[]) {
      const s = this.gates[lane].stats();
      this.metrics.setGauge('basefyio_admission_inflight', 'Requests inside the admission gate, per lane.', `lane="${lane}"`, s.inflight);
      this.metrics.setGauge('basefyio_admission_waiting', 'Requests waiting for a slot, per lane.', `lane="${lane}"`, s.waiting);
    }
  }

  private wrapRelease(release: () => void): () => void {
    return () => {
      release();
      this.publishGauges();
    };
  }

  private sampleLog(line: string, enforced: boolean): void {
    this.sampleCounter = (this.sampleCounter + 1) % LOG_SAMPLE;
    if (this.sampleCounter === 1) this.logger.log(`[admission ${enforced ? 'enforce' : 'log'}] ${line}`);
  }
}
