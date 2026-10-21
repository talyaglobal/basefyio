const createReadStream = jest.fn();
jest.mock('fs', () => ({ ...jest.requireActual('fs'), createReadStream: (...a: unknown[]) => createReadStream(...a) }));

const removeSpooled = jest.fn();
jest.mock('./upload-spool', () => ({
  ...jest.requireActual('./upload-spool'),
  removeSpooled: (...a: unknown[]) => removeSpooled(...a),
}));

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('./storage.service', () => ({ StorageService: class {} }));
jest.mock('./image-transform.service', () => ({ ImageTransformService: class {} }));
jest.mock('./storage-access.service', () => ({ StorageAccessService: class {} }));
jest.mock('../projects/project-activity.service', () => ({
  ProjectActivityService: class {},
  ProjectActivityKind: {
    STORAGE_OBJECT_UPLOADED: 'storage.object_uploaded',
    STORAGE_BUCKET_CREATED: 'storage.bucket_created',
    STORAGE_BUCKET_UPDATED: 'storage.bucket_updated',
    STORAGE_BUCKET_DELETED: 'storage.bucket_deleted',
    STORAGE_OBJECT_DELETED: 'storage.object_deleted',
  },
}));
jest.mock('../../common/guards/jwt-or-apikey.guard', () => ({ JwtOrApiKeyGuard: class {} }));

