import { BadRequestException } from '@nestjs/common';
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

describe('ApiTokensService — revocation is final (feedback #8)', () => {
  const tokenRow = (status: string) => ({ id: 't1', status });

  it('refuses to roll a revoked token, which used to bring it back to active', async () => {
    const prisma = makePrisma({ platformApiToken: { findFirst: jest.fn().mockResolvedValue(tokenRow('revoked')) } });
    const svc = new ApiTokensService(prisma);
    await expect(svc.roll('u1', 't1')).rejects.toThrow(/revoked/);
    expect(prisma.platformApiToken.update).not.toHaveBeenCalled();
  });

  it('refuses to edit a revoked token', async () => {
    const prisma = makePrisma({ platformApiToken: { findFirst: jest.fn().mockResolvedValue(tokenRow('revoked')) } });
    await expect(new ApiTokensService(prisma).update('u1', 't1', { name: 'again' })).rejects.toThrow(/revoked/);
    expect(prisma.platformApiToken.update).not.toHaveBeenCalled();
  });

  it('still rolls an active token: new secret, status stays active', async () => {
    const update = jest.fn().mockResolvedValue({ id: 't1', status: 'active' });
    const prisma = makePrisma({ platformApiToken: { findFirst: jest.fn().mockResolvedValue(tokenRow('active')), update } });
    const res = await new ApiTokensService(prisma).roll('u1', 't1');
    expect(res.token).toMatch(/^bf_pat_/);
    expect(update.mock.calls[0][0].data.status).toBe('active');
  });

  it('revokes an active token, and removes an already revoked one from the list', async () => {
    const del = jest.fn().mockResolvedValue({});
    const active = makePrisma({ platformApiToken: { findFirst: jest.fn().mockResolvedValue(tokenRow('active')), delete: del } });
    await expect(new ApiTokensService(active).revoke('u1', 't1')).resolves.toEqual({ revoked: true });
    expect(active.platformApiToken.update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { status: 'revoked' } });
    expect(del).not.toHaveBeenCalled();

    const revoked = makePrisma({ platformApiToken: { findFirst: jest.fn().mockResolvedValue(tokenRow('revoked')), delete: del } });
    await expect(new ApiTokensService(revoked).revoke('u1', 't1')).resolves.toEqual({ removed: true });
    expect(del).toHaveBeenCalledWith({ where: { id: 't1' } });
  });
});
