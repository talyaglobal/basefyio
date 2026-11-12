import { BadRequestException, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHmac } from 'crypto';

jest.mock('./flow-http', () => ({ performHttpRequest: jest.fn() }));
jest.mock('../projects/projects.service', () => ({ ProjectsService: class {} }));
jest.mock('../projects/public-api.service', () => ({ PublicApiService: class {} }));
import { performHttpRequest } from './flow-http';
import { FlowsService } from './flows.service';
import { MASKED_VALUE } from './flow-definition';
import { PublicApiService } from '../projects/public-api.service';

// Webhook secrets are stored encrypted; the helpers need a key.
process.env.DB_CRED_ENC_KEY = 'a'.repeat(64);

const http = performHttpRequest as jest.MockedFunction<typeof performHttpRequest>;
const httpOk = (body: unknown = null, status = 200) => ({
  ok: status < 400,
  status,
  headers: {},
  body,
  truncated: false,
  redirects: [],
  durationMs: 5,
  error: status >= 400 ? `HTTP ${status}` : undefined,
});

function flowRow(over: Record<string, any> = {}) {
  return {
    id: 'f1',
    projectId: 'p1',
    name: 'demo',
    enabled: true,
    trigger: { type: 'manual' },
    actions: [{ type: 'log', message: 'hi' }],
    options: null,
    webhookId: null,
    webhookSecret: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...over,
  };
}

function build(opts: { flow?: Record<string, any>; run?: Record<string, any>; claimed?: number } = {}) {
  const flow = flowRow(opts.flow);
  const runUpdates: any[] = [];
  const prisma = {
    flow: {
      findFirst: jest.fn().mockResolvedValue(flow),
      findMany: jest.fn().mockResolvedValue([flow]),
      findUnique: jest.fn().mockResolvedValue(flow),
      create: jest.fn().mockImplementation(async ({ data }: any) => flowRow({ ...data })),
      update: jest.fn().mockImplementation(async ({ data }: any) => flowRow({ ...flow, ...data })),
      delete: jest.fn(),
    },
    flowRun: {
      create: jest.fn().mockImplementation(async ({ data }: any) => ({ id: 'run-1', ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: opts.claimed ?? 1 }),
      findUnique: jest.fn().mockResolvedValue({
        id: 'run-1',
        flowId: flow.id,
        projectId: flow.projectId,
        status: 'running',
        input: null,
        meta: null,
        source: 'manual',
        flow,
        ...opts.run,
      }),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockImplementation(async (args: any) => {
        runUpdates.push(args.data);
        return {};
      }),
    },
    project: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }) },
  };
  const queue = { add: jest.fn().mockResolvedValue({}) };
  const projects = { findOne: jest.fn().mockResolvedValue({}) };
  const entitlement = { assertCan: jest.fn().mockResolvedValue(undefined), can: jest.fn().mockResolvedValue(true) };
  const config = { get: jest.fn().mockReturnValue('https://api.example.com') };
  const publicApi = {
    insert: jest.fn().mockResolvedValue([{ id: 1 }]),
    select: jest.fn().mockResolvedValue({ data: [{ id: 1 }], count: 1 }),
    update: jest.fn().mockResolvedValue([{ id: 1 }]),
  };
  const moduleRef = {
    get: jest.fn((token: unknown) => {
      if (token === PublicApiService) return publicApi;
      throw new Error('unknown');
    }),
  };
  const svc = new FlowsService(
    prisma as any,
    queue as any,
    projects as any,
    entitlement as any,
    config as any,
    moduleRef as any,
  );
  const finalUpdate = () => runUpdates[runUpdates.length - 1];
  return { svc, prisma, queue, entitlement, publicApi, runUpdates, finalUpdate, flow };
}

