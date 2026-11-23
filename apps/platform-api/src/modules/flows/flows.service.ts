import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import axios from 'axios';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { EntitlementService } from '../entitlement/entitlement.service';
import { EntitlementKey } from '../entitlement/entitlement-key';
import { FLOW_QUEUE } from '../queue/queue.module';
import {
  FlowAction,
  FlowDefinitionInput,
  FlowStepResult,
} from './flow.types';
import { assertSafeUrl } from './flow-url-guard';

/**
 * Header keys that may carry secrets. Matched case-insensitively.
 * Values are replaced with "***" in read responses so callers cannot
 * exfiltrate secrets they set when creating/updating a flow.
 */
const SENSITIVE_HEADER_PATTERNS = [
  /^authorization$/i,
  /^x-api-key$/i,
  /^x-auth-token$/i,
  /^x-secret$/i,
  /^x-webhook-secret$/i,
  /^proxy-authorization$/i,
];

function maskHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return headers;
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    masked[k] = SENSITIVE_HEADER_PATTERNS.some(re => re.test(k)) ? '***' : v;
  }
  return masked;
}

/** Mask sensitive headers in every action of a flow's actions array. */
function maskFlowActions(actions: FlowAction[]): FlowAction[] {
  return actions.map(a => ({
    ...a,
    headers: a.type === 'http.request' ? maskHeaders(a.headers) : a.headers,
  }));
}

/** Strip the webhookSecret from a flow record before sending to the caller. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sanitizeFlow(flow: any) {
  if (!flow) return flow;
  const { webhookSecret: _secret, actions, ...rest } = flow;
  return {
    ...rest,
    // Expose a stable boolean so the UI knows whether a webhook secret is configured.
    webhookSecretConfigured: !!_secret,
    actions: Array.isArray(actions) ? maskFlowActions(actions as FlowAction[]) : actions,
  };
}

/** Generate a cryptographically random 32-byte hex webhook secret. */
function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Verify an HMAC-SHA256 signature supplied in the `x-basefyio-signature` header.
 * The expected signature is `sha256=<hex>` over the raw request body.
 * Returns true when the signature matches, false otherwise.
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: Buffer,
  signature: string,
): boolean {
  if (!signature?.startsWith('sha256=')) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(signature, 'utf8'));
  } catch {
    return false;
  }
}

// cron-parser is a CommonJS module; require() avoids esModuleInterop issues.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseExpression: cronParseExpression } = require('cron-parser') as typeof import('cron-parser');

/** Parse and validate a 5-field cron expression. Returns the interval object. */
function parseCron(expr: string) {
  try {
    return cronParseExpression(expr, { iterator: false });
  } catch {
    throw new BadRequestException(`Invalid cron expression: "${expr}"`);
  }
}

