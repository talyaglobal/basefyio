/**
 * Phase 6C — Certificate renewal E2E + dead-key custody gate.
 *
 * Tests the full HTTP path through DeveloperAccessController → CertificateService.
 * Uses real CertificateService with mocked PrismaService and CertificateProvider.
 *
 * Covers:
 *  1. POST .../renew → 200 with new privateKeyPem
 *  2. Renewal sequence: issue before revoke (no access gap)
 *  3. Dead-key custody: deleteKey called with OLD cert's openbaoKeyPath
 *  4. deleteKey failure is non-fatal (still 200)
 *  5. POST .../revoke → 204, deleteKey called
 *  6. GET .../certificate (list) — never exposes privateKeyPem or openbaoKeyPath
 *  7. Leakage: renew response body does not contain old cert's openbaoKeyPath
 */

import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { DeveloperAccessController } from './developer-access.controller';
import { DeveloperAccessService } from './developer-access.service';
import { CertificateService } from '../certificates/certificate.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EntitlementService } from '../entitlement/entitlement.service';
import { ProjectActivityService } from '../projects/project-activity.service';
import { CERTIFICATE_PROVIDER } from '../certificates/providers/certificate-provider.interface';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';

// ── Fixed IDs ─────────────────────────────────────────────────────────────────

const PROJECT_ID = 'proj-6c-1';
const USER_ID    = 'user-6c-1';
const OLD_CERT_ID = 'cert-6c-old';

const OLD_SERIAL       = 'AABB6C0001';
const OLD_KEY_PATH     = `secret/data/certs/${PROJECT_ID}/${OLD_SERIAL}`;
const NEW_SERIAL       = 'AABB6C0002';
const NEW_KEY_PATH     = `secret/data/certs/${PROJECT_ID}/${NEW_SERIAL}`;

// ── Cert fixtures ─────────────────────────────────────────────────────────────

const OLD_CERT_ROW = {
  id: OLD_CERT_ID,
  projectId: PROJECT_ID,
  subject: `CN=${PROJECT_ID}.basefyio.com`,
  serialNumber: OLD_SERIAL,
  fingerprint: 'OLD-FP',
  openbaoKeyPath: OLD_KEY_PATH,
  certificatePem: '-----BEGIN CERTIFICATE-----\nOLD\n-----END CERTIFICATE-----',
  caCertPem: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
  accessLevel: 'READ_WRITE',
  status: 'ACTIVE',
  notBefore: new Date('2025-01-01'),
  notAfter:  new Date('2026-12-31'),
  issuedAt:  new Date('2025-01-01'),
  revokedAt: null,
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
  entitlementRef: null,
};

const NEW_CERT_ROW = {
  ...OLD_CERT_ROW,
  id: 'cert-6c-new',
  serialNumber: NEW_SERIAL,
  fingerprint: 'NEW-FP',
  openbaoKeyPath: NEW_KEY_PATH,
  certificatePem: '-----BEGIN CERTIFICATE-----\nNEW\n-----END CERTIFICATE-----',
  notBefore: new Date(),
  notAfter:  new Date(Date.now() + 365 * 24 * 3_600_000),
  issuedAt:  new Date(),
};

const NEW_ISSUED = {
  serialNumber:   NEW_SERIAL,
  fingerprint:    'NEW-FP',
  subject:        OLD_CERT_ROW.subject,
  certificatePem: NEW_CERT_ROW.certificatePem,
  privateKeyPem:  '-----BEGIN RSA PRIVATE KEY-----\nNEW-KEY-BYTES\n-----END RSA PRIVATE KEY-----',
  caCertPem:      OLD_CERT_ROW.caCertPem,
  openbaoKeyPath: NEW_KEY_PATH,
  notBefore:      NEW_CERT_ROW.notBefore,
  notAfter:       NEW_CERT_ROW.notAfter,
};

// ── Mock factories ────────────────────────────────────────────────────────────