describe('FlowsService', () => {
  beforeEach(() => {
    http.mockReset();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('execute', () => {
    it('records a failed run once and does not throw, so the queue never re-runs it from the start', async () => {
      http.mockResolvedValue(httpOk(null, 500) as any);
      const { svc, finalUpdate } = build({
        flow: {
          actions: [
            { type: 'log', message: 'before' },
            { type: 'http.request', method: 'GET', url: 'https://httpbin.org/status/500' },
          ],
        },
      });
      await expect(svc.execute('run-1')).resolves.toBeUndefined();
      expect(http).toHaveBeenCalledTimes(1);
      const final = finalUpdate();
      expect(final.status).toBe('failed');
      expect(final.error).toContain('Step 2 (http.request) failed: HTTP 500');
      expect(final.result).toHaveLength(2);
      expect(final.result[1]).toMatchObject({ ok: false, status: 500, attempts: 1 });
    });

    it('queues runs with a single attempt and the run id as job id', async () => {
      const { svc, queue } = build();
      await svc.trigger('p1', 'f1', { a: 1 }, 'user-1');
      expect(queue.add).toHaveBeenCalledWith(
        'execute',
        { flowRunId: 'run-1' },
        expect.objectContaining({ jobId: 'run-1', attempts: 1 }),
      );
    });

    it('retries only the failing step when the action asks for it, and records every attempt', async () => {
      http
        .mockResolvedValueOnce(httpOk(null, 503) as any)
        .mockResolvedValueOnce(httpOk({ ok: 1 }, 200) as any);
      const { svc, finalUpdate } = build({
        flow: {
          actions: [
            { type: 'log', message: 'before' },
            { type: 'http.request', method: 'GET', url: 'https://x.io', retries: 2, retryDelayMs: 0 },
          ],
        },
      });
      await svc.execute('run-1');
      const final = finalUpdate();
      expect(final.status).toBe('success');
      expect(http).toHaveBeenCalledTimes(2);
      expect(final.result[0]).toMatchObject({ type: 'log', attempts: 1 });
      expect(final.result[1].attempts).toBe(2);
      expect(final.result[1].attemptLog.map((a: any) => a.status)).toEqual([503, 200]);
    });

    it('does not retry a 4xx that will not fix itself', async () => {
      http.mockResolvedValue(httpOk(null, 404) as any);
      const { svc } = build({
        flow: { actions: [{ type: 'http.request', method: 'GET', url: 'https://x.io', retries: 3, retryDelayMs: 0 }] },
      });
      await svc.execute('run-1');
      expect(http).toHaveBeenCalledTimes(1);
    });

    it('feeds the input and earlier step outputs into later steps', async () => {
      http.mockResolvedValueOnce(httpOk({ id: 42 }) as any).mockResolvedValueOnce(httpOk() as any);
      const { svc, finalUpdate } = build({
        run: { input: { customer: 'ACME Ltd' } },
        flow: {
          actions: [
            { type: 'http.request', name: 'create', method: 'POST', url: 'https://x.io/orders', body: { who: '{{input.customer}}' } },
            { type: 'http.request', method: 'POST', url: 'https://x.io/orders/{{steps.create.body.id}}/notify?c={{input.customer}}', body: { id: '{{steps.0.body.id}}' } },
            { type: 'log', message: 'done {{steps.1.status}} {{input.nope}}' },
          ],
        },
      });
      await svc.execute('run-1');
      expect(http.mock.calls[0][0]).toMatchObject({ body: { who: 'ACME Ltd' } });
      expect(http.mock.calls[1][0]).toMatchObject({
        url: 'https://x.io/orders/42/notify?c=ACME%20Ltd',
        body: { id: 42 },
      });
      const final = finalUpdate();
      expect(final.result[2]).toMatchObject({ detail: 'done 200 ', warnings: ['{{input.nope}} resolved to nothing'] });
    });

    it('continues past a failing step marked continueOnError', async () => {
      http.mockResolvedValue(httpOk(null, 500) as any);
      const { svc, finalUpdate } = build({
        flow: {
          actions: [
            { type: 'http.request', method: 'GET', url: 'https://x.io', continueOnError: true },
            { type: 'log', message: 'after' },
          ],
        },
      });
      await svc.execute('run-1');
      expect(finalUpdate().status).toBe('success');
      expect(finalUpdate().result[0]).toMatchObject({ ok: false, continued: true });
    });

    it('does not start the steps of a run a dead worker left running; it marks it interrupted', async () => {
      const { svc, prisma } = build({ claimed: 0, run: { status: 'running' } });
      await svc.execute('run-1');
      expect(http).not.toHaveBeenCalled();
      expect(prisma.flowRun.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: { id: 'run-1', status: 'running' },
          data: expect.objectContaining({ status: 'failed', error: expect.stringContaining('Interrupted') }),
        }),
      );
    });

    it('ignores a run that already finished', async () => {
      const { svc, prisma } = build({ claimed: 0, run: { status: 'success' } });
      await svc.execute('run-1');
      expect(prisma.flowRun.update).not.toHaveBeenCalled();
    });

    it('runs data actions with the service role and templated values', async () => {
      const { svc, publicApi, finalUpdate } = build({
        run: { input: { email: 'a@b.co', id: 7 } },
        flow: {
          actions: [
            { type: 'db.insert', table: 'leads', values: { email: '{{input.email}}' } },
            { type: 'db.update', table: 'leads', filters: { id: 'eq.{{input.id}}' }, values: { seen: true } },
            { type: 'db.select', table: 'leads', filters: { id: 'eq.{{steps.0.row.id}}' }, limit: 5 },
          ],
        },
      });
      await svc.execute('run-1');
      expect(publicApi.insert).toHaveBeenCalledWith('p1', 'leads', { email: 'a@b.co' }, true, { role: 'service_role' });
      expect(publicApi.update).toHaveBeenCalledWith('p1', 'leads', { id: 'eq.7' }, { seen: true }, true, { role: 'service_role' });
      expect(publicApi.select).toHaveBeenCalledWith('p1', 'leads', { id: 'eq.1', limit: '5' }, { role: 'service_role' });
      expect(finalUpdate().status).toBe('success');
      expect(finalUpdate().result[2]).toMatchObject({ rowCount: 1, rows: [{ id: 1 }] });
    });

    it('keeps running a legacy http.request (no method) as the POST it always was', async () => {
      http.mockResolvedValue(httpOk() as any);
      const { svc } = build({
        flow: { actions: [{ url: 'https://x.io', type: 'http.request', message: 'Hello from flow' }] },
      });
      await svc.execute('run-1');
      expect(http.mock.calls[0][0]).toMatchObject({ method: 'POST', url: 'https://x.io' });
    });
  });

  describe('definitions', () => {
    it('refuses a schedule trigger without a cron (it could never run)', async () => {
      const { svc } = build();
      await expect(
        svc.create('p1', { name: 'x', trigger: { type: 'schedule' }, actions: [{ type: 'log', message: 'x' }] } as any, 'u'),
      ).rejects.toThrow(BadRequestException);
    });

    it('reports the next tick of a schedule flow', () => {
      const { svc } = build();
      const out = svc.toPublicFlow(
        flowRow({ trigger: { type: 'schedule', cron: '*/15 * * * *' } }) as any,
        new Date('2026-10-22T10:07:00Z'),
      );
      expect(out).toMatchObject({ nextRunAt: '2026-10-22T10:15:00.000Z', scheduleError: null });
      const broken = svc.toPublicFlow(flowRow({ trigger: { type: 'schedule' } }) as any);
      expect(broken).toMatchObject({ nextRunAt: null, scheduleError: 'no cron expression is set' });
    });

    it('gives a webhook flow its own URL and returns the secret only on creation', async () => {
      const { svc, prisma } = build();
      const created = await svc.create(
        'p1',
        { name: 'hook', trigger: { type: 'webhook' }, actions: [{ type: 'log', message: 'x' }] } as any,
        'u',
      );
      expect(created.webhookUrl).toMatch(/^https:\/\/api\.example\.com\/api\/hooks\/flows\/[A-Za-z0-9_-]{32}$/);
      expect(created.webhookSecret).toMatch(/^fwhs_/);
      const stored = prisma.flow.create.mock.calls[0][0].data;
      expect(stored.webhookSecret).toMatch(/^enc:v1:/);

      const listed = svc.toPublicFlow(flowRow({ ...stored }) as any);
      expect(listed).not.toHaveProperty('webhookSecret');
      expect(listed.hasWebhookSecret).toBe(true);
    });

    it('masks sensitive header values in responses', async () => {
      const { svc } = build({
        flow: { actions: [{ type: 'http.request', url: 'https://x.io', headers: { Authorization: 'Bearer s3cr3t' } }] },
      });
      const [listed] = await svc.list('p1', 'u');
      expect(listed.actions[0].headers).toEqual({ Authorization: MASKED_VALUE });
    });

    it('updates only what a PATCH sends, and no longer re-enables a disabled flow on edit', async () => {
      const { svc, prisma } = build({ flow: { enabled: false, actions: [{ type: 'log', message: '' }] } });
      await svc.update('p1', 'f1', { name: 'renamed' }, 'u');
      expect(prisma.flow.update).toHaveBeenCalledWith({ where: { id: 'f1' }, data: { name: 'renamed' } });
    });
  });

  describe('webhooks', () => {
    const secret = 'fwhs_super_secret_value_123456';
    async function hookFlow() {
      const { encryptField } = await import('../../common/crypto/field-crypto');
      return { trigger: { type: 'webhook' }, webhookId: 'w'.repeat(32), webhookSecret: encryptField(secret) };
    }

    it('starts a run for a caller with the right secret, without a project key', async () => {
      const { svc, prisma } = build({ flow: await hookFlow() });
      const body = { ref: 'main' };
      const res = await svc.receiveWebhook('w'.repeat(32), {
        headers: { 'x-webhook-secret': secret, 'x-github-event': 'push', cookie: 'a=b' },
        rawBody: Buffer.from(JSON.stringify(body)),
        body,
        query: {},
      });
      expect(res).toEqual({ runId: 'run-1', status: 'queued' });
      const data = prisma.flowRun.create.mock.calls[0][0].data;
      expect(data).toMatchObject({ source: 'webhook', input: body });
      expect(data.meta.headers).toEqual({ 'x-github-event': 'push' });
      expect(JSON.stringify(data)).not.toContain(secret);
    });

    it('accepts a body signature', async () => {
      const { svc } = build({ flow: await hookFlow() });
      const raw = Buffer.from('{"a":1}');
      const sig = createHmac('sha256', secret).update(raw).digest('hex');
      await expect(
        svc.receiveWebhook('w'.repeat(32), { headers: { 'x-basefyio-signature': `sha256=${sig}` }, rawBody: raw, body: { a: 1 } }),
      ).resolves.toMatchObject({ status: 'queued' });
    });

    it('refuses a wrong secret with 401 and an unknown id or non-webhook flow with 404', async () => {
      const { svc } = build({ flow: await hookFlow() });
      await expect(
        svc.receiveWebhook('w'.repeat(32), { headers: { 'x-webhook-secret': 'wrong' }, body: {} }),
      ).rejects.toThrow(UnauthorizedException);

      const manual = build({ flow: { ...(await hookFlow()), trigger: { type: 'manual' } } });
      await expect(
        manual.svc.receiveWebhook('w'.repeat(32), { headers: { 'x-webhook-secret': secret }, body: {} }),
      ).rejects.toThrow(NotFoundException);

      const missing = build();
      missing.prisma.flow.findUnique.mockResolvedValue(null);
      await expect(missing.svc.receiveWebhook('w'.repeat(32), { headers: {}, body: {} })).rejects.toThrow(NotFoundException);
    });

    it('reveals and rotates the secret only on explicit request', async () => {
      const { svc } = build({ flow: await hookFlow() });
      await expect(svc.revealWebhookSecret('p1', 'f1', 'u')).resolves.toMatchObject({ secret });
      const rotated = await svc.rotateWebhook('p1', 'f1', {}, 'u');
      expect('secret' in rotated && rotated.secret).toMatch(/^fwhs_/);
      const own = await svc.rotateWebhook('p1', 'f1', { secret: 'whsec_from_stripe_123456' }, 'u');
      expect(own).toEqual({ webhookUrl: expect.any(String), secretSet: true });
    });
  });

  describe('createRun', () => {
    it('returns null when the dedupe key already exists', async () => {
      const { svc, prisma, queue } = build();
      prisma.flowRun.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '5' }),
      );
      await expect(svc.createRun({ id: 'f1', projectId: 'p1' }, { source: 'schedule', dedupeKey: 'k' })).resolves.toBeNull();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('marks the run failed when it cannot be queued', async () => {
      const { svc, queue, prisma } = build();
      queue.add.mockRejectedValue(new Error('redis down'));
      await expect(svc.createRun({ id: 'f1', projectId: 'p1' }, { source: 'api' })).rejects.toThrow('flow queue is unavailable');
      expect(prisma.flowRun.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
      );
    });
  });
});
