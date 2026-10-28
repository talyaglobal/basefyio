import { Logger } from '@nestjs/common';
import { StorageCatalogService } from './storage-catalog.service';

function build() {
  const client = {
    query: jest.fn<Promise<{ rows: unknown[] }>, [string, unknown[]?]>(async () => ({ rows: [] })),
  };
  const runner = {
    runAsOwner: jest.fn(async (_p: string, fn: (c: any) => Promise<unknown>) => fn(client)),
  };
  const svc = new StorageCatalogService(runner as any);
  const sql = () => client.query.mock.calls.map(([s]) => s.replace(/\s+/g, ' ').trim());
  return { svc, runner, client, sql };
}

let debug: jest.SpyInstance;
let warn: jest.SpyInstance;
beforeAll(() => {
  debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
beforeEach(() => {
  debug.mockClear();
  warn.mockClear();
});

describe('StorageCatalogService writes', () => {
  it('recordUpload ensures the bucket row, upserts the object and returns its id', async () => {
    const { svc, client, sql } = build();
    client.query.mockImplementation(async (s: string) =>
      s.includes('RETURNING id') ? { rows: [{ id: 'obj-1' }] } : { rows: [] },
    );
    const id = await svc.recordUpload(
      'p1',
      'docs',
      'a/b.txt',
      { size: 5, etag: 'e', lastModified: new Date('2026-01-01T00:00:00Z'), metaData: { 'content-type': 'text/plain' } },
      'application/octet-stream',
      { 'x-amz-meta-owner': 'alice', 'Cache-Control': 'max-age=10' },
    );
    expect(id).toBe('obj-1');
    expect(sql()[0]).toContain('INSERT INTO storage.buckets');
    expect(sql()[1]).toContain('INSERT INTO storage.objects');
    const params = client.query.mock.calls[1][1] as unknown[];
    expect(params.slice(0, 4)).toEqual(['docs', 'a/b.txt', null, 'alice']);
    expect(JSON.parse(params[4] as string)).toMatchObject({ mimetype: 'text/plain', cacheControl: 'max-age=10', size: 5 });
  });

  it('recordUpload ignores folder markers', async () => {
    const { svc, runner } = build();
    expect(await svc.recordUpload('p1', 'docs', 'folder/', { size: 0 }, 'x', undefined)).toBeUndefined();
    expect(runner.runAsOwner).not.toHaveBeenCalled();
  });

  it('deleteObjects skips folder markers and empty names', async () => {
    const { svc, client, runner } = build();
    await svc.deleteObjects('p1', 'docs', ['a.txt', 'dir/', '']);
    expect(client.query.mock.calls[0][1]).toEqual(['docs', ['a.txt']]);
    await svc.deleteObjects('p1', 'docs', ['dir/']);
    expect(runner.runAsOwner).toHaveBeenCalledTimes(1);
  });

  it('moveObject clears a stale destination row, then renames; a cross-bucket move ensures the target bucket', async () => {
    const { svc, sql, client } = build();
    await svc.moveObject('p1', 'docs', 'a.txt', 'b/c.txt', 'other');
    expect(sql()[0]).toContain('INSERT INTO storage.buckets');
    expect(sql()[1]).toContain('DELETE FROM storage.objects');
    expect(client.query.mock.calls[1][1]).toEqual(['other', ['b/c.txt']]);
    expect(sql()[2]).toContain('UPDATE storage.objects SET bucket_id = $3, name = $4');
    expect(client.query.mock.calls[2][1]).toEqual(['docs', 'a.txt', 'other', 'b/c.txt']);
  });

  it('a missing catalog is swallowed and not probed again for a while', async () => {
    const { svc, runner } = build();
    runner.runAsOwner.mockRejectedValueOnce(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    await expect(svc.upsertBucket('p1', { name: 'x', public: false })).resolves.toBeUndefined();
    await svc.upsertBucket('p1', { name: 'y', public: false });
    expect(runner.runAsOwner).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('any other failure is logged as a warning and never thrown', async () => {
    const { svc, runner } = build();
    runner.runAsOwner.mockRejectedValueOnce(new Error('connection refused'));
    await expect(svc.deleteBucket('p1', 'x')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('connection refused'));
    // The next write tries again straight away.
    await svc.deleteBucket('p1', 'x');
    expect(runner.runAsOwner).toHaveBeenCalledTimes(2);
  });
});

describe('StorageCatalogService reads', () => {
  it('getBucket / getObject return the row or null', async () => {
    const { svc, client } = build();
    client.query.mockResolvedValueOnce({ rows: [{ id: 'docs', public: true }] } as any);
    expect(await svc.getBucket('p1', 'docs')).toEqual({ id: 'docs', public: true });
    expect(await svc.getObject('p1', 'docs', 'nope')).toBeNull();
  });

  it('reads throw when the catalog is missing, except getBucketIfAvailable', async () => {
    const { svc, runner } = build();
    const missing = Object.assign(new Error('no schema'), { code: '3F000' });
    runner.runAsOwner.mockRejectedValue(missing);
    await expect(svc.getObject('p1', 'docs', 'a')).rejects.toBe(missing);
    expect(await svc.getBucketIfAvailable('p1', 'docs')).toBeNull();
  });

  it('available() asks for the objects table and answers false on any failure', async () => {
    const { svc, client, runner } = build();
    client.query.mockResolvedValueOnce({ rows: [{ ok: true }] } as any);
    expect(await svc.available('p1')).toBe(true);
    runner.runAsOwner.mockRejectedValueOnce(new Error('down'));
    expect(await svc.available('p1')).toBe(false);
  });
});
