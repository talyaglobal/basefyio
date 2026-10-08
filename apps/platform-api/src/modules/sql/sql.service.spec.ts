import { BadRequestException } from '@nestjs/common';

// SqlService imports ProjectsService only for its type and DI token. Loading
// the real module here would drag in the Keycloak admin client (ESM), which
// this unit test neither needs nor can transform. The harness injects a mock.
jest.mock('../projects/projects.service', () => ({ ProjectsService: class {} }));

import { SqlService } from './sql.service';

/**
 * Parameters, and the reason they exist.
 *
 * `sql-guard.ts` scans the statement it is given — string literals included,
 * because a literal is where a smuggled `COPY` would hide. The cost was paid by
 * ordinary text: a value written into the SQL was refused as the operation it
 * happened to name, and a caller storing the sentence "myfyio copy would post
 * there" could not write its row at all.
 *
 * These tests hold both halves of the fix: a value never reaches the statement
 * (so the guard never reads it), and the statement is still scanned exactly as
 * before (so a real `COPY` is still refused).
 */

interface FakeClient {
  query: jest.Mock;
  release: jest.Mock;
}

function harness(queryResult: unknown = { rows: [], fields: [], rowCount: 0 }) {
  const client: FakeClient = {
    query: jest.fn().mockResolvedValue(queryResult),
    release: jest.fn(),
  };
  const prisma = {
    project: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'p1',
        teamId: 't1',
        dbHost: 'h',
        dbPort: 5432,
        dbUser: 'u',
        dbPassword: 'secret',
        dbName: 'db',
      }),
    },
    teamMember: { findUnique: jest.fn().mockResolvedValue({ id: 'm1' }) },
    sqlAuditLog: { create: jest.fn().mockResolvedValue({ id: 'a1' }) },
  };
  const activity = { append: jest.fn().mockResolvedValue(undefined) };
  const embedding = { enqueueJob: jest.fn() };

  const projectsService = { ensureRlsBootstrap: jest.fn() };
  const svc = new SqlService(
    prisma as any,
    {} as any,
    activity as any,
    embedding as any,
    projectsService as any,
  );
  // The pool is the one dependency that needs a live database; everything this
  // file is about happens on the way to it.
  (svc as any).getPool = () => ({ connect: async () => client });

  return { svc, client, prisma, activity };
}

