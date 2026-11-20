jest.mock('minio', () => ({ Client: jest.fn() }));
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../billing/quota.service', () => ({ QuotaService: class {} }));

import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import * as Minio from 'minio';
import { Readable } from 'stream';
import { StorageService } from './storage.service';

/**
 * Cross-tenant isolation of physical buckets. `bf-a-` + `b-x` and `bf-a-b-` + `x` are the same
 * physical bucket `bf-a-b-x`; it belongs to project `a-b` (recorded) and project `a` must not
 * reach it through any verb. Every refusal is a 404 that touches no object in the store.
 */

const A = { id: 'a', slug: 'a', storagePrefix: null as string | null, teamId: 't1', status: 'ACTIVE' };
const AB = { id: 'ab', slug: 'a-b', storagePrefix: null as string | null, teamId: 't2', status: 'ACTIVE' };
const SHARED = 'bf-a-b-x';

function build(opts: { owners?: Record<string, string>; projects?: any[]; buckets?: string[] } = {}) {
  const projects = opts.projects ?? [A, AB];
  const owners = new Map(Object.entries(opts.owners ?? { [SHARED]: 'ab' }));
  const buckets = new Set(opts.buckets ?? [SHARED, 'bf-a-docs']);
  const client = {
    listBuckets: jest.fn(async () => [...buckets].map((name) => ({ name, creationDate: new Date(0) }))),
    bucketExists: jest.fn(async (b: string) => buckets.has(b)),
    makeBucket: jest.fn().mockResolvedValue(undefined),
    removeBucket: jest.fn().mockResolvedValue(undefined),
    setBucketPolicy: jest.fn().mockResolvedValue(undefined),
    getBucketPolicy: jest.fn().mockResolvedValue(''),
    listObjectsV2: jest.fn(() => Readable.from([{ name: 'secret.txt', size: 3 }])),
    putObject: jest.fn().mockResolvedValue({ etag: 'e' }),
    statObject: jest.fn().mockResolvedValue({ size: 3, etag: 'e', lastModified: new Date(0), metaData: {} }),
    getObject: jest.fn().mockResolvedValue(Readable.from(['abc'])),
    getPartialObject: jest.fn().mockResolvedValue(Readable.from(['a'])),
    removeObject: jest.fn().mockResolvedValue(undefined),
    removeObjects: jest.fn().mockResolvedValue(undefined),
    copyObject: jest.fn().mockResolvedValue(undefined),
  };
  const publicClient = { presignedGetObject: jest.fn().mockResolvedValue('https://files.example.com/signed') };
  (Minio.Client as unknown as jest.Mock)
    .mockReset()
    .mockImplementationOnce(() => client)
    .mockImplementationOnce(() => publicClient);
  const prisma = {
    project: {
      findFirst: jest.fn(async ({ where }: any) => projects.find((p) => p.id === where.id && p.status === 'ACTIVE') ?? null),
      findMany: jest.fn(async () => projects),
      count: jest.fn().mockResolvedValue(0),
    },
    teamMember: { findUnique: jest.fn().mockResolvedValue({ role: 'OWNER' }) },
    storageBucketOwner: {
      findUnique: jest.fn(async ({ where }: any) =>
        owners.has(where.physicalName) ? { physicalName: where.physicalName, projectId: owners.get(where.physicalName) } : null,
      ),
      findMany: jest.fn(async ({ where }: any = {}) =>
        [...owners]
          .filter(([n]) => !where?.physicalName?.in || where.physicalName.in.includes(n))
          .map(([physicalName, projectId]) => ({ physicalName, projectId })),
      ),
      create: jest.fn(async ({ data }: any) => {
        if (owners.has(data.physicalName)) throw Object.assign(new Error('unique'), { code: 'P2002' });
        owners.set(data.physicalName, data.projectId);
        return data;
      }),
      createMany: jest.fn(async ({ data }: any) => {
        for (const d of data) if (!owners.has(d.physicalName)) owners.set(d.physicalName, d.projectId);
        return { count: data.length };
      }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const quota = { assertCanUploadStorage: jest.fn().mockResolvedValue(undefined) };
  const cfg: Record<string, unknown> = {
    'minio.endpoint': 'minio',
    'minio.port': 9000,
    'minio.publicEndpoint': 'files.example.com',
    'minio.publicPort': 443,
    'minio.publicSsl': 'true',
  };
  const svc = new StorageService(prisma as any, { get: (k: string) => cfg[k] } as any, quota as any);
  return { svc, client, publicClient, prisma, owners };
}

/** No call that reads, writes or deletes data in the store. */
function expectUntouched(client: ReturnType<typeof build>['client'], publicClient: { presignedGetObject: jest.Mock }) {
  for (const fn of [
    client.listObjectsV2,
    client.putObject,
    client.statObject,
    client.getObject,
    client.getPartialObject,
    client.removeObject,
    client.removeObjects,
    client.copyObject,
    client.removeBucket,
    client.setBucketPolicy,
    client.makeBucket,
    publicClient.presignedGetObject,
  ]) {
    expect(fn).not.toHaveBeenCalled();
  }
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
});

/** Every verb, as project `a` asking for its "bucket" `b-x` (= a-b's `x`). */
const VERBS: Array<[string, (svc: StorageService) => Promise<unknown>]> = [
  ['listObjects', (s) => s.listObjects('a', 'u1', 'b-x')],
  ['createFolder', (s) => s.createFolder('a', 'u1', 'b-x', 'f')],
  ['getPublicUrl', (s) => s.getPublicUrl('a', 'u1', 'b-x', 'secret.txt')],
  ['findExistingObjects', (s) => s.findExistingObjects('a', 'u1', 'b-x', ['secret.txt'])],
  ['moveObjects', (s) => s.moveObjects('a', 'u1', 'b-x', ['secret.txt'], 'moved')],
  ['moveObject (source)', (s) => s.moveObject('a', 'u1', 'b-x', 'secret.txt', 'stolen.txt', 'docs')],
  ['moveObject (destination)', (s) => s.moveObject('a', 'u1', 'docs', 'mine.txt', 'planted.txt', 'b-x')],
  ['copyObject (source)', (s) => s.copyObject('a', 'u1', 'b-x', 'secret.txt', 'stolen.txt', 'docs')],
  ['copyObject (destination)', (s) => s.copyObject('a', 'u1', 'docs', 'mine.txt', 'planted.txt', 'b-x')],
  ['uploadObject', (s) => s.uploadObject('a', 'u1', 'b-x', 'planted.txt', Buffer.from('x'), 'text/plain')],
  ['uploadObjectStream', (s) => s.uploadObjectStream('a', 'u1', 'b-x', 'planted.txt', Readable.from(['x']), 1, 'text/plain')],
  ['getObject', (s) => s.getObject('a', 'u1', 'b-x', 'secret.txt')],
  ['getPartialObject', (s) => s.getPartialObject('a', 'u1', 'b-x', 'secret.txt', 0, 1)],
  ['deleteObjects', (s) => s.deleteObjects('a', 'u1', 'b-x', ['secret.txt', 'dir/'])],
  ['getPresignedUrl', (s) => s.getPresignedUrl('a', 'u1', 'b-x', 'secret.txt')],
  ['toggleBucketPublic', (s) => s.toggleBucketPublic('a', 'u1', 'b-x', true)],
  ['deleteBucket', (s) => s.deleteBucket('a', 'u1', 'b-x')],
  ['resolveBucket (storage API, upload sessions, access rules)', (s) => s.resolveBucket('a', undefined, 'b-x')],
  ['resolveProjectBucket (upload session chunks)', (s) => s.resolveProjectBucket(A, 'b-x')],
];

describe("project a cannot reach project a-b's bucket through the shared physical name", () => {
  it.each(VERBS)('%s answers 404 and touches nothing', async (_name, call) => {
    const { svc, client, publicClient } = build();
    await expect(call(svc)).rejects.toBeInstanceOf(NotFoundException);
    expectUntouched(client, publicClient);
  });

  it('the 404 reads exactly like a missing bucket (no existence oracle)', async () => {
    const { svc } = build();
    const foreign = await svc.listObjects('a', 'u1', 'b-x').catch((e) => e.message);
    const missing = await svc.listObjects('a', 'u1', 'nope').catch((e) => e.message);
    expect(foreign).toBe('Bucket "b-x" not found');
    expect(missing).toBe('Bucket "nope" not found');
  });

  it('createBucket of the shared name is refused for a', async () => {
    const { svc, client, owners } = build({ buckets: [] });
    owners.clear();
    await expect(svc.createBucket('a', 'u1', 'b-x')).rejects.toBeInstanceOf(ConflictException);
    expect(client.makeBucket).not.toHaveBeenCalled();
  });

  it("the listing of a does not show a-b's bucket", async () => {
    const { svc } = build();
    expect((await svc.listBucketNames('a')).map((b) => b.physical)).toEqual(['bf-a-docs']);
    expect((await svc.listBuckets('a')).map((b) => b.id)).toEqual(['bf-a-docs']);
  });
});

describe('legitimate access keeps working', () => {
  it('the recorded owner reads, lists and writes its bucket', async () => {
    const { svc, client } = build();
    await expect(svc.listObjects('ab', 'u1', 'x')).resolves.toHaveLength(1);
    await expect(svc.uploadObject('ab', 'u1', 'x', 'a.txt', Buffer.from('x'), 'text/plain')).resolves.toMatchObject({ name: 'a.txt' });
    expect(client.putObject).toHaveBeenCalledWith(SHARED, 'a.txt', expect.any(Buffer), 1, expect.any(Object));
    expect((await svc.listBucketNames('ab')).map((b) => b.name)).toEqual(['x']);
  });

  it('a recorded bucket of project a under the shared name is a\'s, and a-b is refused', async () => {
    const { svc } = build({ owners: { [SHARED]: 'a' } });
    await expect(svc.resolveBucket('a', undefined, 'b-x')).resolves.toMatchObject({ minioBucket: SHARED });
    await expect(svc.resolveBucket('ab', undefined, 'x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('an unambiguous legacy bucket (no record) works and is recorded on first use', async () => {
    const { svc, owners, prisma } = build({ owners: {} });
    await expect(svc.resolveBucket('a', undefined, 'docs')).resolves.toMatchObject({ minioBucket: 'bf-a-docs' });
    expect(owners.get('bf-a-docs')).toBe('a');
    prisma.project.findMany.mockClear();
    // The second access is a primary-key lookup, not a scan of every project.
    await svc.resolveBucket('a', undefined, 'docs');
    expect(prisma.project.findMany).not.toHaveBeenCalled();
  });

  it('the listing backfills unambiguous legacy buckets', async () => {
    const { svc, owners } = build({ owners: {} });
    expect((await svc.listBucketNames('a')).map((b) => b.physical)).toEqual(['bf-a-docs']);
    expect(owners.get('bf-a-docs')).toBe('a');
    expect(owners.has(SHARED)).toBe(false);
  });

  it('creating a bucket claims its owner row, and a second project cannot claim it', async () => {
    const { svc, owners } = build({ buckets: [], owners: {} });
    await svc.createBucket('ab', 'u1', 'xyz');
    expect(owners.get('bf-a-b-xyz')).toBe('ab');
    await expect(svc.resolveProjectBucket(A, 'b-xyz')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a failed makeBucket gives the claimed name back', async () => {
    const { svc, client, prisma } = build({ buckets: [], owners: {} });
    client.makeBucket.mockRejectedValue(new Error('store down'));
    await expect(svc.createBucket('ab', 'u1', 'xyz')).rejects.toThrow('store down');
    expect(prisma.storageBucketOwner.deleteMany).toHaveBeenCalledWith({ where: { physicalName: 'bf-a-b-xyz', projectId: 'ab' } });
  });
});

describe('ambiguous legacy buckets', () => {
  it('without a record, the shared name is refused to both projects and is not recorded', async () => {
    const { svc, owners, client, publicClient } = build({ owners: {} });
    await expect(svc.resolveBucket('a', undefined, 'b-x')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.resolveBucket('ab', undefined, 'x')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.getObject('ab', 'u1', 'x', 'secret.txt')).rejects.toBeInstanceOf(NotFoundException);
    expect(owners.size).toBe(0);
    expectUntouched(client, publicClient);
    expect((await svc.listBucketNames('ab')).length).toBe(0);
  });

  it('a deleted project with the overlapping prefix keeps the name ambiguous', async () => {
    const { svc } = build({ owners: {}, projects: [A, { ...AB, status: 'DELETED' }] });
    await expect(svc.resolveBucket('a', undefined, 'b-x')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('platform buckets', () => {
  const PLATFORM = { id: 'pl', slug: 'platform', storagePrefix: null, teamId: 't9', status: 'ACTIVE' };
  const PLATFORM_DATA = { id: 'pd', slug: 'platform_data', storagePrefix: null, teamId: 't9', status: 'ACTIVE' };

  it.each([
    ['platform', 'pitr'],
    ['platform', 'auto-backups'],
    ['platform', 'exports'],
    ['pd', 'imports'],
  ])('project %s asking for "%s" never reaches a platform bucket', async (id, bucket) => {
    const { svc, client, publicClient } = build({
      projects: [PLATFORM, PLATFORM_DATA],
      owners: {},
      buckets: ['bf-platform-pitr', 'bf-platform-auto-backups', 'bf-platform-exports', 'bf-platform-data-imports'],
    });
    const projectId = id === 'platform' ? 'pl' : id;
    await expect(svc.getObject(projectId, 'u1', bucket, 'base.tar')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.getPresignedUrl(projectId, 'u1', bucket, 'base.tar')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.createBucket(projectId, 'u1', bucket)).rejects.toBeInstanceOf(ConflictException);
    expect(await svc.listBucketNames(projectId)).toEqual([]);
    expectUntouched(client, publicClient);
  });

  it('even a (bogus) owner row cannot hand a platform bucket to a project', async () => {
    const { svc } = build({ projects: [PLATFORM], owners: { 'bf-platform-pitr': 'pl' }, buckets: ['bf-platform-pitr'] });
    await expect(svc.resolveBucket('pl', undefined, 'pitr')).rejects.toBeInstanceOf(NotFoundException);
  });
});
