jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  StorageAccessService,
  decide,
  normalisePrefix,
  resolveModeFromRows,
} from './storage-access.service';
import type { StorageCaller } from './storage-caller';

const service: StorageCaller = { kind: 'service' };
const dashboard: StorageCaller = { kind: 'dashboard', sub: 'member-1' };
const alice: StorageCaller = { kind: 'authenticated', sub: 'alice' };
const bob: StorageCaller = { kind: 'authenticated', sub: 'bob' };
const anon: StorageCaller = { kind: 'anon' };

describe('decide()', () => {
  it('allows everyone when there is no rule — today\'s behaviour', () => {
    for (const c of [service, dashboard, alice, anon]) expect(decide(c, null)).toBe('allow');
  });

  it('public-read is an explicit "no rule"', () => {
    for (const c of [service, dashboard, alice, anon]) expect(decide(c, 'public-read')).toBe('allow');
  });

  it('authenticated-read refuses the anon key alone and nobody else', () => {
    expect(decide(anon, 'authenticated-read')).toBe('deny-anon');
    expect(decide(alice, 'authenticated-read')).toBe('allow');
    expect(decide(service, 'authenticated-read')).toBe('allow');
    expect(decide(dashboard, 'authenticated-read')).toBe('allow');
  });

  it('owner-only admits the uploader, the service key and team members', () => {
    expect(decide(alice, 'owner-only', 'alice')).toBe('allow');
    expect(decide(bob, 'owner-only', 'alice')).toBe('deny-owner');
    expect(decide(anon, 'owner-only', 'alice')).toBe('deny-anon');
    expect(decide(service, 'owner-only', 'alice')).toBe('allow');
    expect(decide(dashboard, 'owner-only', 'alice')).toBe('allow');
  });

  it('owner-only keeps objects without an owner tag away from key callers', () => {
    expect(decide(alice, 'owner-only', undefined)).toBe('deny-owner');
    expect(decide(service, 'owner-only', undefined)).toBe('allow');
  });
});

describe('resolveModeFromRows()', () => {
  const rows = [
    { bucket: 'docs', pathPrefix: '', mode: 'authenticated-read' },
    { bucket: 'docs', pathPrefix: 'private/', mode: 'owner-only' },
    { bucket: 'docs', pathPrefix: 'private/shared/', mode: 'public-read' },
    { bucket: 'other', pathPrefix: '', mode: 'owner-only' },
  ];

  it('picks the longest matching prefix within the bucket', () => {
    expect(resolveModeFromRows(rows, 'docs', 'readme.md')).toBe('authenticated-read');
    expect(resolveModeFromRows(rows, 'docs', 'private/a.pdf')).toBe('owner-only');
    expect(resolveModeFromRows(rows, 'docs', '/private/a.pdf')).toBe('owner-only');
    expect(resolveModeFromRows(rows, 'docs', 'private/shared/a.pdf')).toBe('public-read');
    expect(resolveModeFromRows(rows, 'other', 'x')).toBe('owner-only');
    expect(resolveModeFromRows(rows, 'none', 'x')).toBeNull();
  });

  it('treats an unknown stored mode as no rule', () => {
    expect(resolveModeFromRows([{ bucket: 'b', pathPrefix: '', mode: 'weird' }], 'b', 'k')).toBeNull();
  });
});

describe('normalisePrefix()', () => {
  it('strips a leading slash and refuses traversal', () => {
    expect(normalisePrefix(undefined)).toBe('');
    expect(normalisePrefix('/private/')).toBe('private/');
    expect(normalisePrefix(' a/b ')).toBe('a/b');
    expect(() => normalisePrefix('../x')).toThrow(BadRequestException);
  });
});

