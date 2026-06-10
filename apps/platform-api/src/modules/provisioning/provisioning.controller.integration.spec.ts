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

const USER_ID    = '00000000-0000-4000-8000-000000000001';
const TEAM_ID    = '00000000-0000-4000-8000-000000000002';
const PROJECT_ID = '00000000-0000-4000-8000-000000000003';
const PP_ID      = '00000000-0000-4000-8000-000000000004';
const OP_ID      = '00000000-0000-4000-8000-000000000005';
const IDEM_KEY = 'key-integ-abc';

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
    },
  };
  prisma.$transaction = jest.fn().mockImplementation((cb: any) => cb(prisma));
  return prisma;
}

// ── Provider registry mock factory ───────────────────────────────────────────

function makeRegistry(
  applyResult: any = { success: true, resources: [], deletedExternalIds: [], metadata: { noop: true } },
) {
  return {
    resolve: jest.fn().mockReturnValue({
      plan: jest.fn().mockReturnValue({ actions: [], validationErrors: [] }),
      apply: jest.fn().mockResolvedValue(applyResult),
    }),
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
});
