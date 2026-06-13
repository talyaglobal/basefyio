import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { SecureGatewayService } from './secure-gateway.service';
import { SecureClientFactory } from './secure-client-factory';
import { QueryGuard } from './query-guard';
import { CrlCacheService } from './crl-cache.service';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PROJECT_ID = 'proj-gw-1';
const USER_ID = 'user-1';
const CERT_ID = 'cert-1';
const SERIAL = 'AABBCCDDEEFF';

const MOCK_CERT_ROW = {
  id: CERT_ID,
  projectId: PROJECT_ID,
  serialNumber: SERIAL,
  fingerprint: 'ABC123',
  subject: `CN=project-${PROJECT_ID}.basefyio.com`,
  openbaoKeyPath: `secret/data/certs/${PROJECT_ID}/${SERIAL}`,
  certificatePem: '-----BEGIN CERTIFICATE-----\nMOCK\n-----END CERTIFICATE-----',
  caCertPem: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
  accessLevel: 'READ_WRITE',
  status: 'ACTIVE',
  notBefore: new Date('2026-01-01'),
  notAfter: new Date('2027-01-01'),
  issuedAt: new Date('2026-01-01'),
  revokedAt: null,
};

const MOCK_BUNDLE = {
  certificatePem: MOCK_CERT_ROW.certificatePem,
  privateKeyPem: '-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----',
  caCertPem: MOCK_CERT_ROW.caCertPem,
};

function makePrisma(certRow: any = MOCK_CERT_ROW) {
  return {
    projectClientCertificate: {
      findFirst: jest.fn().mockImplementation(async ({ where }: any) =>
        certRow && certRow.id === where.id && certRow.projectId === where.projectId ? certRow : null,
      ),
      create: jest.fn().mockResolvedValue(certRow),
      update: jest.fn().mockResolvedValue(certRow),
    },
  };
}

function makeEntitlement(allow = true) {
  return {
    assertCan: allow
      ? jest.fn().mockResolvedValue(undefined)
      : jest.fn().mockRejectedValue(new ForbiddenException('Plan does not include feature: gatewayConnect')),
  };
}

function makeCertProvider(bundleOverride?: Partial<typeof MOCK_BUNDLE> | Error) {
  return {
    getBundle: bundleOverride instanceof Error
      ? jest.fn().mockRejectedValue(bundleOverride)
      : jest.fn().mockResolvedValue({ ...MOCK_BUNDLE, ...bundleOverride }),
    issue: jest.fn(),
    revoke: jest.fn(),
    deleteKey: jest.fn(),
    checkRevocation: jest.fn().mockResolvedValue({ revoked: false }),
  };
}

function makeStorageProvider(rows: any[] = [{ id: 1 }]) {
  return {
    providerType: 'postgres-jsonb' as const,
    connect: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue({ rows, rowCount: rows.length }),
    disconnect: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue(true),
  };
}

function makeAudit() {
  return {
    logConnectionAttempt: jest.fn().mockResolvedValue(undefined),
    logQueryExecution: jest.fn().mockResolvedValue(undefined),
    logQueryFailed: jest.fn().mockResolvedValue(undefined),
  };
}

function makeCrlCache(revokedIds: string[] = []) {
  return {
    isRevoked: jest.fn().mockImplementation(async (certId: string) => revokedIds.includes(certId)),
    forceRefresh: jest.fn().mockResolvedValue(undefined),
  } as unknown as CrlCacheService;
}

function makeSvc(overrides: {
  prisma?: any;
  entitlement?: any;
  certProvider?: any;
  storageProvider?: any;
  audit?: any;
  queryGuard?: Partial<QueryGuard>;
  crlCache?: CrlCacheService;
} = {}) {
  const prisma = overrides.prisma ?? makePrisma();
  const entitlement = overrides.entitlement ?? makeEntitlement();
  const clientFactory = new SecureClientFactory();
  const audit = overrides.audit ?? makeAudit();
  const certProvider = overrides.certProvider ?? makeCertProvider();
  const storageProvider = overrides.storageProvider ?? makeStorageProvider();
  const queryGuard = Object.assign(new QueryGuard(), overrides.queryGuard ?? {});
  const crlCache = overrides.crlCache ?? makeCrlCache();

  const svc = new SecureGatewayService(
    prisma as any,
    entitlement as any,
    clientFactory,
    audit as any,
    queryGuard,
    crlCache,
    certProvider as any,
    storageProvider as any,
  );

  return { svc, prisma, entitlement, certProvider, storageProvider, audit, queryGuard, crlCache };
}

// ── connect() — 5C.1 policy ───────────────────────────────────────────────────

