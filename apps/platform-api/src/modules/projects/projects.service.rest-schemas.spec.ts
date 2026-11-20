import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ProjectsService } from './projects.service';

/**
 * Settings → API: the exposed REST schemas (#264). The instance is built from the
 * prototype with only the collaborators the two methods touch.
 */
function build(opts: { role?: string; stored?: string[] | null; missing?: boolean } = {}) {
  const updates: any[] = [];
  const activity: any[] = [];
  const svc: any = Object.create(ProjectsService.prototype);
  svc.prisma = {
    project: {
      findFirst: jest.fn(async () =>
        opts.missing ? null : { id: 'p1', teamId: 't1', restExposedSchemas: opts.stored ?? [] },
      ),
      update: jest.fn(async (args: any) => {
        updates.push(args);
        return {};
      }),
    },
  };
  svc.assertTeamMember = jest.fn(async () => opts.role ?? 'OWNER');
  svc.activity = { append: jest.fn(async (_id: string, entry: any) => void activity.push(entry)) };
  return { svc: svc as ProjectsService, updates, activity };
}

describe('ProjectsService exposed REST schemas (#264)', () => {
  it('reads public only for a project that never set it', async () => {
    const { svc } = build({ stored: [] });
    await expect(svc.getRestSchemas('p1', 'u1')).resolves.toEqual({ schemas: ['public'], exposedSchemas: [] });
  });

  it('reads the stored extras after public', async () => {
    const { svc } = build({ stored: ['r6s'] });
    await expect(svc.getRestSchemas('p1', 'u1')).resolves.toEqual({ schemas: ['public', 'r6s'], exposedSchemas: ['r6s'] });
  });

  it('stores a validated list and logs the change', async () => {
    const { svc, updates, activity } = build();
    const res = await svc.updateRestSchemas('p1', 'u1', ['r6s', 'public', 'r6s', 'reports']);
    expect(res).toEqual({ schemas: ['public', 'r6s', 'reports'], exposedSchemas: ['r6s', 'reports'] });
    expect(updates).toEqual([{ where: { id: 'p1' }, data: { restExposedSchemas: ['r6s', 'reports'] } }]);
    expect(activity).toHaveLength(1);
    expect(activity[0].title).toBe('Exposed REST schemas changed');
  });

  it('goes back to public only with an empty list', async () => {
    const { svc, updates } = build({ stored: ['r6s'] });
    await expect(svc.updateRestSchemas('p1', 'u1', [])).resolves.toEqual({ schemas: ['public'], exposedSchemas: [] });
    expect(updates[0].data).toEqual({ restExposedSchemas: [] });
  });

  it.each([['auth'], ['pg_catalog'], ['information_schema'], ['storage'], ['basefyio_internal'], ['a"b']])(
    'refuses %s with 400 and stores nothing',
    async (name) => {
      const { svc, updates } = build();
      await expect(svc.updateRestSchemas('p1', 'u1', ['r6s', name])).rejects.toBeInstanceOf(BadRequestException);
      expect(updates).toHaveLength(0);
    },
  );

  it('lets only owners and admins change it', async () => {
    const { svc, updates } = build({ role: 'MEMBER' });
    await expect(svc.updateRestSchemas('p1', 'u1', ['r6s'])).rejects.toBeInstanceOf(ForbiddenException);
    expect(updates).toHaveLength(0);
    await expect(build({ role: 'ADMIN' }).svc.updateRestSchemas('p1', 'u1', ['r6s'])).resolves.toBeDefined();
  });

  it('answers 404 for a project that does not exist', async () => {
    await expect(build({ missing: true }).svc.getRestSchemas('p1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
