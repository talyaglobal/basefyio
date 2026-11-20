import { Readable } from 'stream';

const execFileMock = jest.fn();
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: (...args: any[]) => execFileMock(...args),
}));

import { BadRequestException } from '@nestjs/common';
import {
  PitrRestoreError,
  ProjectPitrService,
  recoveryContainerOptions,
  recoveryTargetLiteral,
} from './project-pitr.service';

const PROJECT = {
  id: 'p1',
  teamId: 't1',
  name: 'demo',
  dbName: 'db_p1',
  dbUser: 'u_p1',
  dbPassword: 'pw',
  dbHost: 'postgres',
  dbPort: 5432,
  databaseType: 'RELATIONAL',
};

type Obj = { name: string; lastModified: Date; size?: number };

function build(objects: { cluster?: Obj[]; project?: Obj[] } = {}) {
  const storage = {
    listPlatformObjects: jest.fn(async (_bucket: string, prefix: string) => {
      if (prefix.startsWith('_cluster/base/')) return objects.cluster ?? [];
      if (prefix === 'p1/base/') return objects.project ?? [];
      return [];
    }),
    getPlatformObject: jest.fn(async () => ({ stream: Readable.from([Buffer.from('dump')]) })),
  };
  const activity = { append: jest.fn().mockResolvedValue(undefined) };
  const svc = new ProjectPitrService(
    {} as any,
    storage as any,
    activity as any,
    {} as any,
    { raise: jest.fn() } as any,
  );
  return { svc, storage, activity };
}

function ctx() {
  const controller = new AbortController();
  return {
    controller,
    phases: [] as string[],
    get value() {
      const phases = this.phases;
      return {
        signal: controller.signal,
        phase: async (p: string) => {
          phases.push(p);
        },
      };
    },
  };
}

/** execFile(cmd, args, opts, cb) → answers pg_restore --list with `entries` lines. */
function fakeExec(entries: number, restoreError?: Error & { stderr?: string }) {
  execFileMock.mockImplementation((cmd: string, args: string[], opts: any, cb: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (cmd === 'pg_restore' && args[0] === '--list') {
      const lines = [';', '; Archive created at …', ...Array.from({ length: entries }, (_, i) => `${i}; 1259 TABLE public t${i}`)];
      done(null, { stdout: lines.join('\n'), stderr: '' });
      return;
    }
    if (cmd === 'pg_restore' && restoreError) {
      done(restoreError);
      return;
    }
    done(null, { stdout: '', stderr: '' });
  });
}

beforeEach(() => execFileMock.mockReset());
afterEach(() => delete process.env.PITR_ATOMIC_MAX_OBJECTS);

