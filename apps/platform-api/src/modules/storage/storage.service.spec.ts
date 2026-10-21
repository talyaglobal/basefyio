// The real client factory runs; only the S3 client library underneath it is
// replaced, so the service is built exactly as it is at boot (MINIO_* config,
// default driver) and talks to two recorded fakes: the internal data-path
// client first, then the public client that signs URLs.
jest.mock('minio', () => ({ Client: jest.fn() }));
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../billing/quota.service', () => ({ QuotaService: class {} }));

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as Minio from 'minio';
import { Readable } from 'stream';
import { StorageService } from './storage.service';

/**
 * StorageService: what a project's buckets are called, who may touch them,
 * what "public" means, and how usage is measured.
 *
 * The behaviour pinned here predates the S3 driver and the upload sessions;
 * those have their own specs. Everything below runs on the default MinIO path.
 */

const PROJECT = { id: 'p1', slug: 'acme', storagePrefix: null as string | null, teamId: 't1', status: 'ACTIVE' };
const BUCKET = 'bf-acme-docs';

type Item = { name?: string; prefix?: string; size?: number; lastModified?: Date; etag?: string };

const listing = (items: Item[]) => Readable.from(items);
const failingListing = () =>
  new Readable({
    objectMode: true,
    read() {
      this.destroy(new Error('listing broke'));
    },
  });

function internalClient() {
  return {
    listBuckets: jest.fn().mockResolvedValue([]),
    bucketExists: jest.fn().mockResolvedValue(true),
    makeBucket: jest.fn().mockResolvedValue(undefined),
    removeBucket: jest.fn().mockResolvedValue(undefined),
    setBucketPolicy: jest.fn().mockResolvedValue(undefined),
    getBucketPolicy: jest.fn().mockResolvedValue(''),
    listObjectsV2: jest.fn().mockImplementation(() => listing([])),
    putObject: jest.fn().mockResolvedValue({ etag: 'e1' }),
    statObject: jest.fn().mockResolvedValue({ size: 3, etag: 'e1', lastModified: new Date(0), metaData: {} }),
    getObject: jest.fn(),
    removeObject: jest.fn().mockResolvedValue(undefined),
    removeObjects: jest.fn().mockResolvedValue(undefined),
    copyObject: jest.fn().mockResolvedValue(undefined),
    presignedGetObject: jest.fn().mockResolvedValue('http://internal/never'),
  };
}

const DEFAULT_CFG: Record<string, unknown> = {
  'minio.endpoint': 'minio',
  'minio.port': 9000,
  'minio.publicEndpoint': 'files.example.com',
  'minio.publicPort': 443,
  'minio.publicSsl': 'true',
};

function build(cfg: Record<string, unknown> = DEFAULT_CFG) {
  const client = internalClient();
  const publicClient = { presignedGetObject: jest.fn().mockResolvedValue('https://files.example.com/signed') };
  (Minio.Client as unknown as jest.Mock)
    .mockReset()
    .mockImplementationOnce(() => client)
    .mockImplementationOnce(() => publicClient);

  const prisma = {
    project: {
      findFirst: jest.fn().mockResolvedValue(PROJECT),
      findMany: jest.fn().mockResolvedValue([PROJECT]),
      count: jest.fn().mockResolvedValue(0),
    },
    teamMember: { findUnique: jest.fn().mockResolvedValue({ teamId: 't1', userId: 'u1' }) },
    teamUsage: { upsert: jest.fn().mockResolvedValue(undefined) },
    projectUsage: { upsert: jest.fn().mockResolvedValue(undefined) },
    systemSetting: { upsert: jest.fn().mockResolvedValue(undefined), findUnique: jest.fn().mockResolvedValue(null) },
  };
  const quota = { assertCanUploadStorage: jest.fn().mockResolvedValue(undefined) };
  const config = { get: (k: string) => cfg[k] };
  const svc = new StorageService(prisma as any, config as any, quota as any);
  const priv = svc as any;
  return { svc, priv, client, publicClient, prisma, quota };
}