function makePrisma() {
  return {
    project: {
      findUnique: jest.fn().mockResolvedValue({ id: PROJECT_ID, teamId: 'team-6c' }),
    },
    teamMember: {
      findUnique: jest.fn().mockResolvedValue({ id: 'mem-6c', role: 'ADMIN' }),
    },
    projectClientCertificate: {
      create:   jest.fn().mockResolvedValue(NEW_CERT_ROW),
      findMany: jest.fn().mockResolvedValue([OLD_CERT_ROW, NEW_CERT_ROW]),
      findFirst: jest.fn().mockImplementation(({ where }: any) => {
        if (where.id === OLD_CERT_ID) return Promise.resolve(OLD_CERT_ROW);
        return Promise.resolve(null);
      }),
      update: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ ...OLD_CERT_ROW, ...data }),
      ),
    },
    certificateEvent: {
      create: jest.fn().mockResolvedValue({ id: 'ev-6c' }),
    },
  };
}

function makeCertProvider() {
  return {
    issue:           jest.fn().mockResolvedValue(NEW_ISSUED),
    revoke:          jest.fn().mockResolvedValue(undefined),
    deleteKey:       jest.fn().mockResolvedValue(undefined),
    getBundle:       jest.fn().mockResolvedValue({ ...NEW_ISSUED }),
    checkRevocation: jest.fn().mockResolvedValue({ revoked: false }),
  };
}

class MockJwtGuard {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ user: unknown }>();
    req.user = { sub: USER_ID, email: 'test@6c.local' };
    return true;
  }
}

// ── App setup ─────────────────────────────────────────────────────────────────

