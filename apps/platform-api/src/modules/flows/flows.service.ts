import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Flow, FlowRun, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { PublicApiService } from '../projects/public-api.service';
import { EntitlementService } from '../entitlement/entitlement.service';
import { EntitlementKey } from '../entitlement/entitlement-key';
import { FLOW_QUEUE } from '../queue/queue.module';
import {
  decryptField,
  encryptField,
  isEncryptionEnabled,
} from '../../common/crypto/field-crypto';
import {
  FlowAction,
  FlowDefinitionInput,
  FlowOptions,
  FlowRunSource,
  FlowStepAttempt,
  FlowStepResult,
  FlowTrigger,
} from './flow.types';
import {
  FLOW_LIMITS,
  maskActions,
  normalizeDefinition,
  normalizeOptions,
  normalizeTrigger,
  readStoredActions,
  readStoredOptions,
  readStoredTrigger,
  runDeadlineMs,
  stepLimits,
} from './flow-definition';
import { cronError, nextCronTimes, parseCron } from './flow-cron';
import { renderString, renderValue, TemplateContext } from './flow-template';
import { performHttpRequest } from './flow-http';
import {
  generateWebhookId,
  generateWebhookSecret,
  safeRequestHeaders,
  verifyWebhookRequest,
  webhookSecretError,
} from './flow-webhook-auth';

/** Projects whose flows may still fire on their own (schedule, webhook). */
export const RUNNABLE_PROJECT_STATUSES = ['ACTIVE', 'PAUSED'] as const;

/** Largest webhook payload kept as a run's input. */
export const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

/** How much of a response / row set is stored on the run for the details view. */
const STORED_BODY_CHARS = 8 * 1024;
const STORED_ROWS = 20;
const RUNS_PAGE_MAX = 200;

export interface PublicFlow {
  id: string;
  projectId: string;
  name: string;
  enabled: boolean;
  trigger: FlowTrigger;
  actions: FlowAction[];
  options: FlowOptions | null;
  createdAt: Date;
  updatedAt: Date;
  /** webhook flows: the URL callers POST to. */
  webhookUrl?: string | null;
  /** webhook flows: whether a secret is set (it is never returned here). */
  hasWebhookSecret?: boolean;
  /** schedule flows: the next tick, or null when the schedule cannot fire. */
  nextRunAt?: string | null;
  /** schedule flows: why the stored schedule cannot fire, when it cannot. */
  scheduleError?: string | null;
  /** Only on create / when a webhook URL is first provisioned: shown once. */
  webhookSecret?: string;
}

interface StepOutcome {
  ok: boolean;
  /** worth trying again (network error, timeout, 5xx, 408, 429) */
  retryable: boolean;
  status?: number;
  detail?: string;
  /** what later steps can template from */
  output: Record<string, unknown>;
  stored: Partial<FlowStepResult>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function truncateForStorage(value: unknown): { value: unknown; truncated: boolean } {
  if (value === null || value === undefined) return { value: null, truncated: false };
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= STORED_BODY_CHARS) return { value, truncated: false };
  return { value: text.slice(0, STORED_BODY_CHARS), truncated: true };
}

function errorMessage(e: unknown): string {
  const anyErr = e as any;
  const resp = anyErr?.getResponse?.();
  const msg = typeof resp === 'object' && resp?.message ? resp.message : anyErr?.message;
  return (Array.isArray(msg) ? msg.join('; ') : String(msg ?? e)).slice(0, 500);
}

/**
 * Project automation flows: a trigger plus an ordered list of actions, executed
 * asynchronously on the BullMQ FLOW_QUEUE. Re-implemented from the askin "flows"
 * concept following our own patterns (no code copied).
 *
 * A run is executed once. It is never re-run from the start behind the user's
 * back: a failed step is retried on its own only when the action asks for it
 * (`retries`), every attempt is recorded on the step, and "Run again" creates a
 * new, separately recorded run.
 */
