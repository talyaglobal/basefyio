import { EventEmitter } from 'events';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';

const putObject = jest.fn();
const statObject = jest.fn();
const bucketExists = jest.fn();
const makeBucket = jest.fn();
const listObjectsV2 = jest.fn();
const clientCtor = jest.fn();

jest.mock('minio', () => ({
  Client: jest.fn().mockImplementation((opts: unknown) => {
    clientCtor(opts);
    return { putObject, statObject, bucketExists, makeBucket, listObjectsV2 };
  }),
}));
jest.mock('../../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }));

import { encryptedSize, resetBackupKeyCache } from './backup-crypto';
import {
  AUTO_BACKUP_BUCKET,
  BackupOffsiteService,
  PITR_BUCKET,
  kindForLocalKey,
  projectIdForLocalKey,
  readOffsiteSetup,
  remoteKeyFor,
} from './backup-offsite.service';

const KEY_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const ENV_KEYS = [
  'BACKUP_S3_ENDPOINT',
  'BACKUP_S3_BUCKET',
  'BACKUP_S3_ACCESS_KEY',
  'BACKUP_S3_SECRET_KEY',
  'BACKUP_S3_REGION',
  'BACKUP_S3_PATH_STYLE',
  'BACKUP_S3_PREFIX',
  'BACKUP_S3_TIMEOUT_MS',
  'BACKUP_OFFSITE_ALLOW_PLAINTEXT',
  'BACKUP_ENC_KEY',
];
const saved: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string>) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  resetBackupKeyCache();
}

function listing(names: string[]) {
  const e = new EventEmitter();
  setImmediate(() => {
    for (const n of names) e.emit('data', { name: n });
    e.emit('end');
  });
  return e;
}

function fakes() {
  const prisma = {
    rootAlert: { create: jest.fn().mockResolvedValue({}) },
    backupOffsiteCopy: {
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    user: { findUnique: jest.fn() },
  };
  const storage = {
    ensurePlatformBucket: jest.fn().mockResolvedValue(undefined),
    listPlatformObjects: jest.fn().mockResolvedValue([]),
    getPlatformObject: jest.fn(),
  };
  return { prisma, storage };
}

const S3 = {
  BACKUP_S3_ENDPOINT: 'https://fsn1.your-objectstorage.com',
  BACKUP_S3_BUCKET: 'bf-offsite',
  BACKUP_S3_ACCESS_KEY: 'ak',
  BACKUP_S3_SECRET_KEY: 'sk',
};

let dir: string;
let smallFile: string;
const PLAIN = Buffer.from('backup archive bytes '.repeat(50));

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  dir = await mkdtemp(join(tmpdir(), 'offsite-spec-'));
  smallFile = join(dir, 'a.zip');
  await writeFile(smallFile, PLAIN);
});

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  resetBackupKeyCache();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  statObject.mockRejectedValue(Object.assign(new Error('Not Found'), { code: 'NotFound' }));
  bucketExists.mockResolvedValue(true);
  putObject.mockResolvedValue({ etag: 'e' });
});

describe('readOffsiteSetup', () => {
  it('is disabled when nothing is set', () => {
    expect(readOffsiteSetup({}, null)).toEqual({ kind: 'disabled' });
  });

  it('is misconfigured when only some variables are set, or the URL is bad', () => {
    expect(readOffsiteSetup({ BACKUP_S3_ENDPOINT: 'https://x' }, null)).toMatchObject({ kind: 'misconfigured' });
    expect(readOffsiteSetup({ ...S3, BACKUP_S3_ENDPOINT: 'http://[bad' }, Buffer.alloc(32))).toMatchObject({
      kind: 'misconfigured',
      reason: expect.stringMatching(/valid URL/),
    });
  });

  it('refuses to run without a key unless plaintext is allowed explicitly', () => {
    expect(readOffsiteSetup(S3, null)).toMatchObject({
      kind: 'misconfigured',
      reason: expect.stringMatching(/BACKUP_ENC_KEY/),
    });
    const plain = readOffsiteSetup({ ...S3, BACKUP_OFFSITE_ALLOW_PLAINTEXT: 'true' }, null);
    expect(plain).toMatchObject({ kind: 'enabled', config: { encrypt: false } });
  });

  it('parses the endpoint URL and the addressing/region/prefix knobs', () => {
    const a = readOffsiteSetup(S3, Buffer.alloc(32));
    expect(a).toMatchObject({
      kind: 'enabled',
      config: {
        endPoint: 'fsn1.your-objectstorage.com',
        port: 443,
        useSSL: true,
        region: 'us-east-1',
        pathStyle: true,
        prefix: 'basefyio/',
        timeoutMs: 600_000,
        encrypt: true,
      },
    });
    const b = readOffsiteSetup(
      {
        ...S3,
        BACKUP_S3_ENDPOINT: 'http://minio.internal:9000',
        BACKUP_S3_PATH_STYLE: 'false',
        BACKUP_S3_REGION: 'eu-central-1',
        BACKUP_S3_PREFIX: '/prod/backups',
        BACKUP_S3_TIMEOUT_MS: '1000',
      },
      Buffer.alloc(32),
    );
    expect(b).toMatchObject({
      kind: 'enabled',
      config: {
        endPoint: 'minio.internal',
        port: 9000,
        useSSL: false,
        pathStyle: false,
        region: 'eu-central-1',
        prefix: 'prod/backups/',
        timeoutMs: 1000,
      },
    });
  });
});