const publicPolicy = (bucket: string) =>
  JSON.stringify({
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${bucket}/*`] }],
  });

let warn: jest.SpyInstance;
beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
beforeEach(() => warn.mockClear());

describe('construction', () => {
  it('builds the internal client first and the URL-signing client second, from MINIO_* config', () => {
    build();
    const calls = (Minio.Client as unknown as jest.Mock).mock.calls.map(([o]) => o);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ endPoint: 'minio', port: 9000, useSSL: false });
    expect(calls[1]).toMatchObject({ endPoint: 'files.example.com', port: 443, useSSL: true });
  });

  it('reports the default driver and bucket prefix', () => {
    const { svc } = build();
    expect(svc.capabilities).toEqual({
      driver: 'minio',
      supportsBucketPolicies: true,
      virtualHost: false,
      bucketPrefix: 'bf-',
    });
  });
});

describe('bucket naming', () => {
  it('lower-cases and sanitises the project slug and the bucket name', () => {
    const { priv } = build();
    expect(priv.minioBucketName('Acme Shop', 'My_Bucket')).toBe('bf-acme-shop-my-bucket');
  });

  it('derives the project prefix the same way', () => {
    const { priv } = build();
    expect(priv.minioProjectPrefix('Acme.Shop')).toBe('bf-acme-shop-');
  });

  it('gives a bucket to the project with the longest matching prefix (warebnb vs warebnb-2)', () => {
    const { priv } = build();
    const projects = [
      { id: 'a', slug: 'warebnb' },
      { id: 'b', slug: 'warebnb-2' },
    ];
    expect(priv.resolveMinioBucketOwner('bf-warebnb-2-docs', projects)).toEqual({ id: 'b', slug: 'warebnb-2' });
    expect(priv.resolveMinioBucketOwner('bf-warebnb-docs', projects)).toEqual({ id: 'a', slug: 'warebnb' });
  });

  it('answers null for a bucket no project owns', () => {
    const { priv } = build();
    expect(priv.resolveMinioBucketOwner('bf-platform-feedback', [{ id: 'a', slug: 'acme' }])).toBeNull();
    expect(priv.resolveMinioBucketOwner('somebody-else', [{ id: 'a', slug: 'acme' }])).toBeNull();
  });

  it('matches a project by its storagePrefix when it has one, not by its slug', () => {
    const { priv, svc } = build();
    const projects = [{ id: 'a', slug: 'acme', storagePrefix: 'legacy' }];
    expect(priv.resolveMinioBucketOwner('bf-legacy-docs', projects)).toEqual({ id: 'a', slug: 'acme' });
    expect(priv.resolveMinioBucketOwner('bf-acme-docs', projects)).toBeNull();
    expect(svc.physicalBucketName({ slug: 'acme', storagePrefix: 'legacy' }, 'docs')).toBe('bf-legacy-docs');
    expect(svc.physicalBucketName({ slug: 'acme' }, 'docs')).toBe('bf-acme-docs');
  });
});

describe('project access', () => {
  it('refuses a project that is missing or not ACTIVE', async () => {
    const { svc, prisma } = build();
    prisma.project.findFirst.mockResolvedValue(null);
    await expect(svc.resolveProject('p1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.project.findFirst).toHaveBeenCalledWith({ where: { id: 'p1', status: 'ACTIVE' } });
  });

  it('refuses a dashboard user who is not on the project\'s team', async () => {
    const { svc, prisma } = build();
    prisma.teamMember.findUnique.mockResolvedValue(null);
    await expect(svc.resolveProject('p1', 'u9')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.teamMember.findUnique).toHaveBeenCalledWith({
      where: { teamId_userId: { teamId: 't1', userId: 'u9' } },
    });
  });

  it('does not look for a membership when the caller is an API key (no user id)', async () => {
    const { svc, prisma } = build();
    await expect(svc.resolveProject('p1')).resolves.toBe(PROJECT);
    expect(prisma.teamMember.findUnique).not.toHaveBeenCalled();
  });

  it('returns the project to a team member', async () => {
    const { svc } = build();
    await expect(svc.resolveProject('p1', 'u1')).resolves.toBe(PROJECT);
  });

  it('resolveBucket answers NotFound for a bucket that does not exist', async () => {
    const { svc, client } = build();
    client.bucketExists.mockResolvedValue(false);
    await expect(svc.resolveBucket('p1', undefined, 'docs')).rejects.toBeInstanceOf(NotFoundException);
    client.bucketExists.mockResolvedValue(true);
    await expect(svc.resolveBucket('p1', undefined, 'docs')).resolves.toEqual({ project: PROJECT, minioBucket: BUCKET });
  });
});

describe('listBuckets', () => {
  it('lists only the buckets this project owns, by their logical name', async () => {
    const { svc, client, prisma } = build();
    prisma.project.findMany.mockResolvedValue([
      PROJECT,
      { id: 'p2', slug: 'acme-2', storagePrefix: null },
    ]);
    const created = new Date('2026-01-01T00:00:00Z');
    client.listBuckets.mockResolvedValue([
      { name: 'bf-acme-docs', creationDate: created },
      { name: 'bf-acme-2-docs', creationDate: created },
      { name: 'bf-other-files', creationDate: created },
    ]);
    const out = await svc.listBuckets('p1');
    expect(out.map((b) => [b.id, b.name])).toEqual([['bf-acme-docs', 'docs']]);
    expect(out[0].createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('reports visibility from the bucket policy and counts files, not folder markers', async () => {
    const { svc, client } = build();
    client.listBuckets.mockResolvedValue([{ name: BUCKET, creationDate: new Date(0) }]);
    client.getBucketPolicy.mockResolvedValue(publicPolicy(BUCKET));
    client.listObjectsV2.mockImplementation(() =>
      listing([
        { name: 'img/', size: 0 },
        { name: 'img/a.png', size: 100 },
        { name: 'b.txt', size: 23 },
      ]),
    );
    const [bucket] = await svc.listBuckets('p1');
    expect(bucket).toMatchObject({ public: true, objectCount: 2, totalSize: 123 });
    expect(client.listObjectsV2).toHaveBeenCalledWith(BUCKET, '', true);
  });
});

describe('createBucket', () => {
  it('refuses names that are too short, too long, or start/end with a hyphen or hold other characters', async () => {
    const { svc, client } = build();
    for (const name of ['', 'ab', '-abc', 'abc-', 'a b', 'a_b_c', 'x'.repeat(64)]) {
      await expect(svc.createBucket('p1', undefined, name)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(client.bucketExists).not.toHaveBeenCalled();
  });

  it('refuses a name that is already taken', async () => {
    const { svc, client } = build();
    client.bucketExists.mockResolvedValue(true);
    await expect(svc.createBucket('p1', undefined, 'docs')).rejects.toBeInstanceOf(ConflictException);
    expect(client.makeBucket).not.toHaveBeenCalled();
  });

  it('creates a private bucket without any policy', async () => {
    const { svc, client } = build();
    client.bucketExists.mockResolvedValue(false);
    const out = await svc.createBucket('p1', undefined, 'docs');
    expect(client.makeBucket).toHaveBeenCalledWith(BUCKET);
    expect(client.setBucketPolicy).not.toHaveBeenCalled();
    expect(out).toMatchObject({ id: BUCKET, name: 'docs', public: false, objectCount: 0, totalSize: 0 });
  });

  it('keeps the logical name as given but stores the bucket lower-cased', async () => {
    const { svc, client } = build();
    client.bucketExists.mockResolvedValue(false);
    const out = await svc.createBucket('p1', undefined, 'MyDocs');
    expect(client.bucketExists).toHaveBeenCalledWith('bf-acme-mydocs');
    expect(out.name).toBe('MyDocs');
  });

  it('a public bucket gets anonymous GetObject on its objects and ListBucket on itself', async () => {
    const { svc, client } = build();
    client.bucketExists.mockResolvedValue(false);
    await svc.createBucket('p1', undefined, 'docs', true);
    const [bucket, policy] = client.setBucketPolicy.mock.calls[0];
    expect(bucket).toBe(BUCKET);
    const statements = JSON.parse(policy).Statement;
    expect(statements).toEqual([
      { Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${BUCKET}/*`] },
      { Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:ListBucket'], Resource: [`arn:aws:s3:::${BUCKET}`] },
    ]);
  });
});

describe('deleteBucket', () => {
  it('answers NotFound for a bucket that does not exist', async () => {
    const { svc, client } = build();
    client.bucketExists.mockResolvedValue(false);
    await expect(svc.deleteBucket('p1', undefined, 'docs')).rejects.toBeInstanceOf(NotFoundException);
    expect(client.removeBucket).not.toHaveBeenCalled();
  });

  it('empties the bucket before removing it', async () => {
    const { svc, client } = build();
    client.listObjectsV2.mockImplementation(() => listing([{ name: 'a.txt', size: 1 }, { name: 'dir/b.txt', size: 2 }]));
    const order: string[] = [];
    client.removeObjects.mockImplementation(async () => void order.push('removeObjects'));
    client.removeBucket.mockImplementation(async () => void order.push('removeBucket'));
    await expect(svc.deleteBucket('p1', undefined, 'docs')).resolves.toEqual({ message: 'Bucket "docs" deleted' });
    expect(client.removeObjects).toHaveBeenCalledWith(BUCKET, ['a.txt', 'dir/b.txt']);
    expect(order).toEqual(['removeObjects', 'removeBucket']);
  });

  it('skips the object sweep for an empty bucket', async () => {
    const { svc, client } = build();
    await svc.deleteBucket('p1', undefined, 'docs');
    expect(client.removeObjects).not.toHaveBeenCalled();
    expect(client.removeBucket).toHaveBeenCalledWith(BUCKET);
  });
});

describe('pruneProjectStorageBuckets', () => {
  it('deletes this project\'s buckets that are not in the keep list, and leaves a sibling project\'s alone', async () => {
    const { svc, client, prisma } = build();
    prisma.project.findMany.mockResolvedValue([PROJECT, { id: 'p2', slug: 'acme-2', storagePrefix: null }]);
    client.listBuckets.mockResolvedValue([
      { name: 'bf-acme-docs', creationDate: new Date(0) },
      { name: 'bf-acme-ghost', creationDate: new Date(0) },
      { name: 'bf-acme-2-docs', creationDate: new Date(0) },
    ]);
    await svc.pruneProjectStorageBuckets('p1', new Set(['Docs']));
    expect(client.removeBucket.mock.calls.map(([b]) => b)).toEqual(['bf-acme-ghost']);
  });

  it('does nothing with an empty keep list (never wipes a project by accident)', async () => {
    const { svc, client } = build();
    await svc.pruneProjectStorageBuckets('p1', new Set(['  ']));
    expect(client.listBuckets).not.toHaveBeenCalled();
    expect(client.removeBucket).not.toHaveBeenCalled();
  });
});

describe('toggleBucketPublic', () => {
  it('answers NotFound for a bucket that does not exist', async () => {
    const { svc, client } = build();
    client.bucketExists.mockResolvedValue(false);
    await expect(svc.toggleBucketPublic('p1', undefined, 'docs', true)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('making it public applies the anonymous read policy', async () => {
    const { svc, client } = build();
    await expect(svc.toggleBucketPublic('p1', undefined, 'docs', true)).resolves.toEqual({ public: true });
    const policy = JSON.parse(client.setBucketPolicy.mock.calls[0][1]);
    expect(policy.Statement[0].Action).toEqual(['s3:GetObject']);
  });

  it('making it private clears the policy', async () => {
    const { svc, client } = build();
    await expect(svc.toggleBucketPublic('p1', undefined, 'docs', false)).resolves.toEqual({ public: false });
    expect(client.setBucketPolicy).toHaveBeenCalledWith(BUCKET, '');
  });
});

describe('isBucketPublic', () => {
  it('is true for an Allow statement granting everyone s3:GetObject', async () => {
    const { svc, client } = build();
    client.getBucketPolicy.mockResolvedValue(publicPolicy(BUCKET));
    await expect(svc.bucketIsPublic(BUCKET)).resolves.toBe(true);
  });

  it('is false for a Deny, or for a grant to a specific principal', async () => {
    const { svc, client } = build();
    const deny = JSON.parse(publicPolicy(BUCKET));
    deny.Statement[0].Effect = 'Deny';
    client.getBucketPolicy.mockResolvedValueOnce(JSON.stringify(deny));
    await expect(svc.bucketIsPublic(BUCKET)).resolves.toBe(false);

    const scoped = JSON.parse(publicPolicy(BUCKET));
    scoped.Statement[0].Principal = { AWS: ['arn:aws:iam::123:user/alice'] };
    client.getBucketPolicy.mockResolvedValueOnce(JSON.stringify(scoped));
    await expect(svc.bucketIsPublic(BUCKET)).resolves.toBe(false);
  });

  it('is false for a ListBucket-only grant (objects are not readable)', async () => {
    const { svc, client } = build();
    const listOnly = JSON.parse(publicPolicy(BUCKET));
    listOnly.Statement[0].Action = ['s3:ListBucket'];
    client.getBucketPolicy.mockResolvedValue(JSON.stringify(listOnly));
    await expect(svc.bucketIsPublic(BUCKET)).resolves.toBe(false);
  });

  it('is false when the bucket has no policy at all (the store throws)', async () => {
    const { svc, client } = build();
    client.getBucketPolicy.mockRejectedValue(Object.assign(new Error('no policy'), { code: 'NoSuchBucketPolicy' }));
    await expect(svc.bucketIsPublic(BUCKET)).resolves.toBe(false);
  });

  it('is false for an empty or unparsable policy', async () => {
    const { svc, client } = build();
    client.getBucketPolicy.mockResolvedValueOnce('');
    await expect(svc.bucketIsPublic(BUCKET)).resolves.toBe(false);
    client.getBucketPolicy.mockResolvedValueOnce('{not json');
    await expect(svc.bucketIsPublic(BUCKET)).resolves.toBe(false);
  });
});

describe('getPublicUrl', () => {
  it('answers no URL for a private bucket, since the link would 403', async () => {
    const { svc } = build();
    await expect(svc.getPublicUrl('p1', undefined, 'docs', 'a.png')).resolves.toEqual({ public: false, url: null });
  });

  it('omits the default https port', async () => {
    const { svc, client } = build();
    client.getBucketPolicy.mockResolvedValue(publicPolicy(BUCKET));
    await expect(svc.getPublicUrl('p1', undefined, 'docs', 'img/a.png')).resolves.toEqual({
      public: true,
      url: `https://files.example.com/${BUCKET}/img/a.png`,
    });
  });

  it('omits port 80 on http and keeps any other port', async () => {
    const plain = build({ ...DEFAULT_CFG, 'minio.publicSsl': 'false', 'minio.publicPort': 80 });
    plain.client.getBucketPolicy.mockResolvedValue(publicPolicy(BUCKET));
    await expect(plain.svc.getPublicUrl('p1', undefined, 'docs', 'a')).resolves.toMatchObject({
      url: `http://files.example.com/${BUCKET}/a`,
    });

    const custom = build({ ...DEFAULT_CFG, 'minio.publicSsl': 'false', 'minio.publicPort': 9000 });
    custom.client.getBucketPolicy.mockResolvedValue(publicPolicy(BUCKET));
    await expect(custom.svc.getPublicUrl('p1', undefined, 'docs', 'a')).resolves.toMatchObject({
      url: `http://files.example.com:9000/${BUCKET}/a`,
    });
  });

  it('trims leading slashes and gives the bucket root for an empty path', async () => {
    const { svc, client } = build();
    client.getBucketPolicy.mockResolvedValue(publicPolicy(BUCKET));
    await expect(svc.getPublicUrl('p1', undefined, 'docs', '///a.txt')).resolves.toMatchObject({
      url: `https://files.example.com/${BUCKET}/a.txt`,
    });
    await expect(svc.getPublicUrl('p1', undefined, 'docs')).resolves.toMatchObject({
      url: `https://files.example.com/${BUCKET}/`,
    });
  });

  it('answers NotFound for a bucket that does not exist', async () => {
    const { svc, client } = build();
    client.bucketExists.mockResolvedValue(false);
    await expect(svc.getPublicUrl('p1', undefined, 'docs', 'a')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('listObjects', () => {
  it('passes prefix and recursion through and hides folder markers', async () => {
    const { svc, client } = build();
    const when = new Date('2026-02-02T00:00:00Z');
    client.listObjectsV2.mockImplementation(() =>
      listing([
        { name: 'img/', size: 0 },
        { name: 'img/sub/', size: 0 },
        { name: 'img/a.png', size: 5, lastModified: when, etag: 'x' },
        { prefix: 'img/deeper/' },
      ]),
    );
    const out = await svc.listObjects('p1', undefined, 'docs', 'img/', true);
    expect(client.listObjectsV2).toHaveBeenCalledWith(BUCKET, 'img/', true);
    expect(out).toEqual([
      { name: 'img/a.png', prefix: undefined, size: 5, lastModified: when, etag: 'x' },
      expect.objectContaining({ name: '', prefix: 'img/deeper/', size: 0 }),
    ]);
  });

  it('rejects when the listing stream fails', async () => {
    const { svc, client } = build();
    client.listObjectsV2.mockImplementation(() => failingListing());
    await expect(svc.listObjects('p1', undefined, 'docs')).rejects.toThrow('listing broke');
  });

  it('answers NotFound for a bucket that does not exist', async () => {
    const { svc, client } = build();
    client.bucketExists.mockResolvedValue(false);
    await expect(svc.listObjects('p1', undefined, 'docs')).rejects.toBeInstanceOf(NotFoundException);
    expect(client.listObjectsV2).not.toHaveBeenCalled();
  });
});

describe('createFolder', () => {
  it('refuses an empty, traversing or doubled-slash path', async () => {
    const { svc, client } = build();
    for (const path of ['', '/', '..', 'a/../b', 'a//b']) {
      await expect(svc.createFolder('p1', undefined, 'docs', path)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(client.putObject).not.toHaveBeenCalled();
  });

  it('writes a zero-byte directory marker whose key ends in a slash', async () => {
    const { svc, client } = build();
    await expect(svc.createFolder('p1', undefined, 'docs', '/docs/2026/')).resolves.toEqual({ name: 'docs/2026/' });
    expect(client.putObject).toHaveBeenCalledWith(BUCKET, 'docs/2026/', Buffer.alloc(0), 0, {
      'Content-Type': 'application/x-directory',
    });
  });
});

describe('findExistingObjects', () => {
  it('returns only the keys that exist, without leading slashes, skipping blanks', async () => {
    const { svc, client } = build();
    client.statObject.mockImplementation(async (_b: string, key: string) => {
      if (key === 'missing.txt') throw Object.assign(new Error('nope'), { code: 'NotFound' });
      return { size: 1 };
    });
    const out = await svc.findExistingObjects('p1', undefined, 'docs', ['/a.txt', 'missing.txt', '', 'b/c.txt']);
    expect(out.sort()).toEqual(['a.txt', 'b/c.txt']);
    expect(client.statObject).toHaveBeenCalledTimes(3);
  });

  it('checks at most 1000 paths per call', async () => {
    const { svc, client } = build();
    const paths = Array.from({ length: 1200 }, (_, i) => `f${i}`);
    const out = await svc.findExistingObjects('p1', undefined, 'docs', paths);
    expect(client.statObject).toHaveBeenCalledTimes(1000);
    expect(out).toHaveLength(1000);
  });
});

describe('moveObjects', () => {
  it('refuses a destination that traverses upwards', async () => {
    const { svc, client } = build();
    await expect(svc.moveObjects('p1', undefined, 'docs', ['a.txt'], '../x')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(client.copyObject).not.toHaveBeenCalled();
  });

  it('refuses to move a folder into itself', async () => {
    const { svc } = build();
    await expect(svc.moveObjects('p1', undefined, 'docs', ['img/'], 'img/sub')).rejects.toThrow(
      'Cannot move a folder into itself',
    );
  });

  it('moves a file as copy then delete into the destination folder', async () => {
    const { svc, client } = build();
    const order: string[] = [];
    client.copyObject.mockImplementation(async () => void order.push('copy'));
    client.removeObject.mockImplementation(async () => void order.push('remove'));
    await expect(svc.moveObjects('p1', undefined, 'docs', ['/inbox/file.txt'], 'dest')).resolves.toEqual({ moved: 1 });
    expect(client.copyObject).toHaveBeenCalledWith(BUCKET, 'dest/file.txt', `/${BUCKET}/inbox/file.txt`);
    expect(client.removeObject).toHaveBeenCalledWith(BUCKET, 'inbox/file.txt');
    expect(order).toEqual(['copy', 'remove']);
  });

  it('skips a file that is already where it would go, and blank sources', async () => {
    const { svc, client } = build();
    await expect(svc.moveObjects('p1', undefined, 'docs', ['file.txt', ''], '')).resolves.toEqual({ moved: 0 });
    expect(client.copyObject).not.toHaveBeenCalled();
  });

  it('moves a folder with every key beneath it, keeping the folder name', async () => {
    const { svc, client } = build();
    client.listObjectsV2.mockImplementation(() =>
      listing([{ name: 'img/' }, { name: 'img/a.png' }, { name: 'img/sub/b.png' }]),
    );
    await expect(svc.moveObjects('p1', undefined, 'docs', ['img/'], 'archive/')).resolves.toEqual({ moved: 3 });
    expect(client.listObjectsV2).toHaveBeenCalledWith(BUCKET, 'img/', true);
    expect(client.copyObject.mock.calls.map((c) => c[1])).toEqual([
      'archive/img/',
      'archive/img/a.png',
      'archive/img/sub/b.png',
    ]);
    expect(client.removeObject.mock.calls.map((c) => c[1])).toEqual(['img/', 'img/a.png', 'img/sub/b.png']);
  });

  it('leaves a folder alone when it already sits in the destination', async () => {
    const { svc, client } = build();
    await expect(svc.moveObjects('p1', undefined, 'docs', ['archive/img/'], 'archive')).resolves.toEqual({ moved: 0 });
    expect(client.listObjectsV2).not.toHaveBeenCalled();
  });
});

describe('uploadObject', () => {
  it('refuses an empty path before looking anything up', async () => {
    const { svc, prisma } = build();
    for (const path of ['', '/']) {
      await expect(
        svc.uploadObject('p1', undefined, 'docs', path, Buffer.from('x'), 'text/plain'),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(prisma.project.findFirst).not.toHaveBeenCalled();
  });

  it('checks the team\'s storage quota for the upload size before touching the bucket', async () => {
    const { svc, client, quota } = build();
    const order: string[] = [];
    quota.assertCanUploadStorage.mockImplementation(async () => void order.push('quota'));
    client.bucketExists.mockImplementation(async () => {
      order.push('bucketExists');
      return true;
    });
    await svc.uploadObject('p1', undefined, 'docs', 'a.txt', Buffer.from('hello'), 'text/plain');
    expect(quota.assertCanUploadStorage).toHaveBeenCalledWith('t1', 5);
    expect(order).toEqual(['quota', 'bucketExists']);
  });

  it('a quota refusal (402) propagates and nothing is stored', async () => {
    const { svc, client, quota } = build();
    quota.assertCanUploadStorage.mockRejectedValue(new HttpException('Storage quota exceeded', 402));
    await expect(
      svc.uploadObject('p1', undefined, 'docs', 'a.txt', Buffer.from('hello'), 'text/plain'),
    ).rejects.toMatchObject({ status: 402 });
    expect(client.putObject).not.toHaveBeenCalled();
  });

  it('answers NotFound for a bucket that does not exist', async () => {
    const { svc, client } = build();
    client.bucketExists.mockResolvedValue(false);
    await expect(
      svc.uploadObject('p1', undefined, 'docs', 'a.txt', Buffer.from('x'), 'text/plain'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(client.putObject).not.toHaveBeenCalled();
  });

  it('stores the buffer under the path without its leading slash and reports what landed', async () => {
    const { svc, client } = build();
    const buf = Buffer.from('hello');
    const when = new Date('2026-03-03T00:00:00Z');
    client.statObject.mockResolvedValue({ size: 5, etag: 'tag', lastModified: when, metaData: {} });
    const out = await svc.uploadObject('p1', undefined, 'docs', '/a/b.txt', buf, 'text/plain');
    expect(client.putObject).toHaveBeenCalledWith(BUCKET, 'a/b.txt', buf, 5, { 'Content-Type': 'text/plain' });
    expect(client.statObject).toHaveBeenCalledWith(BUCKET, 'a/b.txt');
    expect(out).toEqual({ name: 'a/b.txt', size: 5, contentType: 'text/plain', lastModified: when, etag: 'tag' });
  });
});

describe('uploadObjectStream', () => {
  it('hands the client no length at all when the source declared none, instead of an empty object', async () => {
    const { svc, client } = build();
    const body = Readable.from(['abc']);
    await svc.uploadObjectStream('p1', undefined, 'docs', 'a.txt', body, 0, 'text/plain');
    expect(client.putObject).toHaveBeenCalledWith(BUCKET, 'a.txt', body, undefined, { 'Content-Type': 'text/plain' });
  });

  it('fails loudly when the stored size differs from the declared one, naming both', async () => {
    const { svc, client } = build();
    client.statObject.mockResolvedValue({ size: 10, metaData: {} });
    const err = await svc
      .uploadObjectStream('p1', undefined, 'docs', 'big.bin', Readable.from(['x']), 2048, 'application/octet-stream')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InternalServerErrorException);
    expect((err as Error).message).toContain('10');
    expect((err as Error).message).toContain('2048');
  });

  it('passes extra metadata through and returns the stat when sizes match', async () => {
    const { svc, client, quota } = build();
    client.statObject.mockResolvedValue({ size: 3, etag: 'e', lastModified: new Date(0), metaData: { 'content-type': 'text/csv' } });
    const out = await svc.uploadObjectStream('p1', undefined, 'docs', 'a.csv', Readable.from(['abc']), 3, 'text/plain', {
      'X-Amz-Meta-Owner': 'u1',
    });
    expect(quota.assertCanUploadStorage).toHaveBeenCalledWith('t1', 3);
    expect(client.putObject.mock.calls[0][4]).toEqual({ 'Content-Type': 'text/plain', 'X-Amz-Meta-Owner': 'u1' });
    expect(out).toMatchObject({ name: 'a.csv', size: 3, contentType: 'text/csv' });
  });
});

describe('getObject', () => {
  it('maps a missing key to NotFound', async () => {
    const { svc, client } = build();
    for (const code of ['NoSuchKey', 'NotFound']) {
      client.statObject.mockRejectedValueOnce(Object.assign(new Error('gone'), { code }));
      await expect(svc.getObject('p1', undefined, 'docs', 'a.txt')).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it('maps any other failure to a 500 that names the cause', async () => {
    const { svc, client } = build();
    client.statObject.mockRejectedValue(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
    await expect(svc.getObject('p1', undefined, 'docs', 'a.txt')).rejects.toThrow(
      new InternalServerErrorException('Failed to get object: connection reset'),
    );
  });

  it('returns the stat and the stream of the object', async () => {
    const { svc, client } = build();
    const stream = Readable.from(['x']);
    client.getObject.mockResolvedValue(stream);
    const out = await svc.getObject('p1', undefined, 'docs', 'a.txt');
    expect(out.stream).toBe(stream);
    expect(client.getObject).toHaveBeenCalledWith(BUCKET, 'a.txt');
  });
});

describe('deleteObjects', () => {
  it('expands folders into their keys, de-duplicates, and removes everything in one call', async () => {
    const { svc, client } = build();
    client.listObjectsV2.mockImplementation(() => listing([{ name: 'img/' }, { name: 'img/a.png' }, { name: 'img/b.png' }]));
    const out = await svc.deleteObjects('p1', undefined, 'docs', ['img/', '/img/a.png', 'top.txt', '']);
    expect(client.listObjectsV2).toHaveBeenCalledWith(BUCKET, 'img/', true);
    expect(client.removeObjects).toHaveBeenCalledTimes(1);
    expect([...client.removeObjects.mock.calls[0][1]].sort()).toEqual(['img/', 'img/a.png', 'img/b.png', 'top.txt']);
    expect(out).toEqual({ message: 'Deleted 4 object(s)' });
  });

  it('reports zero for an empty selection', async () => {
    const { svc, client } = build();
    await expect(svc.deleteObjects('p1', undefined, 'docs', [])).resolves.toEqual({ message: 'Deleted 0 object(s)' });
    expect(client.removeObjects).toHaveBeenCalledWith(BUCKET, []);
  });
});

describe('getPresignedUrl', () => {
  it('signs with the public client so the signature matches the host the browser uses', async () => {
    const { svc, client, publicClient } = build();
    await expect(svc.getPresignedUrl('p1', undefined, 'docs', 'a.txt', 600)).resolves.toEqual({
      url: 'https://files.example.com/signed',
      expiresIn: 600,
    });
    expect(publicClient.presignedGetObject).toHaveBeenCalledWith(BUCKET, 'a.txt', 600);
    expect(client.presignedGetObject).not.toHaveBeenCalled();
  });

  it('defaults to one hour', async () => {
    const { svc, publicClient } = build();
    await expect(svc.getPresignedUrl('p1', undefined, 'docs', 'a.txt')).resolves.toMatchObject({ expiresIn: 3600 });
    expect(publicClient.presignedGetObject).toHaveBeenCalledWith(BUCKET, 'a.txt', 3600);
  });

  it('checks project access first', async () => {
    const { svc, prisma, publicClient } = build();
    prisma.teamMember.findUnique.mockResolvedValue(null);
    await expect(svc.getPresignedUrl('p1', 'stranger', 'docs', 'a.txt')).rejects.toBeInstanceOf(ForbiddenException);
    expect(publicClient.presignedGetObject).not.toHaveBeenCalled();
  });
});

describe('statObjectIn', () => {
  it('answers null for a missing key and rethrows anything else', async () => {
    const { svc, client } = build();
    client.statObject.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'NoSuchKey' }));
    await expect(svc.statObjectIn(BUCKET, 'a')).resolves.toBeNull();
    client.statObject.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'AccessDenied' }));
    await expect(svc.statObjectIn(BUCKET, 'a')).rejects.toThrow('denied');
  });
});

describe('recalculateStorageUsage', () => {
  const T1A = { id: 'p1', slug: 'acme', storagePrefix: null, teamId: 't1' };
  const T1B = { id: 'p2', slug: 'beta', storagePrefix: null, teamId: 't1' };
  const T2 = { id: 'p3', slug: 'gamma', storagePrefix: null, teamId: 't2' };

  function withBuckets(sizes: Record<string, number[]>) {
    const ctx = build();
    ctx.client.listBuckets.mockResolvedValue(
      Object.keys(sizes).map((name) => ({ name, creationDate: new Date('2026-01-01T00:00:00Z') })),
    );
    ctx.client.listObjectsV2.mockImplementation((bucket: string) =>
      listing((sizes[bucket] ?? []).map((size, i) => ({ name: `o${i}`, size }))),
    );
    return ctx;
  }

  it('does nothing when there are no billable projects', async () => {
    const { svc, prisma, client } = build();
    prisma.project.findMany.mockResolvedValue([]);
    await svc.recalculateStorageUsage();
    expect(client.listBuckets).not.toHaveBeenCalled();
    expect(prisma.teamUsage.upsert).not.toHaveBeenCalled();
    expect(prisma.projectUsage.upsert).not.toHaveBeenCalled();
  });

  it('excludes deleted and deactivated projects from the measured set', async () => {
    const { svc, prisma } = build();
    prisma.project.findMany.mockResolvedValue([]);
    await svc.recalculateStorageUsage();
    expect(prisma.project.findMany.mock.calls[0][0].where).toEqual({ status: { notIn: ['DELETED', 'DEACTIVATED'] } });
  });

  it('sums every bucket of a team into one BigInt total per team', async () => {
    const { svc, prisma } = withBuckets({ 'bf-acme-a': [100, 50], 'bf-beta-b': [25], 'bf-gamma-c': [7] });
    prisma.project.findMany.mockResolvedValueOnce([T1A, T1B, T2]).mockResolvedValueOnce([T1A, T1B, T2]);
    await svc.recalculateStorageUsage();
    const byTeam = Object.fromEntries(
      prisma.teamUsage.upsert.mock.calls.map(([arg]: any[]) => [arg.where.teamId, arg.update.storageBytes]),
    );
    expect(byTeam).toEqual({ t1: BigInt(175), t2: BigInt(7) });
    expect(prisma.teamUsage.upsert.mock.calls[0][0].create).toEqual({ teamId: 't1', storageBytes: BigInt(175) });
  });

  it('writes a per-project figure with its measurement time, zero for a project without buckets', async () => {
    const { svc, prisma } = withBuckets({ 'bf-acme-a': [10] });
    prisma.project.findMany.mockResolvedValueOnce([T1A, T1B]).mockResolvedValueOnce([T1A, T1B]);
    await svc.recalculateStorageUsage();
    const calls = prisma.projectUsage.upsert.mock.calls.map(([arg]: any[]) => arg);
    expect(calls.map((c: any) => [c.where.projectId, c.update.storageBytes])).toEqual([
      ['p1', BigInt(10)],
      ['p2', BigInt(0)],
    ]);
    expect(calls[0].update.storageCalculatedAt).toBeInstanceOf(Date);
    expect(calls[0].create).toMatchObject({ projectId: 'p1', teamId: 't1', storageBytes: BigInt(10) });
  });

  it('a team-scoped pass measures only that team and leaves the inventory alone', async () => {
    const { svc, prisma, client } = withBuckets({ 'bf-acme-a': [10], 'bf-gamma-c': [99] });
    prisma.project.findMany.mockResolvedValueOnce([T1A]);
    await svc.recalculateStorageUsage('t1');
    expect(prisma.project.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.project.findMany.mock.calls[0][0].where).toMatchObject({ teamId: 't1' });
    expect(client.listObjectsV2).toHaveBeenCalledTimes(1);
    expect(client.listObjectsV2).toHaveBeenCalledWith('bf-acme-a', '', true);
    expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
    expect(prisma.teamUsage.upsert).toHaveBeenCalledTimes(1);
  });

  it('a full pass records every bucket, naming a deleted project\'s and leaving unowned ones null', async () => {
    const { svc, prisma } = withBuckets({ 'bf-acme-a': [10], 'bf-gone-x': [5], 'bf-platform-feedback': [1, 2] });
    const deleted = { id: 'p-deleted', slug: 'gone', storagePrefix: null };
    prisma.project.findMany.mockResolvedValueOnce([T1A]).mockResolvedValueOnce([T1A, deleted]);
    await svc.recalculateStorageUsage();
    const arg = prisma.systemSetting.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ key: 'storage_bucket_inventory' });
    const inventory = arg.create.value;
    expect(typeof inventory.measuredAt).toBe('string');
    expect(inventory.buckets).toEqual([
      { bucket: 'bf-acme-a', projectId: 'p1', sizeBytes: 10, objectCount: 1, createdAt: '2026-01-01T00:00:00.000Z' },
      { bucket: 'bf-gone-x', projectId: 'p-deleted', sizeBytes: 5, objectCount: 1, createdAt: '2026-01-01T00:00:00.000Z' },
      { bucket: 'bf-platform-feedback', projectId: null, sizeBytes: 3, objectCount: 2, createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    // A deleted project's bytes are not billed to anyone.
    const teams = prisma.teamUsage.upsert.mock.calls.map(([a]: any[]) => [a.where.teamId, a.update.storageBytes]);
    expect(teams).toEqual([['t1', BigInt(10)]]);
  });

  it('never throws: a failure is logged and swallowed', async () => {
    const { svc, prisma } = build();
    prisma.project.findMany.mockRejectedValue(new Error('db down'));
    await expect(svc.recalculateStorageUsage()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
  });
});

describe('getBucketInventory', () => {
  it('is null until a full pass has run, then returns the stored value', async () => {
    const { svc, prisma } = build();
    await expect(svc.getBucketInventory()).resolves.toBeNull();
    const value = { measuredAt: 'now', buckets: [] };
    prisma.systemSetting.findUnique.mockResolvedValue({ key: 'storage_bucket_inventory', value });
    await expect(svc.getBucketInventory()).resolves.toEqual(value);
    expect(prisma.systemSetting.findUnique).toHaveBeenCalledWith({ where: { key: 'storage_bucket_inventory' } });
  });
});

describe('onModuleInit', () => {
  afterEach(() => jest.useRealTimers());

  it('schedules no extra pass when every project has a measurement', async () => {
    jest.useFakeTimers();
    const { svc } = build();
    const spy = jest.spyOn(svc, 'recalculateStorageUsage').mockResolvedValue(undefined);
    await svc.onModuleInit();
    jest.advanceTimersByTime(120_000);
    expect(spy).not.toHaveBeenCalled();
  });

  it('runs one pass 90 s after boot when some project was never measured', async () => {
    jest.useFakeTimers();
    const { svc, prisma } = build();
    prisma.project.count.mockResolvedValue(3);
    const spy = jest.spyOn(svc, 'recalculateStorageUsage').mockResolvedValue(undefined);
    await svc.onModuleInit();
    jest.advanceTimersByTime(89_000);
    expect(spy).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1_000);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith();
  });
});

describe('uploadFeedbackAttachment', () => {
  it('accepts only images and videos', async () => {
    const { svc, client } = build();
    await expect(svc.uploadFeedbackAttachment('u1', Buffer.from('x'), 'application/pdf')).rejects.toThrow(
      'Only image or video files are allowed',
    );
    expect(client.putObject).not.toHaveBeenCalled();
  });

  it('caps images at 5 MB and videos at 20 MB', async () => {
    const { svc } = build();
    await expect(
      svc.uploadFeedbackAttachment('u1', Buffer.alloc(5 * 1024 * 1024 + 1), 'image/png'),
    ).rejects.toThrow('Image too large (max 5 MB)');
    await expect(
      svc.uploadFeedbackAttachment('u1', Buffer.alloc(20 * 1024 * 1024 + 1), 'video/mp4'),
    ).rejects.toThrow('Video too large (max 20 MB)');
    // A 6 MB video is fine — the image limit does not apply to it.
    await expect(
      svc.uploadFeedbackAttachment('u1', Buffer.alloc(6 * 1024 * 1024), 'video/mp4'),
    ).resolves.toMatchObject({ kind: 'video' });
  });

  it('creates the platform bucket with a read-only (GetObject) policy the first time', async () => {
    const { svc, client } = build();
    client.bucketExists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await svc.uploadFeedbackAttachment('u1', Buffer.from('x'), 'image/png');
    expect(client.makeBucket).toHaveBeenCalledWith('bf-platform-feedback', '');
    const policy = JSON.parse(client.setBucketPolicy.mock.calls[0][1]);
    expect(policy.Statement).toHaveLength(1);
    expect(policy.Statement[0]).toMatchObject({ Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::bf-platform-feedback/*'] });

    await svc.uploadFeedbackAttachment('u1', Buffer.from('x'), 'image/png');
    expect(client.makeBucket).toHaveBeenCalledTimes(1);
  });

  it('names the file by content type and returns a direct public URL', async () => {
    const { svc, client } = build();
    const cases: Array<[string, string]> = [
      ['image/png', 'png'],
      ['image/jpeg', 'jpg'],
      ['image/webp', 'webp'],
      ['video/quicktime', 'mov'],
      ['video/webm', 'webm'],
      ['video/x-matroska', 'mp4'],
    ];
    for (const [type, ext] of cases) {
      const out = await svc.uploadFeedbackAttachment('u1', Buffer.from('x'), type);
      expect(out.url).toMatch(
        new RegExp(`^https://files\\.example\\.com:443/bf-platform-feedback/u1/\\d+-[0-9a-f]{16}\\.${ext}$`),
      );
      expect(out.mimeType).toBe(type);
    }
    expect(client.putObject.mock.calls[0][4]).toEqual({ 'Content-Type': 'image/png' });
  });
});