describe('StorageAccessService', () => {
  function build(rows: any[] = []) {
    const prisma = {
      storagePolicy: {
        findMany: jest.fn().mockResolvedValue(rows),
        upsert: jest.fn().mockImplementation(async ({ create }) => ({ id: 'p', ...create })),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    return { prisma, access: new StorageAccessService(prisma as any) };
  }

  it('caches a project\'s rules and invalidates on change', async () => {
    const { prisma, access } = build([{ bucket: 'b', pathPrefix: '', mode: 'owner-only' }]);
    expect(await access.resolveMode('p1', 'b', 'k')).toBe('owner-only');
    expect(await access.resolveMode('p1', 'b', 'k')).toBe('owner-only');
    expect(prisma.storagePolicy.findMany).toHaveBeenCalledTimes(1);

    await access.setPolicy('p1', 'b', { mode: 'authenticated-read' }, 'member-1');
    expect(prisma.storagePolicy.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId_bucket_pathPrefix: { projectId: 'p1', bucket: 'b', pathPrefix: '' } },
        create: { projectId: 'p1', bucket: 'b', pathPrefix: '', mode: 'authenticated-read', createdBy: 'member-1' },
      }),
    );
    await access.resolveMode('p1', 'b', 'k');
    expect(prisma.storagePolicy.findMany).toHaveBeenCalledTimes(2);

    await access.removePolicy('p1', 'b', '/private/');
    expect(prisma.storagePolicy.deleteMany).toHaveBeenCalledWith({
      where: { projectId: 'p1', bucket: 'b', pathPrefix: 'private/' },
    });
  });

  it('rejects an unknown mode and a traversing prefix', async () => {
    const { access } = build();
    await expect(access.setPolicy('p1', 'b', { mode: 'public' })).rejects.toThrow(/mode must be one of/);
    await expect(access.setPolicy('p1', 'b', { mode: 'owner-only', pathPrefix: '../' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('answers null quickly for a project without rules', async () => {
    const { access } = build([]);
    expect(await access.resolveMode('p1', 'b', 'k')).toBeNull();
  });

  describe('assertions', () => {
    const { access } = build();
    const owned = { metaData: { owner: 'alice', 'content-type': 'image/png' } };
    const untagged = { metaData: { 'content-type': 'image/png' } };

    it('read: names the rule that refused', () => {
      expect(() => access.assertCanRead(anon, 'authenticated-read', owned, 'k')).toThrow(/signed-in user to read "k"/);
      expect(() => access.assertCanRead(bob, 'owner-only', owned, 'k')).toThrow(/Only the owner of "k" can read it/);
      expect(() => access.assertCanRead(alice, 'owner-only', untagged, 'k')).toThrow(ForbiddenException);
      expect(() => access.assertCanRead(alice, 'owner-only', owned, 'k')).not.toThrow();
      expect(() => access.assertCanRead(anon, null, untagged, 'k')).not.toThrow();
      expect(() => access.assertCanRead(service, 'owner-only', untagged, 'k')).not.toThrow();
    });

    it('overwrite: a new key is free, an existing one belongs to its owner', () => {
      expect(() => access.assertCanOverwrite(bob, 'owner-only', null, 'k')).not.toThrow();
      expect(() => access.assertCanOverwrite(bob, 'owner-only', owned, 'k')).toThrow(/overwrite/);
      expect(() => access.assertCanOverwrite(alice, 'owner-only', owned, 'k')).not.toThrow();
      expect(() => access.assertCanOverwrite(bob, 'authenticated-read', owned, 'k')).not.toThrow();
    });
  });

  describe('assertCanModifyAll', () => {
    const rows = [{ bucket: 'b', pathPrefix: 'private/', mode: 'owner-only' }];
    const stats: Record<string, any> = {
      'private/mine.txt': { metaData: { owner: 'alice' } },
      'private/theirs.txt': { metaData: { owner: 'bob' } },
    };
    const statFn = jest.fn(async (k: string) => stats[k] ?? null);

    beforeEach(() => statFn.mockClear());

    it('skips the store entirely for privileged callers and buckets without rules', async () => {
      const { access } = build(rows);
      await access.assertCanModifyAll(service, 'p1', 'b', ['private/theirs.txt'], statFn, 'delete');
      await access.assertCanModifyAll(alice, 'p1', 'nope', ['private/theirs.txt'], statFn, 'delete');
      expect(statFn).not.toHaveBeenCalled();
    });

    it('lets the owner delete, refuses others, ignores missing keys and refuses folders', async () => {
      const { access } = build(rows);
      await access.assertCanModifyAll(alice, 'p1', 'b', ['private/mine.txt', 'private/gone.txt', 'public.txt'], statFn, 'delete');
      await expect(
        access.assertCanModifyAll(alice, 'p1', 'b', ['private/theirs.txt'], statFn, 'delete'),
      ).rejects.toThrow(/Only the owner of "private\/theirs.txt" can delete it/);
      await expect(
        access.assertCanModifyAll(alice, 'p1', 'b', ['private/sub/'], statFn, 'move'),
      ).rejects.toThrow(/folder in an owner-only location/);
    });
  });

  describe('filterListing', () => {
    const objects = [
      { name: 'private/', prefix: 'private/sub/' },
      { name: 'private/mine.txt', size: 1 },
      { name: 'private/theirs.txt', size: 1 },
      { name: 'private/untagged.txt', size: 1 },
    ];
    const stats: Record<string, any> = {
      'private/mine.txt': { metaData: { owner: 'alice' } },
      'private/theirs.txt': { metaData: { owner: 'bob' } },
      'private/untagged.txt': { metaData: {} },
    };
    const statFn = jest.fn(async (k: string) => stats[k] ?? null);

    beforeEach(() => statFn.mockClear());

    it('returns the listing untouched unless the rule is owner-only for a key caller', async () => {
      const { access } = build();
      expect(await access.filterListing(alice, null, objects, statFn)).toBe(objects);
      expect(await access.filterListing(alice, 'authenticated-read', objects, statFn)).toBe(objects);
      expect(await access.filterListing(service, 'owner-only', objects, statFn)).toBe(objects);
      expect(await access.filterListing(dashboard, 'owner-only', objects, statFn)).toBe(objects);
      expect(statFn).not.toHaveBeenCalled();
    });

    it('keeps folders and only the caller\'s own files', async () => {
      const { access } = build();
      const out = await access.filterListing(alice, 'owner-only', objects, statFn);
      expect(out.map((o) => o.name)).toEqual(['private/', 'private/mine.txt']);
      expect(statFn).toHaveBeenCalledTimes(3);
    });

    it('shows the anon key only the folder structure', async () => {
      const { access } = build();
      const out = await access.filterListing(anon, 'owner-only', objects, statFn);
      expect(out.map((o) => o.name)).toEqual(['private/']);
      expect(statFn).not.toHaveBeenCalled();
    });

    it('treats a failing stat as not owned', async () => {
      const { access } = build();
      const flaky = jest.fn(async (k: string) => {
        if (k === 'private/mine.txt') throw new Error('store hiccup');
        return stats[k] ?? null;
      });
      const out = await access.filterListing(alice, 'owner-only', objects, flaky);
      expect(out.map((o) => o.name)).toEqual(['private/']);
    });
  });
});
