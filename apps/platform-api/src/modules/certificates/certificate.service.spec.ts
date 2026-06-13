import {
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { CertificateService } from './certificate.service';
import { CERTIFICATE_PROVIDER } from './providers/certificate-provider.interface';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PROJECT_ID = 'proj-1';
const USER_ID = 'user-1';
const CERT_ID = 'cert-1';
const SERIAL = 'AABBCCDDEEFF';

const MOCK_ISSUED = {
  serialNumber: SERIAL,
  fingerprint: 'ABC123',
  subject: `CN=project-${PROJECT_ID}.basefyio.com`,
  certificatePem: '-----BEGIN CERTIFICATE-----\nMOCK\n-----END CERTIFICATE-----',
  privateKeyPem: '-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----',
  caCertPem: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
  openbaoKeyPath: `secret/data/certs/${PROJECT_ID}/${SERIAL}`,
  notBefore: new Date('2026-01-01'),
  notAfter: new Date('2027-01-01'),
};

const MOCK_CERT_ROW = {
  id: CERT_ID,
  projectId: PROJECT_ID,
  subject: MOCK_ISSUED.subject,
  serialNumber: SERIAL,
  fingerprint: MOCK_ISSUED.fingerprint,
  openbaoKeyPath: MOCK_ISSUED.openbaoKeyPath,
  certificatePem: MOCK_ISSUED.certificatePem,
  caCertPem: MOCK_ISSUED.caCertPem,
  accessLevel: 'READ_WRITE',
  status: 'ACTIVE',
  notBefore: MOCK_ISSUED.notBefore,
  notAfter: MOCK_ISSUED.notAfter,
  issuedAt: new Date('2026-01-01'),
  revokedAt: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  entitlementRef: null,
};

function makePrisma(certRows: any[] = [MOCK_CERT_ROW]) {
  return {
    project: {
      findUnique: jest.fn().mockResolvedValue({ id: PROJECT_ID, teamId: 'team-1' }),
    },
    teamMember: {
      findUnique: jest.fn().mockResolvedValue({ id: 'mem-1', role: 'ADMIN' }),
    },
    projectClientCertificate: {
      create: jest.fn().mockResolvedValue(MOCK_CERT_ROW),
      findMany: jest.fn().mockResolvedValue(certRows),
      findFirst: jest.fn().mockImplementation(async ({ where }: any) =>
        certRows.find((c) => c.id === where.id && c.projectId === where.projectId) ?? null,
      ),
      update: jest.fn().mockImplementation(async ({ data }: any) => ({
        ...MOCK_CERT_ROW,
        ...data,
      })),
    },
    certificateEvent: {
      create: jest.fn().mockResolvedValue({ id: 'ev-1' }),
    },
  };
}

function makeProvider(overrides: Partial<{
  issue: jest.Mock;
  revoke: jest.Mock;
  getBundle: jest.Mock;
  deleteKey: jest.Mock;
  checkRevocation: jest.Mock;
}> = {}) {
  return {
    issue: overrides.issue ?? jest.fn().mockResolvedValue(MOCK_ISSUED),
    revoke: overrides.revoke ?? jest.fn().mockResolvedValue(undefined),
    getBundle: overrides.getBundle ?? jest.fn().mockResolvedValue({
      certificatePem: MOCK_ISSUED.certificatePem,
      privateKeyPem: MOCK_ISSUED.privateKeyPem,
      caCertPem: MOCK_ISSUED.caCertPem,
    }),
    deleteKey: overrides.deleteKey ?? jest.fn().mockResolvedValue(undefined),
    checkRevocation: overrides.checkRevocation ?? jest.fn().mockResolvedValue({ revoked: false }),
  };
}

function makeSvc(prismaOverrides?: any, providerOverrides?: any) {
  const prisma = makePrisma();
  Object.assign(prisma, prismaOverrides ?? {});

  const provider = makeProvider(providerOverrides ?? {});
  const entitlement = {
    assertCan: jest.fn().mockResolvedValue(undefined),
  };
  const activity = {
    append: jest.fn().mockResolvedValue(undefined),
  };

  const svc = new CertificateService(
    prisma as any,
    entitlement as any,
    activity as any,
    provider as any,
  );

  return { svc, prisma, provider, entitlement, activity };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CertificateService.list', () => {
  it('returns certificates without privateKeyPem', async () => {
    const { svc } = makeSvc();
    const results = await svc.list(PROJECT_ID, USER_ID);
    expect(results).toHaveLength(1);
    const row = results[0] as any;
    expect(row).not.toHaveProperty('privateKeyPem');
    expect(row).not.toHaveProperty('openbaoKeyPath');
    expect(row.serialNumber).toBe(SERIAL);
  });

  it('throws NotFoundException when project not found', async () => {
    const { svc } = makeSvc({
      project: { findUnique: jest.fn().mockResolvedValue(null) },
    });
    await expect(svc.list(PROJECT_ID, USER_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws ForbiddenException when not a team member', async () => {
    const { svc } = makeSvc({
      teamMember: { findUnique: jest.fn().mockResolvedValue(null) },
    });
    await expect(svc.list(PROJECT_ID, USER_ID)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('CertificateService.issue', () => {
  it('calls provider.issue and returns privateKeyPem in response', async () => {
    const { svc, provider } = makeSvc();
    const result = await svc.issue(PROJECT_ID, USER_ID, { accessLevel: 'READ_WRITE' });

    expect(provider.issue).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID, accessLevel: 'READ_WRITE' }),
    );
    expect(result.privateKeyPem).toBe(MOCK_ISSUED.privateKeyPem);
    expect(result.certificatePem).toBe(MOCK_ISSUED.certificatePem);
    expect(result.serialNumber).toBe(SERIAL);
  });

  it('persists cert WITHOUT privateKeyPem in DB create call', async () => {
    const { svc, prisma } = makeSvc();
    await svc.issue(PROJECT_ID, USER_ID, {});

    const createCall = (prisma.projectClientCertificate.create as jest.Mock).mock.calls[0][0];
    expect(createCall.data).not.toHaveProperty('privateKeyPem');
    expect(createCall.data.openbaoKeyPath).toBe(MOCK_ISSUED.openbaoKeyPath);
  });

  it('records a certificate event', async () => {
    const { svc, prisma } = makeSvc();
    await svc.issue(PROJECT_ID, USER_ID, {});
    expect(prisma.certificateEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'issue' }) }),
    );
  });

  it('appends CERT_ISSUED activity', async () => {
    const { svc, activity } = makeSvc();
    await svc.issue(PROJECT_ID, USER_ID, {});
    expect(activity.append).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({ kind: 'cert.issued' }),
    );
  });

  it('gates on EXTERNAL_DB_ACCESS entitlement', async () => {
    const { svc, entitlement } = makeSvc();
    entitlement.assertCan.mockRejectedValueOnce(new ForbiddenException('No entitlement'));
    await expect(svc.issue(PROJECT_ID, USER_ID, {})).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('CertificateService.revoke', () => {
  it('calls provider.revoke and marks cert REVOKED in DB', async () => {
    const { svc, provider, prisma } = makeSvc();
    await svc.revoke(PROJECT_ID, USER_ID, CERT_ID);

    expect(provider.revoke).toHaveBeenCalledWith(SERIAL);
    expect(prisma.projectClientCertificate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CERT_ID },
        data: expect.objectContaining({ status: 'REVOKED' }),
      }),
    );
  });

  it('throws NotFoundException when cert not found', async () => {
    const { svc } = makeSvc({
      projectClientCertificate: {
        ...makePrisma().projectClientCertificate,
        findFirst: jest.fn().mockResolvedValue(null),
      },
    });
    await expect(svc.revoke(PROJECT_ID, USER_ID, 'bad-id')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is idempotent: already-revoked cert returns without calling provider', async () => {
    const revokedCert = { ...MOCK_CERT_ROW, status: 'REVOKED' };
    const { svc, provider } = makeSvc({
      projectClientCertificate: {
        ...makePrisma().projectClientCertificate,
        findFirst: jest.fn().mockResolvedValue(revokedCert),
      },
    });
    await svc.revoke(PROJECT_ID, USER_ID, CERT_ID);
    expect(provider.revoke).not.toHaveBeenCalled();
  });

  it('records a revoke event', async () => {
    const { svc, prisma } = makeSvc();
    await svc.revoke(PROJECT_ID, USER_ID, CERT_ID);
    expect(prisma.certificateEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'revoke' }) }),
    );
  });
});

