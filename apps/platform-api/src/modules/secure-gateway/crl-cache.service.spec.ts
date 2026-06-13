import { CrlCacheService } from './crl-cache.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

const SERIAL_1 = 'AABBCCDDEEFF';
const SERIAL_2 = '112233445566';

function makePrisma(revokedRows: { id: string; revokedAt: Date | null }[] = [], activeCerts: { id: string; serialNumber: string }[] = []) {
  return {
    projectClientCertificate: {
      findMany: jest.fn().mockImplementation(async ({ where }: any) => {
        if (where?.status === 'REVOKED') return revokedRows;
        if (where?.status === 'ACTIVE') return activeCerts;
        return [];
      }),
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn(),
    },
  };
}

function makeCertProvider(revokedSerials: string[] = [], crlSerials: string[] | null = null) {
  return {
    checkRevocation: jest.fn().mockImplementation(async (serial: string) => ({
      revoked: revokedSerials.includes(serial),
      revokedAt: revokedSerials.includes(serial) ? new Date('2026-06-01') : undefined,
    })),
    // null = CRL unavailable → triggers per-cert fallback (default for existing tests)
    fetchCrlSerials: jest.fn().mockResolvedValue(crlSerials),
    issue: jest.fn(),
    revoke: jest.fn(),
    getBundle: jest.fn(),
    deleteKey: jest.fn(),
  };
}

function makeSvc(
  revokedRows: { id: string; revokedAt: Date | null }[] = [],
  activeCerts: { id: string; serialNumber: string }[] = [],
  certProviderRevokedSerials: string[] = [],
  ttlMs = 999_999_999,
) {
  const prisma = makePrisma(revokedRows, activeCerts);
  const certProvider = makeCertProvider(certProviderRevokedSerials);
  const svc = new CrlCacheService(prisma as any, certProvider as any, ttlMs);
  return { svc, prisma, certProvider };
}

// ── Basic revocation checks ───────────────────────────────────────────────────

describe('CrlCacheService — isRevoked()', () => {
  it('returns false for unknown certId', async () => {
    const { svc } = makeSvc();
    expect(await svc.isRevoked('cert-unknown')).toBe(false);
  });

  it('returns true when certId is in REVOKED rows', async () => {
    const { svc } = makeSvc([{ id: 'cert-1', revokedAt: new Date() }]);
    expect(await svc.isRevoked('cert-1')).toBe(true);
  });

  it('returns false for a non-revoked cert even when others are revoked', async () => {
    const { svc } = makeSvc([{ id: 'cert-bad', revokedAt: new Date() }]);
    expect(await svc.isRevoked('cert-good')).toBe(false);
  });

  it('handles revokedAt=null rows without throwing', async () => {
    const { svc } = makeSvc([{ id: 'cert-null', revokedAt: null }]);
    expect(await svc.isRevoked('cert-null')).toBe(true);
  });
});

// ── TTL caching ───────────────────────────────────────────────────────────────

