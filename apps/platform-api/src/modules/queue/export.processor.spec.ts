// The export processor's real dependencies reach Keycloak (ESM-only client),
// Postgres and MinIO; only their identities matter for constructing it here.
jest.mock('../auth/keycloak-admin.service', () => ({ KeycloakAdminService: class {} }));
jest.mock('../projects/projects.service', () => ({ ProjectsService: class {} }));
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }));

const execFileMock = jest.fn();
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: (...args: any[]) => execFileMock(...args),
}));

const pgClients: any[] = [];
const pgClientFactory = jest.fn();
jest.mock('pg', () => ({
  ...jest.requireActual('pg'),
  Client: jest.fn().mockImplementation((opts: unknown) => {
    const c = pgClientFactory(opts);
    pgClients.push(c);
    return c;
  }),
}));

import { existsSync } from 'fs';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ExportProcessor } from './export.processor';
import { resetBackupKeyCache } from '../projects/backups/backup-crypto';

const project = {
  id: 'p1',
  slug: 'shop',
  name: 'Shop',
  dbHost: 'postgres',
  dbPort: 5432,
  dbUser: 'p_shop',
  dbPassword: 'secret',
  dbName: 'p_shop_db',
  keycloakRealm: 'shop',
};

/** The pg_dump argument list exactly as it was before dump-time counting existed. */
function baseDumpArgs(outputPath: string) {
  return [
    '--host', 'postgres',
    '--port', '5432',
    '--username', 'p_shop',
    '--dbname', 'p_shop_db',
    '--format=plain',
    '--no-owner',
    '--no-acl',
    '--clean',
    '--if-exists',
    '-f', outputPath,
  ];
}

function okExec() {
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: any) =>
    cb(null, { stdout: '', stderr: '' }),
  );
}

/** A pg client that exports a snapshot and reports one table with 5 rows. */
function countingClient(overrides: { connect?: () => Promise<void> } = {}) {
  return {
    connect: jest.fn(overrides.connect ?? (async () => undefined)),
    end: jest.fn(async () => undefined),
    query: jest.fn(async (sql: string) => {
      if (/pg_export_snapshot/.test(sql)) return { rows: [{ snap: '00000003-0000001B-1' }] };
      if (/from pg_class/.test(sql)) return { rows: [{ schema: 'public', table: 'items' }] };
      if (/count\(\*\)/.test(sql)) return { rows: [{ n: '5' }] };
      return { rows: [] };
    }),
  };
}

function makeProcessor(over: Partial<Record<string, any>> = {}) {
  const processor: any = Object.create(ExportProcessor.prototype);
  processor.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  processor.exportBucket = 'bf-platform-exports';
  processor.autoBackupBucket = 'bf-platform-auto-backups';
  processor.prisma = { project: { findFirst: jest.fn(async () => project) } };
  processor.storage = {
    ensurePlatformBucket: jest.fn(async () => undefined),
    uploadPlatformFileFromPath: jest.fn(async () => ({ size: 1234 })),
  };
  processor.activity = { append: jest.fn(async () => undefined) };
  processor.offsite = { copyFile: jest.fn(async () => 'uploaded') };
  Object.assign(processor, over);
  return processor;
}

const ENV_KEYS = ['BACKUP_TABLE_COUNTS', 'BACKUP_ENCRYPT_LOCAL', 'BACKUP_ENC_KEY'];
const saved: Record<string, string | undefined> = {};
let dir: string;

beforeEach(async () => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetBackupKeyCache();
  execFileMock.mockReset();
  pgClientFactory.mockReset();
  pgClients.length = 0;
  dir = await mkdtemp(join(tmpdir(), 'bf-export-spec-'));
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetBackupKeyCache();
  await rm(dir, { recursive: true, force: true });
});