describe('CertificateService.getBundle', () => {
  it('returns privateKeyPem from provider — never from DB', async () => {
    const { svc, provider } = makeSvc();
    const bundle = await svc.getBundle(PROJECT_ID, USER_ID, CERT_ID);

    expect(provider.getBundle).toHaveBeenCalledWith(
      MOCK_ISSUED.openbaoKeyPath,
      MOCK_ISSUED.certificatePem,
      MOCK_ISSUED.caCertPem,
    );
    expect(bundle.privateKeyPem).toBe(MOCK_ISSUED.privateKeyPem);
    expect(bundle.certificateId).toBe(CERT_ID);
  });

  it('gates on CERT_DOWNLOAD entitlement', async () => {
    const { svc, entitlement } = makeSvc();
    entitlement.assertCan.mockRejectedValueOnce(new ForbiddenException('certDownload not granted'));
    await expect(svc.getBundle(PROJECT_ID, USER_ID, CERT_ID)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws ForbiddenException when cert is not ACTIVE', async () => {
    const revokedCert = { ...MOCK_CERT_ROW, status: 'REVOKED' };
    const { svc } = makeSvc({
      projectClientCertificate: {
        ...makePrisma().projectClientCertificate,
        findFirst: jest.fn().mockResolvedValue(revokedCert),
      },
    });
    await expect(svc.getBundle(PROJECT_ID, USER_ID, CERT_ID)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('records a download event', async () => {
    const { svc, prisma } = makeSvc();
    await svc.getBundle(PROJECT_ID, USER_ID, CERT_ID);
    expect(prisma.certificateEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'download' }) }),
    );
  });
});

