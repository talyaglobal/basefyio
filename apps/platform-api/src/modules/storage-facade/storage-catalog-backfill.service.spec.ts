import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { StorageCatalogBackfillService } from './storage-catalog-backfill.service';

function build(storageAuthz = 'presets') {
  const prisma = {
    project: {
      findFirst: jest.fn().mockResolvedValue({ id: 'p1', storageAuthz }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const storage = {
    listBucketNames: jest.fn().mockResolvedValue([
      { name: 'docs', physical: 'bf-proj-docs', createdAt: '2026-01-01T00:00:00.000Z' },
    ]),
    bucketIsPublic: jest.fn().mockResolvedValue(true),
    listObjectsIn: jest.fn().mockResolvedValue([
      { name: 'a.txt', size: 1, lastModified: new Date() },
      { name: 'dir/', size: 0, lastModified: new Date() },
      { name: 'dir/b.png', size: 2, lastModified: new Date() },
      { name: 'gone.txt', size: 3, lastModified: new Date() },
    ]),
    statObjectIn: jest.fn(async (_b: string, key: string) =>
      key === 'gone.txt'
        ? null
        : {
            size: key.length,
            etag: `e-${key}`,
            lastModified: new Date('2026-01-02T00:00:00Z'),
            metaData: { 'content-type': key.endsWith('.png') ? 'image/png' : 'text/plain', owner: 'alice' },
          },
    ),
  };
  const catalog = {
    available: jest.fn().mockResolvedValue(true),
    upsertBucket: jest.fn().mockResolvedValue(undefined),
    upsertObject: jest.fn().mockResolvedValue('id'),
  };
  const svc = new StorageCatalogBackfillService(prisma as any, storage as any, catalog as any);
  return { svc, prisma, storage, catalog };
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

describe('StorageCatalogBackfillService.backfill', () => {
  it('writes every bucket with its visibility and every real object with what the store says about it', async () => {
    const { svc, catalog } = build();
    const result = await svc.backfill('p1');
    expect(result).toEqual({ buckets: 1, objects: 2, skipped: 1 });
    expect(catalog.upsertBucket).toHaveBeenCalledWith('p1', { name: 'docs', public: true });
    expect(catalog.upsertObject).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ bucket: 'docs', name: 'dir/b.png', mimetype: 'image/png', owner: 'alice', etag: 'e-dir/b.png' }),
    );
    expect(catalog.upsertObject).not.toHaveBeenCalledWith('p1', expect.objectContaining({ name: 'dir/' }));
  });

  it('refuses when the project has no catalog, naming the bootstrap route', async () => {
    const { svc, catalog } = build();
    catalog.available.mockResolvedValue(false);
    await expect(svc.backfill('p1')).rejects.toThrow(ConflictException);
    await expect(svc.backfill('p1')).rejects.toThrow(/ensure-rls-bootstrap/);
  });

  it('refuses an unknown or inactive project', async () => {
    const { svc, prisma } = build();
    prisma.project.findFirst.mockResolvedValue(null);
    await expect(svc.backfill('p1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('StorageCatalogBackfillService.setMode', () => {
  it('switching to rls backfills first, then records the mode', async () => {
    const { svc, prisma, catalog } = build();
    const out = await svc.setMode('p1', 'rls');
    expect(out.storageAuthz).toBe('rls');
    expect(out.backfill).toEqual({ buckets: 1, objects: 2, skipped: 1 });
    expect(catalog.upsertObject).toHaveBeenCalled();
    expect(prisma.project.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { storageAuthz: 'rls' } });
  });

  it('switching back to presets needs no catalog and skips the update when already there', async () => {
    const { svc, prisma, storage } = build('presets');
    const out = await svc.setMode('p1', 'presets');
    expect(out).toEqual({ storageAuthz: 'presets', backfill: undefined });
    expect(storage.listBucketNames).not.toHaveBeenCalled();
    expect(prisma.project.update).not.toHaveBeenCalled();
  });

  it('refuses a mode it does not know', async () => {
    const { svc } = build();
    await expect(svc.setMode('p1', 'none')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('status reports the mode and whether the catalog exists', async () => {
    const { svc, catalog } = build('rls');
    catalog.available.mockResolvedValue(false);
    expect(await svc.status('p1')).toEqual({ storageAuthz: 'rls', catalogAvailable: false });
  });
});