const TRIGGER_TYPES = ['manual', 'webhook', 'schedule'];
const ACTION_TYPES = ['log', 'http.request'];
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * Keeps only the fields each trigger and action type uses (#23): an action
 * switched from log to http.request no longer carries its old message, an
 * http.request without a method is a POST, and a schedule keeps only its cron.
 */
export function normalizeFlowDefinition(dto: FlowDefinitionInput): FlowDefinitionInput {
  const t = dto.trigger;
  const trigger =
    t.type === 'schedule'
      ? { type: t.type, cron: t.cron!.trim() }
      : { type: t.type };
  const actions = dto.actions.map((a) => {
    if (a.type === 'log') return { type: 'log', message: String(a.message).trim() };
    const method = typeof a.method === 'string' ? a.method.toUpperCase() : 'POST';
    return {
      type: 'http.request',
      method,
      url: String(a.url).trim(),
      ...(a.headers && typeof a.headers === 'object' ? { headers: a.headers } : {}),
      ...(a.body !== undefined ? { body: a.body } : {}),
      ...(a.continueOnError ? { continueOnError: true } : {}),
    };
  });
  return { ...dto, name: dto.name.trim(), trigger, actions } as FlowDefinitionInput;
}

/**
 * Project automation flows: a trigger plus an ordered list of actions, executed
 * asynchronously on the BullMQ FLOW_QUEUE. Re-implemented from the askin "flows"
 * concept following our own patterns (no code copied).
 */
@Injectable()
export class FlowsService {
  private readonly logger = new Logger(FlowsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(FLOW_QUEUE) private readonly queue: Queue,
    private readonly projects: ProjectsService,
    private readonly entitlement: EntitlementService,
  ) {}

  private async assertProject(projectId: string, userId?: string): Promise<void> {
    // Throws if the project is missing or the user has no access.
    await this.projects.findOne(projectId, userId);
  }

  private async validate(dto: FlowDefinitionInput): Promise<void> {
    if (!dto?.name?.trim()) throw new BadRequestException('name is required');
    if (!dto.trigger || !TRIGGER_TYPES.includes(dto.trigger.type)) {
      throw new BadRequestException(`trigger.type must be one of ${TRIGGER_TYPES.join(', ')}`);
    }
    if (dto.trigger.type === 'schedule') {
      if (!dto.trigger.cron?.trim()) {
        throw new BadRequestException('trigger.cron is required for schedule triggers');
      }
      parseCron(dto.trigger.cron.trim()); // throws BadRequestException on bad expression
    }
    if (!Array.isArray(dto.actions) || dto.actions.length === 0) {
      throw new BadRequestException('at least one action is required');
    }
    for (const a of dto.actions) {
      if (!a || !ACTION_TYPES.includes(a.type)) {
        throw new BadRequestException(`action.type must be one of ${ACTION_TYPES.join(', ')}`);
      }
      if (a.type === 'log' && !(typeof a.message === 'string' && a.message.trim())) {
        throw new BadRequestException('A log action needs a message');
      }
      if (a.type === 'http.request') {
        if (!a.url) throw new BadRequestException('http.request action requires a url');
        if (a.method !== undefined && !HTTP_METHODS.includes(String(a.method).toUpperCase())) {
          throw new BadRequestException(`http.request method must be one of ${HTTP_METHODS.join(', ')}`);
        }
        await assertSafeUrl(a.url);
      }
    }
  }

  /**
   * Compute the next fire time for a schedule flow after `after` (default: now).
   * Returns null if the trigger is not a schedule type.
   */
  computeNextRunAt(trigger: FlowDefinitionInput['trigger'], after?: Date): Date | null {
    if (trigger.type !== 'schedule' || !trigger.cron?.trim()) return null;
    const interval = parseCron(trigger.cron.trim());
    if (after) {
      // advance the cursor past `after`
      interval.reset(after);
    }
    return interval.next().toDate();
  }

  async list(projectId: string, userId?: string) {
    await this.assertProject(projectId, userId);
    const flows = await this.prisma.flow.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    return flows.map(sanitizeFlow);
  }

  async get(projectId: string, id: string, userId?: string) {
    await this.assertProject(projectId, userId);
    const flow = await this.prisma.flow.findFirst({ where: { id, projectId } });
    if (!flow) throw new NotFoundException('Flow not found');
    return sanitizeFlow(flow);
  }

  /** Internal get — returns the raw record including webhookSecret. Used by the webhook handler. */
  async getRaw(projectId: string, id: string) {
    const flow = await this.prisma.flow.findFirst({ where: { id, projectId } });
    if (!flow) throw new NotFoundException('Flow not found');
    return flow;
  }

  async create(projectId: string, input: FlowDefinitionInput, userId?: string) {
    await this.assertProject(projectId, userId);
    await this.entitlement.assertCan(projectId, EntitlementKey.FLOWS);
    await this.validate(input);
    const dto = normalizeFlowDefinition(input);
    const enabled = dto.enabled ?? true;
    const nextRunAt = enabled ? this.computeNextRunAt(dto.trigger) : null;
    // Auto-assign a webhook secret for webhook-triggered flows.
    const webhookSecret = dto.trigger.type === 'webhook' ? generateWebhookSecret() : null;
    const created = await this.prisma.flow.create({
      data: {
        projectId,
        name: dto.name.trim(),
        enabled,
        trigger: dto.trigger as unknown as Prisma.InputJsonValue,
        actions: dto.actions as unknown as Prisma.InputJsonValue,
        nextRunAt,
        webhookSecret,
      },
    });
    // Return the secret once at creation time so the user can record it.
    if (webhookSecret) {
      return { ...sanitizeFlow(created), webhookSecret };
    }
    return sanitizeFlow(created);
  }

  async update(projectId: string, id: string, input: FlowDefinitionInput, userId?: string) {
    // assertProject first so an unauthorized caller cannot infer whether the flow exists.
    await this.assertProject(projectId, userId);
    // getRaw so we can carry the existing secret forward when trigger type stays webhook.
    const existing = await this.getRaw(projectId, id);
    await this.validate(input);
    const dto = normalizeFlowDefinition(input);
    const enabled = dto.enabled ?? true;
    const nextRunAt = enabled ? this.computeNextRunAt(dto.trigger) : null;
    // Preserve the existing webhook secret if the trigger stays webhook; generate
    // a new one if it was not webhook before but is now; clear it if no longer webhook.
    let webhookSecret: string | null = existing.webhookSecret ?? null;
    let newSecret = false;
    if (dto.trigger.type !== 'webhook') {
      webhookSecret = null;
    } else if (!webhookSecret) {
      webhookSecret = generateWebhookSecret();
      newSecret = true;
    }
    const updated = await this.prisma.flow.update({
      where: { id },
      data: {
        name: dto.name.trim(),
        enabled,
        trigger: dto.trigger as unknown as Prisma.InputJsonValue,
        actions: dto.actions as unknown as Prisma.InputJsonValue,
        nextRunAt,
        webhookSecret,
      },
    });
    // A flow that just became a webhook flow shows its new secret once, as on create.
    return newSecret ? { ...sanitizeFlow(updated), webhookSecret } : sanitizeFlow(updated);
  }

  /** Rotate the webhook secret for a webhook-triggered flow. Returns the new secret. */
  async rotateWebhookSecret(projectId: string, id: string, userId?: string) {
    const flow = await this.getRaw(projectId, id);
    // Confirm user has access to this project
    await this.assertProject(projectId, userId);
    if ((flow.trigger as unknown as FlowDefinitionInput['trigger']).type !== 'webhook') {
      throw new BadRequestException('Flow is not a webhook-triggered flow');
    }
    const webhookSecret = generateWebhookSecret();
    await this.prisma.flow.update({ where: { id }, data: { webhookSecret } });
    return { webhookSecret };
  }

  async setEnabled(projectId: string, id: string, enabled: boolean, userId?: string) {
    const flow = await this.getRaw(projectId, id);
    await this.assertProject(projectId, userId);
    const trigger = flow.trigger as unknown as FlowDefinitionInput['trigger'];
    // When re-enabling a schedule flow, set the next run time from now so it
    // doesn't immediately fire for every missed minute while it was disabled.
    const nextRunAt = enabled ? this.computeNextRunAt(trigger) : null;
    // Sanitized: the raw record carries the webhook secret, which is shown only once.
    return sanitizeFlow(await this.prisma.flow.update({ where: { id }, data: { enabled, nextRunAt } }));
  }

  async remove(projectId: string, id: string, userId?: string) {
    await this.get(projectId, id, userId);
    await this.prisma.flow.delete({ where: { id } });
    return { deleted: true };
  }

  async runs(projectId: string, id: string, userId?: string) {
    await this.get(projectId, id, userId);
    return this.prisma.flowRun.findMany({
      where: { flowId: id, projectId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async trigger(projectId: string, id: string, input: unknown, userId?: string) {
    const flow = await this.getRaw(projectId, id);
    await this.assertProject(projectId, userId);
    await this.entitlement.assertCan(projectId, EntitlementKey.FLOWS);
    if (!flow.enabled) throw new BadRequestException('Flow is disabled');
    return this.enqueue(flow.id, projectId, input);
  }

  /**
   * Trigger a webhook-type flow from an external caller.
   * Validates the HMAC-SHA256 signature and fires the flow.
   * No user auth — authentication is the per-flow HMAC secret.
   */
  async triggerViaWebhook(
    flowId: string,
    rawBody: Buffer,
    signature: string,
    input: unknown,
  ) {
    // Look up the flow by ID alone; we don't require a projectId in the URL so the
    // caller only needs the flow ID and the secret — not the project ID.
    const flow = await this.prisma.flow.findUnique({ where: { id: flowId } });
    if (!flow) throw new NotFoundException('Flow not found');
    if (!flow.enabled) throw new BadRequestException('Flow is disabled');
    const trigger = flow.trigger as unknown as FlowDefinitionInput['trigger'];
    if (trigger.type !== 'webhook') {
      throw new BadRequestException('Flow is not a webhook-triggered flow');
    }
    if (!flow.webhookSecret) {
      // Should never happen for webhook flows, but guard defensively.
      throw new BadRequestException('Webhook secret not configured');
    }
    if (!verifyWebhookSignature(flow.webhookSecret, rawBody, signature)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    await this.entitlement.assertCan(flow.projectId, EntitlementKey.FLOWS);
    return this.enqueue(flow.id, flow.projectId, input);
  }

  /**
   * Internal trigger called by the scheduler; no user auth check, no entitlement
   * re-check (the scheduler only acts on existing enabled flows).
   * Updates nextRunAt to the next occurrence after firing.
   */
  async triggerScheduled(flowId: string, projectId: string, cron: string): Promise<string> {
    const nextRunAt = this.computeNextRunAt({ type: 'schedule', cron }, new Date());
    await this.prisma.flow.update({ where: { id: flowId }, data: { nextRunAt } });
    const { runId } = await this.enqueue(flowId, projectId, null);
    return runId;
  }

  private async enqueue(flowId: string, projectId: string, input: unknown) {
    const run = await this.prisma.flowRun.create({
      data: {
        flowId,
        projectId,
        status: 'queued',
        input: (input ?? null) as Prisma.InputJsonValue,
      },
    });
    await this.queue.add(
      'execute',
      { flowRunId: run.id },
      {
        // Allow one automatic retry on transient failures (network, DB blip).
        // The retry re-runs all actions; flows with side-effectful HTTP steps
        // should set continueOnError appropriately.
        attempts: 2,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
    return { runId: run.id, status: run.status };
  }

  /**
   * Executes a queued run's actions in order. Called by the FLOW_QUEUE worker.
   *
   * `attemptNumber` is the BullMQ 1-based attempt counter (1 = first try,
   * 2 = first retry, …). Retries re-run all actions from scratch because flows
   * are designed to be retriable: a failed HTTP call with no side-effect already
   * recorded in `result` is safe to retry. The attempt counter is stored so the
   * UI can show "attempt 2 of 2" instead of silently overwriting the first try.
   */
  async execute(flowRunId: string, attemptNumber = 1): Promise<void> {
    const run = await this.prisma.flowRun.findUnique({
      where: { id: flowRunId },
      include: { flow: true },
    });
    if (!run) return;

    // On the first attempt set startedAt; on retries preserve the original
    // startedAt so the UI shows when the run first began.
    await this.prisma.flowRun.update({
      where: { id: run.id },
      data: {
        status: 'running',
        attempt: attemptNumber,
        ...(run.startedAt == null ? { startedAt: new Date() } : {}),
        // Clear a previous error/result so a successful retry shows clean state.
        error: null,
        result: Prisma.DbNull,
        finishedAt: null,
      },
    });

    const actions = (run.flow.actions as unknown as FlowAction[]) ?? [];
    const results: FlowStepResult[] = [];
    try {
      for (const action of actions) {
        const r = await this.runAction(action);
        results.push(r);
        if (!r.ok && !action.continueOnError) {
          throw new Error(r.detail || `action ${action.type} failed`);
        }
      }
      await this.prisma.flowRun.update({
        where: { id: run.id },
        data: {
          status: 'success',
          result: results as unknown as Prisma.InputJsonValue,
          finishedAt: new Date(),
        },
      });
    } catch (e) {
      await this.prisma.flowRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          result: results as unknown as Prisma.InputJsonValue,
          error: (e instanceof Error ? e.message : String(e)).slice(0, 500),
          finishedAt: new Date(),
        },
      });
      throw e; // surface to BullMQ so retry policy applies
    }
  }

  private async runAction(action: FlowAction): Promise<FlowStepResult> {
    if (action.type === 'log') {
      this.logger.log(`[flow] ${action.message ?? ''}`);
      return { type: 'log', ok: true, detail: action.message };
    }
    if (action.type === 'http.request') {
      if (!action.url) return { type: 'http.request', ok: false, detail: 'missing url' };
      await assertSafeUrl(action.url);
      try {
        const res = await axios.request({
          method: action.method || 'POST',
          url: action.url,
          headers: action.headers,
          data: action.body,
          timeout: 10_000,
          // Do NOT follow redirects: a 3xx to a private/loopback host would
          // bypass the SSRF guard that only validated the original URL.
          maxRedirects: 0,
          validateStatus: () => true,
        });
        return { type: 'http.request', ok: res.status < 400, status: res.status };
      } catch (e) {
        return {
          type: 'http.request',
          ok: false,
          detail: (e instanceof Error ? e.message : String(e)).slice(0, 200),
        };
      }
    }
    return { type: action.type, ok: false, detail: 'unknown action type' };
  }
}
