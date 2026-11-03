import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ProjectApiKeysService } from './project-api-keys.service';
import { hashSecretKey, isSecretKey } from '../../common/utils/secret-keys';

function build(opts: { role?: 'OWNER' | 'ADMIN' | 'MEMBER'; serviceUsed?: boolean } = {}) {
  const project = {
    id: 'p1',
    teamId: 't1',
    anonKey: 'bf_anon_publicvalue',
    serviceKey: 'bf_service_abcdefghijklmnopqrstuvwxyz0123456789ABCD',
    serviceKeyLastUsedAt: opts.serviceUsed ? new Date('2026-11-03T10:00:00Z') : null,
  };
  const keys: any[] = [];
  const prisma = {
    project: {
      findFirst: jest.fn(async () => project),
      update: jest.fn(async ({ data }: any) => Object.assign(project, data)),
    },
    teamMember: { findUnique: jest.fn(async () => ({ role: opts.role ?? 'OWNER' })) },
    teamRolePermission: { findUnique: jest.fn(async () => null) },
    projectSecretKey: {
      findMany: jest.fn(async () => keys.filter((k) => !k.revokedAt)),
      count: jest.fn(async () => keys.filter((k) => !k.revokedAt).length),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `k${keys.length + 1}`, createdAt: new Date(), lastUsedAt: null, revokedAt: null, ...data };
        keys.push(row);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const k = keys.find((x) => x.id === where.id && x.projectId === where.projectId && !x.revokedAt);
        if (k) Object.assign(k, data);
        return { count: k ? 1 : 0 };
      }),
    },
  };
  return { svc: new ProjectApiKeysService(prisma as any), prisma, project, keys };
}

describe('ProjectApiKeysService', () => {
  it('lists the service key masked, and revealable while no application has used it', async () => {
    const { svc, project } = build();
    const view = await svc.list('p1', 'u1');
    expect(view.anonKey).toBe(project.anonKey);
    expect(view.serviceKey.masked).toMatch(/^bf_service_…?/);
    expect(view.serviceKey.masked).not.toContain('klmnop');
    expect(view.serviceKey.masked.endsWith('ABCD')).toBe(true);
    expect(view.serviceKey.revealable).toBe(true);
    await expect(svc.revealServiceKey('p1', 'u1')).resolves.toEqual({ serviceKey: project.serviceKey });
  });

  it('stops revealing the service key once it has been used', async () => {
    const { svc } = build({ serviceUsed: true });
    expect((await svc.list('p1', 'u1')).serviceKey.revealable).toBe(false);
    await expect(svc.revealServiceKey('p1', 'u1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('rotates the service key: a new value, returned once, revealable again until used', async () => {
    const { svc, project } = build({ serviceUsed: true });
    const before = project.serviceKey;
    const { serviceKey } = await svc.rotateServiceKey('p1', 'u1');
    expect(serviceKey).toMatch(/^bf_service_[A-Za-z0-9_-]{43}$/);
    expect(serviceKey).not.toBe(before);
    expect(project.serviceKey).toBe(serviceKey);
    expect(project.serviceKeyLastUsedAt).toBeNull();
  });

  it('rotates the anon key: a new public key, the service key untouched', async () => {
    const { svc, project } = build();
    const { anonKey: before } = { anonKey: project.anonKey };
    const service = project.serviceKey;
    const { anonKey } = await svc.rotateAnonKey('p1', 'u1');
    expect(anonKey).toMatch(/^bf_anon_[A-Za-z0-9_-]{43}$/);
    expect(anonKey).not.toBe(before);
    expect(project.anonKey).toBe(anonKey);
    expect(project.serviceKey).toBe(service);
    expect((await svc.list('p1', 'u1')).anonKey).toBe(anonKey);
  });

  it('a member without the credentials permission cannot rotate the anon key', async () => {
    const { svc } = build({ role: 'MEMBER' });
    await expect(svc.rotateAnonKey('p1', 'u1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('creates a secret key: the full value once, only its hash stored', async () => {
    const { svc, keys } = build();
    const created = await svc.createSecretKey('p1', 'u1', '  ci deploy  ');
    expect(isSecretKey(created.key)).toBe(true);
    expect(created.name).toBe('ci deploy');
    expect(keys[0].keyHash).toBe(hashSecretKey(created.key));
    expect(JSON.stringify(keys[0])).not.toContain(created.key);
    const view = await svc.list('p1', 'u1');
    expect(view.secretKeys).toEqual([
      expect.objectContaining({ id: created.id, name: 'ci deploy', hint: created.hint, lastUsedAt: null }),
    ]);
    expect(JSON.stringify(view)).not.toContain(created.key);
  });

  it('refuses a key without a name', async () => {
    const { svc } = build();
    await expect(svc.createSecretKey('p1', 'u1', '   ')).rejects.toThrow(/name/);
  });

  it('revokes a secret key; a second revoke finds nothing', async () => {
    const { svc } = build();
    const { id } = await svc.createSecretKey('p1', 'u1', 'old server');
    await expect(svc.revokeSecretKey('p1', 'u1', id)).resolves.toEqual({ revoked: true });
    expect((await svc.list('p1', 'u1')).secretKeys).toHaveLength(0);
    await expect(svc.revokeSecretKey('p1', 'u1', id)).rejects.toThrow(/not found/);
  });

  it('lets a member without the credentials permission read but not rotate, create or revoke', async () => {
    const { svc } = build({ role: 'MEMBER' });
    const view = await svc.list('p1', 'u1');
    expect(view.canManage).toBe(false);
    await expect(svc.rotateServiceKey('p1', 'u1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.createSecretKey('p1', 'u1', 'x')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses someone outside the team entirely', async () => {
    const { svc, prisma } = build();
    prisma.teamMember.findUnique.mockResolvedValueOnce(null as any);
    await expect(svc.list('p1', 'stranger')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