import {
  ForbiddenException,
  NotImplementedException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { MAX_FILE_SIZE, StorageController } from './storage.controller';

const user = { sub: 'u1' } as any;

// Request shapes as the guards leave them.
const dashboardReq = { user: { sub: 'u1' } } as any;
const anonReq = { apiKeyPayload: { projectId: 'p1', role: 'anon', dbRole: 'anon' } } as any;
const aliceReq = {
  apiKeyPayload: { projectId: 'p1', role: 'anon', dbRole: 'authenticated', jwtClaims: { sub: 'alice' } },
} as any;
const serviceReq = { apiKeyPayload: { projectId: 'p1', role: 'service', dbRole: 'service_role' } } as any;

function deps() {
  const storage = {
    uploadObjectStream: jest.fn(),
    getObject: jest.fn(),
    listObjects: jest.fn(),
    deleteObjects: jest.fn().mockResolvedValue({ message: 'ok' }),
    moveObjects: jest.fn().mockResolvedValue({ moved: 1 }),
    getPresignedUrl: jest.fn().mockResolvedValue({ url: 'signed', expiresIn: 3600 }),
    resolveBucket: jest.fn().mockResolvedValue({ project: { id: 'p1' }, minioBucket: 'bf-p-docs' }),
    statObjectIn: jest.fn().mockResolvedValue(null),
  };
  const activity = { append: jest.fn().mockResolvedValue(undefined) };
  const transforms = {
    limits: { cacheSeconds: 3600, maxSourceBytes: 25 * 1024 * 1024 },
    available: jest.fn().mockReturnValue(true),
    parseTransformQuery: jest.fn().mockReturnValue({ width: 200 }),
    etagFor: jest.fn().mockReturnValue('W/"abc-123"'),
    isTransformableSource: jest.fn().mockReturnValue({ ok: true }),
    tryAcquire: jest.fn(),
    transform: jest.fn(),
  };
  const access = {
    resolveMode: jest.fn().mockResolvedValue(null),
    assertCanRead: jest.fn(),
    assertCanOverwrite: jest.fn(),
    assertCanModifyAll: jest.fn().mockResolvedValue(undefined),
    filterListing: jest.fn(async (_c: unknown, _m: unknown, objects: unknown[]) => objects),
  };
  const controller = new StorageController(storage as any, activity as any, transforms as any, access as any);
  return { storage, activity, transforms, access, controller };
}

function fakeRes() {
  const res: any = {
    headersSent: false,
    headers: {} as Record<string, unknown>,
    statusCode: 200,
    listeners: {} as Record<string, (...a: unknown[]) => void>,
  };
  res.set = jest.fn((k: any, v?: any) => {
    if (typeof k === 'object') Object.assign(res.headers, k);
    else res.headers[k] = v;
    return res;
  });
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.end = jest.fn();
  res.once = jest.fn((event: string, fn: any) => {
    res.listeners[event] = fn;
  });
  res.removeHeader = jest.fn((h: string) => delete res.headers[h]);
  res.type = jest.fn(() => res);
  res.send = jest.fn();
  res.destroy = jest.fn();
  return res;
}

function sourceStream() {
  return { destroy: jest.fn(), pipe: jest.fn(), on: jest.fn() } as any;
}

beforeEach(() => {
  createReadStream.mockReset();
  removeSpooled.mockReset().mockResolvedValue(undefined);
});

describe('the upload ceiling', () => {
  it('defaults to 500 MB', () => {
    expect(MAX_FILE_SIZE).toBe(500 * 1024 * 1024);
  });
});

describe('uploadObject (disk spool → stream)', () => {
  const file = {
    path: '/spool/abc.part',
    size: 1234,
    mimetype: 'text/plain',
    originalname: 'orig.txt',
  } as any;

  it('streams the spooled file to the store, records the uploader, logs the activity and removes the spool file', async () => {
    const { storage, activity, controller } = deps();
    createReadStream.mockReturnValue('READ-STREAM');
    storage.uploadObjectStream.mockResolvedValue({ name: 'docs/a.txt', size: 1234 });

    const result = await controller.uploadObject('p1', 'docs', 'docs/a.txt', file, dashboardReq, user);

    expect(result).toEqual({ name: 'docs/a.txt', size: 1234 });
    expect(createReadStream).toHaveBeenCalledWith('/spool/abc.part');
    expect(storage.uploadObjectStream).toHaveBeenCalledWith(
      'p1',
      'u1',
      'docs',
      'docs/a.txt',
      'READ-STREAM',
      1234,
      'text/plain',
      { 'x-amz-meta-owner': 'u1' },
    );
    expect(activity.append).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        kind: 'storage.object_uploaded',
        detail: 'docs/a.txt',
        metadata: { size: 1234, contentType: 'text/plain' },
      }),
    );
    expect(removeSpooled).toHaveBeenCalledWith('/spool/abc.part');
  });

  it('records the end user as owner, and nobody for the service key', async () => {
    const { storage, controller } = deps();
    storage.uploadObjectStream.mockResolvedValue({});
    await controller.uploadObject('p1', 'docs', 'a.txt', file, aliceReq, undefined);
    expect(storage.uploadObjectStream.mock.calls[0][7]).toEqual({ 'x-amz-meta-owner': 'alice' });
    await controller.uploadObject('p1', 'docs', 'a.txt', file, serviceReq, undefined);
    expect(storage.uploadObjectStream.mock.calls[1][7]).toEqual({});
  });

  it('falls back to the original file name when no path is given', async () => {
    const { storage, controller } = deps();
    storage.uploadObjectStream.mockResolvedValue({});
    await controller.uploadObject('p1', 'docs', '', file, dashboardReq, user);
    expect(storage.uploadObjectStream.mock.calls[0][3]).toBe('orig.txt');
  });

  it('does not touch the store for an existing object under an owner-only rule unless the rule allows it', async () => {
    const { storage, access, controller } = deps();
    access.resolveMode.mockResolvedValue('owner-only');
    storage.statObjectIn.mockResolvedValue({ metaData: { owner: 'bob' } });
    access.assertCanOverwrite.mockImplementation(() => {
      throw new ForbiddenException('not yours');
    });

    await expect(controller.uploadObject('p1', 'docs', '/a.txt', file, aliceReq, undefined)).rejects.toThrow(
      ForbiddenException,
    );

    expect(storage.statObjectIn).toHaveBeenCalledWith('bf-p-docs', 'a.txt');
    expect(access.assertCanOverwrite).toHaveBeenCalledWith(
      { kind: 'authenticated', sub: 'alice' },
      'owner-only',
      { metaData: { owner: 'bob' } },
      'a.txt',
    );
    expect(storage.uploadObjectStream).not.toHaveBeenCalled();
    expect(removeSpooled).toHaveBeenCalledWith('/spool/abc.part');
  });

  it('skips the overwrite check for privileged callers and when there is no rule', async () => {
    const { storage, access, controller } = deps();
    storage.uploadObjectStream.mockResolvedValue({});
    await controller.uploadObject('p1', 'docs', 'a.txt', file, aliceReq, undefined);
    access.resolveMode.mockResolvedValue('owner-only');
    await controller.uploadObject('p1', 'docs', 'a.txt', file, serviceReq, undefined);
    expect(storage.statObjectIn).not.toHaveBeenCalled();
    expect(access.assertCanOverwrite).not.toHaveBeenCalled();
  });

  it('removes the spool file even when the store rejects the upload', async () => {
    const { storage, activity, controller } = deps();
    storage.uploadObjectStream.mockRejectedValue(new Error('store down'));

    await expect(controller.uploadObject('p1', 'docs', 'a.txt', file, dashboardReq, user)).rejects.toThrow('store down');

    expect(removeSpooled).toHaveBeenCalledWith('/spool/abc.part');
    expect(activity.append).not.toHaveBeenCalled();
  });

  it('answers 503 and drops the spool file when every upload slot is busy', async () => {
    const { storage, controller } = deps();
    const spool = jest.requireActual('./upload-spool');
    const limit = spool.resolveMaxConcurrentUploads();
    // Fill the shared semaphore by starting `limit` uploads that finish only when told to.
    const finishers: ((v: unknown) => void)[] = [];
    storage.uploadObjectStream.mockImplementation(() => new Promise((r) => finishers.push(r)));
    const pending = Array.from({ length: limit }, () =>
      controller.uploadObject('p1', 'docs', 'a.txt', file, dashboardReq, user),
    );
    // Let the pending uploads reach the store call.
    await new Promise((r) => setImmediate(r));
    expect(finishers).toHaveLength(limit);

    await expect(controller.uploadObject('p1', 'docs', 'b.txt', file, dashboardReq, user)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(removeSpooled).toHaveBeenCalledTimes(1);

    for (const finish of finishers) finish({});
    await Promise.all(pending);
    expect(removeSpooled).toHaveBeenCalledTimes(limit + 1);
  });
});