describe('CrlCacheService — TTL caching', () => {
  it('queries DB on first isRevoked() call', async () => {
    const { svc, prisma } = makeSvc([], [], [], 999_999_999);
    await svc.isRevoked('cert-1');
    expect(prisma.projectClientCertificate.findMany).toHaveBeenCalledTimes(1);
  });

  it('does not re-query DB within TTL window', async () => {
    const { svc, prisma } = makeSvc([], [], [], 999_999_999);
    await svc.isRevoked('cert-1');
    await svc.isRevoked('cert-2');
    await svc.isRevoked('cert-3');
    expect(prisma.projectClientCertificate.findMany).toHaveBeenCalledTimes(1);
  });

  it('always re-queries when ttlMs = 0', async () => {
    const { svc, prisma } = makeSvc([], [], [], 0);
    await svc.isRevoked('cert-1');
    await svc.isRevoked('cert-2');
    expect(prisma.projectClientCertificate.findMany).toHaveBeenCalledTimes(2);
  });

  it('cache invalidated on ttlMs=0 re-query — changed revocation is reflected', async () => {
    let revokedRows: { id: string; revokedAt: Date | null }[] = [];
    const prisma = {
      projectClientCertificate: {
        findMany: jest.fn().mockImplementation(async ({ where }: any) => {
          if (where?.status === 'REVOKED') return revokedRows;
          return [];
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const certProvider = makeCertProvider();
    const svc = new CrlCacheService(prisma as any, certProvider as any, 0);

    expect(await svc.isRevoked('cert-1')).toBe(false);

    revokedRows = [{ id: 'cert-1', revokedAt: new Date() }];
    expect(await svc.isRevoked('cert-1')).toBe(true);
  });
});

// ── forceRefresh() + OpenBao sync ─────────────────────────────────────────────

describe('CrlCacheService — forceRefresh()', () => {
  it('calls DB refresh', async () => {
    const { svc, prisma } = makeSvc([{ id: 'cert-1', revokedAt: new Date() }]);
    await svc.forceRefresh();
    expect(prisma.projectClientCertificate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'REVOKED' } }),
    );
  });

  it('also calls syncFromOpenBao — finds ACTIVE certs and checks OpenBao', async () => {
    const { svc, certProvider } = makeSvc(
      [],
      [{ id: 'cert-a', serialNumber: SERIAL_1 }],
    );
    await svc.forceRefresh();
    expect(certProvider.checkRevocation).toHaveBeenCalledWith(SERIAL_1);
  });

  it('picks up newly revoked cert from OpenBao after initial empty DB load', async () => {
    const prisma = {
      projectClientCertificate: {
        findMany: jest.fn()
          .mockResolvedValueOnce([])   // first refresh: no REVOKED in DB
          .mockResolvedValueOnce([{ id: 'cert-new', serialNumber: SERIAL_1 }])  // ACTIVE certs
          .mockResolvedValueOnce([{ id: 'cert-new', revokedAt: new Date() }]),  // second refresh: REVOKED
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const certProvider = makeCertProvider([SERIAL_1]); // OpenBao says SERIAL_1 is revoked
    const svc = new CrlCacheService(prisma as any, certProvider as any, 999_999_999);

    expect(await svc.isRevoked('cert-new')).toBe(false); // not in cache yet

    await svc.forceRefresh(); // sync finds cert-new revoked in OpenBao
    expect(await svc.isRevoked('cert-new')).toBe(true); // now in cache
  });
});

// ── syncFromOpenBao() ─────────────────────────────────────────────────────────

describe('CrlCacheService — syncFromOpenBao()', () => {
  it('returns synced=0 and checked=0 when no ACTIVE certs', async () => {
    const { svc } = makeSvc();
    const result = await svc.syncFromOpenBao();
    expect(result).toEqual({ synced: 0, checked: 0 });
  });

  it('returns synced=0 when OpenBao reports no revocations', async () => {
    const { svc } = makeSvc([], [{ id: 'cert-a', serialNumber: SERIAL_1 }], []);
    const result = await svc.syncFromOpenBao();
    expect(result.synced).toBe(0);
    expect(result.checked).toBe(1);
  });

  it('detects out-of-band revocation and adds to cache', async () => {
    const { svc } = makeSvc(
      [],
      [{ id: 'cert-a', serialNumber: SERIAL_1 }],
      [SERIAL_1], // OpenBao says SERIAL_1 is revoked
    );
    // Prime the DB cache so lastRefreshedAt is set before sync —
    // otherwise the next isRevoked() call triggers a fresh DB refresh that clears the cache.
    await svc.isRevoked('cert-a');
    await svc.syncFromOpenBao();
    expect(await svc.isRevoked('cert-a')).toBe(true);
  });

  it('returns synced=N matching discovered revocations', async () => {
    const { svc } = makeSvc(
      [],
      [
        { id: 'cert-a', serialNumber: SERIAL_1 },
        { id: 'cert-b', serialNumber: SERIAL_2 },
      ],
      [SERIAL_1, SERIAL_2],
    );
    const result = await svc.syncFromOpenBao();
    expect(result.synced).toBe(2);
    expect(result.checked).toBe(2);
  });

  it('syncs revoked cert back to Prisma', async () => {
    const { svc, prisma } = makeSvc(
      [],
      [{ id: 'cert-a', serialNumber: SERIAL_1 }],
      [SERIAL_1],
    );
    await svc.syncFromOpenBao();
    expect(prisma.projectClientCertificate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cert-a' },
        data: expect.objectContaining({ status: 'REVOKED' }),
      }),
    );
  });

  it('continues when Prisma update fails (non-fatal)', async () => {
    const prisma = {
      projectClientCertificate: {
        findMany: jest.fn()
          .mockResolvedValueOnce([])   // first isRevoked() → REVOKED query (prime)
          .mockResolvedValue([{ id: 'cert-a', serialNumber: SERIAL_1 }]),  // ACTIVE query
        update: jest.fn().mockRejectedValue(new Error('DB error')),
      },
    };
    const certProvider = makeCertProvider([SERIAL_1]);
    const svc = new CrlCacheService(prisma as any, certProvider as any, 999_999_999);
    await svc.isRevoked('cert-a'); // prime lastRefreshedAt
    // Must not throw even when Prisma update fails
    const result = await svc.syncFromOpenBao();
    expect(result.synced).toBe(1);
    // Still added to cache despite DB failure
    expect(await svc.isRevoked('cert-a')).toBe(true);
  });

  it('scoped to projectId when provided', async () => {
    const { svc, prisma } = makeSvc(
      [],
      [{ id: 'cert-a', serialNumber: SERIAL_1 }],
    );
    await svc.syncFromOpenBao('proj-x');
    expect(prisma.projectClientCertificate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ projectId: 'proj-x' }) }),
    );
  });

  it('calls checkRevocation once per ACTIVE cert', async () => {
    const { svc, certProvider } = makeSvc(
      [],
      [
        { id: 'cert-a', serialNumber: SERIAL_1 },
        { id: 'cert-b', serialNumber: SERIAL_2 },
      ],
    );
    await svc.syncFromOpenBao();
    expect(certProvider.checkRevocation).toHaveBeenCalledTimes(2);
    expect(certProvider.checkRevocation).toHaveBeenCalledWith(SERIAL_1);
    expect(certProvider.checkRevocation).toHaveBeenCalledWith(SERIAL_2);
  });
});