describe('SecureGatewayService.connect', () => {
  it('returns policy and accessLevel — NO private key in response', async () => {
    const { svc } = makeSvc();
    const res = await svc.connect(PROJECT_ID, USER_ID, CERT_ID);

    expect(res.status).toBe('connected');
    expect(res.accessLevel).toBe('READ_WRITE');
    expect(res.policy.allowedAccess).toBe('READ_WRITE');
    expect(res).not.toHaveProperty('params');
    expect(JSON.stringify(res)).not.toContain('SECRET');
    expect(JSON.stringify(res)).not.toContain('PRIVATE KEY');
  });

  it('policy.allowedAccess reflects cert accessLevel — READ cert → READ policy', async () => {
    const readCert = { ...MOCK_CERT_ROW, accessLevel: 'READ' };
    const { svc } = makeSvc({ prisma: makePrisma(readCert) });

    const res = await svc.connect(PROJECT_ID, USER_ID, CERT_ID);
    expect(res.accessLevel).toBe('READ');
    expect(res.policy.allowedAccess).toBe('READ');
  });

  it('missing entitlement → 403', async () => {
    const { svc } = makeSvc({ entitlement: makeEntitlement(false) });
    await expect(svc.connect(PROJECT_ID, USER_ID, CERT_ID)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('5C.1 expired ACTIVE cert → 403 ForbiddenException', async () => {
    const expired = { ...MOCK_CERT_ROW, notAfter: new Date('2020-01-01') };
    const { svc } = makeSvc({ prisma: makePrisma(expired) });
    await expect(svc.connect(PROJECT_ID, USER_ID, CERT_ID)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('5C.1 expired cert → audit logs cert_expired before 403', async () => {
    const expired = { ...MOCK_CERT_ROW, notAfter: new Date('2020-01-01') };
    const audit = makeAudit();
    const { svc } = makeSvc({ prisma: makePrisma(expired), audit });
    await svc.connect(PROJECT_ID, USER_ID, CERT_ID).catch(() => null);
    expect(audit.logConnectionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'cert_expired' }),
    );
  });

  it('5C.3 CRL cache revoked cert → 403, no OpenBao call', async () => {
    const certProvider = makeCertProvider();
    const { svc } = makeSvc({ crlCache: makeCrlCache([CERT_ID]), certProvider });
    await expect(svc.connect(PROJECT_ID, USER_ID, CERT_ID)).rejects.toBeInstanceOf(ForbiddenException);
    expect(certProvider.getBundle).not.toHaveBeenCalled();
  });

  it('5C.3 CRL cache revoked cert → audit logs crl_revoked', async () => {
    const audit = makeAudit();
    const { svc } = makeSvc({ crlCache: makeCrlCache([CERT_ID]), audit });
    await svc.connect(PROJECT_ID, USER_ID, CERT_ID).catch(() => null);
    expect(audit.logConnectionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'crl_revoked' }),
    );
  });

  it('revoked certificate (DB status) → 403', async () => {
    const { svc } = makeSvc({ prisma: makePrisma({ ...MOCK_CERT_ROW, status: 'REVOKED' }) });
    await expect(svc.connect(PROJECT_ID, USER_ID, CERT_ID)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('OpenBao unavailable → 503 ServiceUnavailableException', async () => {
    const { svc } = makeSvc({ certProvider: makeCertProvider(new Error('openbao:8200 refused')) });
    await expect(svc.connect(PROJECT_ID, USER_ID, CERT_ID)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('connect() response never contains params, sslKey, privateKeyPem', async () => {
    const { svc } = makeSvc();
    const res = await svc.connect(PROJECT_ID, USER_ID, CERT_ID);
    const json = JSON.stringify(res);
    expect(json).not.toContain('sslKey');
    expect(json).not.toContain('privateKeyPem');
    expect(json).not.toContain('SECRET');
  });
});

// ── getConnectionBundle() — internal mTLS ────────────────────────────────────

describe('SecureGatewayService.getConnectionBundle', () => {
  it('returns ConnectionParams with mTLS fields — sslKey is privateKeyPem in memory', async () => {
    const { svc } = makeSvc();
    const { params } = await svc.getConnectionBundle(PROJECT_ID, USER_ID, CERT_ID);

    expect(params.sslCert).toBe(MOCK_BUNDLE.certificatePem);
    expect(params.sslKey).toBe(MOCK_BUNDLE.privateKeyPem);
    expect(params.sslCa).toBe(MOCK_BUNDLE.caCertPem);
    expect(params.requireMtls).toBe(true);
  });

  it('missing entitlement → 403 ForbiddenException', async () => {
    const { svc } = makeSvc({ entitlement: makeEntitlement(false) });
    await expect(svc.getConnectionBundle(PROJECT_ID, USER_ID, CERT_ID)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('missing entitlement → audit logs denied_entitlement', async () => {
    const audit = makeAudit();
    const { svc } = makeSvc({ entitlement: makeEntitlement(false), audit });
    await svc.getConnectionBundle(PROJECT_ID, USER_ID, CERT_ID).catch(() => null);
    expect(audit.logConnectionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'denied_entitlement' }),
    );
  });

  it('5C.1 expired ACTIVE cert → 403 ForbiddenException', async () => {
    const expired = { ...MOCK_CERT_ROW, notAfter: new Date('2020-01-01') };
    const { svc } = makeSvc({ prisma: makePrisma(expired) });
    await expect(svc.getConnectionBundle(PROJECT_ID, USER_ID, CERT_ID)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('5C.1 expired cert → audit logs cert_expired', async () => {
    const expired = { ...MOCK_CERT_ROW, notAfter: new Date('2020-01-01') };
    const audit = makeAudit();
    const { svc } = makeSvc({ prisma: makePrisma(expired), audit });
    await svc.getConnectionBundle(PROJECT_ID, USER_ID, CERT_ID).catch(() => null);
    expect(audit.logConnectionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'cert_expired' }),
    );
  });

  it('5C.3 CRL cache revoked cert → 403, no OpenBao bundle fetch', async () => {
    const certProvider = makeCertProvider();
    const { svc } = makeSvc({ crlCache: makeCrlCache([CERT_ID]), certProvider });
    await expect(svc.getConnectionBundle(PROJECT_ID, USER_ID, CERT_ID)).rejects.toBeInstanceOf(ForbiddenException);
    expect(certProvider.getBundle).not.toHaveBeenCalled();
  });

  it('5C.3 CRL cache revoked cert → audit logs crl_revoked', async () => {
    const audit = makeAudit();
    const { svc } = makeSvc({ crlCache: makeCrlCache([CERT_ID]), audit });
    await svc.getConnectionBundle(PROJECT_ID, USER_ID, CERT_ID).catch(() => null);
    expect(audit.logConnectionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'crl_revoked' }),
    );
  });

  it('revoked certificate (DB status) → 403', async () => {
    const { svc } = makeSvc({ prisma: makePrisma({ ...MOCK_CERT_ROW, status: 'REVOKED' }) });
    await expect(svc.getConnectionBundle(PROJECT_ID, USER_ID, CERT_ID)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('revoked certificate → audit logs cert_inactive', async () => {
    const audit = makeAudit();
    const { svc } = makeSvc({ prisma: makePrisma({ ...MOCK_CERT_ROW, status: 'REVOKED' }), audit });
    await svc.getConnectionBundle(PROJECT_ID, USER_ID, CERT_ID).catch(() => null);
    expect(audit.logConnectionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'cert_inactive' }),
    );
  });

  it('certificate not found → NotFoundException', async () => {
    const { svc } = makeSvc({ prisma: makePrisma(null) });
    await expect(svc.getConnectionBundle(PROJECT_ID, USER_ID, CERT_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('OpenBao unavailable → ServiceUnavailableException', async () => {
    const { svc } = makeSvc({ certProvider: makeCertProvider(new Error('connection refused')) });
    await expect(svc.getConnectionBundle(PROJECT_ID, USER_ID, CERT_ID)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('OpenBao unavailable → audit logs openbao_unavailable with error', async () => {
    const audit = makeAudit();
    const { svc } = makeSvc({ certProvider: makeCertProvider(new Error('timeout')), audit });
    await svc.getConnectionBundle(PROJECT_ID, USER_ID, CERT_ID).catch(() => null);
    expect(audit.logConnectionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'openbao_unavailable', error: 'timeout' }),
    );
  });

  it('successful connect → audit logs connected', async () => {
    const audit = makeAudit();
    const { svc } = makeSvc({ audit });
    await svc.getConnectionBundle(PROJECT_ID, USER_ID, CERT_ID);
    expect(audit.logConnectionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'connected', certId: CERT_ID }),
    );
  });
});

// ── executeQuery() — 5C.1 access level + 5C.2 guards ────────────────────────

describe('SecureGatewayService.executeQuery', () => {
  it('gates on GATEWAY_QUERY entitlement', async () => {
    const entitlement = {
      assertCan: jest.fn().mockRejectedValue(new ForbiddenException('gatewayQuery not in plan')),
    };
    const { svc } = makeSvc({ entitlement });
    await expect(svc.executeQuery(PROJECT_ID, USER_ID, CERT_ID, 'SELECT 1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('READ cert + SELECT → allowed, returns rows', async () => {
    const readCert = { ...MOCK_CERT_ROW, accessLevel: 'READ' };
    const { svc } = makeSvc({ prisma: makePrisma(readCert) });
    const result = await svc.executeQuery(PROJECT_ID, USER_ID, CERT_ID, 'SELECT id FROM items');
    expect(result.rows).toHaveLength(1);
  });

  it('READ cert + INSERT → 403 ForbiddenException', async () => {
    const readCert = { ...MOCK_CERT_ROW, accessLevel: 'READ' };
    const { svc } = makeSvc({ prisma: makePrisma(readCert) });
    await expect(
      svc.executeQuery(PROJECT_ID, USER_ID, CERT_ID, "INSERT INTO items VALUES ('x')"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('READ_WRITE cert + INSERT → allowed', async () => {
    const { svc } = makeSvc();
    await expect(
      svc.executeQuery(PROJECT_ID, USER_ID, CERT_ID, "INSERT INTO items VALUES ('x')"),
    ).resolves.not.toThrow();
  });

  it('delegates to storageProvider.query', async () => {
    const { svc, storageProvider } = makeSvc();
    await svc.executeQuery(PROJECT_ID, USER_ID, CERT_ID, 'SELECT id FROM items LIMIT 10');
    expect(storageProvider.query).toHaveBeenCalledWith('SELECT id FROM items LIMIT 10', undefined);
  });

  it('row limit applied — returns truncated=true when rows exceed maxRowLimit', async () => {
    const bigRows = Array.from({ length: 1500 }, (_, i) => ({ id: i }));
    const { svc } = makeSvc({ storageProvider: makeStorageProvider(bigRows) });
    const result = await svc.executeQuery(PROJECT_ID, USER_ID, CERT_ID, 'SELECT * FROM big');
    expect(result.rows).toHaveLength(1000);
    expect(result.truncated).toBe(true);
  });

  it('audit logs query execution with rowCount and latency', async () => {
    const audit = makeAudit();
    const { svc } = makeSvc({ audit });
    await svc.executeQuery(PROJECT_ID, USER_ID, CERT_ID, 'SELECT 1');
    expect(audit.logQueryExecution).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID, userId: USER_ID, rowCount: 1 }),
    );
  });

  it('audit logs failure when storageProvider.query throws', async () => {
    const audit = makeAudit();
    const storageProvider = makeStorageProvider();
    (storageProvider.query as jest.Mock).mockRejectedValue(new Error('db connection lost'));
    const { svc } = makeSvc({ audit, storageProvider });
    await svc.executeQuery(PROJECT_ID, USER_ID, CERT_ID, 'SELECT 1').catch(() => null);
    expect(audit.logQueryFailed).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'db connection lost' }),
    );
  });
});

// ── Security invariant: privateKeyPem never written to DB ─────────────────────

describe('Security invariant: privateKeyPem never written to DB', () => {
  it('getConnectionBundle: no Prisma write contains privateKeyPem or sslKey bytes', async () => {
    const prisma = makePrisma();
    const { svc } = makeSvc({ prisma });
    await svc.getConnectionBundle(PROJECT_ID, USER_ID, CERT_ID);
    const allCalls = [
      ...(prisma.projectClientCertificate.create as jest.Mock).mock.calls,
      ...(prisma.projectClientCertificate.update as jest.Mock).mock.calls,
    ];
    for (const [arg] of allCalls) {
      const s = JSON.stringify(arg);
      expect(s).not.toContain('SECRET');
      expect(s).not.toContain('PRIVATE KEY');
      expect(s).not.toContain('privateKeyPem');
      expect(s).not.toContain('sslKey');
    }
  });

  it('connect(): response never contains sslKey, privateKeyPem, or private key bytes', async () => {
    const { svc } = makeSvc();
    const res = await svc.connect(PROJECT_ID, USER_ID, CERT_ID);
    const s = JSON.stringify(res);
    expect(s).not.toContain('SECRET');
    expect(s).not.toContain('sslKey');
    expect(s).not.toContain('privateKeyPem');
  });

  it('audit metadata never includes private key bytes', async () => {
    const audit = makeAudit();
    const { svc } = makeSvc({ audit });
    await svc.connect(PROJECT_ID, USER_ID, CERT_ID);
    for (const call of (audit.logConnectionAttempt as jest.Mock).mock.calls) {
      expect(JSON.stringify(call)).not.toContain('SECRET');
      expect(JSON.stringify(call)).not.toContain('PRIVATE KEY');
    }
  });

  it('getConnectionBundle with OpenBao error: no Prisma write occurs', async () => {
    const prisma = makePrisma();
    const { svc } = makeSvc({ prisma, certProvider: makeCertProvider(new Error('openbao down')) });
    await svc.getConnectionBundle(PROJECT_ID, USER_ID, CERT_ID).catch(() => null);
    expect((prisma.projectClientCertificate.create as jest.Mock).mock.calls).toHaveLength(0);
    expect((prisma.projectClientCertificate.update as jest.Mock).mock.calls).toHaveLength(0);
  });
});