describe('key layout helpers', () => {
  it('mirrors the local buckets under the prefix and marks encrypted copies', () => {
    expect(remoteKeyFor('basefyio/', AUTO_BACKUP_BUCKET, 'p1/1-auto.zip', true)).toBe('basefyio/auto-backups/p1/1-auto.zip.enc');
    expect(remoteKeyFor('basefyio/', PITR_BUCKET, '_cluster/wal/0001.gz', false)).toBe('basefyio/pitr/_cluster/wal/0001.gz');
    expect(remoteKeyFor('', 'other', 'k', false)).toBe('other/k');
  });

  it('classifies local keys by artifact kind and owning project', () => {
    expect(kindForLocalKey(AUTO_BACKUP_BUCKET, 'p1/x.zip')).toBe('AUTO_BACKUP');
    expect(kindForLocalKey(PITR_BUCKET, '_cluster/base/s/base.tar.gz')).toBe('PITR_CLUSTER_BASE');
    expect(kindForLocalKey(PITR_BUCKET, '_cluster/wal/0001.gz')).toBe('PITR_WAL');
    expect(kindForLocalKey(PITR_BUCKET, 'p1/base/s.dump')).toBe('PITR_PROJECT_BASE');
    expect(projectIdForLocalKey('p1/base/s.dump')).toBe('p1');
    expect(projectIdForLocalKey('_cluster/wal/0001.gz')).toBeNull();
  });
});

