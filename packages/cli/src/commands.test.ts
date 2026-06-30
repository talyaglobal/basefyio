import { describe, expect, it, vi } from 'vitest';
import {
  formatBuckets,
  formatProject,
  formatProjects,
  formatSqlResult,
  parseArgs,
  run,
  type CommandDeps,
} from './commands';
import type { CliConfig } from './config';

// ── Fakes ─────────────────────────────────────────────────────────────────────

function fakeClient() {
  const sql = {
    execute: vi.fn().mockResolvedValue({
      rows: [{ n: 1 }],
      fields: [],
      rowCount: 1,
      command: 'SELECT',
      resultSets: [],
    }),
  };
  const storage = {
    listBuckets: vi.fn().mockResolvedValue([{ name: 'uploads', public: false, createdAt: 't' }]),
    createBucket: vi.fn().mockResolvedValue({ name: 'images', public: true, createdAt: 't' }),
    deleteBucket: vi.fn().mockResolvedValue(undefined),
  };
  const withProject = vi.fn().mockReturnValue({ sql, storage });
  const auth = {
    signIn: vi.fn().mockResolvedValue({ accessToken: 'jwt-123', refreshToken: 'r' }),
  };
  const projects = {
    list: vi
      .fn()
      .mockResolvedValue([{ id: 'p1', name: 'App', slug: 'app', status: 'ACTIVE', createdAt: 't' }]),
    create: vi
      .fn()
      .mockResolvedValue({ id: 'p2', name: 'New', slug: 'new', status: 'ACTIVE', createdAt: 't' }),
    get: vi
      .fn()
      .mockResolvedValue({ id: 'p1', name: 'App', slug: 'app', status: 'ACTIVE', createdAt: 't' }),
  };
  const client = { auth, projects, withProject } as unknown;
  return { client, auth, projects, sql, storage, withProject };
}

function makeDeps(client: unknown, config: CliConfig = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const saved: CliConfig[] = [];
  const makeClient = vi.fn().mockReturnValue(client);
  const readPassword = vi.fn().mockResolvedValue('from-prompt');
  const deps: CommandDeps = {
    loadConfig: () => config,
    saveConfig: (c) => saved.push(c),
    makeClient: makeClient as unknown as CommandDeps['makeClient'],
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    defaultApiUrl: 'http://localhost:4000',
    readPassword,
  };
  return { deps, out, err, saved, makeClient, readPassword };
}

const AUTHED: CliConfig = { token: 'existing-jwt', apiUrl: 'http://localhost:4000' };

// ── parseArgs ─────────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('separates positionals from string flags', () => {
    const { positionals, flags } = parseArgs(['projects', 'create', '--name', 'My App', '--team', 't1']);
    expect(positionals).toEqual(['projects', 'create']);
    expect(flags).toEqual({ name: 'My App', team: 't1' });
  });

  it('treats a trailing or back-to-back flag as boolean true', () => {
    const { flags } = parseArgs(['storage', 'buckets', 'create', 'p1', 'docs', '--public']);
    expect(flags.public).toBe(true);
  });
});

// ── login ─────────────────────────────────────────────────────────────────────

describe('login', () => {
  it('signs in, saves the token, and does not require a prior token', async () => {
    const { client, auth } = fakeClient();
    const { deps, saved, makeClient } = makeDeps(client);
    const code = await run(['login', '--email', 'a@b.com', '--password', 'pw'], deps);
    expect(code).toBe(0);
    expect(auth.signIn).toHaveBeenCalledWith({ email: 'a@b.com', password: 'pw' });
    expect(makeClient).toHaveBeenCalledWith({ url: 'http://localhost:4000' });
    expect(saved[0]).toEqual({ apiUrl: 'http://localhost:4000', token: 'jwt-123', email: 'a@b.com' });
  });

  it('falls back to the password prompt when --password is omitted', async () => {
    const { client, auth } = fakeClient();
    const { deps, readPassword } = makeDeps(client);
    await run(['login', '--email', 'a@b.com'], deps);
    expect(readPassword).toHaveBeenCalledOnce();
    expect(auth.signIn).toHaveBeenCalledWith({ email: 'a@b.com', password: 'from-prompt' });
  });

  it('errors without --email', async () => {
    const { client } = fakeClient();
    const { deps, err } = makeDeps(client);
    expect(await run(['login'], deps)).toBe(1);
    expect(err.join()).toContain('--email is required');
  });
});

// ── auth guard ────────────────────────────────────────────────────────────────

describe('auth guard', () => {
  it('blocks authed commands when not logged in', async () => {
    const { client, projects } = fakeClient();
    const { deps, err } = makeDeps(client, {});
    expect(await run(['projects', 'list'], deps)).toBe(1);
    expect(projects.list).not.toHaveBeenCalled();
    expect(err.join()).toContain('Not logged in');
  });
});

// ── projects ──────────────────────────────────────────────────────────────────

