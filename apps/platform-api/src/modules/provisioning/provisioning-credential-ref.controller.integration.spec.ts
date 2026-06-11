/**
 * ProvisioningCredentialRefController integration tests.
 *
 * Uses NestJS createTestingModule + supertest to cover HTTP-level contracts:
 *  - POST   /v1/provisioning/credentials → 201 creates a credential ref
 *  - GET    /v1/provisioning/credentials?teamId=... → 200 lists refs
 *  - DELETE /v1/provisioning/credentials/:id → 204 revokes a ref
 *
 * PrismaService and AuditLogInterceptor are stubbed.
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

import { ProvisioningCredentialRefController } from './provisioning-credential-ref.controller';
import { ProvisioningCredentialRefService } from './provisioning-credential-ref.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ModuleEnabledGuard } from '../../common/guards/module-enabled.guard';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { AuditLogInterceptor } from '../../common/interceptors/audit-log.interceptor';

// ── No-op interceptor (replaces AuditLogInterceptor) ────────────────────────

@Injectable()
class NoopInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle();
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const USER_ID  = '00000000-0000-4000-8000-000000000001';
const TEAM_ID  = '00000000-0000-4000-8000-000000000002';
const CRED_ID  = '00000000-0000-4000-8000-000000000010';

// ── Prisma mock factory ───────────────────────────────────────────────────────

function makePrisma(overrides: Record<string, any> = {}) {
  const prisma: any = {
    teamMember: {
      findUnique: jest.fn().mockResolvedValue({ teamId: TEAM_ID, userId: USER_ID }),
    },
    provisioningCredentialRef: {
      create: jest.fn().mockResolvedValue({
        id: CRED_ID,
        teamId: TEAM_ID,
        label: 'prod-hetzner',
        openbaoPath: 'secret/hetzner/prod',
        provider: 'hetzner',
        revokedAt: null,
        createdAt: new Date('2026-06-11T00:00:00Z'),
        updatedAt: new Date('2026-06-11T00:00:00Z'),
      }),
      findUnique: jest.fn().mockResolvedValue({
        id: CRED_ID,
        teamId: TEAM_ID,
        label: 'prod-hetzner',
        openbaoPath: 'secret/hetzner/prod',
        provider: 'hetzner',
        revokedAt: null,
        createdAt: new Date('2026-06-11T00:00:00Z'),
      }),
      findMany: jest.fn().mockResolvedValue([
        {
          id: CRED_ID,
          label: 'prod-hetzner',
          openbaoPath: 'secret/hetzner/prod',
          provider: 'hetzner',
          createdAt: new Date('2026-06-11T00:00:00Z'),
        },
      ]),
      update: jest.fn().mockResolvedValue({}),
    },
    ...overrides,
  };
  return prisma;
}

// ── App factory ──────────────────────────────────────────────────────────────

async function buildApp(prisma: any): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [ProvisioningCredentialRefController],
    providers: [
      ProvisioningCredentialRefService,
      Reflector,
      ModuleEnabledGuard,
      { provide: PrismaService, useValue: prisma },
    ],
  })
    .overrideGuard(JwtOrApiKeyGuard)
    .useValue({
      canActivate: (ctx: ExecutionContext) => {
        ctx.switchToHttp().getRequest().user = { sub: USER_ID };
        return true;
      },
    })
    .overrideInterceptor(AuditLogInterceptor)
    .useClass(NoopInterceptor)
    .compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ProvisioningCredentialRefController — integration', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  // ── 1. POST /credentials → 201 ───────────────────────────────────────────

  describe('POST /v1/provisioning/credentials', () => {
    it('returns 201 with credentialRef shape', async () => {
      app = await buildApp(makePrisma());

      const res = await request(app.getHttpServer())
        .post('/v1/provisioning/credentials')
        .send({
          teamId: TEAM_ID,
          label: 'prod-hetzner',
          openbaoPath: 'secret/hetzner/prod',
        })
        .expect(201);

      expect(res.body.credentialRefId).toBe(CRED_ID);
      expect(res.body.teamId).toBe(TEAM_ID);
      expect(res.body.label).toBe('prod-hetzner');
      expect(res.body.openbaoPath).toBe('secret/hetzner/prod');
      expect(res.body.createdAt).toBeDefined();
    });

    it('returns 400 when required fields are missing', async () => {
      app = await buildApp(makePrisma());

      await request(app.getHttpServer())
        .post('/v1/provisioning/credentials')
        .send({ teamId: TEAM_ID }) // missing label and openbaoPath
        .expect(400);
    });

    it('returns 403 when user is not a team member', async () => {
      const prisma = makePrisma();
      prisma.teamMember.findUnique.mockResolvedValue(null); // not a member

      app = await buildApp(prisma);

      await request(app.getHttpServer())
        .post('/v1/provisioning/credentials')
        .send({
          teamId: TEAM_ID,
          label: 'prod-hetzner',
          openbaoPath: 'secret/hetzner/prod',
        })
        .expect(403);
    });
  });

  // ── 2. GET /credentials?teamId=... → 200 ────────────────────────────────

  describe('GET /v1/provisioning/credentials', () => {
    it('returns 200 with array of refs', async () => {
      app = await buildApp(makePrisma());

      const res = await request(app.getHttpServer())
        .get('/v1/provisioning/credentials')
        .query({ teamId: TEAM_ID })
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].credentialRefId).toBe(CRED_ID);
      expect(res.body[0].label).toBe('prod-hetzner');
      expect(res.body[0].openbaoPath).toBe('secret/hetzner/prod');
    });

    it('returns 200 with empty array when none exist', async () => {
      const prisma = makePrisma();
      prisma.provisioningCredentialRef.findMany.mockResolvedValue([]);

      app = await buildApp(prisma);

      const res = await request(app.getHttpServer())
        .get('/v1/provisioning/credentials')
        .query({ teamId: TEAM_ID })
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(0);
    });

    it('returns 400 when teamId is missing', async () => {
      app = await buildApp(makePrisma());

      await request(app.getHttpServer())
        .get('/v1/provisioning/credentials')
        // no teamId query param
        .expect(400);
    });
  });

  // ── 3. DELETE /credentials/:id → 204 ────────────────────────────────────

  describe('DELETE /v1/provisioning/credentials/:id', () => {
    it('returns 204 when ref is successfully revoked', async () => {
      app = await buildApp(makePrisma());

      await request(app.getHttpServer())
        .delete(`/v1/provisioning/credentials/${CRED_ID}`)
        .expect(204);
    });

    it('returns 404 when ref is not found', async () => {
      const prisma = makePrisma();
      prisma.provisioningCredentialRef.findUnique.mockResolvedValue(null);

      app = await buildApp(prisma);

      await request(app.getHttpServer())
        .delete(`/v1/provisioning/credentials/${CRED_ID}`)
        .expect(404);
    });

    it('returns 409 when ref is already revoked', async () => {
      const prisma = makePrisma();
      prisma.provisioningCredentialRef.findUnique.mockResolvedValue({
        id: CRED_ID,
        teamId: TEAM_ID,
        revokedAt: new Date('2026-01-01T00:00:00Z'), // already revoked
      });

      app = await buildApp(prisma);

      await request(app.getHttpServer())
        .delete(`/v1/provisioning/credentials/${CRED_ID}`)
        .expect(409);
    });
  });
});