describe('Certificate renewal — HTTP E2E (Phase 6C)', () => {
  let app: INestApplication;
  let provider: ReturnType<typeof makeCertProvider>;
  let prisma: ReturnType<typeof makePrisma>;

  beforeAll(async () => {
    provider = makeCertProvider();
    prisma   = makePrisma();

    const module = await Test.createTestingModule({
      controllers: [DeveloperAccessController],
      providers: [
        // Real CertificateService — exercises the actual renewal + deleteKey logic
        CertificateService,
        { provide: DeveloperAccessService,  useValue: { getAccessInfo: jest.fn() } },
        { provide: PrismaService,           useValue: prisma },
        { provide: EntitlementService,      useValue: { assertCan: jest.fn() } },
        { provide: ProjectActivityService,  useValue: { append: jest.fn().mockResolvedValue(undefined) } },
        { provide: CERTIFICATE_PROVIDER,    useValue: provider },
      ],
    })
      .overrideGuard(JwtOrApiKeyGuard).useClass(MockJwtGuard)
      .compile();

    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
    // Restore per-test defaults that individual tests might override.
    provider.issue.mockResolvedValue(NEW_ISSUED);
    provider.revoke.mockResolvedValue(undefined);
    provider.deleteKey.mockResolvedValue(undefined);
  });

  // ── renew() ────────────────────────────────────────────────────────────────

  describe('POST /v1/projects/:projectId/access/certificate/:certId/renew', () => {
    it('201 — returns new cert with privateKeyPem in response', async () => {
      const res = await request(app.getHttpServer())
        .post(`/v1/projects/${PROJECT_ID}/access/certificate/${OLD_CERT_ID}/renew`)
        .send({});

      expect(res.status).toBe(201);
      expect(res.body.privateKeyPem).toBe(NEW_ISSUED.privateKeyPem);
      expect(res.body.serialNumber).toBe(NEW_SERIAL);
    });

    it('new cert has a different serialNumber from the old one', async () => {
      const res = await request(app.getHttpServer())
        .post(`/v1/projects/${PROJECT_ID}/access/certificate/${OLD_CERT_ID}/renew`)
        .send({});

      expect(res.status).toBe(201);
      expect(res.body.serialNumber).not.toBe(OLD_SERIAL);
    });

    it('issue is called before revoke — no access gap during renewal', async () => {
      await request(app.getHttpServer())
        .post(`/v1/projects/${PROJECT_ID}/access/certificate/${OLD_CERT_ID}/renew`)
        .send({});

      expect(provider.issue.mock.invocationCallOrder[0])
        .toBeLessThan(provider.revoke.mock.invocationCallOrder[0]);
    });

    it('deleteKey is called with the OLD cert openbaoKeyPath after renewal', async () => {
      await request(app.getHttpServer())
        .post(`/v1/projects/${PROJECT_ID}/access/certificate/${OLD_CERT_ID}/renew`)
        .send({});

      expect(provider.deleteKey).toHaveBeenCalledWith(OLD_KEY_PATH);
    });

    it('deleteKey is called exactly once — new cert private key is preserved in OpenBao', async () => {
      await request(app.getHttpServer())
        .post(`/v1/projects/${PROJECT_ID}/access/certificate/${OLD_CERT_ID}/renew`)
        .send({});

      expect(provider.deleteKey).toHaveBeenCalledTimes(1);
    });

    it('deleteKey failure is non-fatal — still returns 201 with new cert', async () => {
      provider.deleteKey.mockRejectedValue(new Error('KV offline'));

      const res = await request(app.getHttpServer())
        .post(`/v1/projects/${PROJECT_ID}/access/certificate/${OLD_CERT_ID}/renew`)
        .send({});

      expect(res.status).toBe(201);
      expect(res.body.privateKeyPem).toBe(NEW_ISSUED.privateKeyPem);
    });

    it('old cert status is set to REVOKED in DB after renewal', async () => {
      await request(app.getHttpServer())
        .post(`/v1/projects/${PROJECT_ID}/access/certificate/${OLD_CERT_ID}/renew`)
        .send({});

      expect(prisma.projectClientCertificate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: OLD_CERT_ID },
          data:  expect.objectContaining({ status: 'REVOKED' }),
        }),
      );
    });

    it('renew response body never contains old cert openbaoKeyPath', async () => {
      const res = await request(app.getHttpServer())
        .post(`/v1/projects/${PROJECT_ID}/access/certificate/${OLD_CERT_ID}/renew`)
        .send({});

      expect(JSON.stringify(res.body)).not.toContain(OLD_KEY_PATH);
      expect(JSON.stringify(res.body)).not.toContain('openbaoKeyPath');
    });

    it('404 when old cert not found', async () => {
      const res = await request(app.getHttpServer())
        .post(`/v1/projects/${PROJECT_ID}/access/certificate/cert-does-not-exist/renew`)
        .send({});

      expect(res.status).toBe(404);
    });
  });

  // ── revoke() ───────────────────────────────────────────────────────────────

  describe('POST /v1/projects/:projectId/access/certificate/:certId/revoke', () => {
    it('204 — revoke returns no content', async () => {
      const res = await request(app.getHttpServer())
        .post(`/v1/projects/${PROJECT_ID}/access/certificate/${OLD_CERT_ID}/revoke`)
        .send({});

      expect(res.status).toBe(204);
    });

    it('deleteKey is called with the cert openbaoKeyPath after revoke', async () => {
      await request(app.getHttpServer())
        .post(`/v1/projects/${PROJECT_ID}/access/certificate/${OLD_CERT_ID}/revoke`)
        .send({});

      expect(provider.deleteKey).toHaveBeenCalledWith(OLD_KEY_PATH);
    });

    it('deleteKey failure is non-fatal — still returns 204', async () => {
      provider.deleteKey.mockRejectedValue(new Error('KV timeout'));

      const res = await request(app.getHttpServer())
        .post(`/v1/projects/${PROJECT_ID}/access/certificate/${OLD_CERT_ID}/revoke`)
        .send({});

      expect(res.status).toBe(204);
    });
  });

  // ── list() leakage ─────────────────────────────────────────────────────────

  describe('GET /v1/projects/:projectId/access/certificate — leakage', () => {
    it('list response never contains privateKeyPem', async () => {
      const res = await request(app.getHttpServer())
        .get(`/v1/projects/${PROJECT_ID}/access/certificate`);

      expect(res.status).toBe(200);
      const json = JSON.stringify(res.body);
      expect(json).not.toContain('privateKeyPem');
      expect(json).not.toContain('NEW-KEY-BYTES');
    });

    it('list response never exposes openbaoKeyPath', async () => {
      const res = await request(app.getHttpServer())
        .get(`/v1/projects/${PROJECT_ID}/access/certificate`);

      expect(res.status).toBe(200);
      const json = JSON.stringify(res.body);
      expect(json).not.toContain('openbaoKeyPath');
      expect(json).not.toContain(OLD_KEY_PATH);
      expect(json).not.toContain(NEW_KEY_PATH);
    });

    it('list returns both certs (old + new) after renewal', async () => {
      const res = await request(app.getHttpServer())
        .get(`/v1/projects/${PROJECT_ID}/access/certificate`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      const serials = res.body.map((c: any) => c.serialNumber);
      expect(serials).toContain(OLD_SERIAL);
      expect(serials).toContain(NEW_SERIAL);
    });
  });
});