// ── DB query shape ────────────────────────────────────────────────────────────

describe('CrlCacheService — DB query shape', () => {
  it('isRevoked: queries WHERE status=REVOKED with id + revokedAt select', async () => {
    const { svc, prisma } = makeSvc();
    await svc.isRevoked('x');
    expect(prisma.projectClientCertificate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'REVOKED' },
        select: { id: true, revokedAt: true },
      }),
    );
  });

  it('syncFromOpenBao: queries WHERE status=ACTIVE with id + serialNumber select', async () => {
    const { svc, prisma } = makeSvc();
    await svc.syncFromOpenBao();
    expect(prisma.projectClientCertificate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'ACTIVE' },
        select: { id: true, serialNumber: true },
      }),
    );
  });
});

// ── ttlMs exposure ────────────────────────────────────────────────────────────

describe('CrlCacheService — ttlMs', () => {
  it('exposes configured ttlMs', () => {
    const { svc } = makeSvc([], [], [], 12_345);
    expect(svc.ttlMs).toBe(12_345);
  });

  it('defaults to 5 minutes', () => {
    const prisma = makePrisma();
    const certProvider = makeCertProvider();
    const svc = new CrlCacheService(prisma as any, certProvider as any);
    expect(svc.ttlMs).toBe(5 * 60 * 1000);
  });
});

// ── syncFromOpenBao() — CRL path ──────────────────────────────────────────────

