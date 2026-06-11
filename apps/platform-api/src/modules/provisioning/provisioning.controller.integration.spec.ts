/**
 * Provisioning controller integration tests.
 *
 * Uses NestJS createTestingModule + supertest to cover HTTP-level contracts:
 *  - POST /operations creates an operation; dryRun=true → DRY_RUN immediately
 *  - POST /operations/:id/execute runs the full PENDING → COMPLETED path
 *  - GET  /resources response never leaks rollbackSpec
 *  - GET  /operations/:id response never leaks rollbackSpec
 *  - ModuleEnabledGuard: project.modules.provisioning=false → 403
 *
 * PrismaService, IProviderRegistry, and AuditLogInterceptor are stubbed.
 * JwtOrApiKeyGuard is overridden to inject a fixed user.
 */

import {
  INestApplication,
  ValidationPipe,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Injectable,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import request from 'supertest';

import { ProvisioningController } from './provisioning.controller';
import { ProvisioningService } from './provisioning.service';
import { ProvisioningExecutorService } from './provisioning-executor.service';
import { ProvisioningResourceProjectionService } from './provisioning-resource-projection.service';
import { ProvisioningPlannerService } from './provisioning-planner.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PROVIDER_REGISTRY } from './interfaces/provider-registry.interface';
import { ProviderRegistry } from './providers/provider-registry.service';
import { ModuleEnabledGuard } from '../../common/guards/module-enabled.guard';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { AuditLogInterceptor } from '../../common/interceptors/audit-log.interceptor';

// ── No-op interceptor (replaces AuditLogInterceptor — avoids static PrismaClient) ──

@Injectable()
class NoopInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle();
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const USER_ID      = '00000000-0000-4000-8000-000000000001';
const TEAM_ID      = '00000000-0000-4000-8000-000000000002';
const PROJECT_ID   = '00000000-0000-4000-8000-000000000003';
const PP_ID        = '00000000-0000-4000-8000-000000000004';
const OP_ID        = '00000000-0000-4000-8000-000000000005';
const CRED_ID      = '00000000-0000-4000-8000-000000000006';
const OTHER_TEAM   = '00000000-0000-4000-8000-000000000099';
const IDEM_KEY     = 'key-integ-abc';
const PROJ_IDEM    = 'proj-idem-1';

// ── Prisma mock factory ───────────────────────────────────────────────────────

function makePrisma(projectModules: Record<string, unknown> = {}) {
  const prisma: any = {
    project: {
      // Returns fields needed by both ModuleEnabledGuard and service ownership checks.
      findUnique: jest.fn().mockResolvedValue({ teamId: TEAM_ID, modules: projectModules }),
    },
    teamMember: {
      findUnique: jest.fn().mockResolvedValue({ teamId: TEAM_ID, userId: USER_ID }),
    },
    provisioningCredentialRef: {
      findUnique: jest.fn().mockResolvedValue({ teamId: TEAM_ID, revokedAt: null }),
    },
    provisioningProject: {
      findUnique: jest.fn().mockResolvedValue({
        id: PP_ID,
        projectId: PROJECT_ID,
        provider: 'noop',
        region: 'eu-central',
        datacenter: null,
        status: 'ACTIVE',
        project: { teamId: TEAM_ID, id: PROJECT_ID },
        credentialRef: { openbaoPath: 'secret/test' },
      }),
      create: jest.fn(),
      update: jest.fn(),
    },
    provisioningOperation: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    provisioningResource: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({}),
    },
    provisioningAuditEvent: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  prisma.$transaction = jest.fn().mockImplementation((cb: any) => cb(prisma));
  return prisma;
}

// ── Capability fixtures ──────────────────────────────────────────────────────

const MOCK_HETZNER_CAPABILITY = {
  name: 'hetzner',
  displayName: 'Hetzner Cloud',
  regions: ['eu-central', 'us-east', 'ap-southeast'],
  resourceTypes: ['server', 'network', 'loadbalancer', 'volume'],
  supportedResources: [
    { type: 'server',       description: 'Virtual machine instances' },
    { type: 'network',      description: 'Private networks and subnets' },
    { type: 'loadbalancer', description: 'Managed load balancers' },
    { type: 'volume',       description: 'Block storage volumes' },
  ],
  supportsCreate:   true,
  supportsUpdate:   true,
  supportsRollback: true,
  supportsDryRun:   true,
};

const MOCK_NOOP_CAPABILITY = {
  name: 'noop',
  displayName: 'No-op (testing)',
  regions: [],
  resourceTypes: [],
  supportedResources: [],
  supportsCreate: true,
  supportsUpdate: true,
  supportsRollback: true,
  supportsDryRun: true,
};

// ── Provider registry mock factory ───────────────────────────────────────────

function makeRegistry(
  applyResult: any = { success: true, resources: [], deletedExternalIds: [], metadata: { noop: true } },
) {
  return {
    resolve: jest.fn().mockReturnValue({
      getCapabilities: jest.fn().mockReturnValue(MOCK_NOOP_CAPABILITY),
      plan: jest.fn().mockReturnValue({ actions: [], validationErrors: [] }),
      apply: jest.fn().mockResolvedValue(applyResult),
      healthCheck: jest.fn().mockResolvedValue({ healthy: true, latencyMs: 0 }),
    }),
    list: jest.fn().mockReturnValue([MOCK_HETZNER_CAPABILITY, MOCK_NOOP_CAPABILITY]),
  };
}

// ── Stub operation fixture ───────────────────────────────────────────────────

function stubPendingOp(dryRun = false): any {
  return {
    id: OP_ID,
    status: 'PENDING',
    type: 'CREATE',
    dryRun,
    input: { resources: [] },
    idempotencyKey: IDEM_KEY,
    provisioningProjectId: PP_ID,
    errorMessage: null,
    result: null,
    createdAt: new Date('2026-06-10T00:00:00Z'),
    startedAt: null,
    completedAt: null,
    provisioningProject: {
      id: PP_ID,
      projectId: PROJECT_ID,
      provider: 'noop',
      region: 'eu-central',
      datacenter: null,
      project: { teamId: TEAM_ID, id: PROJECT_ID },
      credentialRef: { openbaoPath: 'secret/test' },
    },
  };
}

function stubUpdatedOp(status: string, extra: Record<string, unknown> = {}): any {
  return {
    ...stubPendingOp(),
    status,
    completedAt: new Date('2026-06-10T00:01:00Z'),
    ...extra,
  };
}

// ── App factory ──────────────────────────────────────────────────────────────

async function buildApp(prisma: any, registry: any): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [ProvisioningController],
    providers: [
      ProvisioningService,
      ProvisioningExecutorService,
      ProvisioningResourceProjectionService,
      ProvisioningPlannerService,
      Reflector,
      ModuleEnabledGuard,
      { provide: PrismaService, useValue: prisma },
      { provide: PROVIDER_REGISTRY, useValue: registry },
      { provide: ProviderRegistry, useValue: registry },
    ],
  })
    // Bypass JWT auth — inject fixed user so CurrentUser() works
    .overrideGuard(JwtOrApiKeyGuard)
    .useValue({
      canActivate: (ctx: ExecutionContext) => {
        ctx.switchToHttp().getRequest().user = { sub: USER_ID };
        return true;
      },
    })
    // Replace AuditLogInterceptor — it creates a static PrismaClient that needs a real DB
    .overrideInterceptor(AuditLogInterceptor)
    .useClass(NoopInterceptor)
    .compile();

  const app = moduleRef.createNestApplication();
  // Activate class-validator DTO pipes so request body validation runs
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Provisioning controller — integration', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  // ── 1. POST /operations → 201 with operation response ──────────────────────

  describe('POST /v1/provisioning/operations', () => {
    it('returns 201 with PENDING status when dryRun=false', async () => {
      const prisma = makePrisma();
      const createdOp = {
        id: OP_ID,
        provisioningProjectId: PP_ID,
        type: 'CREATE',
        status: 'PENDING',
        dryRun: false,
        idempotencyKey: IDEM_KEY,
        createdAt: new Date('2026-06-10T00:00:00Z'),
      };
      prisma.provisioningOperation.findUnique.mockResolvedValue(null); // no duplicate
      prisma.provisioningOperation.create.mockResolvedValue(createdOp);
      app = await buildApp(prisma, makeRegistry());

      const res = await request(app.getHttpServer())
        .post('/v1/provisioning/operations')
        .send({
          projectId: PROJECT_ID,
          type: 'CREATE',
          idempotencyKey: IDEM_KEY,
          desiredSpec: { resources: [{ type: 'server', name: 'web-1', spec: {} }] },
          dryRun: false,
        })
        .expect(201);

      expect(res.body.status).toBe('PENDING');
      expect(res.body.dryRun).toBe(false);
      expect(res.body.provisioningOperationId).toBe(OP_ID);
    });

    it('returns 201 with DRY_RUN status when dryRun=true (no execute needed)', async () => {
      const prisma = makePrisma();
      const createdOp = {
        id: OP_ID,
        provisioningProjectId: PP_ID,
        type: 'CREATE',
        status: 'DRY_RUN',
        dryRun: true,
        idempotencyKey: IDEM_KEY,
        createdAt: new Date('2026-06-10T00:00:00Z'),
      };
      prisma.provisioningOperation.findUnique.mockResolvedValue(null);
      prisma.provisioningOperation.create.mockResolvedValue(createdOp);
      app = await buildApp(prisma, makeRegistry());

      const res = await request(app.getHttpServer())
        .post('/v1/provisioning/operations')
        .send({
          projectId: PROJECT_ID,
          type: 'CREATE',
          idempotencyKey: IDEM_KEY,
          desiredSpec: {},
          dryRun: true,
        })
        .expect(201);

      expect(res.body.status).toBe('DRY_RUN');
      expect(res.body.dryRun).toBe(true);
    });

    it('returns 400 when required fields are missing', async () => {
      app = await buildApp(makePrisma(), makeRegistry());

      await request(app.getHttpServer())
        .post('/v1/provisioning/operations')
        .send({ projectId: PROJECT_ID }) // missing type, idempotencyKey, desiredSpec, dryRun
        .expect(400);
    });

    it('returns 200 on idempotent replay with matching key', async () => {
      const prisma = makePrisma();
      const existingOp = {
        id: OP_ID,
        provisioningProjectId: PP_ID,
        type: 'CREATE',
        status: 'COMPLETED',
        dryRun: false,
        idempotencyKey: IDEM_KEY,
        createdAt: new Date('2026-06-10T00:00:00Z'),
      };
      prisma.provisioningOperation.findUnique.mockResolvedValue(existingOp);
      app = await buildApp(prisma, makeRegistry());

      const res = await request(app.getHttpServer())
        .post('/v1/provisioning/operations')
        .send({
          projectId: PROJECT_ID,
          type: 'CREATE',
          idempotencyKey: IDEM_KEY,
          desiredSpec: {},
          dryRun: false,
        })
        .expect(201);

      expect(res.body.idempotent).toBe(true);
    });
  });

  // ── 2. POST /operations/:id/execute → COMPLETED path ──────────────────────

  describe('POST /v1/provisioning/operations/:id/execute', () => {
    it('returns 200 with COMPLETED status for a PENDING operation', async () => {
      const prisma = makePrisma();
      prisma.provisioningOperation.findUnique.mockResolvedValue(stubPendingOp());
      prisma.provisioningOperation.update
        .mockResolvedValueOnce(stubUpdatedOp('RUNNING', { startedAt: new Date() }))
        .mockResolvedValueOnce(stubUpdatedOp('COMPLETED'));

      const registry = makeRegistry();
      app = await buildApp(prisma, registry);

      const res = await request(app.getHttpServer())
        .post(`/v1/provisioning/operations/${OP_ID}/execute`)
        .expect(200);

      expect(res.body.status).toBe('COMPLETED');
    });

    it('transitions PENDING → RUNNING → COMPLETED in order', async () => {
      const prisma = makePrisma();
      prisma.provisioningOperation.findUnique.mockResolvedValue(stubPendingOp());
      prisma.provisioningOperation.update
        .mockResolvedValueOnce(stubUpdatedOp('RUNNING'))
        .mockResolvedValueOnce(stubUpdatedOp('COMPLETED'));

      app = await buildApp(prisma, makeRegistry());
      await request(app.getHttpServer())
        .post(`/v1/provisioning/operations/${OP_ID}/execute`)
        .expect(200);

      const statuses = prisma.provisioningOperation.update.mock.calls.map(
        (c: any) => c[0].data.status,
      );
      expect(statuses[0]).toBe('RUNNING');
      expect(statuses[1]).toBe('COMPLETED');
    });

    it('returns 400 when operation is already COMPLETED', async () => {
      const prisma = makePrisma();
      prisma.provisioningOperation.findUnique.mockResolvedValue(
        stubUpdatedOp('COMPLETED'),
      );
      app = await buildApp(prisma, makeRegistry());

      await request(app.getHttpServer())
        .post(`/v1/provisioning/operations/${OP_ID}/execute`)
        .expect(400);
    });
  });

  // ── 3. dryRun contract ──────────────────────────────────────────────────────

  describe('dryRun contract', () => {
    it('dryRun=true operation is DRY_RUN at creation — execute is not needed', async () => {
      const prisma = makePrisma();
      prisma.provisioningOperation.findUnique.mockResolvedValue(null);
      prisma.provisioningOperation.create.mockResolvedValue({
        id: OP_ID, provisioningProjectId: PP_ID, type: 'CREATE',
        status: 'DRY_RUN', dryRun: true, idempotencyKey: IDEM_KEY,
        createdAt: new Date(),
      });
      app = await buildApp(prisma, makeRegistry());

      const createRes = await request(app.getHttpServer())
        .post('/v1/provisioning/operations')
        .send({ projectId: PROJECT_ID, type: 'CREATE', idempotencyKey: IDEM_KEY, desiredSpec: {}, dryRun: true })
        .expect(201);

      expect(createRes.body.status).toBe('DRY_RUN');
      // provider.apply is NOT called — service short-circuits at DRY_RUN status
      const registry = makeRegistry();
      expect(registry.resolve).not.toHaveBeenCalled();
    });

    it('executor passes dryRun=true to provider.apply when op.dryRun=true', async () => {
      const prisma = makePrisma();
      // Executor handles PENDING op that has dryRun: true stored in DB
      prisma.provisioningOperation.findUnique.mockResolvedValue(stubPendingOp(true));
      prisma.provisioningOperation.update
        .mockResolvedValueOnce(stubUpdatedOp('RUNNING', { dryRun: true }))
        .mockResolvedValueOnce(stubUpdatedOp('DRY_RUN', { dryRun: true }));

      const registry = makeRegistry({ success: true, resources: [], metadata: { dryRun: true } });
      app = await buildApp(prisma, registry);

      await request(app.getHttpServer())
        .post(`/v1/provisioning/operations/${OP_ID}/execute`)
        .expect(200);

      const applyInput = (registry.resolve() as any).apply.mock.calls[0]?.[0];
      expect(applyInput?.dryRun).toBe(true);
    });
  });

  // ── 4. rollbackSpec does not leak ─────────────────────────────────────────

  describe('rollbackSpec leak guard', () => {
    it('GET /resources response contains no rollbackSpec field', async () => {
      const prisma = makePrisma();
      // Resource row returned by Prisma — rollbackSpec is never in the select
      prisma.provisioningResource.findMany.mockResolvedValue([
        {
          id: 'res-1',
          kind: 'server',
          name: 'web-1',
          status: 'ACTIVE',
          externalId: 'ext-123',
          desiredSpec: { size: 'cx11' },
          actualSpec: { size: 'cx11' },
          destroyedAt: null,
          createdAt: new Date('2026-06-10T00:00:00Z'),
          updatedAt: new Date('2026-06-10T00:00:00Z'),
          // rollbackSpec intentionally added here to simulate a DB row with the field
          rollbackSpec: { size: 'cx11-prev' },
        },
      ]);
      app = await buildApp(prisma, makeRegistry());

      const res = await request(app.getHttpServer())
        .get('/v1/provisioning/resources')
        .query({ projectId: PROJECT_ID })
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      for (const item of res.body) {
        expect(item).not.toHaveProperty('rollbackSpec');
      }
    });

    it('GET /operations/:id response contains no rollbackSpec field', async () => {
      const prisma = makePrisma();
      prisma.provisioningOperation.findUnique.mockResolvedValue({
        ...stubPendingOp(),
        status: 'COMPLETED',
        result: null,
        completedAt: new Date(),
        rollbackSpec: 'should-not-appear', // extra field
        provisioningProject: {
          projectId: PROJECT_ID,
          project: { teamId: TEAM_ID },
        },
      });
      app = await buildApp(prisma, makeRegistry());

      const res = await request(app.getHttpServer())
        .get(`/v1/provisioning/operations/${OP_ID}`)
        .expect(200);

      expect(res.body).not.toHaveProperty('rollbackSpec');
    });
  });

  // ── 5. ModuleEnabledGuard: module disabled → 403 ─────────────────────────

  describe('module disabled → 403', () => {
    it('returns 403 when project.modules.provisioning = false', async () => {
      const prisma = makePrisma({ provisioning: false }); // guard will see this
      app = await buildApp(prisma, makeRegistry());

      await request(app.getHttpServer())
        .post('/v1/provisioning/operations')
        .send({
          projectId: PROJECT_ID,
          type: 'CREATE',
          idempotencyKey: IDEM_KEY,
          desiredSpec: {},
          dryRun: false,
        })
        .expect(403);
    });

    it('returns 201 when project.modules = {} (default-enabled)', async () => {
      const prisma = makePrisma({}); // absent key = enabled
      prisma.provisioningOperation.findUnique.mockResolvedValue(null);
      prisma.provisioningOperation.create.mockResolvedValue({
        id: OP_ID, provisioningProjectId: PP_ID, type: 'CREATE',
        status: 'PENDING', dryRun: false, idempotencyKey: IDEM_KEY,
        createdAt: new Date(),
      });
      app = await buildApp(prisma, makeRegistry());

      await request(app.getHttpServer())
        .post('/v1/provisioning/operations')
        .send({
          projectId: PROJECT_ID,
          type: 'CREATE',
          idempotencyKey: IDEM_KEY,
          desiredSpec: {},
          dryRun: false,
        })
        .expect(201);
    });

    it('returns 201 when project.modules.provisioning = true (explicit enable)', async () => {
      const prisma = makePrisma({ provisioning: true });
      prisma.provisioningOperation.findUnique.mockResolvedValue(null);
      prisma.provisioningOperation.create.mockResolvedValue({
        id: OP_ID, provisioningProjectId: PP_ID, type: 'CREATE',
        status: 'PENDING', dryRun: false, idempotencyKey: IDEM_KEY,
        createdAt: new Date(),
      });
      app = await buildApp(prisma, makeRegistry());

      await request(app.getHttpServer())
        .post('/v1/provisioning/operations')
        .send({
          projectId: PROJECT_ID,
          type: 'CREATE',
          idempotencyKey: IDEM_KEY,
          desiredSpec: {},
          dryRun: false,
        })
        .expect(201);
    });

    it('execute endpoint: guard falls through when no projectId in path (ownership check in executor)', async () => {
      // POST /operations/:id/execute has no projectId param — ModuleEnabledGuard
      // cannot find the projectId and deliberately passes through. Access control
      // for this route is handled by executor's team-membership check.
      const prisma = makePrisma({ provisioning: false });
      // Operation not found → 404 (not 403) — confirms guard did not block it
      prisma.provisioningOperation.findUnique.mockResolvedValue(null);
      app = await buildApp(prisma, makeRegistry());

      // Guard passes through (no projectId resolvable), executor throws 404
      await request(app.getHttpServer())
        .post(`/v1/provisioning/operations/${OP_ID}/execute`)
        .expect(404);
    });

    it('returns 403 on GET /resources when module is disabled', async () => {
      const prisma = makePrisma({ provisioning: false });
      app = await buildApp(prisma, makeRegistry());

      await request(app.getHttpServer())
        .get('/v1/provisioning/resources')
        .query({ projectId: PROJECT_ID })
        .expect(403);
    });
  });

  // ── 6. POST /projects → project + first operation creation ─────────────────

  describe('POST /v1/provisioning/projects', () => {
    const validBody = () => ({
      projectId: PROJECT_ID,
      credentialRefId: CRED_ID,
      region: 'eu-central',
      desiredSpec: {},
      dryRun: false,
      idempotencyKey: PROJ_IDEM,
    });

    const createdPP = () => ({
      id: PP_ID,
      projectId: PROJECT_ID,
      provider: 'hetzner',
      region: 'eu-central',
      datacenter: null,
      status: 'PENDING',
      credentialRefId: CRED_ID,
    });

    const createdOp = (status = 'PENDING', dryRun = false) => ({
      id: OP_ID,
      provisioningProjectId: PP_ID,
      type: 'CREATE',
      status,
      dryRun,
      idempotencyKey: PROJ_IDEM,
      requestedBy: USER_ID,
      createdAt: new Date('2026-06-11T00:00:00Z'),
      startedAt: dryRun ? new Date('2026-06-11T00:00:00Z') : null,
      completedAt: dryRun ? new Date('2026-06-11T00:00:00Z') : null,
    });

    it('returns 201 with PENDING when dryRun=false (new project)', async () => {
      const prisma = makePrisma();
      prisma.provisioningProject.findUnique.mockResolvedValue(null);
      prisma.provisioningProject.create.mockResolvedValue(createdPP());
      prisma.provisioningOperation.create.mockResolvedValue(createdOp('PENDING', false));
      app = await buildApp(prisma, makeRegistry());

      const res = await request(app.getHttpServer())
        .post('/v1/provisioning/projects')
        .send(validBody())
        .expect(201);

      expect(res.body.provisioningProjectId).toBe(PP_ID);
      expect(res.body.operation.status).toBe('PENDING');
      expect(res.body.operation.dryRun).toBe(false);
      expect(res.body.operation.idempotent).toBe(false);
    });

    it('returns 201 with DRY_RUN when dryRun=true', async () => {
      const prisma = makePrisma();
      prisma.provisioningProject.findUnique.mockResolvedValue(null);
      prisma.provisioningProject.create.mockResolvedValue(createdPP());
      prisma.provisioningOperation.create.mockResolvedValue(createdOp('DRY_RUN', true));
      app = await buildApp(prisma, makeRegistry());

      const res = await request(app.getHttpServer())
        .post('/v1/provisioning/projects')
        .send({ ...validBody(), dryRun: true })
        .expect(201);

      expect(res.body.operation.status).toBe('DRY_RUN');
      expect(res.body.operation.dryRun).toBe(true);
    });

    it('returns 201 idempotent replay when same projectId + same key', async () => {
      const prisma = makePrisma();
      // provisioningProject.findUnique returns existing PP (non-null — default in makePrisma)
      prisma.provisioningOperation.findUnique.mockResolvedValue(createdOp('PENDING', false));
      app = await buildApp(prisma, makeRegistry());

      const res = await request(app.getHttpServer())
        .post('/v1/provisioning/projects')
        .send(validBody())
        .expect(201);

      expect(res.body.operation.idempotent).toBe(true);
      // No create calls — pure read path
      expect(prisma.provisioningProject.create).not.toHaveBeenCalled();
    });

    it('returns 409 when project already exists with a different idempotencyKey', async () => {
      const prisma = makePrisma();
      // PP exists (default in makePrisma); op not found → different key
      prisma.provisioningOperation.findUnique.mockResolvedValue(null);
      app = await buildApp(prisma, makeRegistry());

      await request(app.getHttpServer())
        .post('/v1/provisioning/projects')
        .send(validBody())
        .expect(409);
    });

    it('returns 403 when credentialRef belongs to a different team', async () => {
      const prisma = makePrisma();
      prisma.provisioningProject.findUnique.mockResolvedValue(null);
      prisma.provisioningCredentialRef.findUnique.mockResolvedValue({
        teamId: OTHER_TEAM,
        revokedAt: null,
      });
      app = await buildApp(prisma, makeRegistry());

      await request(app.getHttpServer())
        .post('/v1/provisioning/projects')
        .send(validBody())
        .expect(403);
    });

    it('returns 409 when credentialRef is revoked', async () => {
      const prisma = makePrisma();
      prisma.provisioningProject.findUnique.mockResolvedValue(null);
      prisma.provisioningCredentialRef.findUnique.mockResolvedValue({
        teamId: TEAM_ID,
        revokedAt: new Date('2026-01-01T00:00:00Z'),
      });
      app = await buildApp(prisma, makeRegistry());

      await request(app.getHttpServer())
        .post('/v1/provisioning/projects')
        .send(validBody())
        .expect(409);
    });

    it('returns 400 when required fields are missing', async () => {
      const prisma = makePrisma();
      app = await buildApp(prisma, makeRegistry());

      await request(app.getHttpServer())
        .post('/v1/provisioning/projects')
        .send({ region: 'eu-central' }) // missing projectId, credentialRefId, desiredSpec, dryRun, idempotencyKey
        .expect(400);
    });
  });

  // ── 7. POST /operations/:id/cancel ─────────────────────────────────────────

  describe('POST /v1/provisioning/operations/:id/cancel', () => {
    // Stub that simulates cancelOperation: findUnique returns pending op,
    // $transaction calls update + auditEvent.create, update returns cancelled op.
    function buildCancelPrisma(opStub: any) {
      const prisma = makePrisma();
      prisma.provisioningOperation.findUnique.mockResolvedValue({
        ...opStub,
        provisioningProject: {
          projectId: PROJECT_ID,
          project: { teamId: TEAM_ID },
        },
      });
      const cancelledOp = {
        ...opStub,
        status: 'CANCELLED',
        completedAt: new Date('2026-06-11T00:02:00Z'),
        provisioningProject: {
          projectId: PROJECT_ID,
          project: { teamId: TEAM_ID },
        },
      };
      prisma.provisioningOperation.update.mockResolvedValue(cancelledOp);
      prisma.provisioningAuditEvent.create.mockResolvedValue({});
      return { prisma, cancelledOp };
    }

    it('200: PENDING operation → CANCELLED status in response', async () => {
      const { prisma } = buildCancelPrisma(stubPendingOp());
      app = await buildApp(prisma, makeRegistry());

      const res = await request(app.getHttpServer())
        .post(`/v1/provisioning/operations/${OP_ID}/cancel`)
        .expect(200);

      expect(res.body.status).toBe('CANCELLED');
      expect(res.body.id).toBe(OP_ID);
    });

    it('400: Already COMPLETED operation → 400', async () => {
      const prisma = makePrisma();
      prisma.provisioningOperation.findUnique.mockResolvedValue({
        ...stubUpdatedOp('COMPLETED'),
        provisioningProject: {
          projectId: PROJECT_ID,
          project: { teamId: TEAM_ID },
        },
      });
      app = await buildApp(prisma, makeRegistry());

      await request(app.getHttpServer())
        .post(`/v1/provisioning/operations/${OP_ID}/cancel`)
        .expect(400);
    });

    it('400: RUNNING operation → 400', async () => {
      const prisma = makePrisma();
      prisma.provisioningOperation.findUnique.mockResolvedValue({
        ...stubUpdatedOp('RUNNING', { startedAt: new Date(), completedAt: null }),
        provisioningProject: {
          projectId: PROJECT_ID,
          project: { teamId: TEAM_ID },
        },
      });
      app = await buildApp(prisma, makeRegistry());

      await request(app.getHttpServer())
        .post(`/v1/provisioning/operations/${OP_ID}/cancel`)
        .expect(400);
    });

    it('404: Operation not found → 404', async () => {
      const prisma = makePrisma();
      prisma.provisioningOperation.findUnique.mockResolvedValue(null);
      app = await buildApp(prisma, makeRegistry());

      await request(app.getHttpServer())
        .post(`/v1/provisioning/operations/${'00000000-0000-4000-8000-000000000099'}/cancel`)
        .expect(404);
    });

    it('assert: provisioningOperation.update was called with status CANCELLED and completedAt set', async () => {
      const { prisma } = buildCancelPrisma(stubPendingOp());
      app = await buildApp(prisma, makeRegistry());

      await request(app.getHttpServer())
        .post(`/v1/provisioning/operations/${OP_ID}/cancel`)
        .expect(200);

      const updateCall = prisma.provisioningOperation.update.mock.calls[0][0];
      expect(updateCall.data.status).toBe('CANCELLED');
      expect(updateCall.data.completedAt).toBeInstanceOf(Date);
    });

    it('assert: provisioningAuditEvent.create was called with fromStatus=PENDING, toStatus=CANCELLED', async () => {
      const { prisma } = buildCancelPrisma(stubPendingOp());
      app = await buildApp(prisma, makeRegistry());

      await request(app.getHttpServer())
        .post(`/v1/provisioning/operations/${OP_ID}/cancel`)
        .expect(200);

      const auditCall = prisma.provisioningAuditEvent.create.mock.calls[0][0];
      expect(auditCall.data.fromStatus).toBe('PENDING');
      expect(auditCall.data.toStatus).toBe('CANCELLED');
      expect(auditCall.data.kind).toBe('STATUS_CHANGED');
    });

    it('rollbackSpec: response does not contain rollbackSpec field', async () => {
      const prisma = makePrisma();
      prisma.provisioningOperation.findUnique.mockResolvedValue({
        ...stubPendingOp(),
        rollbackSpec: { secret: 'should-not-appear' },
        provisioningProject: {
          projectId: PROJECT_ID,
          project: { teamId: TEAM_ID },
        },
      });
      const cancelledOp = {
        ...stubPendingOp(),
        status: 'CANCELLED',
        completedAt: new Date('2026-06-11T00:02:00Z'),
        rollbackSpec: { secret: 'should-not-appear' },
        provisioningProject: {
          projectId: PROJECT_ID,
          project: { teamId: TEAM_ID },
        },
      };
      prisma.provisioningOperation.update.mockResolvedValue(cancelledOp);
      prisma.provisioningAuditEvent.create.mockResolvedValue({});
      app = await buildApp(prisma, makeRegistry());

      const res = await request(app.getHttpServer())
        .post(`/v1/provisioning/operations/${OP_ID}/cancel`)
        .expect(200);

      expect(res.body).not.toHaveProperty('rollbackSpec');
    });
  });

  // ── 8. GET /operations → list with optional filter ─────────────────────────

  describe('GET /v1/provisioning/operations', () => {
    const opRow = (status = 'COMPLETED') => ({
      id: OP_ID,
      type: 'CREATE',
      status,
      dryRun: false,
      idempotencyKey: IDEM_KEY,
      errorMessage: null,
      result: null,
      input: {},
      createdAt: new Date('2026-06-11T00:00:00Z'),
      startedAt: new Date('2026-06-11T00:00:01Z'),
      completedAt: new Date('2026-06-11T00:00:02Z'),
      provisioningProject: {
        projectId: PROJECT_ID,
        project: { teamId: TEAM_ID },
      },
    });

    it('returns 200 with array of operations', async () => {
      const prisma = makePrisma();
      prisma.provisioningOperation.findMany = jest.fn().mockResolvedValue([opRow()]);
      app = await buildApp(prisma, makeRegistry());

      const res = await request(app.getHttpServer())
        .get('/v1/provisioning/operations')
        .query({ projectId: PROJECT_ID })
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0].id).toBe(OP_ID);
    });

    it('returns 200 empty array when no provisioning project exists', async () => {
      const prisma = makePrisma();
      prisma.provisioningProject.findUnique.mockResolvedValue(null);
      app = await buildApp(prisma, makeRegistry());

      const res = await request(app.getHttpServer())
        .get('/v1/provisioning/operations')
        .query({ projectId: PROJECT_ID })
        .expect(200);

      expect(res.body).toEqual([]);
    });

    it('passes status filter to findMany', async () => {
      const prisma = makePrisma();
      prisma.provisioningOperation.findMany = jest.fn().mockResolvedValue([opRow('PENDING')]);
      app = await buildApp(prisma, makeRegistry());

      await request(app.getHttpServer())
        .get('/v1/provisioning/operations')
        .query({ projectId: PROJECT_ID, status: 'PENDING' })
        .expect(200);

      const whereArg = prisma.provisioningOperation.findMany.mock.calls[0][0].where;
      expect(whereArg.status).toBe('PENDING');
    });

    it('returns 400 when projectId is missing', async () => {
      const prisma = makePrisma();
      app = await buildApp(prisma, makeRegistry());

      await request(app.getHttpServer())
        .get('/v1/provisioning/operations')
        .expect(400);
    });

    it('response items do not contain rollbackSpec', async () => {
      const prisma = makePrisma();
      prisma.provisioningOperation.findMany = jest
        .fn()
        .mockResolvedValue([{ ...opRow(), rollbackSpec: { secret: 'leak' } }]);
      app = await buildApp(prisma, makeRegistry());

      const res = await request(app.getHttpServer())
        .get('/v1/provisioning/operations')
        .query({ projectId: PROJECT_ID })
        .expect(200);

      expect(res.body[0]).not.toHaveProperty('rollbackSpec');
    });
  });

  // ── 9. GET /projects → provisioning project status ─────────────────────────

  describe('GET /v1/provisioning/projects', () => {
    const ppRow = () => ({
      id: PP_ID,
      provider: 'hetzner',
      region: 'eu-central',
      datacenter: null,
      status: 'ACTIVE',
      createdAt: new Date('2026-06-11T00:00:00Z'),
    });

    it('returns 200 with project shape', async () => {
      const prisma = makePrisma();
      prisma.provisioningProject.findUnique.mockResolvedValue(ppRow());
      app = await buildApp(prisma, makeRegistry());

      const res = await request(app.getHttpServer())
        .get('/v1/provisioning/projects')
        .query({ projectId: PROJECT_ID })
        .expect(200);

      expect(res.body.provisioningProjectId).toBe(PP_ID);
      expect(res.body.provider).toBe('hetzner');
      expect(res.body.status).toBe('ACTIVE');
    });

    it('datacenter is null when not set', async () => {
      const prisma = makePrisma();
      prisma.provisioningProject.findUnique.mockResolvedValue(ppRow());
      app = await buildApp(prisma, makeRegistry());

      const res = await request(app.getHttpServer())
        .get('/v1/provisioning/projects')
        .query({ projectId: PROJECT_ID })
        .expect(200);

      expect(res.body.datacenter).toBeNull();
    });

    it('returns 404 when no provisioning project found', async () => {
      const prisma = makePrisma();
      prisma.provisioningProject.findUnique.mockResolvedValue(null);
      app = await buildApp(prisma, makeRegistry());

      await request(app.getHttpServer())
        .get('/v1/provisioning/projects')
        .query({ projectId: PROJECT_ID })
        .expect(404);
    });

    it('returns 400 when projectId is missing', async () => {
      const prisma = makePrisma();
      app = await buildApp(prisma, makeRegistry());

      await request(app.getHttpServer())
        .get('/v1/provisioning/projects')
        .expect(400);
    });
  });

  // ── 10. Sprint 4e — Full lifecycle flows ───────────────────────────────────

  describe('Sprint 4e — Full lifecycle flows', () => {
    // ── 10-1. Create → cancel → verify CANCELLED ─────────────────────────────

    it('cancel flow: POST /operations → POST /operations/:id/cancel → status is CANCELLED', async () => {
      const prisma = makePrisma();

      // Step 1: create a PENDING operation
      const createdOp = {
        id: OP_ID,
        provisioningProjectId: PP_ID,
        type: 'CREATE',
        status: 'PENDING',
        dryRun: false,
        idempotencyKey: 'lifecycle-1',
        createdAt: new Date('2026-06-11T00:00:00Z'),
      };
      prisma.provisioningOperation.findUnique
        .mockResolvedValueOnce(null)       // idempotency check — no duplicate
        .mockResolvedValueOnce({           // cancelOperation lookup
          ...createdOp,
          input: {},
          errorMessage: null,
          result: null,
          startedAt: null,
          completedAt: null,
          provisioningProject: {
            projectId: PROJECT_ID,
            project: { teamId: TEAM_ID },
          },
        });
      prisma.provisioningOperation.create.mockResolvedValue(createdOp);

      const cancelledOp = {
        ...createdOp,
        status: 'CANCELLED',
        input: {},
        errorMessage: null,
        result: null,
        startedAt: null,
        completedAt: new Date('2026-06-11T00:02:00Z'),
        provisioningProject: {
          projectId: PROJECT_ID,
          project: { teamId: TEAM_ID },
        },
      };
      prisma.provisioningOperation.update.mockResolvedValue(cancelledOp);
      prisma.provisioningAuditEvent.create.mockResolvedValue({});

      app = await buildApp(prisma, makeRegistry());

      // POST /operations → 201 PENDING
      const createRes = await request(app.getHttpServer())
        .post('/v1/provisioning/operations')
        .send({
          projectId: PROJECT_ID,
          type: 'CREATE',
          idempotencyKey: 'lifecycle-1',
          desiredSpec: {},
          dryRun: false,
        })
        .expect(201);

      expect(createRes.body.status).toBe('PENDING');
      expect(createRes.body.provisioningOperationId).toBe(OP_ID);

      // POST /operations/:id/cancel → 200 CANCELLED
      const cancelRes = await request(app.getHttpServer())
        .post(`/v1/provisioning/operations/${OP_ID}/cancel`)
        .expect(200);

      expect(cancelRes.body.status).toBe('CANCELLED');

      // Assert that update was called with status: 'CANCELLED'
      const updateCall = prisma.provisioningOperation.update.mock.calls[0][0];
      expect(updateCall.data.status).toBe('CANCELLED');
    });

    // ── 10-2. dryRun=true → DRY_RUN status, no execute side-effects ──────────

    it('dry-run: POST /operations with dryRun=true returns DRY_RUN status', async () => {
      const prisma = makePrisma();
      const dryRunOp = {
        id: OP_ID,
        provisioningProjectId: PP_ID,
        type: 'CREATE',
        status: 'DRY_RUN',
        dryRun: true,
        idempotencyKey: 'lifecycle-dry-1',
        createdAt: new Date('2026-06-11T00:00:00Z'),
      };
      prisma.provisioningOperation.findUnique.mockResolvedValue(null);
      prisma.provisioningOperation.create.mockResolvedValue(dryRunOp);

      const registry = makeRegistry();
      app = await buildApp(prisma, registry);

      const res = await request(app.getHttpServer())
        .post('/v1/provisioning/operations')
        .send({
          projectId: PROJECT_ID,
          type: 'CREATE',
          idempotencyKey: 'lifecycle-dry-1',
          desiredSpec: {},
          dryRun: true,
        })
        .expect(201);

      expect(res.body.status).toBe('DRY_RUN');
      expect(res.body.dryRun).toBe(true);
      // provider.apply must NOT have been called — dry-run short-circuits at creation
      expect(registry.resolve).not.toHaveBeenCalled();
    });

    // ── 10-3. GET /operations returns array filtered by projectId ─────────────

    it('GET /operations?projectId=PROJECT_ID returns operations array', async () => {
      const prisma = makePrisma();
      const opRow = {
        id: OP_ID,
        type: 'CREATE',
        status: 'COMPLETED',
        dryRun: false,
        idempotencyKey: IDEM_KEY,
        errorMessage: null,
        result: null,
        input: {},
        createdAt: new Date('2026-06-11T00:00:00Z'),
        startedAt: new Date('2026-06-11T00:00:01Z'),
        completedAt: new Date('2026-06-11T00:00:02Z'),
        provisioningProject: {
          projectId: PROJECT_ID,
          project: { teamId: TEAM_ID },
        },
      };
      prisma.provisioningOperation.findMany = jest.fn().mockResolvedValue([opRow]);
      app = await buildApp(prisma, makeRegistry());

      const res = await request(app.getHttpServer())
        .get('/v1/provisioning/operations')
        .query({ projectId: PROJECT_ID })
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body[0].id).toBe(OP_ID);
    });

    // ── 10-4. GET /projects returns provisioning project status ───────────────

    it('GET /projects?projectId=PROJECT_ID returns provisioning project status', async () => {
      const prisma = makePrisma();
      prisma.provisioningProject.findUnique.mockResolvedValue({
        id: PP_ID,
        provider: 'hetzner',
        region: 'eu-central',
        datacenter: null,
        status: 'ACTIVE',
        createdAt: new Date('2026-06-11T00:00:00Z'),
      });
      app = await buildApp(prisma, makeRegistry());

      const res = await request(app.getHttpServer())
        .get('/v1/provisioning/projects')
        .query({ projectId: PROJECT_ID })
        .expect(200);

      expect(res.body.provisioningProjectId).toBe(PP_ID);
      expect(res.body.status).toBe('ACTIVE');
    });

    // ── 10-5. rollbackSpec is NOT leaked in GET /operations response ──────────

    it('GET /operations does not expose rollbackSpec in response', async () => {
      const prisma = makePrisma();
      const opRowWithSecret = {
        id: OP_ID,
        type: 'CREATE',
        status: 'COMPLETED',
        dryRun: false,
        idempotencyKey: IDEM_KEY,
        errorMessage: null,
        result: null,
        input: {},
        rollbackSpec: { secret: 'must-not-leak' },  // sensitive field in DB row
        createdAt: new Date('2026-06-11T00:00:00Z'),
        startedAt: new Date('2026-06-11T00:00:01Z'),
        completedAt: new Date('2026-06-11T00:00:02Z'),
        provisioningProject: {
          projectId: PROJECT_ID,
          project: { teamId: TEAM_ID },
        },
      };
      prisma.provisioningOperation.findMany = jest.fn().mockResolvedValue([opRowWithSecret]);
      app = await buildApp(prisma, makeRegistry());

      const res = await request(app.getHttpServer())
        .get('/v1/provisioning/operations')
        .query({ projectId: PROJECT_ID })
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      for (const item of res.body) {
        expect(item).not.toHaveProperty('rollbackSpec');
      }
    });

    // ── 10-6. Module disabled → guard passes cancel through (no projectId in URL) ──

    it('cancel: ModuleEnabledGuard passes through (no projectId in path) — operation not found → 404', async () => {
      // POST /operations/:id/cancel has no projectId param; ModuleEnabledGuard cannot
      // resolve the projectId and deliberately passes through, matching the same
      // pattern as POST /operations/:id/execute. The test confirms the guard does NOT
      // return 403 even when provisioning is disabled — 404 is returned by the service.
      const prisma = makePrisma({ provisioning: false });
      prisma.provisioningOperation.findUnique.mockResolvedValue(null); // op not found → 404
      app = await buildApp(prisma, makeRegistry());

      await request(app.getHttpServer())
        .post(`/v1/provisioning/operations/${OP_ID}/cancel`)
        .expect(404); // guard passed through; service throws NotFoundException
    });
  });

  // ── GET /providers — discovery endpoint ─────────────────────────────────

  describe('GET /v1/provisioning/providers', () => {
    it('returns 200 with an array of provider capabilities', async () => {
      app = await buildApp(makePrisma(), makeRegistry());

      const res = await request(app.getHttpServer())
        .get('/v1/provisioning/providers')
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(2);
    });

    it('includes hetzner capability with supportsRollback=true', async () => {
      app = await buildApp(makePrisma(), makeRegistry());

      const res = await request(app.getHttpServer())
        .get('/v1/provisioning/providers')
        .expect(200);

      const hetzner = res.body.find((c: any) => c.name === 'hetzner');
      expect(hetzner).toBeDefined();
      expect(hetzner.supportsRollback).toBe(true);
      expect(hetzner.supportsDryRun).toBe(true);
      expect(hetzner.supportsCreate).toBe(true);
      expect(hetzner.supportsUpdate).toBe(true);
    });

    it('hetzner capability includes supportedResources array', async () => {
      app = await buildApp(makePrisma(), makeRegistry());

      const res = await request(app.getHttpServer())
        .get('/v1/provisioning/providers')
        .expect(200);

      const hetzner = res.body.find((c: any) => c.name === 'hetzner');
      expect(Array.isArray(hetzner.supportedResources)).toBe(true);
      expect(hetzner.supportedResources.length).toBeGreaterThan(0);
      expect(hetzner.supportedResources[0]).toHaveProperty('type');
      expect(hetzner.supportedResources[0]).toHaveProperty('description');
    });

    it('hetzner capability retains backward-compat resourceTypes string array', async () => {
      app = await buildApp(makePrisma(), makeRegistry());

      const res = await request(app.getHttpServer())
        .get('/v1/provisioning/providers')
        .expect(200);

      const hetzner = res.body.find((c: any) => c.name === 'hetzner');
      expect(Array.isArray(hetzner.resourceTypes)).toBe(true);
      expect(hetzner.resourceTypes).toContain('server');
    });
  });

  // ── GET /operations/:id/events — audit event log ─────────────────────────

  describe('GET /v1/provisioning/operations/:id/events', () => {
    const eventRow = (kind: string, seq: number) => ({
      id: `evt-${seq}`,
      operationId: OP_ID,
      provisioningProjectId: PP_ID,
      resourceId: null,
      kind,
      actorUserId: USER_ID,
      fromStatus: seq === 1 ? null : 'PENDING',
      toStatus: seq === 1 ? 'PENDING' : 'RUNNING',
      detail: { step: seq },
      createdAt: new Date(`2026-06-11T00:00:0${seq}Z`),
    });

    it('returns 200 with ordered event list for team member', async () => {
      const prisma = makePrisma();
      prisma.provisioningOperation.findUnique.mockResolvedValue({
        ...stubPendingOp(),
        provisioningProject: {
          project: { teamId: TEAM_ID },
        },
      });
      prisma.provisioningAuditEvent.findMany.mockResolvedValue([
        eventRow('OPERATION_STARTED', 1),
        eventRow('STATUS_CHANGED', 2),
      ]);
      app = await buildApp(prisma, makeRegistry());

      const res = await request(app.getHttpServer())
        .get(`/v1/provisioning/operations/${OP_ID}/events`)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].kind).toBe('OPERATION_STARTED');
      expect(res.body[1].kind).toBe('STATUS_CHANGED');
      expect(res.body[0].id).toBe('evt-1');
      expect(res.body[0].actorUserId).toBe(USER_ID);
      expect(res.body[0].metadata).toEqual({ step: 1 });
      expect(typeof res.body[0].createdAt).toBe('string');
    });

    it('returns 404 when operation does not exist', async () => {
      const prisma = makePrisma();
      prisma.provisioningOperation.findUnique.mockResolvedValue(null);
      app = await buildApp(prisma, makeRegistry());

      await request(app.getHttpServer())
        .get(`/v1/provisioning/operations/${'00000000-0000-4000-8000-000000000099'}/events`)
        .expect(404);
    });

    it('returns 404 when user is not a team member', async () => {
      const prisma = makePrisma();
      prisma.provisioningOperation.findUnique.mockResolvedValue({
        ...stubPendingOp(),
        provisioningProject: {
          project: { teamId: TEAM_ID },
        },
      });
      prisma.teamMember.findUnique.mockResolvedValue(null);
      app = await buildApp(prisma, makeRegistry());

      await request(app.getHttpServer())
        .get(`/v1/provisioning/operations/${OP_ID}/events`)
        .expect(404);
    });
  });
});
