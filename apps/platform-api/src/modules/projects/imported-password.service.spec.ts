// The Keycloak admin client is ESM-only and Jest cannot load it.
jest.mock('../auth/keycloak-admin.service', () => ({ KeycloakAdminService: class {} }));
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { UnauthorizedException } from '@nestjs/common';
import { ImportedPasswordService } from './imported-password.service';

/**
 * A known bcrypt vector in the $2a$ form Supabase writes (the OpenBSD test
 * suite's first entry): "U*U" under a fixed salt. Using a hash produced
 * elsewhere, rather than one this library made, proves the formats agree.
 */
const HASH = '$2a$05$CCCCCCCCCCCCCCCCCCCCC.E5YPO9kmyuRGyh0XouQYb4YMJKvyOeW';
const PASSWORD = 'U*U';

const ROW = {
  id: 'row-1',
  projectId: 'p1',
  keycloakUserId: 'u1',
  email: 'ada@example.com',
  passwordHash: HASH,
  settledAt: null,
};

function build(o: {
  row?: Record<string, unknown> | null;
  existing?: Array<Record<string, unknown>>;
  user?: Record<string, unknown> | null;
  locked?: boolean;
  hasPassword?: boolean;
  reset?: () => Promise<void>;
} = {}) {
  const prisma = {
    importedPasswordHash: {
      findFirst: jest.fn().mockResolvedValue(o.row === undefined ? ROW : o.row),
      findMany: jest.fn().mockResolvedValue(o.existing ?? []),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const keycloak = {
    getRealmUserById: jest
      .fn()
      .mockResolvedValue(o.user === undefined ? { id: 'u1', email: 'Ada@Example.com', enabled: true } : o.user),
    isUserLockedOut: jest.fn().mockResolvedValue(o.locked ?? false),
    userHasPasswordCredential: jest.fn().mockResolvedValue(o.hasPassword ?? false),
    resetRealmUserPassword: jest.fn(o.reset ?? (() => Promise.resolve())),
  };
  const svc = new ImportedPasswordService(prisma as any, keycloak as any);
  (svc as any).logger = { log: jest.fn(), warn: jest.fn() };
  return { svc, prisma, keycloak };
}

const settled = (prisma: ReturnType<typeof build>['prisma']) =>
  prisma.importedPasswordHash.update.mock.calls.some(
    ([arg]: any[]) => arg.where.id === 'row-1' && arg.data.settledAt instanceof Date && arg.data.passwordHash === null,
  );

describe('ImportedPasswordService.isSupportedHash', () => {
  it('accepts the bcrypt forms and nothing else', () => {
    expect(ImportedPasswordService.isSupportedHash(HASH)).toBe(true);
    expect(ImportedPasswordService.isSupportedHash(HASH.replace('$2a$', '$2b$'))).toBe(true);
    expect(ImportedPasswordService.isSupportedHash('$argon2id$v=19$m=65536,t=3,p=4$abc$def')).toBe(false);
    expect(ImportedPasswordService.isSupportedHash('')).toBe(false);
    expect(ImportedPasswordService.isSupportedHash(null)).toBe(false);
  });
});

describe('ImportedPasswordService.adoptOnSignIn', () => {
  it('the old password is handed to Keycloak and the hash is dropped', async () => {
    const { svc, prisma, keycloak } = build();
    await expect(svc.adoptOnSignIn('p1', 'realm-p1', ' ADA@example.com ', PASSWORD)).resolves.toBe(true);
    expect(prisma.importedPasswordHash.findFirst).toHaveBeenCalledWith({
      where: { projectId: 'p1', email: 'ada@example.com', settledAt: null },
    });
    expect(keycloak.resetRealmUserPassword).toHaveBeenCalledWith('realm-p1', 'u1', PASSWORD);
    expect(settled(prisma)).toBe(true);
  });

  it('a wrong password changes nothing', async () => {
    const { svc, prisma, keycloak } = build();
    await expect(svc.adoptOnSignIn('p1', 'realm-p1', 'ada@example.com', 'U*V')).resolves.toBe(false);
    expect(keycloak.resetRealmUserPassword).not.toHaveBeenCalled();
    expect(prisma.importedPasswordHash.update).not.toHaveBeenCalled();
  });

  it('an account with nothing pending never reaches Keycloak', async () => {
    const { svc, keycloak } = build({ row: null });
    await expect(svc.adoptOnSignIn('p1', 'realm-p1', 'ada@example.com', PASSWORD)).resolves.toBe(false);
    expect(keycloak.getRealmUserById).not.toHaveBeenCalled();
  });

  it('a locked-out account is not opened by the second check', async () => {
    const { svc, keycloak } = build({ locked: true });
    await expect(svc.adoptOnSignIn('p1', 'realm-p1', 'ada@example.com', PASSWORD)).resolves.toBe(false);
    expect(keycloak.resetRealmUserPassword).not.toHaveBeenCalled();
  });

  it('a password set in Keycloak since the import supersedes the old one for good', async () => {
    const { svc, prisma, keycloak } = build({ hasPassword: true });
    await expect(svc.adoptOnSignIn('p1', 'realm-p1', 'ada@example.com', PASSWORD)).resolves.toBe(false);
    expect(keycloak.resetRealmUserPassword).not.toHaveBeenCalled();
    expect(settled(prisma)).toBe(true);
  });

  it('a hash whose account changed its address no longer belongs to this email', async () => {
    const { svc, prisma, keycloak } = build({ user: { id: 'u1', email: 'someone@else.com', enabled: true } });
    await expect(svc.adoptOnSignIn('p1', 'realm-p1', 'ada@example.com', PASSWORD)).resolves.toBe(false);
    expect(keycloak.resetRealmUserPassword).not.toHaveBeenCalled();
    expect(settled(prisma)).toBe(true);
  });

  it('a disabled account stays shut', async () => {
    const { svc, keycloak } = build({ user: { id: 'u1', email: 'ada@example.com', enabled: false } });
    await expect(svc.adoptOnSignIn('p1', 'realm-p1', 'ada@example.com', PASSWORD)).resolves.toBe(false);
    expect(keycloak.resetRealmUserPassword).not.toHaveBeenCalled();
  });

  it('says so when the password is right but the realm rules refuse it, and keeps the hash', async () => {
    const { svc, prisma } = build({
      reset: () => Promise.reject(Object.assign(new Error('invalidPasswordMinLengthMessage'), { response: { status: 400 } })),
    });
    const err = await svc.adoptOnSignIn('p1', 'realm-p1', 'ada@example.com', PASSWORD).catch((e) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err.getResponse()).toMatchObject({ code: 'password_reset_required' });
    expect(prisma.importedPasswordHash.update).not.toHaveBeenCalled();
  });

  it('a failing lookup leaves the original refusal to stand', async () => {
    const { svc, prisma, keycloak } = build();
    prisma.importedPasswordHash.findFirst.mockRejectedValue(new Error('relation does not exist'));
    await expect(svc.adoptOnSignIn('p1', 'realm-p1', 'ada@example.com', PASSWORD)).resolves.toBe(false);
    expect(keycloak.getRealmUserById).not.toHaveBeenCalled();
  });

  it('an unreachable Keycloak leaves the original refusal to stand', async () => {
    const { svc, keycloak } = build();
    keycloak.getRealmUserById.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(svc.adoptOnSignIn('p1', 'realm-p1', 'ada@example.com', PASSWORD)).resolves.toBe(false);
    expect(keycloak.resetRealmUserPassword).not.toHaveBeenCalled();
  });
});

describe('ImportedPasswordService.stash', () => {
  it('keeps supported hashes for new users and skips the rest', async () => {
    const { svc, prisma } = build();
    const pending = await svc.stash('p1', [
      { userId: 'u1', email: 'Ada@Example.com', hash: HASH },
      { userId: 'u2', email: 'bob@example.com', hash: '$argon2id$v=19$m=65536,t=3,p=4$abc$def' },
      { userId: 'u3', email: '', hash: HASH },
    ]);
    expect(pending).toBe(1);
    expect(prisma.importedPasswordHash.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ projectId: 'p1', keycloakUserId: 'u1', email: 'ada@example.com', passwordHash: HASH }),
      ],
      skipDuplicates: true,
    });
  });

  it('never re-arms a settled hash, and refreshes a pending one that changed at the source', async () => {
    const newer = HASH.replace('E5YPO9', 'F5YPO9');
    const { svc, prisma } = build({
      existing: [
        { id: 'r1', keycloakUserId: 'u1', passwordHash: null, settledAt: new Date() },
        { id: 'r2', keycloakUserId: 'u2', passwordHash: HASH, settledAt: null },
        { id: 'r3', keycloakUserId: 'u3', passwordHash: HASH, settledAt: null },
      ],
    });
    const pending = await svc.stash('p1', [
      { userId: 'u1', email: 'a@example.com', hash: HASH },
      { userId: 'u2', email: 'b@example.com', hash: newer },
      { userId: 'u3', email: 'c@example.com', hash: HASH },
    ]);
    expect(pending).toBe(2);
    expect(prisma.importedPasswordHash.createMany).not.toHaveBeenCalled();
    expect(prisma.importedPasswordHash.update).toHaveBeenCalledTimes(1);
    expect(prisma.importedPasswordHash.update).toHaveBeenCalledWith({
      where: { id: 'r2' },
      data: { passwordHash: newer, email: 'b@example.com' },
    });
  });
});