describe('ExportProcessor.exportDatabase — dump-time table counts', () => {
  it('dumps under the exported snapshot and writes tables.json from the same snapshot', async () => {
    okExec();
    pgClientFactory.mockImplementation(() => countingClient());
    const processor = makeProcessor();
    const out = join(dir, 'dump.sql');
    const counts = join(dir, 'tables.json');

    await processor.exportDatabase(project, out, counts);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe('pg_dump');
    expect(args).toEqual([...baseDumpArgs(out), '--snapshot=00000003-0000001B-1']);

    const client = pgClients[0];
    expect(client.query).toHaveBeenCalledWith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.end).toHaveBeenCalled();

    const written = JSON.parse(await readFile(counts, 'utf8'));
    expect(written).toMatchObject({
      formatVersion: 1,
      snapshot: '00000003-0000001B-1',
      tables: [{ schema: 'public', table: 'items', rows: 5 }],
    });
  });

  it('falls back to the plain dump, unchanged, when the count session cannot connect', async () => {
    okExec();
    pgClientFactory.mockImplementation(() =>
      countingClient({ connect: async () => Promise.reject(new Error('too many connections')) }),
    );
    const processor = makeProcessor();
    const out = join(dir, 'dump.sql');
    const counts = join(dir, 'tables.json');

    await processor.exportDatabase(project, out, counts);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][1]).toEqual(baseDumpArgs(out));
    expect(existsSync(counts)).toBe(false);
    expect(processor.logger.warn).toHaveBeenCalled();
  });

  it('BACKUP_TABLE_COUNTS=false runs the plain dump and opens no count session', async () => {
    process.env.BACKUP_TABLE_COUNTS = 'false';
    okExec();
    const processor = makeProcessor();
    const out = join(dir, 'dump.sql');
    const counts = join(dir, 'tables.json');

    await processor.exportDatabase(project, out, counts);

    expect(pgClientFactory).not.toHaveBeenCalled();
    expect(execFileMock.mock.calls[0][1]).toEqual(baseDumpArgs(out));
    expect(existsSync(counts)).toBe(false);
  });

  it('retries without the snapshot when pg_dump rejects it, and writes no counts', async () => {
    let call = 0;
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: any) => {
      call++;
      if (call === 1) cb(Object.assign(new Error('invalid snapshot identifier'), { stderr: 'invalid snapshot' }));
      else cb(null, { stdout: '', stderr: '' });
    });
    pgClientFactory.mockImplementation(() => countingClient());
    const processor = makeProcessor();
    const out = join(dir, 'dump.sql');
    const counts = join(dir, 'tables.json');

    await processor.exportDatabase(project, out, counts);

    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock.mock.calls[0][1]).toContain('--snapshot=00000003-0000001B-1');
    expect(execFileMock.mock.calls[1][1]).toEqual(baseDumpArgs(out));
    expect(existsSync(counts)).toBe(false);
    expect(pgClients[0].end).toHaveBeenCalled();
  });
});

describe('ExportProcessor.process — off-site copy of the nightly archive', () => {
  const job = (autoBackup: boolean) => ({
    id: 'job-1',
    data: {
      projectId: 'p1',
      userId: 'u1',
      includeDatabase: false,
      includeAuth: false,
      includeStorage: false,
      includeConfig: false,
      autoBackup,
    },
    updateProgress: jest.fn(async () => undefined),
  });

  it('copies an auto-backup off-site while the zip is still on disk', async () => {
    const processor = makeProcessor();
    let fileExistedAtCopy = false;
    processor.offsite.copyFile.mockImplementation(async (input: { localPath: string }) => {
      fileExistedAtCopy = existsSync(input.localPath);
      return 'uploaded';
    });

    const result = await processor.process(job(true));

    expect(processor.offsite.copyFile).toHaveBeenCalledTimes(1);
    const input = processor.offsite.copyFile.mock.calls[0][0];
    expect(input).toMatchObject({
      kind: 'AUTO_BACKUP',
      projectId: 'p1',
      localBucket: 'bf-platform-auto-backups',
      localKey: result.objectKey,
      size: 1234,
    });
    expect(result.objectKey).toMatch(/^p1\/job-1-auto-backup-shop-.*\.zip$/);
    expect(fileExistedAtCopy).toBe(true);
    // Temp directory is cleaned up afterwards, as before.
    expect(existsSync(input.localPath)).toBe(false);
  });

  it('never copies a manual export off-site', async () => {
    const processor = makeProcessor();
    const result = await processor.process(job(false));
    expect(processor.offsite.copyFile).not.toHaveBeenCalled();
    expect(result.bucket).toBe('bf-platform-exports');
  });

  it('stores the nightly archive encrypted when BACKUP_ENCRYPT_LOCAL is on and a key exists', async () => {
    process.env.BACKUP_ENCRYPT_LOCAL = 'true';
    process.env.BACKUP_ENC_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    resetBackupKeyCache();
    const processor = makeProcessor();

    const result = await processor.process(job(true));

    expect(result.objectKey).toMatch(/\.zip\.enc$/);
    const [bucket, key, path, contentType] = processor.storage.uploadPlatformFileFromPath.mock.calls[0];
    expect(bucket).toBe('bf-platform-auto-backups');
    expect(key).toBe(result.objectKey);
    expect(path).toMatch(/\.zip\.enc$/);
    expect(contentType).toBe('application/octet-stream');
    expect(processor.offsite.copyFile.mock.calls[0][0].localKey).toBe(result.objectKey);
  });

  it('a failed off-site copy does not fail the backup', async () => {
    const processor = makeProcessor();
    processor.offsite.copyFile.mockResolvedValue('failed');
    await expect(processor.process(job(true))).resolves.toMatchObject({ bucket: 'bf-platform-auto-backups' });
  });
});