describe('downloadObject', () => {
  const stat = { etag: 'abc', size: 1000, metaData: { 'content-type': 'image/png', owner: 'alice' } };

  it('streams the object with the headers it always had when the bucket has no rule', async () => {
    const { storage, access, controller } = deps();
    const stream = sourceStream();
    storage.getObject.mockResolvedValue({ stream, stat });
    const res = fakeRes();

    await controller.downloadObject('p1', 'b', 'dir/a.png', anonReq, undefined, res);

    expect(access.assertCanRead).not.toHaveBeenCalled();
    expect(res.headers).toMatchObject({
      'Content-Type': 'image/png',
      'Content-Length': 1000,
      'Content-Disposition': `attachment; filename="a.png"; filename*=UTF-8''a.png`,
    });
    expect(stream.pipe).toHaveBeenCalledWith(res);
  });

  it('closes the stream and refuses when the rule says no', async () => {
    const { storage, access, controller } = deps();
    const stream = sourceStream();
    storage.getObject.mockResolvedValue({ stream, stat });
    access.resolveMode.mockResolvedValue('authenticated-read');
    access.assertCanRead.mockImplementation(() => {
      throw new ForbiddenException('signed-in users only');
    });

    await expect(controller.downloadObject('p1', 'b', 'a.png', anonReq, undefined, fakeRes())).rejects.toThrow(
      ForbiddenException,
    );

    expect(access.assertCanRead).toHaveBeenCalledWith({ kind: 'anon' }, 'authenticated-read', stat, 'a.png');
    expect(stream.destroy).toHaveBeenCalled();
    expect(stream.pipe).not.toHaveBeenCalled();
  });
});