describe('BackupOffsiteService', () => {
  it('does nothing at all when BACKUP_S3_ENDPOINT is not set', async () => {
    setEnv({});
    const { prisma, storage } = fakes();
    const svc = new BackupOffsiteService(prisma as any, storage as any);
    await svc.onModuleInit();
    expect(svc.isEnabled()).toBe(false);
    expect(clientCtor).not.toHaveBeenCalled();
    const out = await svc.copyFile({ kind: 'AUTO_BACKUP', localBucket: AUTO_BACKUP_BUCKET, localKey: 'p1/a.zip', localPath: smallFile });
    expect(out).toBe('disabled');
    expect(putObject).not.toHaveBeenCalled();
    expect(prisma.backupOffsiteCopy.upsert).not.toHaveBeenCalled();
    expect(prisma.rootAlert.create).not.toHaveBeenCalled();
  });

  it('refuses to upload without a key and raises one ROOT alert', async () => {
    setEnv(S3);
    const { prisma, storage } = fakes();
    const svc = new BackupOffsiteService(prisma as any, storage as any);
    await svc.onModuleInit();
    expect(svc.isEnabled()).toBe(false);
    expect(prisma.rootAlert.create).toHaveBeenCalledTimes(1);
    expect(prisma.rootAlert.create.mock.calls[0][0].data.kind).toBe('backup.offsite_misconfigured');
    expect(await svc.copyFile({ kind: 'AUTO_BACKUP', localBucket: AUTO_BACKUP_BUCKET, localKey: 'p1/a.zip', localPath: smallFile })).toBe('disabled');
    expect(putObject).not.toHaveBeenCalled();
  });

  it('encrypts and uploads a file under the mirrored key, recording the copy', async () => {
    setEnv({ ...S3, BACKUP_ENC_KEY: KEY_HEX });
    const { prisma, storage } = fakes();
    const svc = new BackupOffsiteService(prisma as any, storage as any);
    expect(svc.isEnabled()).toBe(true);
    expect(svc.isEncrypting()).toBe(true);
    expect(clientCtor).toHaveBeenCalledWith(
      expect.objectContaining({ endPoint: 'fsn1.your-objectstorage.com', port: 443, useSSL: true, pathStyle: true, region: 'us-east-1' }),
    );

    const out = await svc.copyFile({
      kind: 'AUTO_BACKUP',
      projectId: 'p1',
      localBucket: AUTO_BACKUP_BUCKET,
      localKey: 'p1/1-auto.zip',
      localPath: smallFile,
    });

    expect(out).toBe('uploaded');
    expect(putObject).toHaveBeenCalledTimes(1);
    const [bucket, key, body, size, meta] = putObject.mock.calls[0];
    expect(bucket).toBe('bf-offsite');
    expect(key).toBe('basefyio/auto-backups/p1/1-auto.zip.enc');
    expect(size).toBe(encryptedSize(PLAIN.length));
    expect(meta).toMatchObject({
      'x-amz-meta-bf-enc': 'aes-256-gcm-v1',
      'x-amz-meta-bf-plain-size': String(PLAIN.length),
      'x-amz-meta-bf-kind': 'AUTO_BACKUP',
      'x-amz-meta-bf-source': `${AUTO_BACKUP_BUCKET}/p1/1-auto.zip`,
    });
    // The body is a stream the client would consume; drain it to prove it carries the full ciphertext.
    const chunks: Buffer[] = [];
    for await (const c of body as Readable) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).length).toBe(encryptedSize(PLAIN.length));

    expect(prisma.backupOffsiteCopy.upsert).toHaveBeenCalledTimes(1);
    const upsert = prisma.backupOffsiteCopy.upsert.mock.calls[0][0];
    expect(upsert.where).toEqual({ localBucket_localKey: { localBucket: AUTO_BACKUP_BUCKET, localKey: 'p1/1-auto.zip' } });
    expect(upsert.create).toMatchObject({
      kind: 'AUTO_BACKUP',
      projectId: 'p1',
      remoteBucket: 'bf-offsite',
      remoteKey: 'basefyio/auto-backups/p1/1-auto.zip.enc',
      plainBytes: BigInt(PLAIN.length),
      encrypted: true,
      status: 'UPLOADED',
      error: null,
    });
  });

  it('uploads an archive already encrypted at rest as it is, without a second layer', async () => {
    setEnv({ ...S3, BACKUP_ENC_KEY: KEY_HEX });
    const { prisma, storage } = fakes();
    const svc = new BackupOffsiteService(prisma as any, storage as any);
    const out = await svc.copyFile({
      kind: 'AUTO_BACKUP',
      projectId: 'p1',
      localBucket: AUTO_BACKUP_BUCKET,
      localKey: 'p1/1-auto.zip.enc',
      localPath: smallFile,
    });
    expect(out).toBe('uploaded');
    const [, key, , size, meta] = putObject.mock.calls[0];
    expect(key).toBe('basefyio/auto-backups/p1/1-auto.zip.enc');
    expect(size).toBe(PLAIN.length);
    expect(meta['x-amz-meta-bf-enc']).toBe('aes-256-gcm-v1');
  });

  it('uploads plaintext only when the operator allowed it in so many words', async () => {
    setEnv({ ...S3, BACKUP_OFFSITE_ALLOW_PLAINTEXT: 'true' });
    const { prisma, storage } = fakes();
    const svc = new BackupOffsiteService(prisma as any, storage as any);
    expect(svc.isEnabled()).toBe(true);
    expect(svc.isEncrypting()).toBe(false);
    await svc.copyFile({ kind: 'PITR_WAL', localBucket: PITR_BUCKET, localKey: '_cluster/wal/0001.gz', localPath: smallFile });
    const [, key, , size, meta] = putObject.mock.calls[0];
    expect(key).toBe('basefyio/pitr/_cluster/wal/0001.gz');
    expect(size).toBe(PLAIN.length);
    expect(meta['x-amz-meta-bf-enc']).toBe('none');
  });

  it('skips an object the remote already holds at the same size', async () => {
    setEnv({ ...S3, BACKUP_ENC_KEY: KEY_HEX });
    statObject.mockResolvedValue({ size: 1, metaData: { 'bf-plain-size': String(PLAIN.length) } });
    const { prisma, storage } = fakes();
    const svc = new BackupOffsiteService(prisma as any, storage as any);
    const out = await svc.copyFile({ kind: 'AUTO_BACKUP', projectId: 'p1', localBucket: AUTO_BACKUP_BUCKET, localKey: 'p1/a.zip', localPath: smallFile });
    expect(out).toBe('skipped');
    expect(putObject).not.toHaveBeenCalled();
    expect(prisma.backupOffsiteCopy.upsert.mock.calls[0][0].create.status).toBe('UPLOADED');
  });

  it('records a failed upload instead of throwing', async () => {
    setEnv({ ...S3, BACKUP_ENC_KEY: KEY_HEX });
    putObject.mockRejectedValue(new Error('AccessDenied'));
    const { prisma, storage } = fakes();
    const svc = new BackupOffsiteService(prisma as any, storage as any);
    const out = await svc.copyFile({ kind: 'AUTO_BACKUP', projectId: 'p1', localBucket: AUTO_BACKUP_BUCKET, localKey: 'p1/a.zip', localPath: smallFile });
    expect(out).toBe('failed');
    const upsert = prisma.backupOffsiteCopy.upsert.mock.calls[0][0];
    expect(upsert.create.status).toBe('FAILED');
    expect(upsert.create.error).toMatch(/AccessDenied/);
  });

  it('records a missing local file as a failure, never throwing', async () => {
    setEnv({ ...S3, BACKUP_ENC_KEY: KEY_HEX });
    const { prisma, storage } = fakes();
    const svc = new BackupOffsiteService(prisma as any, storage as any);
    const out = await svc.copyFile({ kind: 'AUTO_BACKUP', localBucket: AUTO_BACKUP_BUCKET, localKey: 'p1/a.zip', localPath: join(dir, 'missing.zip') });
    expect(out).toBe('failed');
    expect(putObject).not.toHaveBeenCalled();
  });

  it('reconcile copies only what the remote is missing and writes a manifest', async () => {
    setEnv({ ...S3, BACKUP_ENC_KEY: KEY_HEX });
    const { prisma, storage } = fakes();
    storage.listPlatformObjects.mockImplementation(async (bucket: string) =>
      bucket === AUTO_BACKUP_BUCKET
        ? [
            { name: 'p1/present.zip', size: 10, lastModified: new Date() },
            { name: 'p1/missing.zip', size: 20, lastModified: new Date() },
          ]
        : [{ name: '_cluster/wal/0001.gz', size: 5, lastModified: new Date() }],
    );
    storage.getPlatformObject.mockImplementation(async () => ({
      stream: Readable.from([PLAIN]),
      stat: { size: PLAIN.length },
    }));
    listObjectsV2.mockImplementation((_b: string, prefix: string) =>
      listing(prefix.endsWith('auto-backups/') ? ['basefyio/auto-backups/p1/present.zip.enc'] : []),
    );
    const svc = new BackupOffsiteService(prisma as any, storage as any);
    const spy = jest.spyOn(svc, 'copyFromLocalObject');

    const report = await svc.reconcile();

    expect(report).toMatchObject({ scanned: 3, alreadyPresent: 1, copied: 2, failed: 0 });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.map((c) => c[0].localKey).sort()).toEqual(['_cluster/wal/0001.gz', 'p1/missing.zip']);
    const manifest = putObject.mock.calls.find((c) => String(c[1]).includes('basefyio/manifests/'));
    expect(manifest).toBeDefined();
    expect(JSON.parse(String(manifest![2])).copied).toBe(2);
    expect(prisma.backupOffsiteCopy.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('does not run two reconciles at once', async () => {
    setEnv({ ...S3, BACKUP_ENC_KEY: KEY_HEX });
    const { prisma, storage } = fakes();
    const svc = new BackupOffsiteService(prisma as any, storage as any);
    (svc as any).reconciling = true;
    expect(await svc.reconcile()).toBeNull();
    expect(storage.listPlatformObjects).not.toHaveBeenCalled();
  });

  it('reconcileNow is ROOT-only and reports the configuration state honestly', async () => {
    setEnv({});
    const { prisma, storage } = fakes();
    prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    const svc = new BackupOffsiteService(prisma as any, storage as any);
    await expect(svc.reconcileNow('u1')).rejects.toThrow(/ROOT/);
    prisma.user.findUnique.mockResolvedValue({ role: 'ROOT' });
    expect((await svc.reconcileNow('u1')).message).toMatch(/disabled/);
  });

  it('healthForProject exposes the recorded copies keyed by local object', async () => {
    setEnv({ ...S3, BACKUP_ENC_KEY: KEY_HEX });
    const { prisma, storage } = fakes();
    prisma.backupOffsiteCopy.findMany.mockResolvedValue([
      { localKey: 'p1/a.zip', status: 'UPLOADED', createdAt: new Date('2026-10-20T05:00:00Z'), encrypted: true, error: null },
    ]);
    const svc = new BackupOffsiteService(prisma as any, storage as any);
    const health = await svc.healthForProject('p1');
    expect(health).toMatchObject({
      enabled: true,
      encrypted: true,
      misconfigured: false,
      bucket: 'bf-offsite',
      endpoint: 'fsn1.your-objectstorage.com',
      copies: { 'p1/a.zip': { status: 'UPLOADED', encrypted: true, createdAt: '2026-10-20T05:00:00.000Z', error: null } },
    });
  });
});
