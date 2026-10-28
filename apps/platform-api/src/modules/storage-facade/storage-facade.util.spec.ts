import { StorageFacadeError } from './storage-facade.errors';
import {
  cacheControlHeader,
  contentDisposition,
  decodeUserMetadata,
  metadataFromStat,
  normaliseKey,
  objectInfo,
  parseRange,
  syntheticObjectId,
  transformClaimFromOptions,
  transformOptionsFromQuery,
} from './storage-facade.util';

describe('normaliseKey', () => {
  it('strips leading slashes and collapses doubles', () => {
    expect(normaliseKey('/a//b/c.txt')).toBe('a/b/c.txt');
  });
  it('refuses traversal, NUL, folders and empty keys', () => {
    for (const bad of ['', '/', 'a/../b', '../x', 'a/./b', 'a\0b', 'folder/']) {
      expect(() => normaliseKey(bad)).toThrow(StorageFacadeError);
    }
  });
  it('caps the length at 1024 bytes', () => {
    expect(() => normaliseKey('x'.repeat(1025))).toThrow(/1024/);
    expect(normaliseKey('x'.repeat(1024))).toHaveLength(1024);
  });
});

describe('headers and metadata', () => {
  it('cacheControlHeader turns storage-js seconds into max-age and keeps directives', () => {
    expect(cacheControlHeader('3600')).toBe('max-age=3600');
    expect(cacheControlHeader('max-age=10, public')).toBe('max-age=10, public');
    expect(cacheControlHeader(undefined)).toBeUndefined();
  });
  it('decodeUserMetadata reads JSON, plain or base64, and refuses non-objects', () => {
    expect(decodeUserMetadata('{"a":1}')).toEqual({ a: 1 });
    expect(decodeUserMetadata(Buffer.from('{"b":2}').toString('base64'), true)).toEqual({ b: 2 });
    expect(decodeUserMetadata(undefined)).toBeUndefined();
    expect(() => decodeUserMetadata('[1]')).toThrow(StorageFacadeError);
  });
  it('contentDisposition escapes quotes and encodes the UTF-8 name', () => {
    expect(contentDisposition('attachment', 'ra"port é.pdf')).toBe(`attachment; filename="ra_port _.pdf"; filename*=UTF-8''ra%22port%20%C3%A9.pdf`);
  });
  it('transform options map Supabase\'s names onto the transform service\'s', () => {
    expect(transformOptionsFromQuery({ width: '10', resize: 'contain', format: 'origin', quality: '80' })).toEqual({ width: '10', fit: 'contain', quality: '80' });
    expect(transformClaimFromOptions({ width: 10, format: 'webp', junk: 1 })).toEqual({ width: 10, format: 'webp' });
    expect(transformClaimFromOptions({})).toBeUndefined();
  });
});

describe('parseRange', () => {
  it('reads open, closed and suffix ranges against the size', () => {
    expect(parseRange('bytes=0-3', 10)).toEqual({ start: 0, end: 3 });
    expect(parseRange('bytes=4-', 10)).toEqual({ start: 4, end: 9 });
    expect(parseRange('bytes=-2', 10)).toEqual({ start: 8, end: 9 });
    expect(parseRange('bytes=0-99', 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange('items=1-2', 10)).toBeNull();
  });
  it('416 when the range cannot be satisfied', () => {
    expect(() => parseRange('bytes=10-12', 10)).toThrow(/not satisfiable/);
    expect(() => parseRange('bytes=5-2', 10)).toThrow(StorageFacadeError);
  });
});

describe('listing shapes', () => {
  const stat = { size: 5, etag: 'abc', lastModified: new Date('2026-10-28T12:00:00Z'), metaData: { 'content-type': 'text/plain', 'cache-control': 'max-age=5' } };

  it('metadataFromStat matches what the catalog writes', () => {
    expect(metadataFromStat(stat, 'a.txt')).toEqual({
      eTag: '"abc"',
      size: 5,
      mimetype: 'text/plain',
      cacheControl: 'max-age=5',
      lastModified: '2026-10-28T12:00:00.000Z',
      contentLength: 5,
      httpStatusCode: 200,
    });
    expect(metadataFromStat({ size: 1 }, 'pic.png').mimetype).toBe('image/png');
    expect(metadataFromStat({ size: 1 }, 'blob').mimetype).toBe('application/octet-stream');
  });

  it('syntheticObjectId is stable and UUID-shaped', () => {
    expect(syntheticObjectId('b', 'k')).toBe(syntheticObjectId('b', 'k'));
    expect(syntheticObjectId('b', 'k')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(syntheticObjectId('b', 'k')).not.toBe(syntheticObjectId('b', 'k2'));
  });

  it('objectInfo flattens the record the way storage-js info() expects', () => {
    expect(objectInfo('docs', 'a.txt', stat, { id: 'row-1', created_at: '2026-01-01T00:00:00.000Z', user_metadata: { x: 1 } })).toEqual({
      id: 'row-1',
      name: 'a.txt',
      bucket_id: 'docs',
      size: 5,
      content_type: 'text/plain',
      cache_control: 'max-age=5',
      etag: '"abc"',
      last_modified: '2026-10-28T12:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-10-28T12:00:00.000Z',
      metadata: { x: 1 },
    });
  });
});