describe('CertificateService.renew', () => {
  it('issues a new cert and revokes the old one', async () => {
    const { svc, provider } = makeSvc();
    const result = await svc.renew(PROJECT_ID, USER_ID, CERT_ID, {});

    expect(provider.issue).toHaveBeenCalledTimes(1);
    expect(provider.revoke).toHaveBeenCalledWith(SERIAL);
    expect(result.privateKeyPem).toBe(MOCK_ISSUED.privateKeyPem);
  });

  it('new cert is issued before old is revoked — no access gap', async () => {
    const { svc, provider } = makeSvc();
    await svc.renew(PROJECT_ID, USER_ID, CERT_ID, {});

    // invocationCallOrder is an ascending integer assigned per-call across all mocks.
    // A lower value means the call happened earlier.
    expect(provider.issue.mock.invocationCallOrder[0])
      .toBeLessThan(provider.revoke.mock.invocationCallOrder[0]);
  });
});

// ── Dead-key custody: deleteKey called after every revocation ─────────────────

describe('Dead-key custody — deleteKey', () => {
  it('revoke: calls deleteKey with the cert openbaoKeyPath', async () => {
    const { svc, provider } = makeSvc();
    await svc.revoke(PROJECT_ID, USER_ID, CERT_ID);
    expect(provider.deleteKey).toHaveBeenCalledWith(MOCK_CERT_ROW.openbaoKeyPath);
  });

  it('revoke: deleteKey failure is non-fatal — DB update and PKI revocation still complete', async () => {
    const { svc, provider, prisma } = makeSvc(undefined, {
      deleteKey: jest.fn().mockRejectedValue(new Error('KV offline')),
    });

    await expect(svc.revoke(PROJECT_ID, USER_ID, CERT_ID)).resolves.toBeUndefined();

    expect(provider.revoke).toHaveBeenCalledWith(SERIAL);
    expect(prisma.projectClientCertificate.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REVOKED' }) }),
    );
  });

  it('renew: deleteKey is called exactly once with the OLD cert openbaoKeyPath', async () => {
    const { svc, provider } = makeSvc();
    await svc.renew(PROJECT_ID, USER_ID, CERT_ID, {});

    // Exactly one deletion: only the old cert's KV entry is removed.
    // The new cert's private key stays in OpenBao.
    expect(provider.deleteKey).toHaveBeenCalledTimes(1);
    expect(provider.deleteKey).toHaveBeenCalledWith(MOCK_CERT_ROW.openbaoKeyPath);
  });

  it('renew: deleteKey failure is non-fatal — renewal response is still returned', async () => {
    const { svc } = makeSvc(undefined, {
      deleteKey: jest.fn().mockRejectedValue(new Error('KV timeout')),
    });

    const result = await svc.renew(PROJECT_ID, USER_ID, CERT_ID, {});
    expect(result.privateKeyPem).toBe(MOCK_ISSUED.privateKeyPem);
  });
});

// ── Key invariant: privateKeyPem never in any DB write ────────────────────────

describe('Security invariant: privateKeyPem never persisted', () => {
  it('issue: DB create data does not contain privateKeyPem', async () => {
    const { svc, prisma } = makeSvc();
    await svc.issue(PROJECT_ID, USER_ID, {});
    const allArgs = (prisma.projectClientCertificate.create as jest.Mock).mock.calls;
    for (const [arg] of allArgs) {
      expect(JSON.stringify(arg)).not.toContain('SECRET');
      expect(JSON.stringify(arg)).not.toContain('privateKeyPem');
    }
  });

  it('revoke: DB update data does not contain privateKeyPem', async () => {
    const { svc, prisma } = makeSvc();
    await svc.revoke(PROJECT_ID, USER_ID, CERT_ID);
    const allArgs = (prisma.projectClientCertificate.update as jest.Mock).mock.calls;
    for (const [arg] of allArgs) {
      expect(JSON.stringify(arg)).not.toContain('privateKeyPem');
    }
  });
});
