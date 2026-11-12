jest.mock('./storage.service', () => ({ StorageService: class {} }));

import {
  activeContentHeaders,
  assertBucketName,
  cleanKey,
  isActiveContentType,
  limitViolation,
  mimeAllowed,
  pageListing,
  parseBucketLimits,
  parseListOptions,
  stringList,
} from './storage-objects';
import { StoragePublicController, parseRange } from './storage-public.controller';

describe('keys and lists', () => {
  it('cleanKey strips leading slashes and refuses traversal, NUL and non-strings', () => {
    expect(cleanKey('/a/b.txt')).toBe('a/b.txt');
    expect(() => cleanKey('../x')).toThrow('Invalid path');
    expect(() => cleanKey('a/../../x', 'from')).toThrow('Invalid from');
    expect(() => cleanKey('a\0b')).toThrow('Invalid path');
    expect(() => cleanKey('  ')).toThrow('path is required');
    expect(() => cleanKey(5)).toThrow('path must be a string');
    // A dotted name is not traversal.
    expect(cleanKey('v1..2/a.txt')).toBe('v1..2/a.txt');
  });

  it('stringList wants a non-empty array of strings within the cap', () => {
    expect(stringList(['a'], 'paths')).toEqual(['a']);
    for (const bad of [undefined, [], 'a', [1], [null]]) {
      expect(() => stringList(bad, 'paths')).toThrow('paths must be a non-empty array of strings');
    }
    expect(() => stringList(['a', 'b', 'c'], 'paths', 2)).toThrow('at most 2');
  });
});

describe('bucket names', () => {
  it('accepts what the docs promise and refuses what the store would rewrite', () => {
    expect(assertBucketName('avatars-2026')).toBe('avatars-2026');
    for (const bad of ['Avatars', 'my_bucket', 'a b', 'ab', '-ab', 'ab-', 'x'.repeat(64), 42]) {
      expect(() => assertBucketName(bad)).toThrow(/lowercase letters, digits and hyphens/);
    }
  });
});

describe('listing options', () => {
  it('parses what is present and nothing else', () => {
    expect(parseListOptions({})).toEqual({ limit: undefined, offset: undefined });
    expect(parseListOptions({ limit: '10', offset: '20', sortBy: 'lastModified', order: 'desc', search: ' cat ' })).toEqual(
      { limit: 10, offset: 20, sortBy: 'lastModified', order: 'desc', search: 'cat' },
    );
    expect(() => parseListOptions({ limit: '1001' })).toThrow(/between 1 and 1000/);
    expect(() => parseListOptions({ offset: '-1' })).toThrow(/offset must be/);
    expect(() => parseListOptions({ order: 'up' })).toThrow('order must be asc or desc');
  });

  it('pageListing leaves the order alone without a sort and slices a page', () => {
    const rows = [
      { name: 'b', size: 1, lastModified: new Date(1) },
      { name: 'a', size: 2, lastModified: new Date(2) },
    ];
    expect(pageListing(rows, {})).toEqual({ items: rows, total: 2 });
    expect(pageListing(rows, { offset: 1 })).toEqual({ items: [rows[1]], total: 2 });
    expect(pageListing(rows, { sortBy: 'name' }).items.map((r) => r.name)).toEqual(['a', 'b']);
  });
});

describe('content headers', () => {
  it('marks pages, SVG and XML as attachments and leaves ordinary files alone', () => {
    for (const t of ['text/html', 'TEXT/HTML; charset=utf-8', 'image/svg+xml', 'application/xml', 'application/atom+xml']) {
      expect(isActiveContentType(t)).toBe(true);
    }
    for (const t of ['image/png', 'application/pdf', 'text/plain', 'application/javascript', undefined]) {
      expect(isActiveContentType(t)).toBe(false);
    }
    expect(activeContentHeaders('image/png', 'a.png')).toEqual({});
    expect(activeContentHeaders('text/html', 'site/qa e2e ş.html')).toEqual({
      'Content-Disposition': `attachment; filename="qa%20e2e%20%C5%9F.html"; filename*=UTF-8''qa%20e2e%20%C5%9F.html`,
    });
  });
});

