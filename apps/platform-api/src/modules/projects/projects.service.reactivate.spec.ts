import { BadGatewayException, ForbiddenException } from '@nestjs/common';
import { QuotaExceededException } from '../billing/quota.service';
import { ProjectsService } from './projects.service';

function build(status: 'PAUSED' | 'DEACTIVATED' = 'PAUSED') {
  const project = { id: 'p1', teamId: 't1', name: 'camp', status, keycloakRealm: 'bf-camp' };
  const prisma = {
    project: {
      findUnique: jest.fn().mockResolvedValue(project),
      update: jest.fn().mockResolvedValue({}),
    },
    teamMember: {
      findUnique: jest.fn().mockResolvedValue({ role: 'MEMBER' }),
      findMany: jest.fn().mockResolvedValue([{ userId: 'u1' }]),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ id: 'u1', firstName: 'A', lastName: 'B', email: 'a@x.io' }) },
    projectUsage: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const keycloak = {
    getRealmState: jest.fn(),
    enableRealm: jest.fn().mockResolvedValue(undefined),
    createRealm: jest.fn().mockResolvedValue(undefined),
    createClients: jest.fn().mockResolvedValue({ anonKey: 'anon2', serviceKey: 'svc2' }),
  };
  const activity = { append: jest.fn().mockResolvedValue(undefined) };
  const quota = { assertCanCreateProject: jest.fn().mockResolvedValue(undefined) };
  const usage = { incrementProjectCount: jest.fn().mockResolvedValue(undefined) };
  const pgbouncer = { regenerateConfig: jest.fn().mockResolvedValue(undefined) };
  const realtime = { publish: jest.fn().mockResolvedValue(undefined) };
  const svc = Object.create(ProjectsService.prototype) as any;
  Object.assign(svc, {
    prisma,
    keycloak,
    activity,
    quota,
    usageService: usage,
    pgbouncer,
    realtime,
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  return { svc: svc as ProjectsService, prisma, keycloak, activity, quota, usage };
}

const activated = (prisma: any) =>
  prisma.project.update.mock.calls.some((c: any[]) => c[0].data?.status === 'ACTIVE');

describe('ProjectsService.reactivate', () => {
  it('enables a disabled realm, verifies it, then activates', async () => {
    const { svc, prisma, keycloak } = build();
    keycloak.getRealmState.mockResolvedValueOnce('disabled').mockResolvedValueOnce('enabled');
    const res = await svc.reactivate('p1', 'u1');
    expect(keycloak.enableRealm).toHaveBeenCalledWith('bf-camp');
    expect(keycloak.createRealm).not.toHaveBeenCalled();
    expect(activated(prisma)).toBe(true);
    expect(res.message).toBe('Project reactivated');
  });

  it('keeps the project PAUSED and answers 502 when enabling fails', async () => {
    const { svc, prisma, keycloak, activity } = build();
    keycloak.getRealmState.mockResolvedValueOnce('disabled');
    keycloak.enableRealm.mockRejectedValueOnce(new Error('keycloak down'));
    await expect(svc.reactivate('p1', 'u1')).rejects.toThrow(BadGatewayException);
    expect(activated(prisma)).toBe(false);
    expect(activity.append).toHaveBeenCalledWith('p1', expect.objectContaining({ title: 'Reactivation failed' }));
  });

  it('refuses to activate when the realm is still disabled after enabling', async () => {
    const { svc, prisma, keycloak } = build();
    keycloak.getRealmState.mockResolvedValueOnce('disabled').mockResolvedValueOnce('disabled');
    await expect(svc.reactivate('p1', 'u1')).rejects.toThrow(BadGatewayException);
    expect(activated(prisma)).toBe(false);
  });

  it('never recreates a realm when Keycloak merely fails to answer', async () => {
    const { svc, keycloak, prisma } = build();
    keycloak.getRealmState.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(svc.reactivate('p1', 'u1')).rejects.toThrow(BadGatewayException);
    expect(keycloak.createRealm).not.toHaveBeenCalled();
    expect(activated(prisma)).toBe(false);
  });

  it('recreates a missing realm, activates, and says users could not be restored', async () => {
    const { svc, prisma, keycloak, activity } = build('DEACTIVATED');
    keycloak.getRealmState.mockResolvedValueOnce('missing');
    const res = await svc.reactivate('p1', 'u1');
    expect(keycloak.createRealm).toHaveBeenCalledWith('bf-camp');
    expect(keycloak.createClients).toHaveBeenCalledWith('bf-camp');
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { anonKey: 'anon2', serviceKey: 'svc2' },
    });
    expect(activated(prisma)).toBe(true);
    expect(res.message).toMatch(/could not be restored/);
    expect(activity.append).toHaveBeenCalledWith('p1', expect.objectContaining({ title: 'Authentication recreated' }));
  });

  it('quota rules are unchanged: DEACTIVATED is checked and counted, PAUSED is not', async () => {
    const d = build('DEACTIVATED');
    d.keycloak.getRealmState.mockResolvedValueOnce('disabled').mockResolvedValueOnce('enabled');
    await d.svc.reactivate('p1', 'u1');
    expect(d.quota.assertCanCreateProject).toHaveBeenCalledWith('t1');
    expect(d.usage.incrementProjectCount).toHaveBeenCalledWith('t1');

    const p = build('PAUSED');
    p.keycloak.getRealmState.mockResolvedValueOnce('disabled').mockResolvedValueOnce('enabled');
    await p.svc.reactivate('p1', 'u1');
    expect(p.quota.assertCanCreateProject).not.toHaveBeenCalled();
    expect(p.usage.incrementProjectCount).not.toHaveBeenCalled();

    const over = build('DEACTIVATED');
    over.quota.assertCanCreateProject.mockRejectedValueOnce(new QuotaExceededException('full', 'projects'));
    await expect(over.svc.reactivate('p1', 'u1')).rejects.toThrow(QuotaExceededException);
    expect(over.keycloak.enableRealm).not.toHaveBeenCalled();
  });

  it('rejects a project that is not deactivated', async () => {
    const { svc, prisma } = build();
    prisma.project.findUnique.mockResolvedValueOnce({ id: 'p1', status: 'ACTIVE' });
    await expect(svc.reactivate('p1', 'u1')).rejects.toThrow(ForbiddenException);
  });
});