@Injectable()
export class FlowsService {
  private readonly logger = new Logger(FlowsService.name);
  private publicApiRef?: PublicApiService | null;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(FLOW_QUEUE) private readonly queue: Queue,
    private readonly projects: ProjectsService,
    private readonly entitlement: EntitlementService,
    private readonly config: ConfigService,
    private readonly moduleRef: ModuleRef,
  ) {}

  // ── Shapes ────────────────────────────────────────────────────────────────

  private webhookUrlFor(webhookId: string): string {
    const base = (this.config.get<string>('publicApiUrl') || 'http://localhost:4000').replace(/\/+$/, '');
    return `${base}/api/hooks/flows/${webhookId}`;
  }

  /** A flow as the API returns it: secrets masked, schedule and webhook state spelled out. */
  toPublicFlow(row: Flow, now = new Date()): PublicFlow {
    const trigger = readStoredTrigger(row.trigger);
    const out: PublicFlow = {
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      enabled: row.enabled,
      trigger,
      actions: maskActions(readStoredActions(row.actions)),
      options: row.options && typeof row.options === 'object' ? (row.options as FlowOptions) : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    if (trigger.type === 'webhook') {
      out.webhookUrl = row.webhookId ? this.webhookUrlFor(row.webhookId) : null;
      out.hasWebhookSecret = !!row.webhookSecret;
    }
    if (trigger.type === 'schedule') {
      const err = trigger.cron ? cronError(trigger.cron) : 'no cron expression is set';
      out.scheduleError = err;
      out.nextRunAt =
        !err && row.enabled
          ? nextCronTimes(parseCron(trigger.cron as string), now, 1, trigger.timezone || 'UTC')[0]?.toISOString() ?? null
          : null;
    }
    return out;
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  private async assertProject(projectId: string, userId?: string): Promise<void> {
    // Throws if the project is missing or the user has no access.
    await this.projects.findOne(projectId, userId);
  }

  private async getRow(projectId: string, id: string, userId?: string): Promise<Flow> {
    await this.assertProject(projectId, userId);
    const flow = await this.prisma.flow.findFirst({ where: { id, projectId } });
    if (!flow) throw new NotFoundException('Flow not found');
    return flow;
  }

  async list(projectId: string, userId?: string): Promise<PublicFlow[]> {
    await this.assertProject(projectId, userId);
    const rows = await this.prisma.flow.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    const now = new Date();
    return rows.map((r) => this.toPublicFlow(r, now));
  }

  async get(projectId: string, id: string, userId?: string): Promise<PublicFlow> {
    return this.toPublicFlow(await this.getRow(projectId, id, userId));
  }

  /** A new webhook id + encrypted secret, or null when secrets cannot be stored encrypted here. */
  private provisionWebhook(customSecret?: string): { webhookId: string; stored: string; secret: string } | null {
    if (!isEncryptionEnabled()) return null;
    const secret = customSecret ?? generateWebhookSecret();
    return { webhookId: generateWebhookId(), stored: encryptField(secret) as string, secret };
  }

  async create(projectId: string, dto: FlowDefinitionInput, userId?: string): Promise<PublicFlow> {
    await this.assertProject(projectId, userId);
    await this.entitlement.assertCan(projectId, EntitlementKey.FLOWS);
    const def = normalizeDefinition(dto);
    const hook = def.trigger.type === 'webhook' ? this.provisionWebhook() : null;
    const row = await this.prisma.flow.create({
      data: {
        projectId,
        name: def.name,
        enabled: dto?.enabled ?? true,
        trigger: def.trigger as unknown as Prisma.InputJsonValue,
        actions: def.actions as unknown as Prisma.InputJsonValue,
        options: (def.options ?? Prisma.DbNull) as Prisma.InputJsonValue,
        ...(hook ? { webhookId: hook.webhookId, webhookSecret: hook.stored } : {}),
      },
    });
    const out = this.toPublicFlow(row);
    // The one time the secret is shown without an explicit reveal: its creation.
    if (hook) out.webhookSecret = hook.secret;
    return out;
  }

  /**
   * Update a flow. Fields left out keep their saved value, so
   * `PATCH { "enabled": false }` or `{ "name": … }` works on its own; a
   * full definition still replaces everything, as before.
   */
  async update(projectId: string, id: string, dto: Partial<FlowDefinitionInput>, userId?: string): Promise<PublicFlow> {
    const existing = await this.getRow(projectId, id, userId);
    if (!dto || typeof dto !== 'object') throw new BadRequestException('a flow definition object is required');
    const storedActions = readStoredActions(existing.actions);
    const data: Prisma.FlowUpdateInput = {};

    if (dto.name !== undefined || dto.trigger !== undefined || dto.actions !== undefined) {
      // Validate the parts that were sent; keep the saved ones as they are so
      // an older flow can be renamed without re-validating its stored actions.
      const def = normalizeDefinition(
        {
          name: dto.name ?? existing.name,
          trigger: dto.trigger ?? { type: 'manual' },
          actions: dto.actions ?? [{ type: 'log', message: 'placeholder' }],
        },
        storedActions,
      );
      if (dto.name !== undefined) data.name = def.name;
      if (dto.trigger !== undefined) data.trigger = normalizeTrigger(dto.trigger) as unknown as Prisma.InputJsonValue;
      if (dto.actions !== undefined) data.actions = def.actions as unknown as Prisma.InputJsonValue;
    }
    if (dto.options !== undefined) {
      data.options = (normalizeOptions(dto.options) ?? Prisma.DbNull) as Prisma.InputJsonValue;
    }
    if (dto.enabled !== undefined) {
      if (typeof dto.enabled !== 'boolean') throw new BadRequestException('enabled must be true or false');
      data.enabled = dto.enabled;
    }

    const nextTrigger = dto.trigger !== undefined ? normalizeTrigger(dto.trigger) : readStoredTrigger(existing.trigger);
    let hook: ReturnType<FlowsService['provisionWebhook']> = null;
    if (nextTrigger.type === 'webhook' && !existing.webhookId) {
      hook = this.provisionWebhook();
      if (hook) {
        data.webhookId = hook.webhookId;
        data.webhookSecret = hook.stored;
      }
    }

    const row = await this.prisma.flow.update({ where: { id }, data });
    const out = this.toPublicFlow(row);
    if (hook) out.webhookSecret = hook.secret;
    return out;
  }

  async setEnabled(projectId: string, id: string, enabled: boolean, userId?: string): Promise<PublicFlow> {
    await this.getRow(projectId, id, userId);
    return this.toPublicFlow(await this.prisma.flow.update({ where: { id }, data: { enabled } }));
  }

  async remove(projectId: string, id: string, userId?: string) {
    await this.getRow(projectId, id, userId);
    await this.prisma.flow.delete({ where: { id } });
    return { deleted: true };
  }

  // ── Webhook URL & secret ──────────────────────────────────────────────────

  /**
   * Issue a new webhook URL and secret (the old ones stop working at once), or
   * set a secret the caller brings — e.g. a Stripe endpoint's signing secret.
   * A generated secret is returned once; a supplied one is not echoed back.
   */
  async rotateWebhook(projectId: string, id: string, body: { secret?: unknown; keepUrl?: unknown } | undefined, userId?: string) {
    const flow = await this.getRow(projectId, id, userId);
    if (readStoredTrigger(flow.trigger).type !== 'webhook') {
      throw new BadRequestException('Only a flow with a webhook trigger has a webhook URL');
    }
    let custom: string | undefined;
    if (body?.secret !== undefined && body.secret !== null && body.secret !== '') {
      const err = webhookSecretError(body.secret);
      if (err) throw new BadRequestException(err);
      custom = body.secret as string;
    }
    const hook = this.provisionWebhook(custom);
    if (!hook) {
      throw new ServiceUnavailableException(
        'Webhook secrets need DB_CRED_ENC_KEY on this installation so they can be stored encrypted. Set it to 32 random bytes (base64 or 64 hex characters) and restart the API.',
      );
    }
    const keepUrl = body?.keepUrl === true && !!flow.webhookId;
    const row = await this.prisma.flow.update({
      where: { id },
      data: { webhookSecret: hook.stored, ...(keepUrl ? {} : { webhookId: hook.webhookId }) },
    });
    return {
      webhookUrl: this.webhookUrlFor(row.webhookId as string),
      ...(custom ? { secretSet: true } : { secret: hook.secret }),
    };
  }

  /** The explicit "reveal" — the only read path that returns the secret. */
  async revealWebhookSecret(projectId: string, id: string, userId?: string) {
    const flow = await this.getRow(projectId, id, userId);
    if (!flow.webhookId || !flow.webhookSecret) {
      throw new NotFoundException('This flow has no webhook secret yet; create one first');
    }
    return { webhookUrl: this.webhookUrlFor(flow.webhookId), secret: decryptField(flow.webhookSecret) as string };
  }

  /**
   * A call to a flow's own webhook URL. No project key is involved: the caller
   * proves the flow's secret (see flow-webhook-auth.ts). Unknown ids and flows
   * that are no longer webhook-triggered answer the same 404.
   */
  async receiveWebhook(
    webhookId: string,
    req: { headers: Record<string, string | string[] | undefined>; rawBody?: Buffer; body?: unknown; query?: Record<string, unknown> },
  ) {
    if (!webhookId || !/^[A-Za-z0-9_-]{16,64}$/.test(webhookId)) throw new NotFoundException('Webhook not found');
    const flow = await this.prisma.flow.findUnique({ where: { webhookId } });
    if (!flow || readStoredTrigger(flow.trigger).type !== 'webhook') throw new NotFoundException('Webhook not found');

    const secret = flow.webhookSecret ? (decryptField(flow.webhookSecret) as string) : '';
    const method = secret ? verifyWebhookRequest(secret, { headers: req.headers, rawBody: req.rawBody }) : null;
    if (!method) {
      throw new UnauthorizedException(
        'Webhook secret missing or wrong: send it as X-Webhook-Secret, Authorization: Bearer, or sign the body (X-Basefyio-Signature: sha256=…)',
      );
    }

    const project = await this.prisma.project.findUnique({ where: { id: flow.projectId }, select: { status: true } });
    if (!project || !(RUNNABLE_PROJECT_STATUSES as readonly string[]).includes(project.status)) {
      throw new NotFoundException('Webhook not found');
    }
    if (!flow.enabled) throw new BadRequestException('Flow is disabled');
    if (!(await this.entitlement.can(flow.projectId, EntitlementKey.FLOWS))) {
      throw new ForbiddenException(`Your plan does not include this feature (${EntitlementKey.FLOWS})`);
    }
    if ((req.rawBody?.length ?? 0) > WEBHOOK_MAX_BODY_BYTES) {
      throw new PayloadTooLargeException(`Webhook payload is larger than ${WEBHOOK_MAX_BODY_BYTES / 1024} KB`);
    }

    const input = req.body && typeof req.body === 'object' && Object.keys(req.body as object).length === 0 && !req.rawBody?.length
      ? null
      : (req.body ?? null);
    const run = await this.createRun(flow, {
      source: 'webhook',
      input,
      meta: {
        headers: safeRequestHeaders(req.headers),
        query: req.query && typeof req.query === 'object' ? req.query : {},
        auth: method,
      },
    });
    return this.queued(run);
  }

  // ── Runs ──────────────────────────────────────────────────────────────────

  /**
   * Runs of a flow, newest first. `limit` (default 50, max 200) and `before`
   * (a run id: return runs older than it) page through the full history.
   */
  async runs(projectId: string, id: string, userId?: string, page: { limit?: unknown; before?: unknown } = {}) {
    await this.getRow(projectId, id, userId);
    const limitRaw = page.limit === undefined ? 50 : Number(page.limit);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, RUNS_PAGE_MAX) : 50;
    let createdBefore: Date | undefined;
    if (typeof page.before === 'string' && page.before) {
      const anchor = await this.prisma.flowRun.findFirst({
        where: { id: page.before, flowId: id, projectId },
        select: { createdAt: true },
      });
      if (!anchor) throw new BadRequestException('before must be the id of a run of this flow');
      createdBefore = anchor.createdAt;
    }
    return this.prisma.flowRun.findMany({
      where: { flowId: id, projectId, ...(createdBefore ? { createdAt: { lt: createdBefore } } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
  }

  async run(projectId: string, flowId: string, runId: string, userId?: string): Promise<FlowRun> {
    await this.getRow(projectId, flowId, userId);
    const run = await this.prisma.flowRun.findFirst({ where: { id: runId, flowId, projectId } });
    if (!run) throw new NotFoundException('Run not found');
    return run;
  }

  async trigger(projectId: string, id: string, input: unknown, userId?: string) {
    const flow = await this.getRow(projectId, id, userId);
    await this.entitlement.assertCan(projectId, EntitlementKey.FLOWS);
    if (!flow.enabled) throw new BadRequestException('Flow is disabled');
    const run = await this.createRun(flow, { source: userId ? 'manual' : 'api', input: input ?? null });
    return this.queued(run);
  }

  /** "Run again": a new run with the same input, linked to the one it repeats. */
  async rerun(projectId: string, flowId: string, runId: string, userId?: string) {
    const flow = await this.getRow(projectId, flowId, userId);
    await this.entitlement.assertCan(projectId, EntitlementKey.FLOWS);
    if (!flow.enabled) throw new BadRequestException('Flow is disabled');
    const previous = await this.prisma.flowRun.findFirst({ where: { id: runId, flowId, projectId } });
    if (!previous) throw new NotFoundException('Run not found');
    const run = await this.createRun(flow, {
      source: 'rerun',
      input: previous.input ?? null,
      retryOfId: previous.id,
      meta: previous.meta ?? undefined,
    });
    return this.queued(run);
  }

  private queued(run: FlowRun | null): { runId: string; status: string } {
    // Only a dedupe key can make createRun return null, and these callers pass none.
    if (!run) throw new ServiceUnavailableException('The run could not be recorded');
    return { runId: run.id, status: run.status };
  }

  /**
   * Record a run and queue it. The queue job is named after the run id, so a
   * second enqueue of the same run is dropped by BullMQ, and it is attempted
   * once: whether a failed step is tried again is the action's `retries`, not
   * the queue's.
   *
   * With a `dedupeKey`, a second run for the same key is refused by the
   * database (unique index) and null is returned.
   */
  async createRun(
    flow: Pick<Flow, 'id' | 'projectId'>,
    opts: {
      source: FlowRunSource;
      input?: unknown;
      meta?: unknown;
      retryOfId?: string;
      dedupeKey?: string;
    },
  ): Promise<FlowRun | null> {
    let run: FlowRun;
    try {
      run = await this.prisma.flowRun.create({
        data: {
          flowId: flow.id,
          projectId: flow.projectId,
          status: 'queued',
          input: (opts.input ?? Prisma.DbNull) as Prisma.InputJsonValue,
          source: opts.source,
          meta: (opts.meta ?? Prisma.DbNull) as Prisma.InputJsonValue,
          retryOfId: opts.retryOfId ?? null,
          dedupeKey: opts.dedupeKey ?? null,
        },
      });
    } catch (e) {
      if (opts.dedupeKey && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return null;
      }
      throw e;
    }
    try {
      await this.queue.add(
        'execute',
        { flowRunId: run.id },
        {
          jobId: run.id,
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: { count: 1000 },
        },
      );
    } catch (e) {
      // Without a queued job the run would sit in "queued" for ever.
      await this.prisma.flowRun.update({
        where: { id: run.id },
        data: { status: 'failed', error: `Could not queue the run: ${errorMessage(e)}`, finishedAt: new Date() },
      });
      throw new ServiceUnavailableException('The flow queue is unavailable; the run was not started');
    }
    return run;
  }

  /**
   * Mark runs a dead worker left in "running" as failed. They are not resumed:
   * the steps that already ran may have had effects, and repeating them is
   * exactly what must not happen silently.
   */
  async failAbandonedRuns(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - (FLOW_LIMITS.maxDurationMs.max + 5 * 60_000));
    const { count } = await this.prisma.flowRun.updateMany({
      where: { status: 'running', startedAt: { lt: cutoff } },
      data: {
        status: 'failed',
        error: 'Interrupted: the worker stopped while this run was in progress. It was not re-run automatically, so no step repeats; use "Run again" if needed.',
        finishedAt: now,
      },
    });
    return count;
  }

  // ── Execution ─────────────────────────────────────────────────────────────

  private publicApi(): PublicApiService | null {
    if (this.publicApiRef === undefined) {
      try {
        this.publicApiRef = this.moduleRef.get(PublicApiService, { strict: false });
      } catch {
        this.publicApiRef = null;
      }
    }
    return this.publicApiRef;
  }

  /** Executes a queued run's actions in order. Called by the FLOW_QUEUE worker. */
  async execute(flowRunId: string): Promise<void> {
    const startedAt = new Date();
    // Claim the run: only a queued run starts. A run already "running" was
    // picked up by a worker that died mid-way — its steps are not started again.
    const claimed = await this.prisma.flowRun.updateMany({
      where: { id: flowRunId, status: 'queued' },
      data: { status: 'running', startedAt },
    });
    const run = await this.prisma.flowRun.findUnique({
      where: { id: flowRunId },
      include: { flow: true },
    });
    if (!run) return;
    if (claimed.count === 0) {
      if (run.status === 'running') {
        await this.prisma.flowRun.updateMany({
          where: { id: run.id, status: 'running' },
          data: {
            status: 'failed',
            error: 'Interrupted: the worker stopped while this run was in progress. It was not re-run automatically, so no step repeats; use "Run again" if needed.',
            finishedAt: new Date(),
          },
        });
      }
      return;
    }

    const actions = readStoredActions(run.flow.actions);
    const options = readStoredOptions(run.flow.options);
    const deadline = startedAt.getTime() + runDeadlineMs(options);
    const meta = (run.meta && typeof run.meta === 'object' ? run.meta : {}) as Record<string, unknown>;
    const steps: Record<string, unknown> = {};
    const ctx: TemplateContext = {
      input: run.input ?? null,
      steps,
      trigger: { type: run.source ?? 'api', ...meta },
      run: { id: run.id, startedAt: startedAt.toISOString(), source: run.source ?? null },
      flow: { id: run.flow.id, name: run.flow.name },
      now: startedAt.toISOString(),
    };
    const results: FlowStepResult[] = [];
    let failure: string | null = null;

    try {
      for (let i = 0; i < actions.length; i++) {
        const action = actions[i];
        if (Date.now() >= deadline) {
          failure = `Run exceeded its time limit (${Math.round(runDeadlineMs(options) / 1000)}s) before step ${i + 1}`;
          break;
        }
        const { result, output } = await this.runStep(action, i, options, ctx, deadline, run.projectId);
        results.push(result);
        steps[String(i)] = output;
        if (action.name) steps[action.name] = output;
        if (!result.ok) {
          if (action.continueOnError) {
            result.continued = true;
          } else {
            failure = `Step ${i + 1} (${action.name || action.type}) failed: ${result.detail || 'unknown error'}`;
            break;
          }
        }
        // Progress is visible while the run is still going.
        if (i < actions.length - 1) {
          await this.prisma.flowRun.update({
            where: { id: run.id },
            data: { result: results as unknown as Prisma.InputJsonValue },
          });
        }
      }
    } catch (e) {
      failure = `Run failed: ${errorMessage(e)}`;
    }

    await this.prisma.flowRun.update({
      where: { id: run.id },
      data: {
        status: failure ? 'failed' : 'success',
        result: results as unknown as Prisma.InputJsonValue,
        error: failure ? failure.slice(0, 500) : null,
        finishedAt: new Date(),
      },
    });
    if (failure) this.logger.warn(`flow run ${run.id} failed: ${failure}`);
  }

  /** One step, with its own retries. Earlier steps are never repeated. */
  private async runStep(
    action: FlowAction,
    index: number,
    options: FlowOptions,
    ctx: TemplateContext,
    deadline: number,
    projectId: string,
  ): Promise<{ result: FlowStepResult; output: Record<string, unknown> }> {
    const limits = stepLimits(action, options);
    const started = Date.now();
    const attemptLog: FlowStepAttempt[] = [];
    let outcome: StepOutcome | null = null;
    let warnings: string[] = [];

    for (let attempt = 1; attempt <= limits.retries + 1; attempt++) {
      const t0 = Date.now();
      const timeoutMs = Math.max(1, Math.min(limits.timeoutMs, deadline - t0));
      const r = await this.runActionOnce(action, ctx, timeoutMs, projectId);
      warnings = r.warnings;
      outcome = r.outcome;
      attemptLog.push({
        attempt,
        ok: outcome.ok,
        status: outcome.status,
        detail: outcome.ok ? undefined : outcome.detail,
        durationMs: Date.now() - t0,
      });
      if (outcome.ok || !outcome.retryable || attempt > limits.retries) break;
      const wait = Math.min(limits.retryDelayMs * 2 ** (attempt - 1), 60_000);
      if (Date.now() + wait >= deadline) break;
      await sleep(wait);
    }

    const finished = Date.now();
    const o = outcome as StepOutcome;
    const result: FlowStepResult = {
      index,
      ...(action.name ? { name: action.name } : {}),
      type: action.type,
      ok: o.ok,
      ...(o.status !== undefined ? { status: o.status } : {}),
      ...(o.detail !== undefined ? { detail: o.detail } : {}),
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(finished).toISOString(),
      durationMs: finished - started,
      attempts: attemptLog.length,
      ...(attemptLog.length > 1 ? { attemptLog } : {}),
      ...o.stored,
      ...(warnings.length ? { warnings: [...new Set(warnings)].map((w) => `{{${w}}} resolved to nothing`) } : {}),
    };
    return { result, output: o.output };
  }

  private async runActionOnce(
    action: FlowAction,
    ctx: TemplateContext,
    timeoutMs: number,
    projectId: string,
  ): Promise<{ outcome: StepOutcome; warnings: string[] }> {
    const warnings: string[] = [];
    const text = (s: string | undefined, mode: 'text' | 'url' | 'header' = 'text') => {
      const r = renderString(s ?? '', ctx, mode);
      warnings.push(...r.missing);
      return r.value;
    };
    const value = (v: unknown) => {
      const r = renderValue(v, ctx);
      warnings.push(...r.missing);
      return r.value;
    };

    try {
      if (action.type === 'log') {
        const message = text(action.message).slice(0, 2000);
        this.logger.debug(`[flow] ${message.slice(0, 200)}`);
        return {
          warnings,
          outcome: { ok: true, retryable: false, detail: message, output: { ok: true, message }, stored: {} },
        };
      }

      if (action.type === 'http.request') {
        if (!action.url) {
          return { warnings, outcome: { ok: false, retryable: false, detail: 'missing url', output: { ok: false }, stored: {} } };
        }
        const method = (action.method || 'POST').toUpperCase();
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) {
          return {
            warnings,
            outcome: {
              ok: false,
              retryable: false,
              detail: `method ${method} is not supported; edit the flow to use GET, POST, PUT, PATCH, DELETE or HEAD`,
              output: { ok: false },
              stored: {},
            },
          };
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(action.headers ?? {})) headers[k] = text(v, 'header');
        const body = typeof action.body === 'string' ? text(action.body) : value(action.body);
        const res = await performHttpRequest({
          method: method as any,
          url: text(action.url, 'url'),
          headers,
          body: method === 'GET' || method === 'HEAD' ? undefined : body,
          timeoutMs,
          followRedirects: action.followRedirects,
        });
        const stored = truncateForStorage(res.body);
        const retryable =
          !res.ok &&
          (res.status === undefined
            ? !/refused|not allowed|invalid url|could not be resolved|only http/i.test(res.error ?? '')
            : res.status >= 500 || res.status === 408 || res.status === 429);
        return {
          warnings,
          outcome: {
            ok: res.ok,
            retryable,
            status: res.status,
            detail: res.error,
            output: { ok: res.ok, status: res.status ?? null, headers: res.headers, body: res.body },
            stored: {
              response: {
                headers: res.headers,
                body: stored.value,
                truncated: res.truncated || stored.truncated,
                redirects: res.redirects,
              },
            },
          },
        };
      }

      if (action.type === 'db.select' || action.type === 'db.insert' || action.type === 'db.update') {
        const api = this.publicApi();
        if (!api) {
          return { warnings, outcome: { ok: false, retryable: false, detail: 'database actions are not available', output: { ok: false }, stored: {} } };
        }
        const table = action.table as string;
        const filters: Record<string, string> = {};
        for (const [k, v] of Object.entries(action.filters ?? {})) filters[k] = text(v);
        const ctxRole = { role: 'service_role' as const };
        const work = async (): Promise<unknown[]> => {
          if (action.type === 'db.select') {
            const query: Record<string, string> = { ...filters, limit: String(action.limit ?? 100) };
            if (action.select) query.select = action.select;
            const res = (await api.select(projectId, table, query, ctxRole)) as { data?: unknown[] };
            return Array.isArray(res?.data) ? res.data : [];
          }
          if (action.type === 'db.insert') {
            return (await api.insert(projectId, table, value(action.values) as any, true, ctxRole)) as unknown[];
          }
          return (await api.update(projectId, table, filters, value(action.values) as any, true, ctxRole)) as unknown[];
        };
        let timer: NodeJS.Timeout | undefined;
        const rows = await Promise.race([
          work(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(timeoutMs / 100) / 10}s`)), timeoutMs);
          }),
        ]).finally(() => clearTimeout(timer));
        const list = Array.isArray(rows) ? rows : [];
        return {
          warnings,
          outcome: {
            ok: true,
            retryable: false,
            output: { ok: true, rows: list, rowCount: list.length, row: list[0] ?? null },
            stored: { rows: list.slice(0, STORED_ROWS), rowCount: list.length },
          },
        };
      }

      return {
        warnings,
        outcome: { ok: false, retryable: false, detail: `unknown action type ${String(action.type)}`, output: { ok: false }, stored: {} },
      };
    } catch (e) {
      const status = (e as any)?.getStatus?.();
      const msg = errorMessage(e);
      return {
        warnings,
        outcome: {
          ok: false,
          // 4xx-type errors (bad table, policy denial, bad filter) will not fix themselves.
          retryable: !(typeof status === 'number' && status < 500),
          detail: msg,
          output: { ok: false, error: msg },
          stored: {},
        },
      };
    }
  }
}
