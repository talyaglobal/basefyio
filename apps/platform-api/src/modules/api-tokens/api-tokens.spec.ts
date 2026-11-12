import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ApiTokensService } from './api-tokens.service';
import { generateToken, hashToken, isPlatformToken } from './platform-token.util';

describe('platform-token.util', () => {
  it('generates a bf_pat_ token with a matching sha256 hash + prefix', () => {
    const { token, hash, prefix } = generateToken();
    expect(token.startsWith('bf_pat_')).toBe(true);
    expect(isPlatformToken(token)).toBe(true);
    expect(isPlatformToken('bf_anon_x')).toBe(false);
    expect(hash).toBe(hashToken(token));
    expect(token.startsWith(prefix)).toBe(true);
    expect(hash).toHaveLength(64);
  });
});

function makePrisma(overrides: any = {}) {
  return {
    platformApiToken: {
      create: jest.fn().mockImplementation(({ data, select }) => ({
        id: 't1',
        name: data.name,
        tokenPrefix: data.tokenPrefix,
        scopes: data.scopes,
        teamId: data.teamId,
        status: 'active',
        expiresAt: data.expiresAt,
        lastUsedAt: null,
        createdAt: new Date(),
      })),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      ...overrides.platformApiToken,
    },
    teamMember: { findUnique: jest.fn().mockResolvedValue({ id: 'm1' }) },
  } as any;
}

describe('ApiTokensService', () => {
  it('creates a token and returns the secret once', async () => {
    const svc = new ApiTokensService(makePrisma());
    const r = await svc.create('u1', { name: 'agent', scopes: ['projects:read', 'sql:run'] });
    expect(r.token.startsWith('bf_pat_')).toBe(true);
    expect(r.scopes).toEqual(['projects:read', 'sql:run']);
  });

  it('rejects an unknown scope', async () => {
    const svc = new ApiTokensService(makePrisma());
    await expect(svc.create('u1', { name: 'x', scopes: ['bogus:scope'] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects an empty scope list and a past expiry', async () => {
    const svc = new ApiTokensService(makePrisma());
    await expect(svc.create('u1', { name: 'x', scopes: [] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.create('u1', { name: 'x', scopes: ['sql:run'], expiresAt: '2000-01-01' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('verifies an active token and returns its scopes', async () => {
    const prisma = makePrisma();
    prisma.platformApiToken.findUnique.mockResolvedValue({
      id: 't1', userId: 'u1', teamId: null, scopes: ['sql:run'], status: 'active', expiresAt: null, lastUsedAt: null,
    });
    const svc = new ApiTokensService(prisma);
    const v = await svc.verify('bf_pat_whatever');
    expect(v).toMatchObject({ userId: 'u1', scopes: ['sql:run'] });
  });

  it('rejects a revoked or expired token', async () => {
    const prisma = makePrisma();
    const svc = new ApiTokensService(prisma);
    prisma.platformApiToken.findUnique.mockResolvedValueOnce({ status: 'revoked', scopes: [], expiresAt: null });
    await expect(svc.verify('bf_pat_x')).rejects.toThrow();
    prisma.platformApiToken.findUnique.mockResolvedValueOnce({
      status: 'active', scopes: [], expiresAt: new Date(Date.now() - 1000), userId: 'u1', teamId: null,
    });
    await expect(svc.verify('bf_pat_x')).rejects.toThrow();
  });
});

describe('ApiTokensService — revocation is final', () => {
  function withToken(row: { status: string; expiresAt?: Date | null }) {
    const prisma = makePrisma({
      platformApiToken: {
        findFirst: jest.fn().mockResolvedValue({ id: 't1', expiresAt: null, ...row }),
        updateMany: jest.fn().mockResolvedValue({ count: row.status === 'active' ? 1 : 0 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    });
    return { prisma, svc: new ApiTokensService(prisma) };
  }

  it('refuses to roll a revoked token and never writes', async () => {
    const { prisma, svc } = withToken({ status: 'revoked' });
    await expect(svc.roll('u1', 't1')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.platformApiToken.updateMany).not.toHaveBeenCalled();
    expect(prisma.platformApiToken.update).not.toHaveBeenCalled();
  });

  it('refuses to edit a revoked token', async () => {
    const { prisma, svc } = withToken({ status: 'revoked' });
    await expect(svc.update('u1', 't1', { name: 'again' })).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.platformApiToken.updateMany).not.toHaveBeenCalled();
  });

  it('rolls an active token without touching its status, guarded on status=active', async () => {
    const { prisma, svc } = withToken({ status: 'active' });
    const r = await svc.roll('u1', 't1');
    expect(r.token.startsWith('bf_pat_')).toBe(true);
    const call = prisma.platformApiToken.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: 't1', userId: 'u1', status: 'active' });
    expect(call.data).not.toHaveProperty('status');
  });

  it('loses the race to a concurrent revoke instead of reviving the token', async () => {
    const { prisma, svc } = withToken({ status: 'active' });
    prisma.platformApiToken.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(svc.roll('u1', 't1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses to roll an expired token', async () => {
    const { svc } = withToken({ status: 'active', expiresAt: new Date(Date.now() - 1000) });
    await expect(svc.roll('u1', 't1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('deletes only a revoked token', async () => {
    const active = withToken({ status: 'active' });
    await expect(active.svc.remove('u1', 't1')).rejects.toBeInstanceOf(ConflictException);
    expect(active.prisma.platformApiToken.deleteMany).not.toHaveBeenCalled();

    const revoked = withToken({ status: 'revoked' });
    await expect(revoked.svc.remove('u1', 't1')).resolves.toEqual({ deleted: true });
    expect(revoked.prisma.platformApiToken.deleteMany.mock.calls[0][0].where).toEqual({
      id: 't1',
      userId: 'u1',
      status: { not: 'active' },
    });
  });

  it('a token owned by someone else is not found', async () => {
    const prisma = makePrisma({ platformApiToken: { findFirst: jest.fn().mockResolvedValue(null) } });
    const svc = new ApiTokensService(prisma);
    await expect(svc.roll('u2', 't1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
