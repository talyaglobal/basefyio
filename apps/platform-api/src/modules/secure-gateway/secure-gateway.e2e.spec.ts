/**
 * Phase 6D — Secure Gateway E2E confidence gate (RC1).
 *
 * Suite 1: NestJS DI bootstrap
 *   - SecureGatewayModule compiles and resolves all services across module boundaries.
 *   - CERTIFICATE_PROVIDER cross-module export (Phase 6A fix) is verified.
 *
 * Suite 2: HTTP integration via supertest
 *   - connect() happy path, expired cert, CRL-revoked cert, OpenBao down
 *   - query() SELECT allowed, READ-only enforcement blocks INSERT/DELETE
 *   - health/openbao — all unavailable, partially down, all healthy
 *   - Leakage snapshots: no privateKeyPem / sslKey / vaultToken in any response
 *
 * Infrastructure is fully mocked. No real DB, OpenBao, or pg connections.
 * Real classes in the DI graph: SecureGatewayService, QueryGuard, CrlCacheService,
 * OpenBaoHealthService, GatewayAuditService.
 */

import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { SecureGatewayModule } from './secure-gateway.module';
import { SecureGatewayService } from './secure-gateway.service';
import { CrlCacheService } from './crl-cache.service';
import { OpenBaoHealthService } from '../certificates/openbao-health.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EntitlementService } from '../entitlement/entitlement.service';
import { CERTIFICATE_PROVIDER } from '../certificates/providers/certificate-provider.interface';
import { DATA_STORAGE_PROVIDER } from './data-storage-provider.interface';
import { OPENBAO_PKI_CONFIG } from '../certificates/providers/openbao-pki.provider';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { ProjectActivityService } from '../projects/project-activity.service';

// ── Fixed IDs ─────────────────────────────────────────────────────────────────

const PROJECT_ID  = 'proj-e2e-gw-1';
const USER_ID     = 'user-e2e-gw-1';

const CERT_ACTIVE  = 'cert-e2e-active';
const CERT_EXPIRED = 'cert-e2e-expired';
const CERT_CRL     = 'cert-e2e-crl';
const CERT_READ    = 'cert-e2e-read';

const FUTURE = new Date(Date.now() + 365 * 24 * 3_600_000);
const PAST   = new Date(Date.now() - 3_600_000);

const CERT_ROWS: Record<string, Record<string, unknown>> = {
  [CERT_ACTIVE]: {
    id: CERT_ACTIVE, projectId: PROJECT_ID,
    status: 'ACTIVE', accessLevel: 'READ_WRITE',
    notAfter: FUTURE, serialNumber: 'AABBCCDD01',
    certificatePem: '-----BEGIN CERTIFICATE-----\nACTIVE\n-----END CERTIFICATE-----',
    caCertPem:      '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
    openbaoKeyPath: `secret/data/certs/${CERT_ACTIVE}`,
  },
  [CERT_EXPIRED]: {
    id: CERT_EXPIRED, projectId: PROJECT_ID,
    status: 'ACTIVE', accessLevel: 'READ_WRITE',
    notAfter: PAST,   serialNumber: 'AABBCCDD02',
    certificatePem: '-----BEGIN CERTIFICATE-----\nEXPIRED\n-----END CERTIFICATE-----',
    caCertPem:      '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
    openbaoKeyPath: `secret/data/certs/${CERT_EXPIRED}`,
  },
  // status: ACTIVE in findFirst (DB hasn't yet synced the out-of-band revocation),
  // but findMany({status:REVOKED}) returns this cert so the CRL cache detects it.
  [CERT_CRL]: {
    id: CERT_CRL, projectId: PROJECT_ID,
    status: 'ACTIVE', accessLevel: 'READ_WRITE',
    notAfter: FUTURE, serialNumber: 'AABBCCDD03',
    certificatePem: '-----BEGIN CERTIFICATE-----\nCRL\n-----END CERTIFICATE-----',
    caCertPem:      '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
    openbaoKeyPath: `secret/data/certs/${CERT_CRL}`,
  },
  [CERT_READ]: {
    id: CERT_READ, projectId: PROJECT_ID,
    status: 'ACTIVE', accessLevel: 'READ',
    notAfter: FUTURE, serialNumber: 'AABBCCDD04',
    certificatePem: '-----BEGIN CERTIFICATE-----\nREAD\n-----END CERTIFICATE-----',
    caCertPem:      '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
    openbaoKeyPath: `secret/data/certs/${CERT_READ}`,
  },
};

