/**
 * Phase 6.1 — DI bootstrap spec for SecureGatewayModule.
 *
 * Goal: verify the full NestJS DI graph resolves at module compilation.
 * This is the class of bug that unit tests (which instantiate services directly)
 * cannot catch: a missing export, a mismatched token, or a transitive dependency
 * that NestJS cannot satisfy at runtime.
 *
 * Specifically guards against the CERTIFICATE_PROVIDER export gap that existed
 * before Phase 6.1 (CrlCacheService injected CERTIFICATE_PROVIDER which was
 * not exported from CertificateModule).
 *
 * Guard note: in production GuardsModule is @Global() and imported at AppModule
 * level, making JwtAuthGuard / ApiKeyGuard / JwtOrApiKeyGuard available in all
 * module contexts. In this isolated test we replicate that with MockGuardsModule.
 */

import { Global, Module } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { SecureGatewayModule } from './secure-gateway.module';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CERTIFICATE_PROVIDER,
} from '../certificates/providers/certificate-provider.interface';
import { OPENBAO_PKI_CONFIG } from '../certificates/providers/openbao-pki.provider';
import { CrlCacheService } from './crl-cache.service';
import { SecureGatewayService } from './secure-gateway.service';
import { OpenBaoHealthService } from '../certificates/openbao-health.service';
import { EntitlementService } from '../entitlement/entitlement.service';
import { ProjectActivityService } from '../projects/project-activity.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';

// ── Mock providers (no real network or DB calls) ──────────────────────────────

const MOCK_PRISMA = {
  projectClientCertificate: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  project: { findUnique: jest.fn() },
  teamMember: { findUnique: jest.fn() },
  projectActivity: { create: jest.fn() },
};

const MOCK_CERT_PROVIDER = {
  issue: jest.fn(),
  revoke: jest.fn(),
  getBundle: jest.fn(),
  deleteKey: jest.fn(),
  checkRevocation: jest.fn().mockResolvedValue({ revoked: false }),
};

const MOCK_PKI_CONFIG = {
  baseUrl: 'http://openbao.test:8200',
  vaultToken: 'di-test-token',
  pkiMount: 'pki',
  pkiRole: 'basefyio-client',
  kvMount: 'secret',
};

const MOCK_GUARD = { canActivate: jest.fn().mockResolvedValue(true) };

// Mirrors the @Global() GuardsModule from production so guard tokens are
// visible inside SecureGatewayModule's controller context without needing
// passport, RedisService, or other heavy guard deps.
@Global()
@Module({
  providers: [
    { provide: JwtAuthGuard, useValue: MOCK_GUARD },
    { provide: ApiKeyGuard, useValue: MOCK_GUARD },
    { provide: JwtOrApiKeyGuard, useValue: MOCK_GUARD },
  ],
  exports: [JwtAuthGuard, ApiKeyGuard, JwtOrApiKeyGuard],
})
class MockGuardsModule {}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

describe('SecureGatewayModule — DI graph', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [MockGuardsModule, SecureGatewayModule],
    })
      .overrideProvider(PrismaService)
      .useValue(MOCK_PRISMA)
      // CrlCacheService + SecureGatewayService inject CERTIFICATE_PROVIDER —
      // this is the token CertificateModule must now export (Phase 6.1 fix).
      .overrideProvider(CERTIFICATE_PROVIDER)
      .useValue(MOCK_CERT_PROVIDER)
      // OpenBaoPkiProvider and OpenBaoHealthService inject OPENBAO_PKI_CONFIG.
      .overrideProvider(OPENBAO_PKI_CONFIG)
      .useValue(MOCK_PKI_CONFIG)
      // EntitlementService / ProjectActivityService depend on PrismaService (already mocked)
      // but override them explicitly so transitive deps don't need full wiring.
      .overrideProvider(EntitlementService)
      .useValue({ assertCan: jest.fn().mockResolvedValue(undefined) })
      .overrideProvider(ProjectActivityService)
      .useValue({ append: jest.fn().mockResolvedValue(undefined) })
      .compile();
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  // ── Core resolution ─────────────────────────────────────────────────────────

  it('module compiles without DI resolution errors', () => {
    expect(moduleRef).toBeDefined();
  });

  it('SecureGatewayService resolves', () => {
    const svc = moduleRef.get(SecureGatewayService);
    expect(svc).toBeDefined();
    expect(typeof svc.connect).toBe('function');
    expect(typeof svc.executeQuery).toBe('function');
  });

  // ── Phase 6.1 invariant: CERTIFICATE_PROVIDER injected into CrlCacheService ─

  it('CrlCacheService resolves — CERTIFICATE_PROVIDER export is wired', () => {
    const crl = moduleRef.get(CrlCacheService);
    expect(crl).toBeDefined();
    expect(typeof crl.isRevoked).toBe('function');
    expect(typeof crl.syncFromOpenBao).toBe('function');
  });

  it('CERTIFICATE_PROVIDER token resolves to the expected mock', () => {
    const provider = moduleRef.get(CERTIFICATE_PROVIDER);
    expect(provider).toBe(MOCK_CERT_PROVIDER);
  });

  // ── Health monitoring resolution (Phase 6B pre-check) ───────────────────────

  it('OpenBaoHealthService resolves via CertificateModule', () => {
    const health = moduleRef.get(OpenBaoHealthService);
    expect(health).toBeDefined();
    expect(typeof health.check).toBe('function');
  });
});