describe('SqlService.execute — values travel apart from the statement', () => {
  it('sends the values beside the SQL, and never inside it', async () => {
    const { svc, client } = harness();

    await svc.execute('p1', 'SELECT * FROM t WHERE note = $1', 'u1', {
      params: ['page load'],
    });

    const [text, values] = client.query.mock.calls[0];
    expect(text).toContain('$1');
    expect(text).not.toContain('page load');
    expect(values).toEqual(['page load']);
  });

  it('accepts a value that names a forbidden operation', async () => {
    // The regression this change exists for: the guard reads the statement, and
    // the statement no longer carries the sentence.
    const { svc, client } = harness();

    await expect(
      svc.execute('p1', 'UPDATE t SET error = $1 WHERE id = $2', 'u1', {
        params: ['myfyio copy would post there', 7],
      }),
    ).resolves.toBeDefined();

    expect(client.query.mock.calls[0][1]).toEqual([
      'myfyio copy would post there',
      7,
    ]);
  });

  it('still refuses a forbidden operation written in the statement', async () => {
    const { svc, client } = harness();

    await expect(
      svc.execute('p1', "COPY t FROM PROGRAM 'sh'", 'u1', { params: ['x'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('sends a parameterless query exactly as it did before', async () => {
    const { svc, client } = harness();

    await svc.execute('p1', 'SELECT 1', 'u1');

    expect(client.query.mock.calls[0][1]).toBeUndefined();
  });

  it('gives the count query the same values', async () => {
    const { svc, client } = harness();

    await svc.execute('p1', 'SELECT * FROM t WHERE a = $1', 'u1', {
      params: ['v'],
      countTotal: true,
    });

    expect(client.query).toHaveBeenCalledTimes(2);
    const [countText, countValues] = client.query.mock.calls[1];
    expect(countText).toContain('COUNT(*)');
    expect(countValues).toEqual(['v']);
  });

  it('keeps the placeholders when it wraps a SELECT for pagination', async () => {
    const { svc, client } = harness();

    await svc.execute('p1', 'SELECT * FROM t WHERE a = $1', 'u1', {
      params: ['v'],
      limit: 10,
    });

    const [text] = client.query.mock.calls[0];
    expect(text).toContain('_bf_paged');
    expect(text).toContain('$1');
  });

  it('refuses parameters with a multi-statement script, before touching the database', async () => {
    const { svc, client } = harness();

    await expect(
      svc.execute('p1', 'SELECT $1; SELECT 2', 'u1', { params: ['a'] }),
    ).rejects.toThrow(/single statement/);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('refuses more parameters than Postgres can bind', async () => {
    const { svc, client } = harness();

    await expect(
      svc.execute('p1', 'SELECT 1', 'u1', {
        params: new Array(65536).fill('x'),
      }),
    ).rejects.toThrow(/65535/);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('writes the statement to the audit log, and none of the values', async () => {
    // A parameter is where a password or a customer's message ends up. The
    // audit log records what was run, which is the statement.
    const { svc, prisma, activity } = harness();

    await svc.execute('p1', 'UPDATE t SET secret = $1', 'u1', {
      params: ['hunter2'],
    });

    const audited = JSON.stringify(prisma.sqlAuditLog.create.mock.calls);
    expect(audited).toContain('UPDATE t SET secret = $1');
    expect(audited).not.toContain('hunter2');
    expect(JSON.stringify(activity.append.mock.calls)).not.toContain('hunter2');
  });
});

/**
 * Who the statement runs as.
 *
 * A dashboard editor (no rls context) runs as the database owner, exactly as
 * before. An API-key caller runs inside a transaction that switches to the
 * key's role first, so RLS governs the statement — the public anon key can read
 * what policy allows and, holding no write grant, can write nothing.
 */
describe('SqlService.execute — runs under the caller role', () => {
  function roleHarness(opts?: { denySetRoleOnce?: boolean }) {
    let setRoleCalls = 0;
    const calls: string[] = [];
    const client = {
      query: jest.fn(async (sql: string) => {
        calls.push(sql);
        if (/^SET LOCAL ROLE/.test(sql)) {
          setRoleCalls++;
          if (opts?.denySetRoleOnce && setRoleCalls === 1) {
            const e: any = new Error('permission denied to set role');
            e.code = '42501';
            throw e;
          }
        }
        return { rows: [], fields: [], rowCount: 0 };
      }),
      release: jest.fn(),
    };
    const prisma = {
      project: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'p1', teamId: 't1', dbHost: 'h', dbPort: 5432,
          dbUser: 'u', dbPassword: 'secret', dbName: 'db',
        }),
      },
      teamMember: { findUnique: jest.fn().mockResolvedValue({ id: 'm1' }) },
      sqlAuditLog: { create: jest.fn().mockResolvedValue({ id: 'a1' }) },
    };
    const activity = { append: jest.fn().mockResolvedValue(undefined) };
    const embedding = { enqueueJob: jest.fn() };
    const projectsService = { ensureRlsBootstrap: jest.fn().mockResolvedValue(undefined) };
    const svc = new SqlService(
      prisma as any, {} as any, activity as any, embedding as any, projectsService as any,
    );
    (svc as any).getPool = () => ({ connect: async () => client });
    return { svc, client, calls, projectsService };
  }

  it('switches to the anon role inside a transaction for an API-key call', async () => {
    const { svc, calls } = roleHarness();
    await svc.execute('p1', 'SELECT * FROM t', undefined, {
      rls: { role: 'anon' },
    });
    expect(calls).toContain('BEGIN');
    expect(calls).toContain('SET LOCAL ROLE "anon"');
    expect(calls).toContain('COMMIT');
    expect(calls.some((c) => c.includes("set_config('request.jwt.role'"))).toBe(true);
    // The role switch must come before the statement runs.
    expect(calls.indexOf('SET LOCAL ROLE "anon"')).toBeLessThan(
      calls.findIndex((c) => c.includes('FROM t')),
    );
  });

  it('carries the role for an authenticated API-key call', async () => {
    const { svc, calls } = roleHarness();
    await svc.execute('p1', 'SELECT 1', undefined, {
      rls: { role: 'authenticated', jwtClaims: { sub: 'user-1' } },
    });
    expect(calls).toContain('SET LOCAL ROLE "authenticated"');
  });

  it('does NOT switch role for a dashboard user (owner path unchanged)', async () => {
    const { svc, calls } = roleHarness();
    await svc.execute('p1', 'SELECT 1', 'u1');
    expect(calls.some((c) => c.startsWith('SET LOCAL ROLE'))).toBe(false);
    expect(calls).not.toContain('BEGIN');
  });

  it('bootstraps once and retries when SET ROLE is denied, never falling back to owner', async () => {
    const { svc, calls, projectsService } = roleHarness({ denySetRoleOnce: true });
    await svc.execute('p1', 'SELECT 1', undefined, { rls: { role: 'anon' } });
    expect(projectsService.ensureRlsBootstrap).toHaveBeenCalledWith('p1');
    // Two SET ROLE attempts: the denied one and the post-heal retry.
    expect(calls.filter((c) => c === 'SET LOCAL ROLE "anon"').length).toBe(2);
    // A ROLLBACK for the failed first attempt.
    expect(calls).toContain('ROLLBACK');
  });
});