describe('bucket upload limits', () => {
  it('parses only the fields present, null clearing one', () => {
    expect(parseBucketLimits({})).toEqual({});
    expect(parseBucketLimits({ fileSizeLimit: 1024, allowedMimeTypes: [' Image/PNG ', 'image/png', 'video/*'] })).toEqual({
      fileSizeLimit: 1024,
      allowedMimeTypes: ['image/png', 'video/*'],
    });
    expect(parseBucketLimits({ fileSizeLimit: null, allowedMimeTypes: null })).toEqual({
      fileSizeLimit: null,
      allowedMimeTypes: [],
    });
    expect(() => parseBucketLimits({ fileSizeLimit: '50MB' })).toThrow(/fileSizeLimit must be/);
    expect(() => parseBucketLimits({ fileSizeLimit: 0 })).toThrow(/fileSizeLimit must be/);
    expect(() => parseBucketLimits({ allowedMimeTypes: ['png'] })).toThrow('"png" is not a MIME type');
    expect(() => parseBucketLimits({ allowedMimeTypes: 'image/png' })).toThrow(/must be an array/);
  });

  it('matches exact types and wildcards', () => {
    expect(mimeAllowed('image/png', [])).toBe(true);
    expect(mimeAllowed('image/png', ['image/*'])).toBe(true);
    expect(mimeAllowed('image/png; x=y', ['image/png'])).toBe(true);
    expect(mimeAllowed('imagex/png', ['image/*'])).toBe(false);
    expect(mimeAllowed(undefined, ['application/octet-stream'])).toBe(true);
  });

  it('names the broken limit with the right status', () => {
    expect(limitViolation({ fileSizeLimit: null, allowedMimeTypes: [] }, 'b', 10, 'x/y')).toBeNull();
    expect(limitViolation({ fileSizeLimit: 5, allowedMimeTypes: [] }, 'b', 10, 'x/y')).toMatchObject({ status: 413 });
    expect(limitViolation({ fileSizeLimit: null, allowedMimeTypes: ['image/*'] }, 'b', 1, 'text/plain')).toMatchObject({
      status: 415,
      message: 'Bucket "b" does not accept text/plain; allowed: image/*',
    });
  });
});

describe('StoragePublicController', () => {
  function build(stat: any = { size: 10, etag: 'abc', metaData: { 'content-type': 'image/png' }, lastModified: new Date(0) }) {
    const stream = { pipe: jest.fn(), destroy: jest.fn() };
    const storage = {
      statPublicObject: jest.fn().mockResolvedValue({ minioBucket: 'bf-acme-pub', key: 'img/a.png', stat }),
      openObjectStream: jest.fn().mockResolvedValue(stream),
    };
    const res: any = { headers: {} as Record<string, string>, statusCode: 200 };
    res.set = jest.fn((k: any, v?: any) => {
      if (typeof k === 'object') Object.assign(res.headers, k);
      else res.headers[k] = v;
      return res;
    });
    res.status = jest.fn((c: number) => ((res.statusCode = c), res));
    res.end = jest.fn();
    res.once = jest.fn();
    return { controller: new StoragePublicController(storage as any), storage, stream, res };
  }

  it('streams a public file inline with cache headers and no key in sight', async () => {
    const { controller, storage, stream, res } = build();
    await controller.getPublicObject('p1', 'pub', 'img/a.png', undefined, undefined, res);
    expect(storage.statPublicObject).toHaveBeenCalledWith('p1', 'pub', 'img/a.png');
    expect(res.headers).toMatchObject({
      'Content-Type': 'image/png',
      'Content-Length': '10',
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      ETag: '"abc"',
    });
    expect(res.headers['Content-Disposition']).toMatch(/^inline;/);
    expect(storage.openObjectStream).toHaveBeenCalledWith('bf-acme-pub', 'img/a.png', undefined);
    expect(stream.pipe).toHaveBeenCalledWith(res);
  });

  it('sends a page as an attachment', async () => {
    const { controller, res } = build({ size: 3, metaData: { 'content-type': 'text/html' } });
    await controller.getPublicObject('p1', 'pub', 'a.html', undefined, undefined, res);
    expect(res.headers['Content-Disposition']).toMatch(/^attachment;/);
  });

  it('answers 304 on a matching ETag and 206 for a byte range', async () => {
    const a = build();
    await a.controller.getPublicObject('p1', 'pub', 'img/a.png', undefined, '"abc"', a.res);
    expect(a.res.status).toHaveBeenCalledWith(304);
    expect(a.storage.openObjectStream).not.toHaveBeenCalled();

    const b = build();
    await b.controller.getPublicObject('p1', 'pub', 'img/a.png', 'bytes=2-5', undefined, b.res);
    expect(b.res.status).toHaveBeenCalledWith(206);
    expect(b.res.headers).toMatchObject({ 'Content-Range': 'bytes 2-5/10', 'Content-Length': '4' });
    expect(b.storage.openObjectStream).toHaveBeenCalledWith('bf-acme-pub', 'img/a.png', { start: 2, end: 5 });

    const c = build();
    await c.controller.getPublicObject('p1', 'pub', 'img/a.png', 'bytes=20-', undefined, c.res);
    expect(c.res.status).toHaveBeenCalledWith(416);
  });

  it('parseRange takes one satisfiable range and clamps the end', () => {
    expect(parseRange('bytes=0-', 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=5-100', 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange('bytes=10-', 10)).toBeNull();
    expect(parseRange('bytes=0-1,4-5', 10)).toBeNull();
    expect(parseRange('items=0-1', 10)).toBeNull();
  });
});
