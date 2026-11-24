import {
  hoursLeft,
  ProjectTrashNoticeService,
  purgeWarningKey,
  trashedDisplayName,
  TRASH_RETENTION_MS,
} from './project-trash-notice.service';
import { projectPurgeWarningTemplate } from '../email/templates/project-trash.template';

const HOUR = 60 * 60 * 1000;
const now = new Date('2026-11-24T12:00:00Z');

function setup(opts: { projects?: any[]; members?: any[]; existingKeys?: Set<string>; mailFails?: boolean } = {}) {
  const stored = new Set<string>(opts.existingKeys ?? []);
  const prisma: any = {
    project: { findMany: jest.fn().mockResolvedValue(opts.projects ?? []) },
    teamMember: { findMany: jest.fn().mockResolvedValue(opts.members ?? []) },
    notification: {
      createMany: jest.fn(async ({ data }: any) => {
        const key = `${data[0].userId}|${data[0].dedupeKey}`;
        if (stored.has(key)) return { count: 0 };
        stored.add(key);
        return { count: 1 };
      }),
    },
  };
  const email: any = {
    sendProjectPurgeWarning: jest.fn(async () => {
      if (opts.mailFails) throw new Error('smtp down');
    }),
  };
  return { svc: new ProjectTrashNoticeService(prisma, email), prisma, email, stored };
}

const project = (deletedHoursAgo: number) => ({
  id: 'p1',
  name: 'Shop <db>_deleted',
  teamId: 't1',
  createdBy: 'u-creator',
  deletedAt: new Date(now.getTime() - deletedHoursAgo * HOUR),
});

describe('ProjectTrashNoticeService (#262)', () => {
  it('asks only for trashed projects inside the last six hours of retention', async () => {
    const { svc, prisma } = setup();
    await svc.run(now);
    const where = prisma.project.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('DELETED');
    expect(where.deletedAt.gt).toEqual(new Date(now.getTime() - TRASH_RETENTION_MS));
    expect(where.deletedAt.lte).toEqual(new Date(now.getTime() - 18 * HOUR));
  });

  it('tells the creator and the owners once each, by bell and e-mail', async () => {
    const { svc, email, prisma } = setup({
      projects: [project(19)],
      members: [
        { userId: 'u-owner', user: { email: 'owner@example.com' } },
        { userId: 'u-creator', user: { email: 'creator@example.com' } },
        { userId: 'u-owner', user: { email: 'owner@example.com' } },
      ],
    });
    expect(await svc.run(now)).toBe(2);
    expect(email.sendProjectPurgeWarning).toHaveBeenCalledTimes(2);
    expect(email.sendProjectPurgeWarning).toHaveBeenCalledWith('owner@example.com', 'Shop <db>', 5);
    const row = prisma.notification.createMany.mock.calls[0][0].data[0];
    expect(row.href).toBe('/dashboard/projects?view=trash');
    expect(row.dedupeKey).toBe(purgeWarningKey('p1', project(19).deletedAt));
    const where = prisma.teamMember.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ role: 'OWNER' }, { userId: 'u-creator' }]);
  });

  it('sends nothing on the next run', async () => {
    const ctx = setup({ projects: [project(20)], members: [{ userId: 'u1', user: { email: 'a@example.com' } }] });
    await ctx.svc.run(now);
    await ctx.svc.run(new Date(now.getTime() + HOUR));
    expect(ctx.email.sendProjectPurgeWarning).toHaveBeenCalledTimes(1);
  });

  it('announces a new deletion of a restored project again', () => {
    expect(purgeWarningKey('p1', new Date(1))).not.toBe(purgeWarningKey('p1', new Date(2)));
  });

  it('keeps going when the mail server fails', async () => {
    const { svc } = setup({
      projects: [project(19)],
      members: [{ userId: 'u1', user: { email: 'a@example.com' } }],
      mailFails: true,
    });
    await expect(svc.run(now)).resolves.toBe(1);
  });

  it('shows the name without the internal trash suffix', () => {
    expect(trashedDisplayName('test-batu_deleted')).toBe('test-batu');
    expect(trashedDisplayName('shop_2_deleted')).toBe('shop');
    expect(trashedDisplayName('shop_1795418982603_deleted')).toBe('shop');
    expect(trashedDisplayName('undeleted')).toBe('undeleted');
  });

  it('counts hours left, never below one', () => {
    expect(hoursLeft(new Date(now.getTime() - 18 * HOUR), now)).toBe(6);
    expect(hoursLeft(new Date(now.getTime() - 23.5 * HOUR), now)).toBe(1);
    expect(hoursLeft(new Date(now.getTime() - 30 * HOUR), now)).toBe(1);
  });

  it('escapes the project name in the e-mail', () => {
    const html = projectPurgeWarningTemplate({ projectName: '<script>x</script>', hoursLeft: 5, trashUrl: 'https://app/x' });
    expect(html).not.toContain('<script>x');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('5 hours');
  });
});