describe('listObjects / deleteObjects / moveObjects / getPresignedUrl under rules', () => {
  it('hands the listing through the access filter', async () => {
    const { storage, access, controller } = deps();
    const objects = [{ name: 'a' }, { name: 'b' }];
    storage.listObjects.mockResolvedValue(objects);
    access.resolveMode.mockResolvedValue('owner-only');
    access.filterListing.mockResolvedValue([objects[0]]);

    const out = await controller.listObjects('p1', 'b', 'dir/', aliceReq, undefined);

    expect(storage.listObjects).toHaveBeenCalledWith('p1', undefined, 'b', 'dir/');
    expect(access.resolveMode).toHaveBeenCalledWith('p1', 'b', 'dir/');
    expect(access.filterListing).toHaveBeenCalledWith(
      { kind: 'authenticated', sub: 'alice' },
      'owner-only',
      objects,
      expect.any(Function),
    );
    expect(out).toEqual([objects[0]]);
  });

  it('checks every key before deleting or moving', async () => {
    const { storage, access, controller } = deps();
    await controller.deleteObjects('p1', 'b', { paths: ['x', 'y/'] }, aliceReq, undefined);
    expect(access.assertCanModifyAll).toHaveBeenCalledWith(
      { kind: 'authenticated', sub: 'alice' },
      'p1',
      'b',
      ['x', 'y/'],
      expect.any(Function),
      'delete',
    );
    expect(storage.deleteObjects).toHaveBeenCalledWith('p1', undefined, 'b', ['x', 'y/']);

    access.assertCanModifyAll.mockRejectedValueOnce(new ForbiddenException('nope'));
    await expect(
      controller.moveObjects('p1', 'b', { sources: ['x'], destFolder: 'z' }, aliceReq, undefined),
    ).rejects.toThrow(ForbiddenException);
    expect(storage.moveObjects).not.toHaveBeenCalled();
  });

  it('the stat helper resolves the physical bucket once and stats keys in it', async () => {
    const { storage, access, controller } = deps();
    await controller.deleteObjects('p1', 'b', { paths: ['x', 'y'] }, aliceReq, undefined);
    const statFn = access.assertCanModifyAll.mock.calls[0][4] as (k: string) => Promise<unknown>;
    await statFn('x');
    await statFn('y');
    expect(storage.resolveBucket).toHaveBeenCalledTimes(1);
    expect(storage.statObjectIn).toHaveBeenCalledWith('bf-p-docs', 'x');
    expect(storage.statObjectIn).toHaveBeenCalledWith('bf-p-docs', 'y');
  });

  it('applies the rule when a signed URL is minted, since the URL bypasses every later check', async () => {
    const { storage, access, controller } = deps();
    access.resolveMode.mockResolvedValue('owner-only');
    storage.statObjectIn.mockResolvedValue({ metaData: { owner: 'bob' } });
    access.assertCanRead.mockImplementation(() => {
      throw new ForbiddenException('not yours');
    });

    await expect(controller.getPresignedUrl('p1', 'b', 'k', '600', aliceReq, undefined)).rejects.toThrow(
      ForbiddenException,
    );
    expect(access.assertCanRead).toHaveBeenCalledWith(
      { kind: 'authenticated', sub: 'alice' },
      'owner-only',
      { metaData: { owner: 'bob' } },
      'k',
    );
    expect(storage.getPresignedUrl).not.toHaveBeenCalled();

    // The service key is never checked.
    await controller.getPresignedUrl('p1', 'b', 'k', '600', serviceReq, undefined);
    expect(storage.getPresignedUrl).toHaveBeenCalledWith('p1', undefined, 'b', 'k', 600);
  });
});

