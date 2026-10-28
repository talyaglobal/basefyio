import {
  UPSERT_OBJECT_SQL,
  catalogFieldsFromMeta,
  isCatalogMissingError,
  isUuid,
  objectMetadata,
  upsertBucketParams,
  upsertObjectParams,
} from './storage-catalog.sql';

describe('objectMetadata', () => {
  it('lays the row out the way supabase-js lists a file', () => {
    const meta = objectMetadata({
      bucket: 'docs',
      name: 'a/b.txt',
      size: 12,
      mimetype: 'text/plain',
      etag: 'abc',
      cacheControl: 'max-age=3600',
      lastModified: new Date('2026-10-28T10:00:00Z'),
    });
    expect(meta).toEqual({
      eTag: '"abc"',
      size: 12,
      mimetype: 'text/plain',
      cacheControl: 'max-age=3600',
      lastModified: '2026-10-28T10:00:00.000Z',
      contentLength: 12,
      httpStatusCode: 200,
    });
  });

  it('keeps an already-quoted etag, and falls back to no-cache and octet-stream', () => {
    const meta = objectMetadata({ bucket: 'b', name: 'n', size: 0, mimetype: '', etag: '"q"' });
    expect(meta.eTag).toBe('"q"');
    expect(meta.cacheControl).toBe('no-cache');
    expect(meta.mimetype).toBe('application/octet-stream');
    expect(typeof meta.lastModified).toBe('string');
  });
});

describe('upsertObjectParams', () => {
  it('writes owner (uuid column) only for a UUID subject and owner_id always', () => {
    const uuid = '7f2c9a4e-1b3d-4c5e-8f6a-0a1b2c3d4e5f';
    expect(upsertObjectParams({ bucket: 'b', name: 'n', size: 1, mimetype: 'x', owner: uuid }).slice(0, 4)).toEqual([
      'b',
      'n',
      uuid,
      uuid,
    ]);
    expect(upsertObjectParams({ bucket: 'b', name: 'n', size: 1, mimetype: 'x', owner: 'alice' }).slice(2, 4)).toEqual([
      null,
      'alice',
    ]);
    expect(upsertObjectParams({ bucket: 'b', name: 'n', size: 1, mimetype: 'x' }).slice(2, 4)).toEqual([null, null]);
  });

  it('serialises metadata and user metadata as JSON and strips the etag quotes for version', () => {
    const params = upsertObjectParams({
      bucket: 'b',
      name: 'n',
      size: 3,
      mimetype: 'image/png',
      etag: '"e1"',
      userMetadata: { tag: 'x' },
    });
    expect(JSON.parse(params[4] as string)).toMatchObject({ size: 3, mimetype: 'image/png', eTag: '"e1"' });
    expect(params[5]).toBe('{"tag":"x"}');
    expect(params[6]).toBe('e1');
    expect(UPSERT_OBJECT_SQL).toContain('ON CONFLICT (bucket_id, name) DO UPDATE');
    expect(UPSERT_OBJECT_SQL).toContain('RETURNING id');
  });
});

describe('upsertBucketParams', () => {
  it('maps limits and the creating subject', () => {
    expect(
      upsertBucketParams({ name: 'avatars', public: true, fileSizeLimit: 10, allowedMimeTypes: ['image/*'], owner: 'u' }),
    ).toEqual(['avatars', true, 10, ['image/*'], null, 'u']);
    expect(upsertBucketParams({ name: 'x', public: false })).toEqual(['x', false, null, null, null, null]);
  });
});

describe('catalogFieldsFromMeta', () => {
  it('reads the headers an upload sends', () => {
    expect(
      catalogFieldsFromMeta({
        'x-amz-meta-owner': 'alice',
        'Cache-Control': 'max-age=60',
        'x-amz-meta-user-metadata': '{"a":1}',
      }),
    ).toEqual({ owner: 'alice', cacheControl: 'max-age=60', userMetadata: { a: 1 } });
  });

  it('reads the keys a stat hands back (prefix stripped) and ignores junk', () => {
    expect(
      catalogFieldsFromMeta({ owner: 'bob', 'user-metadata': 'not json', 'content-type': 'text/plain', size: 3 }),
    ).toEqual({ owner: 'bob' });
    expect(catalogFieldsFromMeta(undefined)).toEqual({});
  });
});

describe('helpers', () => {
  it('isUuid / isCatalogMissingError', () => {
    expect(isUuid('7f2c9a4e-1b3d-4c5e-8f6a-0a1b2c3d4e5f')).toBe(true);
    expect(isUuid('alice')).toBe(false);
    expect(isCatalogMissingError({ code: '42P01' })).toBe(true);
    expect(isCatalogMissingError({ code: '3F000' })).toBe(true);
    expect(isCatalogMissingError({ code: '42501' })).toBe(false);
    expect(isCatalogMissingError(new Error('x'))).toBe(false);
  });
});