describe('projects', () => {
  it('list calls projects.list and prints rows', async () => {
    const { client, projects } = fakeClient();
    const { deps, out, makeClient } = makeDeps(client, AUTHED);
    expect(await run(['projects', 'list'], deps)).toBe(0);
    expect(projects.list).toHaveBeenCalledOnce();
    expect(makeClient).toHaveBeenCalledWith({ url: 'http://localhost:4000', token: 'existing-jwt' });
    expect(out.join('\n')).toContain('p1');
  });

  it('create requires --team and passes name + teamId', async () => {
    const { client, projects } = fakeClient();
    const noTeam = makeDeps(client, AUTHED);
    expect(await run(['projects', 'create', '--name', 'X'], noTeam.deps)).toBe(1);
    expect(noTeam.err.join()).toContain('--team');

    const ok = makeDeps(client, AUTHED);
    expect(await run(['projects', 'create', '--name', 'X', '--team', 't1'], ok.deps)).toBe(0);
    expect(projects.create).toHaveBeenCalledWith({ name: 'X', teamId: 't1' });
  });

  it('get passes the positional id', async () => {
    const { client, projects } = fakeClient();
    const { deps } = makeDeps(client, AUTHED);
    expect(await run(['projects', 'get', 'p1'], deps)).toBe(0);
    expect(projects.get).toHaveBeenCalledWith('p1');
  });
});

// ── sql ───────────────────────────────────────────────────────────────────────

describe('sql execute', () => {
  it('scopes to the project and runs the query', async () => {
    const { client, withProject, sql } = fakeClient();
    const { deps, out } = makeDeps(client, AUTHED);
    expect(await run(['sql', 'execute', 'p1', 'SELECT 1'], deps)).toBe(0);
    expect(withProject).toHaveBeenCalledWith('p1');
    expect(sql.execute).toHaveBeenCalledWith('SELECT 1');
    expect(out.join('\n')).toContain('1 row');
  });

  it('errors when query is missing', async () => {
    const { client } = fakeClient();
    const { deps } = makeDeps(client, AUTHED);
    expect(await run(['sql', 'execute', 'p1'], deps)).toBe(1);
  });
});

// ── storage ───────────────────────────────────────────────────────────────────

describe('storage buckets', () => {
  it('list scopes to the project', async () => {
    const { client, withProject, storage } = fakeClient();
    const { deps, out } = makeDeps(client, AUTHED);
    expect(await run(['storage', 'buckets', 'list', 'p1'], deps)).toBe(0);
    expect(withProject).toHaveBeenCalledWith('p1');
    expect(storage.listBuckets).toHaveBeenCalledOnce();
    expect(out.join('\n')).toContain('uploads');
  });

  it('create passes name and --public flag', async () => {
    const { client, storage } = fakeClient();
    const { deps } = makeDeps(client, AUTHED);
    expect(await run(['storage', 'buckets', 'create', 'p1', 'docs', '--public'], deps)).toBe(0);
    expect(storage.createBucket).toHaveBeenCalledWith({ name: 'docs', public: true });
  });

  it('delete passes the bucket name', async () => {
    const { client, storage } = fakeClient();
    const { deps } = makeDeps(client, AUTHED);
    expect(await run(['storage', 'buckets', 'delete', 'p1', 'docs'], deps)).toBe(0);
    expect(storage.deleteBucket).toHaveBeenCalledWith('docs');
  });
});

// ── error handling + unknown ──────────────────────────────────────────────────

describe('dispatch', () => {
  it('maps SDK errors to exit code 1', async () => {
    const { client, projects } = fakeClient();
    projects.list.mockRejectedValueOnce(new Error('boom'));
    const { deps, err } = makeDeps(client, AUTHED);
    expect(await run(['projects', 'list'], deps)).toBe(1);
    expect(err.join()).toContain('Error: boom');
  });

  it('rejects unknown commands', async () => {
    const { client } = fakeClient();
    const { deps, err } = makeDeps(client, AUTHED);
    expect(await run(['frobnicate'], deps)).toBe(1);
    expect(err.join()).toContain('Unknown command');
  });
});

// ── formatters ────────────────────────────────────────────────────────────────

describe('formatters', () => {
  it('formats project lists and empties', () => {
    expect(formatProjects([])).toBe('No projects.');
    expect(formatProjects([{ id: 'p1', name: 'A', slug: 'a', status: 'ACTIVE', createdAt: 't' } as never]))
      .toContain('p1');
  });

  it('formats a single project block', () => {
    const s = formatProject({ id: 'p1', name: 'A', slug: 'a', status: 'ACTIVE', createdAt: 't' } as never);
    expect(s).toContain('ID:      p1');
  });

  it('formats sql results and bucket lists', () => {
    expect(formatSqlResult({ rows: [], fields: [], rowCount: 0 } as never)).toBe('0 rows');
    expect(formatBuckets([])).toBe('No buckets.');
  });
});