describe('renderObject', () => {
  const stat = { etag: 'abc', size: 1000, metaData: { 'content-type': 'image/png' } };

  it('answers 501 before touching storage when the native library is unavailable', async () => {
    const { storage, transforms, controller } = deps();
    transforms.available.mockReturnValue(false);
    await expect(
      controller.renderObject('p1', 'b', 'a.png', { width: '10' }, undefined, anonReq, undefined, fakeRes()),
    ).rejects.toThrow(NotImplementedException);
    expect(storage.getObject).not.toHaveBeenCalled();
  });

  it('validates the query before fetching the object', async () => {
    const { storage, transforms, controller } = deps();
    transforms.parseTransformQuery.mockImplementation(() => {
      throw new Error('bad query');
    });
    await expect(
      controller.renderObject('p1', 'b', 'a.png', {}, undefined, anonReq, undefined, fakeRes()),
    ).rejects.toThrow('bad query');
    expect(storage.getObject).not.toHaveBeenCalled();
  });

  it('applies the access rule before the ETag check', async () => {
    const { storage, access, transforms, controller } = deps();
    const stream = sourceStream();
    storage.getObject.mockResolvedValue({ stream, stat });
    access.resolveMode.mockResolvedValue('authenticated-read');
    access.assertCanRead.mockImplementation(() => {
      throw new ForbiddenException('no');
    });
    const res = fakeRes();

    await expect(
      controller.renderObject('p1', 'b', 'a.png', { width: '200' }, 'W/"abc-123"', anonReq, undefined, res),
    ).rejects.toThrow(ForbiddenException);
    expect(stream.destroy).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(304);
    expect(transforms.transform).not.toHaveBeenCalled();
  });

  it('answers 304 on a matching If-None-Match without transforming', async () => {
    const { storage, transforms, controller } = deps();
    const stream = sourceStream();
    storage.getObject.mockResolvedValue({ stream, stat });
    const res = fakeRes();

    await controller.renderObject('p1', 'b', 'a.png', { width: '200' }, 'W/"other", W/"abc-123"', dashboardReq, user, res);

    expect(storage.getObject).toHaveBeenCalledWith('p1', 'u1', 'b', 'a.png');
    expect(stream.destroy).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(304);
    expect(res.headers).toMatchObject({ ETag: 'W/"abc-123"', 'Cache-Control': 'public, max-age=3600' });
    expect(res.end).toHaveBeenCalled();
    expect(transforms.transform).not.toHaveBeenCalled();
  });

  it('refuses non-image sources with 415 and oversized ones with 413, destroying the stream', async () => {
    const { storage, transforms, controller } = deps();
    const stream = sourceStream();
    storage.getObject.mockResolvedValue({ stream, stat: { ...stat, metaData: { 'content-type': 'application/pdf' } } });
    transforms.isTransformableSource.mockReturnValue({ ok: false, reason: 'type' });

    await expect(
      controller.renderObject('p1', 'b', 'a.pdf', { width: '200' }, undefined, anonReq, undefined, fakeRes()),
    ).rejects.toThrow(UnsupportedMediaTypeException);
    expect(stream.destroy).toHaveBeenCalled();

    const big = sourceStream();
    storage.getObject.mockResolvedValue({ stream: big, stat });
    transforms.isTransformableSource.mockReturnValue({ ok: false, reason: 'size' });
    await expect(
      controller.renderObject('p1', 'b', 'a.png', { width: '200' }, undefined, anonReq, undefined, fakeRes()),
    ).rejects.toThrow(PayloadTooLargeException);
    expect(big.destroy).toHaveBeenCalled();
  });

  it('answers 503 with Retry-After when every transform slot is busy', async () => {
    const { storage, transforms, controller } = deps();
    const stream = sourceStream();
    storage.getObject.mockResolvedValue({ stream, stat });
    transforms.tryAcquire.mockReturnValue(null);
    const res = fakeRes();

    await expect(
      controller.renderObject('p1', 'b', 'a.png', { width: '200' }, undefined, anonReq, undefined, res),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(stream.destroy).toHaveBeenCalled();
    expect(res.headers['Retry-After']).toBe('2');
  });

  it('streams the transformed image inline with cache headers and releases the slot on close', async () => {
    const { storage, transforms, controller } = deps();
    const stream = sourceStream();
    storage.getObject.mockResolvedValue({ stream, stat });
    const release = jest.fn();
    transforms.tryAcquire.mockReturnValue(release);
    const out = { once: jest.fn(), pipe: jest.fn() };
    transforms.transform.mockReturnValue({ stream: out, contentType: 'image/webp', format: 'webp' });
    const res = fakeRes();

    await controller.renderObject('p1', 'b', 'photos/cat.png', { width: '200' }, undefined, anonReq, undefined, res);

    expect(transforms.transform).toHaveBeenCalledWith(stream, 'image/png', { width: 200 });
    expect(res.headers).toMatchObject({
      'Content-Type': 'image/webp',
      'Content-Disposition': `inline; filename="cat.webp"; filename*=UTF-8''cat.webp`,
      'Cache-Control': 'public, max-age=3600',
      ETag: 'W/"abc-123"',
      'X-Content-Type-Options': 'nosniff',
    });
    expect(out.pipe).toHaveBeenCalledWith(res);

    res.listeners['close']();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('turns a decode failure before any byte was sent into a 422 JSON error', async () => {
    const { storage, transforms, controller } = deps();
    storage.getObject.mockResolvedValue({ stream: sourceStream(), stat });
    const release = jest.fn();
    transforms.tryAcquire.mockReturnValue(release);
    const out = { once: jest.fn(), pipe: jest.fn() };
    transforms.transform.mockReturnValue({ stream: out, contentType: 'image/jpeg', format: 'jpeg' });
    const res = fakeRes();

    await controller.renderObject('p1', 'b', 'a.png', { format: 'jpeg' }, undefined, anonReq, undefined, res);

    const onError = out.once.mock.calls.find((c) => c[0] === 'error')![1];
    onError(new Error('Input buffer contains unsupported image format'));

    expect(release).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 422, message: expect.stringContaining('Unprocessable image') }),
    );
    expect(res.headers).not.toHaveProperty('ETag');
  });

  it('closes the connection when the failure happens mid-stream', async () => {
    const { storage, transforms, controller } = deps();
    storage.getObject.mockResolvedValue({ stream: sourceStream(), stat });
    transforms.tryAcquire.mockReturnValue(jest.fn());
    const out = { once: jest.fn(), pipe: jest.fn() };
    transforms.transform.mockReturnValue({ stream: out, contentType: 'image/png', format: 'png' });
    const res = fakeRes();
    res.headersSent = true;

    await controller.renderObject('p1', 'b', 'a.png', { width: '1' }, undefined, anonReq, undefined, res);
    out.once.mock.calls.find((c) => c[0] === 'error')![1](new Error('boom'));

    expect(res.destroy).toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });
});
