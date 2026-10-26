import { ForbiddenException } from '@nestjs/common';
import { ProjectsService } from './projects.service';

/**
 * Putting a project to sleep on request: the same state the idle sweep
 * produces, chosen by the customer from the status badge. A pause, not a
 * lock — nothing is deleted and a keyed request wakes it again.
 */
function build(opts: { status: 'ACTIVE' | 'PAUSED' | 'DEACTIVATED'; role?: 'OWNER' | 'MEMBER'; creator?: string; count?: number }) {
  const project = {
    id: 'p1',
    teamId: 't1',
    name: 'commitcamp',
    slug: 'commitcamp',
    status: opts.status,
    pausedAt: null,
    idleWarningSentAt: null,
    dbHost: 'postgres',
    dbPort: 5432,
    createdBy: opts.creator ?? 'u1',
    keycloakRealm: 'bf-commitcamp',
    githubToken: null,
    vercelToken: null,
    embeddingApiKey: null,
    githubOwner: null,
    githubRepo: null,
    githubBranch: null,
    vercelProjectId: null,
    folder: null,
    tags: [],
    parent: null,
  };
  const prisma = {
    project: {
      findFirst: jest.fn().mockResolvedValue(project),
      updateMany: jest.fn().mockResolvedValue({ count: opts.count ?? 1 }),
    },
    teamMember: {
      findUnique: jest.fn().mockResolvedValue({ teamId: 't1', userId: 'u1', role: opts.role ?? 'OWNER' }),
      findMany: jest.fn().mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: 'u1', firstName: 'Ada', lastName: 'L', email: 'ada@example.com' }),
    },
  };
  const pgbouncer = { regenerateConfig: jest.fn().mockResolvedValue(undefined) };
  const activity = { append: jest.fn().mockResolvedValue(undefined) };
  const realtime = { publish: jest.fn().mockResolvedValue(undefined) };
  const config = { get: jest.fn().mockReturnValue(undefined) };
  const unused = {} as any;
  const svc = new ProjectsService(
    prisma as any,
    unused,
    config as any,
    pgbouncer as any,
    activity as any,
    unused,
    unused,
    unused,
    realtime as any,
    unused,
    unused,
    unused,
  );
  return { svc, prisma, pgbouncer, activity, realtime };
}

describe('ProjectsService.sleep — a project put to sleep from the dashboard', () => {
  it('puts an active project to sleep for its owner and records who did it', async () => {
    const { svc, prisma, pgbouncer, activity, realtime } = build({ status: 'ACTIVE' });

    const out = await svc.sleep('p1', 'u1');

    expect(out).toEqual({ message: 'Project is asleep' });
    expect(prisma.project.updateMany).toHaveBeenCalledWith({
      where: { id: 'p1', status: 'ACTIVE' },
      data: { status: 'PAUSED', pausedAt: expect.any(Date), idleWarningSentAt: null },
    });
    expect(pgbouncer.regenerateConfig).toHaveBeenCalledTimes(1);
    expect(activity.append).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ userId: 'u1', title: 'Project put to sleep' }),
    );
    expect(realtime.publish).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'p1', payload: expect.objectContaining({ status: 'PAUSED' }) }),
    );
  });

  it('lets the creator do it even when they are not the owner', async () => {
    const { svc, prisma } = build({ status: 'ACTIVE', role: 'MEMBER', creator: 'u1' });

    await expect(svc.sleep('p1', 'u1')).resolves.toEqual({ message: 'Project is asleep' });
    expect(prisma.project.updateMany).toHaveBeenCalledTimes(1);
  });

  it('refuses a member who did not create it', async () => {
    const { svc, prisma } = build({ status: 'ACTIVE', role: 'MEMBER', creator: 'someone-else' });

    await expect(svc.sleep('p1', 'u1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.project.updateMany).not.toHaveBeenCalled();
  });

  it('is a no-op for a project that is already asleep', async () => {
    const { svc, prisma, activity } = build({ status: 'PAUSED' });

    await expect(svc.sleep('p1', 'u1')).resolves.toEqual({ message: 'Project is already asleep' });
    expect(prisma.project.updateMany).not.toHaveBeenCalled();
    expect(activity.append).not.toHaveBeenCalled();
  });

  it('refuses a deactivated project — that is a different state with its own path', async () => {
    const { svc } = build({ status: 'DEACTIVATED' });

    await expect(svc.sleep('p1', 'u1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('records nothing when another tab got there first', async () => {
    const { svc, activity, pgbouncer } = build({ status: 'ACTIVE', count: 0 });

    await expect(svc.sleep('p1', 'u1')).resolves.toEqual({ message: 'Project is already asleep' });
    expect(activity.append).not.toHaveBeenCalled();
    expect(pgbouncer.regenerateConfig).not.toHaveBeenCalled();
  });
});