// ── Mock factories ────────────────────────────────────────────────────────────

function makePrisma() {
  return {
    projectClientCertificate: {
      findFirst: jest.fn().mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve(CERT_ROWS[where.id] ?? null),
      ),
      // CRL refresh reads {status:'REVOKED'}: returns cert-crl so the CRL cache blocks it.
      // syncFromOpenBao reads {status:'ACTIVE'}: returns [] (no active certs to sync).
      findMany: jest.fn().mockImplementation(({ where }: { where: { status: string } }) =>
        Promise.resolve(
          where?.status === 'REVOKED' ? [{ id: CERT_CRL, revokedAt: new Date() }] : [],
        ),
      ),
      update: jest.fn().mockResolvedValue({}),
    },
  };
}

const MOCK_BUNDLE = {
  certificatePem: '-----BEGIN CERTIFICATE-----\nMOCK\n-----END CERTIFICATE-----',
  privateKeyPem:  '-----BEGIN RSA PRIVATE KEY-----\nSECRET-KEY-BYTES\n-----END RSA PRIVATE KEY-----',
  caCertPem:      '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
};

function makeCertProvider() {
  return {
    issue:           jest.fn(),
    revoke:          jest.fn(),
    deleteKey:       jest.fn(),
    checkRevocation: jest.fn().mockResolvedValue({ revoked: false }),
    getBundle:       jest.fn().mockResolvedValue(MOCK_BUNDLE),
  };
}

const MOCK_STORAGE = {
  providerType: 'postgres-jsonb' as const,
  connect:    jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn().mockResolvedValue(undefined),
  ping:       jest.fn().mockResolvedValue(true),
  query:      jest.fn().mockResolvedValue({ rows: [{ id: 1, name: 'Alice' }], rowCount: 1 }),
};

const MOCK_OPENBAO_CFG = {
  baseUrl:    'http://fake-vault.test:8200',
  vaultToken: 'fake-vault-token-abc123',
  pkiMount:   'pki',
  pkiRole:    'basefyio-client',
  kvMount:    'secret',
};

// Sets req.user so @CurrentUser() resolves a fixed identity.
class MockJwtGuard {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ user: unknown }>();
    req.user = { sub: USER_ID, email: 'test@e2e.local' };
    return true;
  }
}

// ── 1. DI bootstrap ───────────────────────────────────────────────────────────

describe('SecureGatewayModule — DI bootstrap', () => {
  it('compiles and resolves all services including cross-module CERTIFICATE_PROVIDER', async () => {
    const certProvider = makeCertProvider();

    const module = await Test.createTestingModule({ imports: [SecureGatewayModule] })
      .overrideProvider(PrismaService).useValue(makePrisma())
      .overrideProvider(EntitlementService).useValue({ assertCan: jest.fn() })
      .overrideProvider(ProjectActivityService).useValue({ append: jest.fn().mockResolvedValue(undefined) })
      .overrideProvider(CERTIFICATE_PROVIDER).useValue(certProvider)
      .overrideProvider(DATA_STORAGE_PROVIDER).useValue(MOCK_STORAGE)
      .overrideProvider(OPENBAO_PKI_CONFIG).useValue(MOCK_OPENBAO_CFG)
      .overrideGuard(JwtOrApiKeyGuard).useClass(MockJwtGuard)
      .compile();

    // Core services present in the module
    expect(module.get(SecureGatewayService)).toBeDefined();
    expect(module.get(CrlCacheService)).toBeDefined();
    expect(module.get(OpenBaoHealthService)).toBeDefined();

    // CERTIFICATE_PROVIDER is exported by CertificateModule and injected by both
    // SecureGatewayService and CrlCacheService across module boundaries.
    // Phase 6A fix: CERTIFICATE_PROVIDER was missing from CertificateModule.exports —
    // this assertion fails if the export is removed.
    expect(module.get(CERTIFICATE_PROVIDER)).toBe(certProvider);

    await module.close();
  });
});

// ── 2. HTTP integration ───────────────────────────────────────────────────────