describe('CrlCacheService — syncFromOpenBao() CRL path', () => {
  function makeCrlSvc(
    revokedRows: { id: string; revokedAt: Date | null }[] = [],
    activeCerts: { id: string; serialNumber: string }[] = [],
    crlSerials: string[] | null = null,
    perCertRevokedSerials: string[] = [],
    ttlMs = 999_999_999,
  ) {
    const prisma = makePrisma(revokedRows, activeCerts);
    const certProvider = makeCertProvider(perCertRevokedSerials, crlSerials);
    const svc = new CrlCacheService(prisma as any, certProvider as any, ttlMs);
    return { svc, prisma, certProvider };
  }

  it('uses CRL serials and skips per-cert checkRevocation when CRL is available', async () => {
    const { svc, certProvider } = makeCrlSvc(
      [],
      [{ id: 'cert-a', serialNumber: SERIAL_1 }],
      [SERIAL_1], // CRL says SERIAL_1 revoked
    );
    await svc.isRevoked('cert-a'); // prime lastRefreshedAt
    await svc.syncFromOpenBao();
    expect(certProvider.checkRevocation).not.toHaveBeenCalled();
    expect(await svc.isRevoked('cert-a')).toBe(true);
  });

  it('empty CRL returns synced=0 checked=0 without querying ACTIVE certs', async () => {
    const { svc, prisma, certProvider } = makeCrlSvc(
      [],
      [{ id: 'cert-a', serialNumber: SERIAL_1 }],
      [], // empty CRL
    );
    const result = await svc.syncFromOpenBao();
    expect(result).toEqual({ synced: 0, checked: 0 });
    expect(certProvider.checkRevocation).not.toHaveBeenCalled();
    expect(prisma.projectClientCertificate.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'ACTIVE' } }),
    );
  });

  it('CRL path: only revokes certs whose serial is in the CRL set', async () => {
    const { svc } = makeCrlSvc(
      [],
      [
        { id: 'cert-a', serialNumber: SERIAL_1 },
        { id: 'cert-b', serialNumber: SERIAL_2 },
      ],
      [SERIAL_1], // only SERIAL_1 in CRL
    );
    await svc.isRevoked('cert-a'); // prime
    const result = await svc.syncFromOpenBao();
    expect(result.synced).toBe(1);
    expect(result.checked).toBe(2);
    expect(await svc.isRevoked('cert-a')).toBe(true);
    expect(await svc.isRevoked('cert-b')).toBe(false);
  });

  it('CRL path: syncs matched cert back to Prisma', async () => {
    const { svc, prisma } = makeCrlSvc(
      [],
      [{ id: 'cert-a', serialNumber: SERIAL_1 }],
      [SERIAL_1],
    );
    await svc.isRevoked('cert-a'); // prime
    await svc.syncFromOpenBao();
    expect(prisma.projectClientCertificate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cert-a' },
        data: expect.objectContaining({ status: 'REVOKED' }),
      }),
    );
  });

  it('CRL path: Prisma write-back is non-fatal', async () => {
    const prisma = {
      projectClientCertificate: {
        findMany: jest.fn()
          .mockResolvedValueOnce([])                                  // isRevoked() prime
          .mockResolvedValue([{ id: 'cert-a', serialNumber: SERIAL_1 }]), // ACTIVE query
        update: jest.fn().mockRejectedValue(new Error('DB error')),
      },
    };
    const certProvider = makeCertProvider([], [SERIAL_1]);
    const svc = new CrlCacheService(prisma as any, certProvider as any, 999_999_999);
    await svc.isRevoked('cert-a'); // prime
    const result = await svc.syncFromOpenBao();
    expect(result.synced).toBe(1);
    expect(await svc.isRevoked('cert-a')).toBe(true); // cache updated despite DB failure
  });

  it('CRL path: scoped by projectId', async () => {
    const { svc, prisma } = makeCrlSvc(
      [],
      [{ id: 'cert-a', serialNumber: SERIAL_1 }],
      [SERIAL_1],
    );
    await svc.isRevoked('cert-a'); // prime
    await svc.syncFromOpenBao('proj-x');
    expect(prisma.projectClientCertificate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ projectId: 'proj-x' }) }),
    );
  });

  it('CRL unavailable (null) falls back to per-cert checkRevocation', async () => {
    const { svc, certProvider } = makeCrlSvc(
      [],
      [{ id: 'cert-a', serialNumber: SERIAL_1 }],
      null,        // CRL unavailable
      [SERIAL_1],  // per-cert says SERIAL_1 revoked
    );
    await svc.isRevoked('cert-a'); // prime
    await svc.syncFromOpenBao();
    expect(certProvider.checkRevocation).toHaveBeenCalledWith(SERIAL_1);
    expect(await svc.isRevoked('cert-a')).toBe(true);
  });

  it('fallback does not throw when CRL is null and per-cert also finds nothing', async () => {
    const { svc } = makeCrlSvc([], [], null, []);
    await expect(svc.syncFromOpenBao()).resolves.toEqual({ synced: 0, checked: 0 });
  });
});
