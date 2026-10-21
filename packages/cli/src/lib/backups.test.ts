import { describe, expect, it, vi } from 'vitest';
import {
  buildImportForm,
  buildRestoreBody,
  defaultArchiveName,
  describeRestoreEffects,
  ExportTimeoutError,
  formatBytes,
  isLocalArchive,
  pollExportJob,
  resolveBackupRef,
  resolveProjectId,
  type CloudBackupEntry,
  type ExportJobStatus,
} from './backups';

const entry = (over: Partial<CloudBackupEntry>): CloudBackupEntry => ({
  objectKey: 'p1/1-a.zip',
  filename: 'a.zip',
  size: 10,
  lastModified: '2026-10-01T00:00:00.000Z',
  kind: 'manual',
  ...over,
});

const ENTRIES: CloudBackupEntry[] = [
  entry({ objectKey: 'p1/3-auto.zip', filename: 'auto.zip', kind: 'auto', lastModified: '2026-10-03T00:00:00.000Z' }),
  entry({ objectKey: 'p1/2-b.zip', filename: 'b.zip', kind: 'manual', lastModified: '2026-10-02T00:00:00.000Z' }),
  entry({ objectKey: 'p1/1-a.zip', filename: 'a.zip', kind: 'manual', lastModified: '2026-10-01T00:00:00.000Z' }),
  entry({ objectKey: 'p1/0-a.zip', filename: 'a.zip', kind: 'auto', lastModified: '2026-09-30T00:00:00.000Z' }),
];

describe('resolveProjectId', () => {
  it('prefers the flag, then the linked config, then the env', () => {
    expect(resolveProjectId({ flag: 'flag', config: { projectId: 'cfg' }, env: { BASEFYIO_PROJECT_ID: 'env' } })).toBe('flag');
    expect(resolveProjectId({ config: { projectId: 'cfg' }, env: { BASEFYIO_PROJECT_ID: 'env' } })).toBe('cfg');
    expect(resolveProjectId({ config: null, env: { BASEFYIO_PROJECT_ID: 'env' } })).toBe('env');
  });

  it('explains how to link when nothing is set', () => {
    expect(() => resolveProjectId({ config: null, env: {} })).toThrow(/basefyio link/);
  });
});

describe('resolveBackupRef', () => {
  it('matches a full object key', () => {
    expect(resolveBackupRef(ENTRIES, 'p1/2-b.zip').filename).toBe('b.zip');
  });

  it('matches a filename when it names exactly one backup', () => {
    expect(resolveBackupRef(ENTRIES, 'b.zip').objectKey).toBe('p1/2-b.zip');
  });

  it('refuses an ambiguous filename and lists the candidates', () => {
    expect(() => resolveBackupRef(ENTRIES, 'a.zip')).toThrow(/names 2 backups[\s\S]*p1\/1-a\.zip[\s\S]*p1\/0-a\.zip/);
  });

  it('resolves #n against the newest-first listing', () => {
    expect(resolveBackupRef(ENTRIES, '#1').objectKey).toBe('p1/3-auto.zip');
    expect(resolveBackupRef(ENTRIES, '#4').objectKey).toBe('p1/0-a.zip');
    expect(() => resolveBackupRef(ENTRIES, '#5')).toThrow(/does not exist/);
    expect(() => resolveBackupRef(ENTRIES, '#0')).toThrow(/does not exist/);
  });

  it('resolves latest, latest:auto and latest:manual', () => {
    expect(resolveBackupRef(ENTRIES, 'latest').objectKey).toBe('p1/3-auto.zip');
    expect(resolveBackupRef(ENTRIES, 'latest:auto').objectKey).toBe('p1/3-auto.zip');
    expect(resolveBackupRef(ENTRIES, 'latest:manual').objectKey).toBe('p1/2-b.zip');
    expect(() => resolveBackupRef(ENTRIES.filter((e) => e.kind === 'manual'), 'latest:auto')).toThrow(/No auto backups/);
  });

  it('does not depend on the order the API returned', () => {
    const shuffled = [...ENTRIES].reverse();
    expect(resolveBackupRef(shuffled, 'latest').objectKey).toBe('p1/3-auto.zip');
    expect(resolveBackupRef(shuffled, '#2').objectKey).toBe('p1/2-b.zip');
  });

  it('points at the list command for an unknown reference', () => {
    expect(() => resolveBackupRef(ENTRIES, 'nope.zip')).toThrow(/basefyio backup list/);
  });

  it('reports an empty listing', () => {
    expect(() => resolveBackupRef([], 'latest')).toThrow(/No cloud backups/);
  });
});

describe('defaultArchiveName', () => {
  it('uses the slug and a UTC timestamp', () => {
    const date = new Date(Date.UTC(2026, 9, 20, 15, 15, 0));
    expect(defaultArchiveName('my-app', date)).toBe('my-app-backup-20261020-151500.zip');
  });

  it('sanitises the slug and falls back to "project"', () => {
    const date = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(defaultArchiveName('My App!/v2', date)).toBe('my-app-v2-backup-20260102-030405.zip');
    expect(defaultArchiveName('', date)).toBe('project-backup-20260102-030405.zip');
  });
});

describe('formatBytes', () => {
  it('formats byte counts', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
    expect(formatBytes(-1)).toBe('—');
  });
});