describe('Secure Gateway — HTTP integration', () => {
  let app: INestApplication;
  let certProvider: ReturnType<typeof makeCertProvider>;

  beforeAll(async () => {
    certProvider = makeCertProvider();

    const module = await Test.createTestingModule({ imports: [SecureGatewayModule] })
      .overrideProvider(PrismaService).useValue(makePrisma())
      .overrideProvider(EntitlementService).useValue({ assertCan: jest.fn() })
      .overrideProvider(ProjectActivityService).useValue({ append: jest.fn().mockResolvedValue(undefined) })
      .overrideProvider(CERTIFICATE_PROVIDER).useValue(certProvider)
      .overrideProvider(DATA_STORAGE_PROVIDER).useValue(MOCK_STORAGE)
      .overrideProvider(OPENBAO_PKI_CONFIG).useValue(MOCK_OPENBAO_CFG)
      .overrideGuard(JwtOrApiKeyGuard).useClass(MockJwtGuard)
      .compile();

    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
    // Re-apply defaults that individual tests may have overridden.
    certProvider.getBundle.mockResolvedValue(MOCK_BUNDLE);
    certProvider.checkRevocation.mockResolvedValue({ revoked: false });
    MOCK_STORAGE.query.mockResolvedValue({ rows: [{ id: 1, name: 'Alice' }], rowCount: 1 });
  });

  // ── connect() ──────────────────────────────────────────────────────────────

  describe('POST /v1/projects/:projectId/gateway/connect — happy path', () => {
    it('200 — active cert connects and response never contains private key material', async () => {
      const res = await request(app.getHttpServer())
        .post(`/v1/projects/${PROJECT_ID}/gateway/connect`)
        .send({ certId: CERT_ACTIVE });

      expect(res.status).toBe(200);
      expect(res.body.certId).toBe(CERT_ACTIVE);
      expect(res.body.status).toBe('connected');
      expect(res.body.accessLevel).toBe('READ_WRITE');
      expect(res.body).toHaveProperty('policy');
      expect(res.body.policy.projectId).toBe(PROJECT_ID);
      expect(res.body.policy.requireMtls).toBe(true);

      const json = JSON.stringify(res.body);
      expect(json).not.toContain('privateKeyPem');
      expect(json).not.toContain('sslKey');
      expect(json).not.toContain('SECRET-KEY-BYTES');
    });

    it('200 — getBundle is called once with correct openbaoKeyPath', async () => {
      await request(app.getHttpServer())
        .post(`/v1/projects/${PROJECT_ID}/gateway/connect`)
        .send({ certId: CERT_ACTIVE });

      expect(certProvider.getBundle).toHaveBeenCalledTimes(1);
      expect(certProvider.getBundle).toHaveBeenCalledWith(
        CERT_ROWS[CERT_ACTIVE].openbaoKeyPath,
        expect.any(String),
        expect.any(String),
      );
    });
  });

  describe('POST /v1/projects/:projectId/gateway/connect — rejection paths', () => {
    it('403 — expired cert is rejected before OpenBao is contacted', async () => {
      const res = await request(app.getHttpServer())
        .post(`/v1/projects/${PROJECT_ID}/gateway/connect`)
        .send({ certId: CERT_EXPIRED });

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/expired/i);
      expect(certProvider.getBundle).not.toHaveBeenCalled();
    });

    it('403 — CRL-revoked cert is rejected before OpenBao is contacted', async () => {
      const res = await request(app.getHttpServer())
        .post(`/v1/projects/${PROJECT_ID}/gateway/connect`)
        .send({ certId: CERT_CRL });

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/revoked/i);
      expect(certProvider.getBundle).not.toHaveBeenCalled();
    });

    it('404 — unknown certId returns 404', async () => {
      const res = await request(app.getHttpServer())
        .post(`/v1/projects/${PROJECT_ID}/gateway/connect`)
        .send({ certId: 'cert-not-found' });

      expect(res.status).toBe(404);
    });

    it('503 — OpenBao bundle fetch failure returns ServiceUnavailable', async () => {
      certProvider.getBundle.mockRejectedValue(new Error('ECONNREFUSED'));

      const res = await request(app.getHttpServer())
        .post(`/v1/projects/${PROJECT_ID}/gateway/connect`)
        .send({ certId: CERT_ACTIVE });

      expect(res.status).toBe(503);
      // Error message must not contain the raw exception (no key paths, private data)
      expect(JSON.stringify(res.body)).not.toContain('openbaoKeyPath');
    });

    it('400 — missing certId returns validation error', async () => {
      const res = await request(app.getHttpServer())
        .post(`/v1/projects/${PROJECT_ID}/gateway/connect`)
        .send({});

      expect(res.status).toBe(400);
    });
  });

  // ── query() ────────────────────────────────────────────────────────────────

  describe('POST /v1/projects/:projectId/gateway/query — allowed queries', () => {
    it('200 — SELECT with READ_WRITE cert returns rows', async () => {
      MOCK_STORAGE.query.mockResolvedValue({ rows: [{ id: 1, name: 'Alice' }], rowCount: 1 });

      const res = await request(app.getHttpServer())
        .post(`/v1/projects/${PROJECT_ID}/gateway/query`)
        .send({ certId: CERT_ACTIVE, sql: 'SELECT id, name FROM items' });

      expect(res.status).toBe(200);
      expect(res.body.rows).toHaveLength(1);
      expect(res.body.rowCount).toBe(1);
    });

    it('200 — SELECT with READ cert is also permitted', async () => {
      MOCK_STORAGE.query.mockResolvedValue({ rows: [], rowCount: 0 });

      const res = await request(app.getHttpServer())
        .post(`/v1/projects/${PROJECT_ID}/gateway/query`)
        .send({ certId: CERT_READ, sql: 'SELECT 1' });

      expect(res.status).toBe(200);
      expect(res.body.rowCount).toBe(0);
    });

    it('200 — parameterized query passes $1 params through to storage provider', async () => {
      MOCK_STORAGE.query.mockResolvedValue({ rows: [{ id: 42 }], rowCount: 1 });

      const res = await request(app.getHttpServer())
        .post(`/v1/projects/${PROJECT_ID}/gateway/query`)
        .send({ certId: CERT_ACTIVE, sql: 'SELECT id FROM items WHERE id = $1', params: [42] });

      expect(res.status).toBe(200);
      expect(MOCK_STORAGE.query).toHaveBeenCalledWith(
        'SELECT id FROM items WHERE id = $1',
        [42],
      );
    });
  });

  describe('POST /v1/projects/:projectId/gateway/query — READ-only enforcement', () => {
    it('403 — INSERT with READ cert is blocked before query executes', async () => {
      const res = await request(app.getHttpServer())
        .post(`/v1/projects/${PROJECT_ID}/gateway/query`)
        .send({ certId: CERT_READ, sql: "INSERT INTO items (name) VALUES ('x')" });

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/READ-only/i);
      expect(MOCK_STORAGE.query).not.toHaveBeenCalled();
    });

    it('403 — UPDATE with READ cert is blocked', async () => {
      const res = await request(app.getHttpServer())
        .post(`/v1/projects/${PROJECT_ID}/gateway/query`)
        .send({ certId: CERT_READ, sql: "UPDATE items SET name = 'y' WHERE id = 1" });

      expect(res.status).toBe(403);
      expect(MOCK_STORAGE.query).not.toHaveBeenCalled();
    });

    it('403 — DELETE with READ cert is blocked', async () => {
      const res = await request(app.getHttpServer())
        .post(`/v1/projects/${PROJECT_ID}/gateway/query`)
        .send({ certId: CERT_READ, sql: 'DELETE FROM items WHERE id = 1' });

      expect(res.status).toBe(403);
      expect(MOCK_STORAGE.query).not.toHaveBeenCalled();
    });

    it('403 — DDL (DROP TABLE) with READ cert is blocked', async () => {
      const res = await request(app.getHttpServer())
        .post(`/v1/projects/${PROJECT_ID}/gateway/query`)
        .send({ certId: CERT_READ, sql: 'DROP TABLE items' });

      expect(res.status).toBe(403);
      expect(MOCK_STORAGE.query).not.toHaveBeenCalled();
    });
  });

  // ── health/openbao ─────────────────────────────────────────────────────────

  describe('GET /v1/secure-gateway/health/openbao', () => {
    let savedFetch: typeof global.fetch;

    beforeEach(() => { savedFetch = global.fetch; });
    afterEach(() => { global.fetch = savedFetch; });

    it('200 — all components unavailable when OpenBao is unreachable (fail-open)', async () => {
      (global as any).fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const res = await request(app.getHttpServer())
        .get('/v1/secure-gateway/health/openbao');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('unavailable');
      expect(res.body.components.system.status).toBe('unavailable');
      expect(res.body.components.pkiMount.status).toBe('unavailable');
      expect(res.body.components.kvMount.status).toBe('unavailable');
      expect(res.body.checkedAt).toBeDefined();
    });

    it('200 — individual component failures are isolated (one down does not hide others)', async () => {
      // system → unavailable (503), pkiMount → unavailable (network), kvMount → ok (200)
      (global as any).fetch = jest.fn()
        .mockResolvedValueOnce({ ok: false, status: 503 })
        .mockRejectedValueOnce(new Error('network'))
        .mockResolvedValueOnce({ ok: true, status: 200 });

      const res = await request(app.getHttpServer())
        .get('/v1/secure-gateway/health/openbao');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('unavailable');       // escalated: any unavailable → overall unavailable
      expect(res.body.components.system.status).toBe('unavailable');
      expect(res.body.components.pkiMount.status).toBe('unavailable');
      expect(res.body.components.kvMount.status).toBe('ok');   // kvMount unaffected by others
    });

    it('200 — degraded when PKI mount returns 404 (not configured)', async () => {
      (global as any).fetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, status: 200 })         // system → ok
        .mockResolvedValueOnce({ ok: false, status: 404 })        // pkiMount → degraded
        .mockResolvedValueOnce({ ok: true, status: 200 });        // kvMount → ok

      const res = await request(app.getHttpServer())
        .get('/v1/secure-gateway/health/openbao');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('degraded');
      expect(res.body.components.pkiMount.status).toBe('degraded');
      expect(res.body.components.pkiMount.hint).toMatch(/vault secrets enable/i);
    });

    it('200 — healthy when all three components return 200', async () => {
      (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

      const res = await request(app.getHttpServer())
        .get('/v1/secure-gateway/health/openbao');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('healthy');
      expect(res.body.components.system.status).toBe('ok');
      expect(res.body.components.pkiMount.status).toBe('ok');
      expect(res.body.components.kvMount.status).toBe('ok');
    });
  });

  // ── Leakage snapshots ──────────────────────────────────────────────────────

  describe('Leakage snapshots — no key material or credentials in any response', () => {
    it('connect response never contains privateKeyPem, sslKey, or raw key bytes', async () => {
      const res = await request(app.getHttpServer())
        .post(`/v1/projects/${PROJECT_ID}/gateway/connect`)
        .send({ certId: CERT_ACTIVE });

      expect(res.status).toBe(200);
      const json = JSON.stringify(res.body);
      expect(json).not.toContain('privateKeyPem');
      expect(json).not.toContain('sslKey');
      expect(json).not.toContain('SECRET-KEY-BYTES');
      expect(json).not.toContain('RSA PRIVATE KEY');
    });

    it('query response never contains privateKeyPem or sslKey', async () => {
      const res = await request(app.getHttpServer())
        .post(`/v1/projects/${PROJECT_ID}/gateway/query`)
        .send({ certId: CERT_ACTIVE, sql: 'SELECT id FROM items' });

      expect(res.status).toBe(200);
      const json = JSON.stringify(res.body);
      expect(json).not.toContain('privateKeyPem');
      expect(json).not.toContain('sslKey');
    });

    it('health response never contains vault token or OpenBao internal base URL', async () => {
      const savedFetch = global.fetch;
      (global as any).fetch = jest.fn().mockRejectedValue(new Error('offline'));

      const res = await request(app.getHttpServer())
        .get('/v1/secure-gateway/health/openbao');

      global.fetch = savedFetch;

      const json = JSON.stringify(res.body);
      expect(json).not.toContain(MOCK_OPENBAO_CFG.vaultToken);
      expect(json).not.toContain(MOCK_OPENBAO_CFG.baseUrl);
    });

    it('connect 503 response body does not expose internal error details', async () => {
      certProvider.getBundle.mockRejectedValue(
        new Error(`ETIMEDOUT connecting to ${MOCK_OPENBAO_CFG.baseUrl}`),
      );

      const res = await request(app.getHttpServer())
        .post(`/v1/projects/${PROJECT_ID}/gateway/connect`)
        .send({ certId: CERT_ACTIVE });

      expect(res.status).toBe(503);
      const json = JSON.stringify(res.body);
      expect(json).not.toContain(MOCK_OPENBAO_CFG.baseUrl);
      expect(json).not.toContain(MOCK_OPENBAO_CFG.vaultToken);
    });
  });
});
