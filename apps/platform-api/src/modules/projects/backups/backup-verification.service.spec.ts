import { createWriteStream, createReadStream } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import archiver = require('archiver');

const poolQuery = jest.fn();
const poolEnd = jest.fn().mockResolvedValue(undefined);
const clientQuery = jest.fn();
const clientConnect = jest.fn().mockResolvedValue(undefined);
const clientEnd = jest.fn().mockResolvedValue(undefined);
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({ query: poolQuery, end: poolEnd })),
  Client: jest.fn().mockImplementation(() => ({ connect: clientConnect, query: clientQuery, end: clientEnd })),
}));

const execFileMock = jest.fn();
jest.mock('child_process', () => ({
  execFile: (...args: any[]) => execFileMock(...args),
}));

jest.mock('../../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }));
jest.mock('../project-activity.service', () => ({
  ProjectActivityService: class {},
  ProjectActivityKind: {
    PROJECT_BACKUP_VERIFIED: 'project_backup.verified',
    PROJECT_BACKUP_VERIFICATION_FAILED: 'project_backup.verification_failed',
  },
}));

import { ConflictException } from '@nestjs/common';
import { BackupVerificationService, describeDiskShortage, extractZipEntries } from './backup-verification.service';
import { LIST_USER_TABLES_SQL } from './table-counts';

const ENV_KEYS = [
  'BACKUP_VERIFY_MAX_DISK_PERCENT',
  'BACKUP_VERIFY_ENABLED',
  'BACKUP_VERIFY_PROJECT_IDS',
  'BACKUP_VERIFY_PROJECTS_PER_RUN',
  'BACKUP_VERIFY_MAX_ARCHIVE_MB',
  'BACKUP_VERIFY_TIMEOUT_MS',
];
const saved: Record<string, string | undefined> = {};

let dir: string;

async function makeZip(entries: Record<string, string>): Promise<{ path: string; size: number }> {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.zip`);
  const out = createWriteStream(path);
  const archive = archiver('zip');
  const done = new Promise<void>((resolve, reject) => {
    out.on('close', () => resolve());
    out.on('error', reject);
    archive.on('error', reject);
  });
  archive.pipe(out);
  for (const [name, content] of Object.entries(entries)) archive.append(Buffer.from(content), { name });
  await archive.finalize();
  await done;
  const { statSync } = await import('fs');
  return { path, size: statSync(path).size };
}

/** psql "ran": stdout/stderr as given. psql "failed to run": an error with stderr. */
function psqlResult(stderr: string, fail = false) {
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (e: any, r?: any) => void) => {
    if (fail) cb(Object.assign(new Error('psql exited 2'), { code: 2, stderr }));
    else cb(null, { stdout: '', stderr });
  });
}

function fakes(opts: { zip?: { path: string; size: number } | null; restoredCounts?: Record<string, number> } = {}) {
  let row: any = null;
  const prisma = {
    backupVerification: {
      create: jest.fn(async ({ data }: any) => {
        row = { id: 'v1', startedAt: new Date(), finishedAt: null, ...data };
        return row;
      }),
      findUniqueOrThrow: jest.fn(async () => row),
      update: jest.fn(async ({ data }: any) => {
        row = { ...row, ...data };
        return row;
      }),
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    project: {
      findFirst: jest.fn().mockResolvedValue({ id: 'p1', name: 'Shop', databaseType: 'RELATIONAL' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    teamMember: { findUnique: jest.fn().mockResolvedValue({ teamId: 't1', userId: 'u1' }) },
    rootAlert: { create: jest.fn().mockResolvedValue({}) },
  };
  const zip = opts.zip === undefined ? null : opts.zip;
  const storage = {
    ensurePlatformBucket: jest.fn().mockResolvedValue(undefined),
    listPlatformObjects: jest.fn().mockResolvedValue(
      zip ? [{ name: 'p1/42-auto-backup-shop.zip', size: zip.size, lastModified: new Date() }] : [],
    ),
    getPlatformObject: jest.fn(async () => ({ stream: createReadStream(zip!.path), stat: { size: zip!.size } })),
  };
  const config = {
    get: (k: string) =>
      ({ 'database.host': 'pg', 'database.port': 5432, 'database.user': 'admin', 'database.password': 'pw' } as Record<string, unknown>)[k],
  };
  const activity = { append: jest.fn().mockResolvedValue(undefined) };

  const counts = opts.restoredCounts ?? {};
  clientQuery.mockImplementation(async (sql: string) => {
    if (sql === LIST_USER_TABLES_SQL) {
      return { rows: Object.keys(counts).map((t) => ({ schema: 'public', table: t })) };
    }
    const m = sql.match(/from "public"\."(.+)"$/s);
    if (m) return { rows: [{ n: String(counts[m[1]]) }] };
    return { rows: [] };
  });
  poolQuery.mockImplementation(async (sql: string) => {
    if (sql.startsWith('select datname')) return { rows: [] };
    return { rows: [] };
  });

  const svc = new BackupVerificationService(prisma as any, config as any, storage as any, activity as any);
  return { svc, prisma, storage, activity, getRow: () => row };
}

const TABLES_JSON = JSON.stringify({
  formatVersion: 1,
  snapshot: '0000000A-1',
  countedAt: '2026-10-20T03:00:00Z',
  truncated: false,
  tables: [
    { schema: 'public', table: 'users', rows: 3 },
    { schema: 'public', table: 'orders', rows: 10 },
  ],
});
const DUMP = '-- dump\nCREATE TABLE users();\n';

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  dir = await mkdtemp(join(tmpdir(), 'verify-spec-'));
});
afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV_KEYS) delete process.env[k];
  psqlResult('');
});

const dropCalls = () => poolQuery.mock.calls.map((c) => String(c[0])).filter((s) => s.startsWith('DROP DATABASE'));
const createCalls = () => poolQuery.mock.calls.map((c) => String(c[0])).filter((s) => s.startsWith('CREATE DATABASE'));

describe('extractZipEntries', () => {
  it('streams only the wanted entries out of the archive', async () => {
    const zip = await makeZip({ 'database/dump.sql': DUMP, 'database/tables.json': TABLES_JSON, 'auth/users.json': '[]' });
    const out = await mkdtemp(join(dir, 'x-'));
    const found = await extractZipEntries(zip.path, new Set(['database/dump.sql', 'database/tables.json']), out);
    expect([...found.keys()].sort()).toEqual(['database/dump.sql', 'database/tables.json']);
    const { readFileSync, existsSync } = await import('fs');
    expect(readFileSync(found.get('database/dump.sql')!, 'utf8')).toBe(DUMP);
    expect(existsSync(join(out, 'users.json'))).toBe(false);
  });
});

describe('BackupVerificationService.verifyLatestBackup', () => {
  it('skips a project without an auto-backup and never creates a database', async () => {
    const { svc, prisma } = fakes({ zip: null });
    const r = await svc.verifyLatestBackup('p1', { trigger: 'manual', requestedBy: 'u1' });
    expect(r.status).toBe('SKIPPED');
    expect(r.error).toMatch(/no auto-backup/);
    expect(createCalls()).toHaveLength(0);
    expect(prisma.rootAlert.create).not.toHaveBeenCalled();
  });

  it('skips an archive above the size cap, and one the temp disk cannot hold', async () => {
    const zip = await makeZip({ 'database/dump.sql': DUMP });
    process.env.BACKUP_VERIFY_MAX_ARCHIVE_MB = '1';
    const big = { path: zip.path, size: 2 * 1024 * 1024 };
    const a = fakes({ zip: big });
    const r1 = await a.svc.verifyLatestBackup('p1', { trigger: 'scheduled' });
    expect(r1.status).toBe('SKIPPED');
    expect(r1.error).toMatch(/BACKUP_VERIFY_MAX_ARCHIVE_MB/);
    expect(r1.archiveBytes).toBe(big.size);

    delete process.env.BACKUP_VERIFY_MAX_ARCHIVE_MB;
    const b = fakes({ zip });
    (b.svc as any).diskUsage = async () => ({ totalBytes: 1_000_000, freeBytes: 10 });
    const r2 = await b.svc.verifyLatestBackup('p1', { trigger: 'scheduled' });
    expect(r2.status).toBe('SKIPPED');
    expect(r2.error).toMatch(/insufficient temp space/);
    expect(createCalls()).toHaveLength(0);
  });

  it('skips when the drill would push the volume past the disk limit, even with space free', async () => {
    const zip = await makeZip({ 'database/dump.sql': DUMP });
    const total = 100 * 1024 * 1024 * 1024;
    const a = fakes({ zip });
    // 94% used: plenty of bytes free for a tiny archive, but above the default 85% limit.
    (a.svc as any).diskUsage = async () => ({ totalBytes: total, freeBytes: total * 0.06 });
    const r = await a.svc.verifyLatestBackup('p1', { trigger: 'scheduled' });
    expect(r.status).toBe('SKIPPED');
    expect(r.error).toMatch(/BACKUP_VERIFY_MAX_DISK_PERCENT/);
    expect(createCalls()).toHaveLength(0);

    process.env.BACKUP_VERIFY_MAX_DISK_PERCENT = '97';
    const b = fakes({ zip, restoredCounts: { users: 3, orders: 10 } });
    (b.svc as any).diskUsage = async () => ({ totalBytes: total, freeBytes: total * 0.06 });
    const r2 = await b.svc.verifyLatestBackup('p1', { trigger: 'scheduled' });
    expect(r2.status).not.toBe('SKIPPED');
    delete process.env.BACKUP_VERIFY_MAX_DISK_PERCENT;
  });

  it('passes when psql is clean and every recorded count is reproduced, then drops the database', async () => {
    const zip = await makeZip({ 'database/dump.sql': DUMP, 'database/tables.json': TABLES_JSON });
    const { svc, prisma, activity } = fakes({ zip, restoredCounts: { users: 3, orders: 10 } });

    const r = await svc.verifyLatestBackup('p1', { trigger: 'scheduled' });

    expect(r.status).toBe('PASSED');
    expect(r.countsCompared).toBe(true);
    expect(r.tablesExpected).toBe(2);
    expect(r.tablesRestored).toBe(2);
    expect(r.rowsMismatched).toBe(0);
    expect(r.psqlErrorCount).toBe(0);
    expect(r.backupObjectKey).toBe('p1/42-auto-backup-shop.zip');
    expect(createCalls()).toHaveLength(1);
    expect(createCalls()[0]).toMatch(/^CREATE DATABASE "bfverify_\d+_[0-9a-f]{6}" TEMPLATE template0/);
    expect(dropCalls()).toHaveLength(1);
    expect(dropCalls()[0]).toMatch(/WITH \(FORCE\)/);
    expect(poolEnd).toHaveBeenCalled();
    // psql ran against the throwaway database with ON_ERROR_STOP off, as the dashboard restore does.
    const psqlArgs: string[] = execFileMock.mock.calls[0][1];
    expect(execFileMock.mock.calls[0][0]).toBe('psql');
    expect(psqlArgs).toContain('ON_ERROR_STOP=0');
    expect(psqlArgs[psqlArgs.indexOf('--dbname') + 1]).toMatch(/^bfverify_/);
    expect(prisma.rootAlert.create).not.toHaveBeenCalled();
    expect(activity.append).toHaveBeenCalledWith('p1', expect.objectContaining({ kind: 'project_backup.verified' }));
  });

  it('fails on psql errors, keeps the first lines, and raises a ROOT alert', async () => {
    const zip = await makeZip({ 'database/dump.sql': DUMP, 'database/tables.json': TABLES_JSON });
    psqlResult('psql:dump.sql:10: ERROR:  relation "x" does not exist\nNOTICE: fine\npsql:dump.sql:20: ERROR:  syntax error\n');
    const { svc, prisma, activity } = fakes({ zip, restoredCounts: { users: 3, orders: 10 } });

    const r = await svc.verifyLatestBackup('p1', { trigger: 'scheduled' });

    expect(r.status).toBe('FAILED');
    expect(r.psqlErrorCount).toBe(2);
    expect((r.details as any).psqlErrors).toHaveLength(2);
    expect(r.error).toMatch(/2 psql error/);
    expect(prisma.rootAlert.create).toHaveBeenCalledTimes(1);
    expect(prisma.rootAlert.create.mock.calls[0][0].data.kind).toBe('backup.verification_failed');
    expect(activity.append).toHaveBeenCalledWith('p1', expect.objectContaining({ kind: 'project_backup.verification_failed' }));
    expect(dropCalls()).toHaveLength(1);
  });

  it('fails when a restored count differs from the one recorded at dump time', async () => {
    const zip = await makeZip({ 'database/dump.sql': DUMP, 'database/tables.json': TABLES_JSON });
    const { svc } = fakes({ zip, restoredCounts: { users: 3, orders: 9 } });
    const r = await svc.verifyLatestBackup('p1', { trigger: 'scheduled' });
    expect(r.status).toBe('FAILED');
    expect(r.rowsMismatched).toBe(1);
    expect((r.details as any).mismatches).toEqual([{ schema: 'public', table: 'orders', expected: 10, actual: 9 }]);
  });

  it('fails when a recorded table is missing after the restore', async () => {
    const zip = await makeZip({ 'database/dump.sql': DUMP, 'database/tables.json': TABLES_JSON });
    const { svc } = fakes({ zip, restoredCounts: { users: 3 } });
    const r = await svc.verifyLatestBackup('p1', { trigger: 'scheduled' });
    expect(r.status).toBe('FAILED');
    expect((r.details as any).missingTables).toEqual(['public.orders']);
  });

  it('passes an older archive without dump-time counts when psql is clean and tables exist', async () => {
    const zip = await makeZip({ 'database/dump.sql': DUMP });
    const { svc } = fakes({ zip, restoredCounts: { users: 3 } });
    const r = await svc.verifyLatestBackup('p1', { trigger: 'scheduled' });
    expect(r.status).toBe('PASSED');
    expect(r.countsCompared).toBe(false);
    expect(r.tablesExpected).toBeNull();
    expect(r.tablesRestored).toBe(1);
  });

  it('fails an archive that has no database dump at all', async () => {
    const zip = await makeZip({ 'auth/users.json': '[]' });
    const { svc } = fakes({ zip });
    const r = await svc.verifyLatestBackup('p1', { trigger: 'scheduled' });
    expect(r.status).toBe('FAILED');
    expect(r.error).toMatch(/no database\/dump\.sql/);
    expect(createCalls()).toHaveLength(0);
  });

  it('still drops the throwaway database when psql itself blows up', async () => {
    const zip = await makeZip({ 'database/dump.sql': DUMP, 'database/tables.json': TABLES_JSON });
    psqlResult('psql: error: connection to server failed', true);
    const { svc } = fakes({ zip, restoredCounts: {} });
    const r = await svc.verifyLatestBackup('p1', { trigger: 'manual', requestedBy: 'u1' });
    expect(r.status).toBe('FAILED');
    expect(r.error).toMatch(/psql failed/);
    expect(createCalls()).toHaveLength(1);
    expect(dropCalls()).toHaveLength(1);
  });

  it('refuses to run two drills at once', async () => {
    const { svc } = fakes({ zip: null });
    (svc as any).running = true;
    await expect(svc.verifyLatestBackup('p1', { trigger: 'manual' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('startManual records a RUNNING row for a team member and rejects a stranger', async () => {
    const { svc, prisma } = fakes({ zip: null });
    jest.spyOn(svc, 'verifyLatestBackup').mockResolvedValue({} as any);
    const out = await svc.startManual('p1', 'u1');
    expect(out).toEqual({ verificationId: 'v1' });
    expect(prisma.backupVerification.create.mock.calls[0][0].data).toMatchObject({ trigger: 'manual', requestedBy: 'u1', status: 'RUNNING' });

    prisma.teamMember.findUnique.mockResolvedValue(null);
    await expect(svc.startManual('p1', 'nobody')).rejects.toThrow(/member/);
  });
});

describe('BackupVerificationService scheduling', () => {
  it('drops stale throwaway databases but leaves recent ones alone', async () => {
    const { svc } = fakes({ zip: null });
    const recent = Math.floor(Date.now() / 1000) - 60;
    poolQuery.mockImplementation(async (sql: string) =>
      sql.startsWith('select datname')
        ? { rows: [{ datname: 'bfverify_1000_abc' }, { datname: `bfverify_${recent}_def` }, { datname: 'bfverify_garbage' }] }
        : { rows: [] },
    );
    const dropped = await svc.sweepStaleVerifyDatabases({ query: poolQuery } as any);
    expect(dropped.sort()).toEqual(['bfverify_1000_abc', 'bfverify_garbage']);
    expect(dropCalls().some((s) => s.includes(`bfverify_${recent}_def`))).toBe(false);
  });

  it('rotates to the eligible project that has gone longest without a verdict', async () => {
    const { svc, prisma, storage } = fakes({ zip: null });
    prisma.project.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const fresh = new Date();
    const stale = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    storage.listPlatformObjects.mockResolvedValue([
      { name: 'a/1.zip', size: 100, lastModified: fresh },
      { name: 'b/1.zip', size: 100, lastModified: fresh },
      { name: 'c/1.zip', size: 100, lastModified: stale },
    ]);
    prisma.backupVerification.groupBy.mockResolvedValue([{ projectId: 'a', _max: { startedAt: new Date() } }]);
    expect(await svc.pickProjects(1)).toEqual(['b']);
    expect(await svc.pickProjects(5)).toEqual(['b', 'a']);
  });

  it('honours an explicit BACKUP_VERIFY_PROJECT_IDS list and the kill switch', async () => {
    process.env.BACKUP_VERIFY_PROJECT_IDS = 'x, y';
    const { svc } = fakes({ zip: null });
    expect(await svc.pickProjects(1)).toEqual(['x', 'y']);

    process.env.BACKUP_VERIFY_ENABLED = 'false';
    const spy = jest.spyOn(svc, 'verifyLatestBackup');
    await svc.runScheduledVerification();
    expect(svc.enabled).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('describeDiskShortage', () => {
  const GB = 1024 * 1024 * 1024;
  it('allows a drill that fits and keeps the volume under the limit', () => {
    expect(describeDiskShortage({ totalBytes: 100 * GB, freeBytes: 50 * GB }, 1 * GB, 85)).toBeNull();
  });
  it('refuses when the bytes are not there', () => {
    expect(describeDiskShortage({ totalBytes: 100 * GB, freeBytes: 1 * GB }, 2 * GB, 85)).toMatch(/insufficient temp space/);
  });
  it('refuses when the projected usage crosses the limit', () => {
    const msg = describeDiskShortage({ totalBytes: 100 * GB, freeBytes: 20 * GB }, 6 * GB, 85);
    expect(msg).toMatch(/would reach 86\.0%/);
    expect(msg).toMatch(/now 80\.0%/);
  });
  it('does not block when usage cannot be read', () => {
    expect(describeDiskShortage(null, 6 * GB, 85)).toBeNull();
    expect(describeDiskShortage({ totalBytes: 0, freeBytes: 0 }, 6 * GB, 85)).toBeNull();
  });
});
