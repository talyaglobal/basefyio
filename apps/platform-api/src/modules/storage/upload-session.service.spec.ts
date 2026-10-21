jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../redis/redis.service', () => ({ RedisService: class {} }));
jest.mock('../billing/quota.service', () => ({ QuotaService: class {} }));
jest.mock('./storage.service', () => ({ StorageService: class {} }));
jest.mock('./storage-access.service', () => ({ StorageAccessService: class {} }));

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Readable } from 'stream';
import {
  MAX_CHUNK_BYTES,
  MIN_CHUNK_BYTES,
  UploadOffsetMismatchException,
  UploadSessionService,
  readRawBody,
} from './upload-session.service';
import type { StorageCaller } from './storage-caller';

const MiB = 1024 * 1024;
const alice: StorageCaller = { kind: 'authenticated', sub: 'alice' };
const bob: StorageCaller = { kind: 'authenticated', sub: 'bob' };
const service: StorageCaller = { kind: 'service' };
const dashboard: StorageCaller = { kind: 'dashboard', sub: 'member-1' };

const project = { id: 'p1', teamId: 't1', slug: 'proj', storagePrefix: null };

function row(overrides: Partial<any> = {}) {
  return {
    id: 's1',
    projectId: 'p1',
    bucket: 'docs',
    objectKey: 'big/video.mp4',
    contentType: 'video/mp4',
    totalSize: BigInt(20 * MiB),
    uploadedSize: BigInt(0),
    chunkSize: 8 * MiB,
    uploadId: 'mp-1',
    parts: [],
    ownerSub: 'alice',
    callerKind: 'authenticated',
    status: 'active',
    expiresAt: new Date(Date.now() + 3600_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function build(config: Record<string, unknown> = {}) {
  const prisma = {
    storageUploadSession: {
      create: jest.fn().mockImplementation(async ({ data }) => row({ ...data, id: 'new' })),
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue(undefined),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    project: { findUnique: jest.fn().mockResolvedValue({ slug: 'proj', storagePrefix: null }) },
  };
  const redisClient = { set: jest.fn().mockResolvedValue('OK'), del: jest.fn().mockResolvedValue(1) };
  const redis = { getClient: () => redisClient };
  const quota = { assertCanUploadStorage: jest.fn().mockResolvedValue(undefined) };
  const storage = {
    resolveBucket: jest.fn().mockResolvedValue({ project, minioBucket: 'bf-proj-docs' }),
    resolveProject: jest.fn().mockResolvedValue(project),
    physicalBucketName: jest.fn().mockReturnValue('bf-proj-docs'),
    statObjectIn: jest.fn().mockResolvedValue(null),
    beginMultipart: jest.fn().mockResolvedValue('mp-1'),
    putPart: jest.fn().mockImplementation(async (_b, _k, _u, part) => `etag-${part}`),
    finishMultipart: jest.fn().mockResolvedValue(undefined),
    abortMultipart: jest.fn().mockResolvedValue(undefined),
  };
  const access = {
    resolveMode: jest.fn().mockResolvedValue(null),
    assertCanOverwrite: jest.fn(),
  };
  const sessions = new UploadSessionService(
    prisma as any,
    { get: (k: string) => config[k] } as any,
    redis as any,
    quota as any,
    storage as any,
    access as any,
  );
  return { prisma, redisClient, quota, storage, access, sessions };
}

describe('chunk sizing', () => {
  it('defaults to 8 MiB and clamps requests to the store\'s bounds', () => {
    const { sessions } = build();
    expect(sessions.defaultChunkBytes).toBe(8 * MiB);
    expect(sessions.chunkSizeFor(100 * MiB)).toBe(8 * MiB);
    expect(sessions.chunkSizeFor(100 * MiB, 1 * MiB)).toBe(MIN_CHUNK_BYTES);
    expect(sessions.chunkSizeFor(1024 * MiB, 500 * MiB)).toBe(MAX_CHUNK_BYTES);
    expect(sessions.chunkSizeFor(100 * MiB, 16 * MiB)).toBe(16 * MiB);
  });

  it('uploads a small file as one chunk and never exceeds the file size', () => {
    const { sessions } = build();
    expect(sessions.chunkSizeFor(2 * MiB)).toBe(2 * MiB);
    expect(sessions.chunkSizeFor(6 * MiB, 64 * MiB)).toBe(6 * MiB);
  });

  it('reads STORAGE_RESUMABLE_* overrides', () => {
    const { sessions } = build({ 'storage.resumable.chunkMb': 16, 'storage.resumable.maxMb': 100, 'storage.resumable.ttlHours': 1 });
    expect(sessions.defaultChunkBytes).toBe(16 * MiB);
    expect(sessions.maxTotalBytes).toBe(100 * MiB);
    expect(sessions.ttlMs).toBe(3600_000);
  });
});

describe('createUploadSession', () => {
  it('checks quota, opens a multipart upload with content type and owner, and stores the row', async () => {
    const { prisma, quota, storage, sessions } = build();

    const view = await sessions.createUploadSession('p1', alice, undefined, 'docs', {
      path: '/big/video.mp4',
      size: 20 * MiB,
      contentType: 'video/mp4',
    });

    expect(storage.resolveBucket).toHaveBeenCalledWith('p1', undefined, 'docs');
    expect(quota.assertCanUploadStorage).toHaveBeenCalledWith('t1', 20 * MiB);
    expect(storage.beginMultipart).toHaveBeenCalledWith('bf-proj-docs', 'big/video.mp4', {
      'Content-Type': 'video/mp4',
      'x-amz-meta-owner': 'alice',
    });
    expect(prisma.storageUploadSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'p1',
        bucket: 'docs',
        objectKey: 'big/video.mp4',
        totalSize: BigInt(20 * MiB),
        chunkSize: 8 * MiB,
        uploadId: 'mp-1',
        ownerSub: 'alice',
        callerKind: 'authenticated',
      }),
    });
    expect(view).toMatchObject({ id: 'new', offset: 0, size: 20 * MiB, chunkSize: 8 * MiB, status: 'active' });
  });

  it('records no owner for the service key', async () => {
    const { storage, sessions } = build();
    await sessions.createUploadSession('p1', service, undefined, 'docs', { path: 'a.bin', size: 10 });
    expect(storage.beginMultipart.mock.calls[0][2]).toEqual({ 'Content-Type': 'application/octet-stream' });
  });

  it('validates path and size', async () => {
    const { sessions } = build();
    await expect(sessions.createUploadSession('p1', alice, undefined, 'docs', { path: '', size: 10 })).rejects.toThrow(BadRequestException);
    await expect(sessions.createUploadSession('p1', alice, undefined, 'docs', { path: 'dir/', size: 10 })).rejects.toThrow(/name a file/);
    await expect(sessions.createUploadSession('p1', alice, undefined, 'docs', { path: '../x', size: 10 })).rejects.toThrow(/Invalid path/);
    await expect(sessions.createUploadSession('p1', alice, undefined, 'docs', { path: 'a', size: 0 })).rejects.toThrow(/positive integer/);
    await expect(sessions.createUploadSession('p1', alice, undefined, 'docs', { path: 'a', size: 1.5 })).rejects.toThrow(BadRequestException);
    await expect(
      sessions.createUploadSession('p1', alice, undefined, 'docs', { path: 'a', size: 6 * 1024 * MiB }),
    ).rejects.toThrow(PayloadTooLargeException);
  });

  it('refuses to overwrite another user\'s object under an owner-only rule', async () => {
    const { storage, access, sessions } = build();
    access.resolveMode.mockResolvedValue('owner-only');
    storage.statObjectIn.mockResolvedValue({ metaData: { owner: 'alice' } });
    access.assertCanOverwrite.mockImplementation(() => {
      throw new ForbiddenException('nope');
    });
    await expect(sessions.createUploadSession('p1', bob, undefined, 'docs', { path: 'a', size: 10 })).rejects.toThrow(ForbiddenException);
    expect(storage.beginMultipart).not.toHaveBeenCalled();
  });
});

describe('appendChunk', () => {
  it('uploads the part, advances the offset and releases the lock', async () => {
    const { prisma, redisClient, storage, sessions } = build();
    prisma.storageUploadSession.findUnique.mockResolvedValue(row());

    const view = await sessions.appendChunk('p1', alice, undefined, 'docs', 's1', 0, Buffer.alloc(8 * MiB));

    expect(redisClient.set).toHaveBeenCalledWith('storage:upsess:s1', '1', 'EX', 60, 'NX');
    expect(storage.putPart).toHaveBeenCalledWith('bf-proj-docs', 'big/video.mp4', 'mp-1', 1, expect.any(Buffer));
    expect(prisma.storageUploadSession.updateMany).toHaveBeenCalledWith({
      where: { id: 's1', uploadedSize: BigInt(0), status: 'active' },
      data: { uploadedSize: BigInt(8 * MiB), parts: [{ part: 1, etag: 'etag-1', size: 8 * MiB }] },
    });
    expect(view.offset).toBe(8 * MiB);
    expect(redisClient.del).toHaveBeenCalledWith('storage:upsess:s1');
  });

  it('numbers parts from the offset and accepts a short final chunk', async () => {
    const { prisma, storage, sessions } = build();
    prisma.storageUploadSession.findUnique.mockResolvedValue(
      row({ uploadedSize: BigInt(16 * MiB), parts: [{ part: 1, etag: 'e1', size: 8 * MiB }, { part: 2, etag: 'e2', size: 8 * MiB }] }),
    );
    const view = await sessions.appendChunk('p1', alice, undefined, 'docs', 's1', 16 * MiB, Buffer.alloc(4 * MiB));
    expect(storage.putPart.mock.calls[0][3]).toBe(3);
    expect(view.offset).toBe(20 * MiB);
  });

  it('answers 409 with the server offset when the client is out of step', async () => {
    const { prisma, storage, sessions } = build();
    prisma.storageUploadSession.findUnique.mockResolvedValue(row({ uploadedSize: BigInt(8 * MiB) }));
    const err = await sessions.appendChunk('p1', alice, undefined, 'docs', 's1', 0, Buffer.alloc(8 * MiB)).catch((e) => e);
    expect(err).toBeInstanceOf(UploadOffsetMismatchException);
    expect(err.offset).toBe(8 * MiB);
    expect(storage.putPart).not.toHaveBeenCalled();
  });

  it('refuses a middle chunk that is not exactly chunkSize, an oversized chunk, an empty chunk and an overrun', async () => {
    const { prisma, sessions } = build();
    prisma.storageUploadSession.findUnique.mockResolvedValue(row());
    await expect(sessions.appendChunk('p1', alice, undefined, 'docs', 's1', 0, Buffer.alloc(4 * MiB))).rejects.toThrow(/exactly 8388608 bytes/);
    await expect(sessions.appendChunk('p1', alice, undefined, 'docs', 's1', 0, Buffer.alloc(9 * MiB))).rejects.toThrow(PayloadTooLargeException);
    await expect(sessions.appendChunk('p1', alice, undefined, 'docs', 's1', 0, Buffer.alloc(0))).rejects.toThrow(/Empty chunk/);
    prisma.storageUploadSession.findUnique.mockResolvedValue(row({ uploadedSize: BigInt(16 * MiB) }));
    await expect(sessions.appendChunk('p1', alice, undefined, 'docs', 's1', 16 * MiB, Buffer.alloc(8 * MiB))).rejects.toThrow(/runs past/);
  });

  it('rejects a lost race on the row as a 409', async () => {
    const { prisma, sessions } = build();
    prisma.storageUploadSession.findUnique.mockResolvedValue(row());
    prisma.storageUploadSession.updateMany.mockResolvedValue({ count: 0 });
    await expect(sessions.appendChunk('p1', alice, undefined, 'docs', 's1', 0, Buffer.alloc(8 * MiB))).rejects.toThrow(UploadOffsetMismatchException);
  });

  it('refuses when another chunk holds the lock, and when Redis is unreachable', async () => {
    const { prisma, redisClient, sessions } = build();
    prisma.storageUploadSession.findUnique.mockResolvedValue(row());
    redisClient.set.mockResolvedValueOnce(null);
    await expect(sessions.appendChunk('p1', alice, undefined, 'docs', 's1', 0, Buffer.alloc(8 * MiB))).rejects.toThrow(ConflictException);
    redisClient.set.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(sessions.appendChunk('p1', alice, undefined, 'docs', 's1', 0, Buffer.alloc(8 * MiB))).rejects.toThrow(ServiceUnavailableException);
  });

  it('refuses expired or finished sessions with 410 and foreign sessions with 403/404', async () => {
    const { prisma, sessions } = build();
    prisma.storageUploadSession.findUnique.mockResolvedValue(row({ expiresAt: new Date(Date.now() - 1000) }));
    await expect(sessions.appendChunk('p1', alice, undefined, 'docs', 's1', 0, Buffer.alloc(8 * MiB))).rejects.toThrow(GoneException);
    prisma.storageUploadSession.findUnique.mockResolvedValue(row({ status: 'completed' }));
    await expect(sessions.appendChunk('p1', alice, undefined, 'docs', 's1', 0, Buffer.alloc(8 * MiB))).rejects.toThrow(GoneException);
    prisma.storageUploadSession.findUnique.mockResolvedValue(row());
    await expect(sessions.appendChunk('p1', bob, undefined, 'docs', 's1', 0, Buffer.alloc(8 * MiB))).rejects.toThrow(ForbiddenException);
    await expect(sessions.appendChunk('p1', alice, undefined, 'other', 's1', 0, Buffer.alloc(8 * MiB))).rejects.toThrow(NotFoundException);
    prisma.storageUploadSession.findUnique.mockResolvedValue(null);
    await expect(sessions.appendChunk('p1', alice, undefined, 'docs', 'nope', 0, Buffer.alloc(8 * MiB))).rejects.toThrow(NotFoundException);
  });

  it('lets the service key and team members drive any session of the project', async () => {
    const { prisma, sessions } = build();
    prisma.storageUploadSession.findUnique.mockResolvedValue(row());
    await expect(sessions.appendChunk('p1', service, undefined, 'docs', 's1', 0, Buffer.alloc(8 * MiB))).resolves.toBeTruthy();
    await expect(sessions.appendChunk('p1', dashboard, 'member-1', 'docs', 's1', 0, Buffer.alloc(8 * MiB))).resolves.toBeTruthy();
  });
});

describe('complete / abort', () => {
  const full = row({
    uploadedSize: BigInt(20 * MiB),
    parts: [
      { part: 3, etag: 'e3', size: 4 * MiB },
      { part: 1, etag: 'e1', size: 8 * MiB },
      { part: 2, etag: 'e2', size: 8 * MiB },
    ],
  });

  it('assembles the parts in order, verifies the size and marks the session completed', async () => {
    const { prisma, storage, sessions } = build();
    prisma.storageUploadSession.findUnique.mockResolvedValue(full);
    storage.statObjectIn.mockResolvedValue({ size: 20 * MiB, etag: 'final', lastModified: new Date(0), metaData: { 'content-type': 'video/mp4' } });

    const result = await sessions.complete('p1', alice, undefined, 'docs', 's1');

    expect(storage.finishMultipart).toHaveBeenCalledWith('bf-proj-docs', 'big/video.mp4', 'mp-1', [
      { part: 1, etag: 'e1' },
      { part: 2, etag: 'e2' },
      { part: 3, etag: 'e3' },
    ]);
    expect(prisma.storageUploadSession.update).toHaveBeenCalledWith({ where: { id: 's1' }, data: { status: 'completed' } });
    expect(result).toEqual({
      name: 'big/video.mp4',
      size: 20 * MiB,
      contentType: 'video/mp4',
      lastModified: new Date(0),
      etag: 'final',
      sessionId: 's1',
    });
  });

  it('refuses to complete before every byte arrived', async () => {
    const { prisma, storage, sessions } = build();
    prisma.storageUploadSession.findUnique.mockResolvedValue(row({ uploadedSize: BigInt(8 * MiB) }));
    await expect(sessions.complete('p1', alice, undefined, 'docs', 's1')).rejects.toThrow(/Upload incomplete: 8388608 of 20971520/);
    expect(storage.finishMultipart).not.toHaveBeenCalled();
  });

  it('reports a size mismatch after assembly instead of claiming success', async () => {
    const { prisma, storage, sessions } = build();
    prisma.storageUploadSession.findUnique.mockResolvedValue(full);
    storage.statObjectIn.mockResolvedValue({ size: 1, metaData: {} });
    await expect(sessions.complete('p1', alice, undefined, 'docs', 's1')).rejects.toThrow(/Assembled object is 1 bytes/);
    expect(prisma.storageUploadSession.update).not.toHaveBeenCalled();
  });

  it('abort tears down the multipart upload once and is a no-op on a finished session', async () => {
    const { prisma, storage, sessions } = build();
    prisma.storageUploadSession.findUnique.mockResolvedValue(row());
    await sessions.abort('p1', alice, undefined, 'docs', 's1');
    expect(storage.abortMultipart).toHaveBeenCalledWith('bf-proj-docs', 'big/video.mp4', 'mp-1');
    expect(prisma.storageUploadSession.update).toHaveBeenCalledWith({ where: { id: 's1' }, data: { status: 'aborted' } });

    prisma.storageUploadSession.findUnique.mockResolvedValue(row({ status: 'completed' }));
    await sessions.abort('p1', alice, undefined, 'docs', 's1');
    expect(storage.abortMultipart).toHaveBeenCalledTimes(1);
  });
});

describe('expireStaleSessions', () => {
  it('aborts and marks stale active sessions, purges old finished rows, and survives store errors', async () => {
    const { prisma, storage, sessions } = build();
    const now = new Date('2026-10-20T12:00:00Z');
    prisma.storageUploadSession.findMany.mockResolvedValue([row({ id: 'a' }), row({ id: 'b', projectId: 'gone' })]);
    prisma.project.findUnique.mockImplementation(async ({ where }) => (where.id === 'gone' ? null : { slug: 'proj', storagePrefix: null }));
    storage.abortMultipart.mockRejectedValueOnce(new Error('store down'));
    prisma.storageUploadSession.deleteMany.mockResolvedValue({ count: 4 });

    const result = await sessions.expireStaleSessions(now);

    expect(prisma.storageUploadSession.findMany).toHaveBeenCalledWith({
      where: { status: 'active', expiresAt: { lt: now } },
      take: 200,
    });
    expect(storage.abortMultipart).toHaveBeenCalledTimes(1);
    expect(prisma.storageUploadSession.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.storageUploadSession.deleteMany).toHaveBeenCalledWith({
      where: { status: { not: 'active' }, updatedAt: { lt: new Date(now.getTime() - 7 * 24 * 3600_000) } },
    });
    expect(result).toEqual({ expired: 2, purged: 4 });
  });

  it('never throws out of the cron', async () => {
    const { prisma, sessions } = build();
    prisma.storageUploadSession.findMany.mockRejectedValue(new Error('db down'));
    await expect(sessions.expireStaleSessions()).resolves.toEqual({ expired: 0, purged: 0 });
  });
});

describe('readRawBody', () => {
  function fakeReq(chunks: Buffer[]) {
    const req: any = Readable.from(chunks);
    req.destroy = jest.fn();
    return req;
  }

  it('concatenates the body', async () => {
    const body = await readRawBody(fakeReq([Buffer.from('ab'), Buffer.from('cd')]), 10);
    expect(body.toString()).toBe('abcd');
  });

  it('stops at the cap with 413 and destroys the request', async () => {
    const req = fakeReq([Buffer.alloc(6), Buffer.alloc(6)]);
    await expect(readRawBody(req, 10)).rejects.toThrow(PayloadTooLargeException);
    expect(req.destroy).toHaveBeenCalled();
  });

  it('refuses a stream that was already consumed', async () => {
    const req: any = { readableEnded: true, on: jest.fn() };
    await expect(readRawBody(req, 10)).rejects.toThrow(/already consumed/);
  });
});
