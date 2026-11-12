import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  FOLDER_TAG_NAME_MAX,
  FoldersTagsService,
  normalizeFolderTagName,
} from './folders-tags.service';

/**
 * A double-clicked "Create" used to send two POSTs that both stored a folder
 * with the same name, and a blank name created a nameless folder. Folder names
 * are now unique per team (case-insensitive), checked under a team-scoped
 * advisory lock, and tag creation stays idempotent.
 */
function makePrisma(opts: {
  folders?: Array<{ id: string; name: string; teamId: string }>;
  tags?: Array<{ id: string; name: string; teamId: string }>;
} = {}) {
  const folders = [...(opts.folders ?? [])];
  const tags = [...(opts.tags ?? [])];
  const matches = (rows: Array<{ id: string; name: string; teamId: string }>, where: any) =>
    rows.find(
      (r) =>
        r.teamId === where.teamId &&
        (!where.id?.not || r.id !== where.id.not) &&
        r.name.toLowerCase() === String(where.name.equals).toLowerCase(),
    ) ?? null;

  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    projectFolder: {
      findFirst: jest.fn(async ({ where }: any) => matches(folders, where)),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `f${folders.length + 1}`, ...data };
        folders.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = folders.find((f) => f.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
    },
    projectTag: {
      findFirst: jest.fn(async ({ where }: any) => matches(tags, where)),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `t${tags.length + 1}`, ...data };
        tags.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = tags.find((t) => t.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
    },
  };

  // Serialise interactive transactions the way the advisory lock does.
  let chain = Promise.resolve();
  const prisma = {
    teamMember: {
      findFirst: jest.fn().mockResolvedValue({ id: 'm1' }),
      findMany: jest.fn().mockResolvedValue([{ userId: 'u1' }]),
    },
    projectFolder: {
      findUnique: jest.fn(async ({ where }: any) => folders.find((f) => f.id === where.id) ?? null),
    },
    projectTag: {
      findUnique: jest.fn(async ({ where }: any) => tags.find((t) => t.id === where.id) ?? null),
    },
    $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => {
      const run = chain.then(() => fn(tx));
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    }),
  };
  return { prisma, tx, folders, tags };
}

const realtime = { publish: jest.fn().mockResolvedValue(undefined) };

describe('normalizeFolderTagName', () => {
  it('trims the name', () => {
    expect(normalizeFolderTagName('  Clients  ', 'Folder')).toBe('Clients');
  });

  it('rejects a blank name with a readable message', () => {
    expect(() => normalizeFolderTagName('   ', 'Folder')).toThrow(BadRequestException);
    expect(() => normalizeFolderTagName(undefined, 'Tag')).toThrow('Tag name is required');
  });

  it('rejects an oversized name', () => {
    expect(() => normalizeFolderTagName('x'.repeat(FOLDER_TAG_NAME_MAX + 1), 'Folder')).toThrow(
      BadRequestException,
    );
  });
});

describe('FoldersTagsService folders', () => {
  it('creates a folder with a trimmed name under the team lock', async () => {
    const { prisma, tx, folders } = makePrisma();
    const svc = new FoldersTagsService(prisma as any, realtime as any);
    const created = await svc.createFolder('team1', 'u1', '  Clients ', '#123456');
    expect(created).toMatchObject({ name: 'Clients', teamId: 'team1', color: '#123456' });
    expect(tx.$executeRaw).toHaveBeenCalled();
    expect(folders).toHaveLength(1);
  });

  it('refuses a second folder with the same name in the team, ignoring case', async () => {
    const { prisma } = makePrisma({ folders: [{ id: 'f1', name: 'Clients', teamId: 'team1' }] });
    const svc = new FoldersTagsService(prisma as any, realtime as any);
    await expect(svc.createFolder('team1', 'u1', 'clients')).rejects.toThrow(ConflictException);
  });

  it('allows the same name in another team', async () => {
    const { prisma } = makePrisma({ folders: [{ id: 'f1', name: 'Clients', teamId: 'team1' }] });
    const svc = new FoldersTagsService(prisma as any, realtime as any);
    await expect(svc.createFolder('team2', 'u1', 'Clients')).resolves.toMatchObject({
      teamId: 'team2',
    });
  });

  it('stores only one folder when two creates race (double click)', async () => {
    const { prisma, folders } = makePrisma();
    const svc = new FoldersTagsService(prisma as any, realtime as any);
    const results = await Promise.allSettled([
      svc.createFolder('team1', 'u1', 'Clients'),
      svc.createFolder('team1', 'u1', 'Clients'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(folders).toHaveLength(1);
  });

  it('refuses a blank folder name before touching the database', async () => {
    const { prisma } = makePrisma();
    const svc = new FoldersTagsService(prisma as any, realtime as any);
    await expect(svc.createFolder('team1', 'u1', '  ')).rejects.toThrow('Folder name is required');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses renaming a folder onto another folder name', async () => {
    const { prisma } = makePrisma({
      folders: [
        { id: 'f1', name: 'Clients', teamId: 'team1' },
        { id: 'f2', name: 'Internal', teamId: 'team1' },
      ],
    });
    const svc = new FoldersTagsService(prisma as any, realtime as any);
    await expect(svc.updateFolder('f2', 'u1', { name: 'CLIENTS' })).rejects.toThrow(
      ConflictException,
    );
  });

  it('lets an existing duplicate keep its name while its color changes', async () => {
    const { prisma } = makePrisma({
      folders: [
        { id: 'f1', name: 'Kolay', teamId: 'team1' },
        { id: 'f2', name: 'Kolay', teamId: 'team1' },
      ],
    });
    const svc = new FoldersTagsService(prisma as any, realtime as any);
    await expect(
      svc.updateFolder('f2', 'u1', { name: 'Kolay', color: '#ff0000' }),
    ).resolves.toMatchObject({ id: 'f2', color: '#ff0000' });
  });

  it('only writes name and color on update', async () => {
    const { prisma, tx } = makePrisma({ folders: [{ id: 'f1', name: 'A', teamId: 'team1' }] });
    const svc = new FoldersTagsService(prisma as any, realtime as any);
    await svc.updateFolder('f1', 'u1', { color: '#000000', teamId: 'other' } as any);
    expect(tx.projectFolder.update.mock.calls[0][0].data).toEqual({ color: '#000000' });
  });
});

describe('FoldersTagsService tags', () => {
  it('returns the existing tag when the name is created again in another letter case', async () => {
    const { prisma, tags } = makePrisma({ tags: [{ id: 't1', name: 'Prod', teamId: 'team1' }] });
    const svc = new FoldersTagsService(prisma as any, realtime as any);
    const tag = await svc.createTag('team1', 'u1', ' prod ');
    expect(tag.id).toBe('t1');
    expect(tags).toHaveLength(1);
  });

  it('refuses renaming a tag onto an existing tag with a 409 instead of a 500', async () => {
    const { prisma } = makePrisma({
      tags: [
        { id: 't1', name: 'Prod', teamId: 'team1' },
        { id: 't2', name: 'Staging', teamId: 'team1' },
      ],
    });
    const svc = new FoldersTagsService(prisma as any, realtime as any);
    await expect(svc.updateTag('t2', 'u1', { name: 'prod' })).rejects.toThrow(ConflictException);
  });
});