describe('buildRestoreBody', () => {
  it('targets the existing project', () => {
    expect(buildRestoreBody({ mode: 'existing', projectId: 'p1', teamId: 't1' })).toEqual({
      teamId: 't1',
      nameMode: 'existing',
      existingProjectId: 'p1',
    });
  });

  it('creates a new project', () => {
    expect(buildRestoreBody({ mode: 'new', name: 'Copy', teamId: 't1' })).toEqual({
      teamId: 't1',
      nameMode: 'new',
      newProjectName: 'Copy',
    });
  });

  it('adds the cloud source when given', () => {
    expect(
      buildRestoreBody({ mode: 'existing', projectId: 'p1', teamId: 't1' }, { objectKey: 'p1/9-x.zip', kind: 'auto' }),
    ).toEqual({
      teamId: 't1',
      nameMode: 'existing',
      existingProjectId: 'p1',
      objectKey: 'p1/9-x.zip',
      kind: 'auto',
    });
  });
});

describe('describeRestoreEffects', () => {
  it('states what an in-place restore does', () => {
    const text = describeRestoreEffects({ mode: 'existing', projectId: 'p1', teamId: 't1', projectName: 'Shop' }).join('\n');
    expect(text).toMatch(/"Shop"/);
    expect(text).toMatch(/dropped and recreated/);
    expect(text).toMatch(/temporary passwords/);
  });

  it('states what a restore into a new project does', () => {
    const text = describeRestoreEffects({ mode: 'new', name: 'Copy', teamId: 't1' }).join('\n');
    expect(text).toMatch(/new project named "Copy"/);
    expect(text).not.toMatch(/dropped/);
  });
});

describe('buildImportForm', () => {
  it('appends the text fields and the archive as the file part', () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'application/zip' });
    const form = buildImportForm(
      { teamId: 't1', nameMode: 'existing', existingProjectId: 'p1', newProjectName: undefined },
      blob,
      'x.zip',
    );
    expect(form.get('teamId')).toBe('t1');
    expect(form.get('nameMode')).toBe('existing');
    expect(form.get('existingProjectId')).toBe('p1');
    expect(form.has('newProjectName')).toBe(false);
    const file = form.get('file') as File;
    expect(file).toBeInstanceOf(Blob);
    expect(file.name).toBe('x.zip');
    expect(file.size).toBe(3);
  });
});

describe('pollExportJob', () => {
  const statuses = (...list: Array<ExportJobStatus | null | Error>) => {
    let i = 0;
    return vi.fn(async () => {
      const next = list[Math.min(i++, list.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    });
  };
  const noSleep = async () => {};

  it('resolves with the result once the job completes and reports progress changes only', async () => {
    const result = { bucket: 'b', objectKey: 'p1/1-x.zip', filename: 'x.zip', size: 5 };
    const fetchStatus = statuses(
      { state: 'waiting' },
      { state: 'active', progress: { step: 'database', detail: 'dumping', percent: 10 } },
      { state: 'active', progress: { step: 'database', detail: 'dumping', percent: 10 } },
      { state: 'active', progress: { step: 'storage', detail: 'files', percent: 60 } },
      { state: 'completed', progress: { step: 'completed', detail: 'done', percent: 100 }, result },
    );
    const onProgress = vi.fn();
    await expect(pollExportJob(fetchStatus, { sleep: noSleep, onProgress })).resolves.toEqual(result);
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress.mock.calls.map((c) => c[0].step)).toEqual(['database', 'storage', 'completed']);
  });

  it('rejects with the failure reason', async () => {
    const fetchStatus = statuses({ state: 'active' }, { state: 'failed', failedReason: 'pg_dump exited 1' });
    await expect(pollExportJob(fetchStatus, { sleep: noSleep })).rejects.toThrow('pg_dump exited 1');
  });

  it('rejects when the job is unknown', async () => {
    await expect(pollExportJob(statuses({ state: '', error: 'Job not found' }), { sleep: noSleep })).rejects.toThrow(
      'Job not found',
    );
    await expect(pollExportJob(statuses(null), { sleep: noSleep })).rejects.toThrow(/not found/);
  });

  it('tolerates a few transient fetch errors, then gives up', async () => {
    const result = { bucket: 'b', objectKey: 'k', filename: 'f', size: 1 };
    const flaky = statuses(new Error('ECONNRESET'), new Error('ECONNRESET'), { state: 'completed', result });
    await expect(pollExportJob(flaky, { sleep: noSleep })).resolves.toEqual(result);

    const dead = statuses(new Error('ECONNRESET'));
    await expect(pollExportJob(dead, { sleep: noSleep, maxTransientErrors: 2 })).rejects.toThrow('ECONNRESET');
    expect(dead).toHaveBeenCalledTimes(3);
  });

  it('times out with a hint about backup status', async () => {
    let t = 0;
    const now = () => t;
    const sleep = async (ms: number) => {
      t += ms;
    };
    const fetchStatus = statuses({ state: 'active' });
    await expect(
      pollExportJob(fetchStatus, { sleep, now, intervalMs: 1000, timeoutMs: 3000 }),
    ).rejects.toBeInstanceOf(ExportTimeoutError);
    await expect(
      pollExportJob(fetchStatus, { sleep, now, intervalMs: 1000, timeoutMs: 3000 }),
    ).rejects.toThrow(/basefyio backup status/);
  });
});

describe('isLocalArchive', () => {
  const file = async () => ({ isFile: () => true });
  const dir = async () => ({ isFile: () => false });
  const missing = async () => {
    throw new Error('ENOENT');
  };

  it('is true for an existing .zip file', async () => {
    expect(await isLocalArchive('backup.zip', file)).toBe(true);
    expect(await isLocalArchive('BACKUP.ZIP', file)).toBe(true);
  });

  it('is false for non-zip paths, directories and missing files', async () => {
    expect(await isLocalArchive('dump.sql', file)).toBe(false);
    expect(await isLocalArchive('folder.zip', dir)).toBe(false);
    expect(await isLocalArchive('p1/123-backup.zip', missing)).toBe(false);
    expect(await isLocalArchive('', file)).toBe(false);
  });
});