describe('ProjectPitrService.validateRestoreTarget', () => {
  it('refuses document (NoSQL) projects', async () => {
    const { svc } = build();
    await expect(
      svc.validateRestoreTarget({ ...PROJECT, databaseType: 'NOSQL' }, '2026-11-20T10:00:00Z'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an invalid or future timestamp', async () => {
    const { svc } = build();
    await expect(svc.validateRestoreTarget(PROJECT, 'yesterday-ish')).rejects.toThrow(/valid ISO/);
    await expect(svc.validateRestoreTarget(PROJECT, '2999-01-01T00:00:00Z')).rejects.toThrow(/future/);
  });

  it('accepts any past instant a physical base covers', async () => {
    const { svc } = build({
      cluster: [{ name: '_cluster/base/2026-11-19/base.tar.gz', lastModified: new Date('2026-11-19T02:00:00Z') }],
    });
    const t = await svc.validateRestoreTarget(PROJECT, '2026-11-19T12:00:00Z');
    expect(t.toISOString()).toBe('2026-11-19T12:00:00.000Z');
  });

  it('refuses when no backup of any kind exists yet', async () => {
    const { svc } = build();
    await expect(svc.validateRestoreTarget(PROJECT, '2026-11-19T12:00:00Z')).rejects.toThrow(
      /No base backup exists/,
    );
  });

  it('refuses a target before the oldest snapshot when no physical base covers it', async () => {
    const { svc } = build({
      project: [{ name: 'p1/base/a.dump', lastModified: new Date('2026-11-18T02:00:00Z') }],
    });
    await expect(svc.validateRestoreTarget(PROJECT, '2026-11-17T12:00:00Z')).rejects.toThrow(
      /outside the 7-day recovery window/,
    );
  });
});

describe('ProjectPitrService.executeRestore (snapshot path)', () => {
  const snapshot = { project: [{ name: 'p1/base/a.dump', lastModified: new Date('2026-11-18T02:00:00Z') }] };

  it('loads a small dump in one transaction, so a failure rolls back', async () => {
    fakeExec(10);
    const { svc, activity } = build(snapshot);
    const c = ctx();
    const result = await svc.executeRestore(PROJECT, new Date('2026-11-18T12:00:00Z'), 'u1', c.value);

    const restore = execFileMock.mock.calls.find((call) => call[0] === 'pg_restore' && call[1][0] !== '--list');
    expect(restore[1]).toEqual(expect.arrayContaining(['--single-transaction', '--exit-on-error', '--dbname', 'db_p1']));
    expect(restore[2].signal).toBe(c.controller.signal);
    expect(result).toEqual(expect.objectContaining({ method: 'snapshot', exact: false }));
    expect(c.phases).toEqual(['preparing', 'downloading', 'restoring']);
    expect(activity.append).toHaveBeenCalledWith('p1', expect.objectContaining({ kind: 'project.pitr_restored' }));
  });

  it('loads a very large dump object by object and does not let the deadline kill it halfway', async () => {
    process.env.PITR_ATOMIC_MAX_OBJECTS = '5';
    fakeExec(10);
    const { svc } = build(snapshot);
    await svc.executeRestore(PROJECT, new Date('2026-11-18T12:00:00Z'), 'u1', ctx().value);

    const restore = execFileMock.mock.calls.find((call) => call[0] === 'pg_restore' && call[1][0] !== '--list');
    expect(restore[1]).not.toContain('--single-transaction');
    expect(restore[2].signal).toBeUndefined();
    expect(restore[2].timeout).toBeGreaterThan(0);
  });

  it('reports a failed atomic load as rolled back and unchanged', async () => {
    fakeExec(10, Object.assign(new Error('exit 1'), { stderr: 'pg_restore: error: could not execute query: ERROR:  permission denied' }));
    const { svc, activity } = build(snapshot);
    const err = await svc
      .executeRestore(PROJECT, new Date('2026-11-18T12:00:00Z'), 'u1', ctx().value)
      .catch((e) => e);
    expect(err).toBeInstanceOf(PitrRestoreError);
    expect(err.userMessage).toMatch(/rolled back and your database was not changed/);
    expect(err.userMessage).toMatch(/permission denied/);
    expect(activity.append).not.toHaveBeenCalled();
  });

  it('fails clearly when no snapshot precedes the target', async () => {
    fakeExec(1);
    const { svc } = build(snapshot);
    await expect(
      svc.executeRestore(PROJECT, new Date('2026-11-17T12:00:00Z'), 'u1', ctx().value),
    ).rejects.toBeInstanceOf(PitrRestoreError);
  });
});

describe('recovery instance', () => {
  it('runs without network and under memory, CPU and OOM limits', () => {
    const opts = recoveryContainerOptions('bf-pitr-abcd1234', '/pitr-scratch/restore-abcd1234/data', 'abcd1234') as any;
    expect(opts.HostConfig.NetworkMode).toBe('none');
    expect(opts.HostConfig.Memory).toBe(1024 * 1024 * 1024);
    expect(opts.HostConfig.MemorySwap).toBe(opts.HostConfig.Memory);
    expect(opts.HostConfig.NanoCpus).toBe(1_000_000_000);
    expect(opts.HostConfig.OomScoreAdj).toBeGreaterThan(0);
    expect(opts.HostConfig.Binds).toEqual([expect.stringMatching(/:\/pitr-scratch$/)]);
    expect(opts.Labels).toEqual({ 'basefyio.pitr.run': 'abcd1234' });
  });

  it('writes recovery_target_time in the form Postgres accepts', () => {
    expect(recoveryTargetLiteral(new Date('2026-08-10T03:37:37.687Z'))).toBe('2026-08-10 03:37:37.687+00');
  });
});

describe('cleanupRun', () => {
  it('ignores anything that is not a run id', async () => {
    const { svc } = build();
    await expect(svc.cleanupRun('../../etc')).resolves.toBeUndefined();
  });
});
