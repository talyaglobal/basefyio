// SqlService imports ProjectsService only for its type and DI token; see sql.service.spec.ts.
jest.mock('../projects/projects.service', () => ({ ProjectsService: class {} }));

import { SqlService, uniqueColumnNames } from './sql.service';

/**
 * A harness whose database answers by statement text. Rows come back as
 * arrays, the way the service asks for them (rowMode 'array').
 */
function scripted(answer: (text: string) => unknown) {
  const calls: { text: string; values?: unknown[]; rowMode?: string }[] = [];
  const client = {
    query: jest.fn(async (q: any, v?: unknown[]) => {
      const call = typeof q === 'string' ? { text: q, values: v } : q;
      calls.push(call);
      const out = answer(call.text);
      if (out instanceof Error) throw out;
      return out ?? { rows: [], fields: [], rowCount: 0 };
    }),
    release: jest.fn(),
  };
  const prisma = {
    project: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'p1', teamId: 't1', dbHost: 'h', dbPort: 5432, dbUser: 'u', dbPassword: 'secret', dbName: 'db',
      }),
    },
    teamMember: { findUnique: jest.fn().mockResolvedValue({ id: 'm1', role: 'MEMBER' }) },
    sqlAuditLog: { create: jest.fn().mockResolvedValue({ id: 'a1' }), findMany: jest.fn().mockResolvedValue([]) },
    sqlSnippet: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      create: jest.fn(async ({ data }: any) => ({ id: 's1', ...data })),
      update: jest.fn(async ({ data }: any) => ({ id: 's1', ...data })),
      delete: jest.fn().mockResolvedValue({}),
    },
  };
  const activity = { append: jest.fn().mockResolvedValue(undefined) };
  const svc = new SqlService(
    prisma as any, {} as any, activity as any, { enqueueJob: jest.fn() } as any,
    { ensureRlsBootstrap: jest.fn() } as any,
  );
  (svc as any).getPool = () => ({ connect: async () => client });
  return { svc, client, calls, prisma, activity };
}

const field = (name: string, dataTypeID = 23) => ({ name, dataTypeID });
const firstLine = (s: string) => s.split('\n')[0];

describe('SqlService.execute — statements that cannot be wrapped run as written (#97)', () => {
  it('runs a data-modifying CTE once, unwrapped, and does not count it again', async () => {
    const sql = 'WITH u AS (UPDATE t SET n = n + 1 RETURNING id) SELECT count(*) FROM u';
    const { svc, calls } = scripted(() => ({ rows: [['20']], fields: [field('count', 20)], rowCount: 1 }));

    const res = await svc.execute('p1', sql, 'u1', { countTotal: true, page: 1, limit: 100 });

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toBe(sql);
    expect(res.paginated).toBe(false);
    expect(res.rows).toEqual([{ count: '20' }]);
  });

  it('caps the rows of a data-modifying CTE where it runs when the editor asks for a cap', async () => {
    const sql = 'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d';
    const { svc, calls } = scripted(() => ({ rows: [[1], [2], [3]], fields: [field('id')], rowCount: 3 }));

    const res = await svc.execute('p1', sql, 'u1', { maxRows: 2 });

    expect(calls[0].text).toBe(`${sql}\nLIMIT 3`);
    expect(res.rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(res.truncated).toBe(true);
  });

  it('runs INSERT … RETURNING as written and trims its rows to the cap', async () => {
    const sql = 'INSERT INTO t (v) SELECT g FROM generate_series(1, 3) g RETURNING id';
    const { svc, calls } = scripted(() => ({ rows: [[1], [2], [3]], fields: [field('id')], rowCount: 3 }));
    const res = await svc.execute('p1', sql, 'u1', { maxRows: 2 });
    expect(calls[0].text).toBe(sql);
    expect(res.rows).toHaveLength(2);
    expect(res.rowCount).toBe(3);
  });

  it('does not wrap SELECT … INTO, which creates a table', async () => {
    const sql = 'SELECT * INTO backup_t FROM t';
    const { svc, calls } = scripted(() => ({ rows: [], fields: [], rowCount: 5 }));
    await svc.execute('p1', sql, 'u1');
    expect(calls[0].text).toBe(sql);
  });

  it('wraps a SELECT that ends in a line comment without the comment eating the wrapper', async () => {
    const { svc, calls } = scripted(() => ({ rows: [], fields: [field('a')], rowCount: 0 }));
    await svc.execute('p1', 'SELECT 1 AS a -- note\n;', 'u1');
    expect(calls[0].text).toBe('SELECT * FROM (\nSELECT 1 AS a\n) AS _bf_paged LIMIT 100 OFFSET 0');
  });
});

describe('SqlService.execute — duplicate column names (#98)', () => {
  it('keeps both columns of `SELECT count(*), count(*) FILTER …`', async () => {
    const { svc, calls } = scripted(() => ({
      rows: [['20', '10']],
      fields: [field('count', 20), field('count', 20)],
      rowCount: 1,
    }));

    const res = await svc.execute('p1', 'select count(*), count(*) filter (where x) from t', 'u1');

    expect(calls[0].rowMode).toBe('array');
    expect(res.fields!.map((f) => f.name)).toEqual(['count', 'count_1']);
    expect(res.rows).toEqual([{ count: '20', count_1: '10' }]);
  });

  it('never invents a name that collides with a real column', () => {
    expect(uniqueColumnNames(['a', 'a', 'a_1'])).toEqual(['a', 'a_2', 'a_1']);
    expect(uniqueColumnNames(['id', 'name'])).toEqual(['id', 'name']);
  });
});

describe('SqlService.execute — scripts are capped, not paged (#184)', () => {
  it('caps each read of a script where it runs and reports the truncation', async () => {
    const { svc, calls } = scripted(() => [
      { rows: [[1], [2], [3]], fields: [field('id')], rowCount: 3, command: 'SELECT' },
      { rows: [[1]], fields: [field('?column?')], rowCount: 1, command: 'SELECT' },
    ]);

    const res = await svc.execute('p1', 'select * from t limit 50000; select 1', 'u1', { maxRows: 2 });

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toBe(
      'SELECT * FROM (\nselect * from t limit 50000\n) AS _bf_capped LIMIT 3;\nSELECT * FROM (\nselect 1\n) AS _bf_capped LIMIT 3',
    );
    expect(res.resultSets![0].rows).toHaveLength(2);
    expect(res.resultSets![0].truncated).toBe(true);
    expect(res.resultSets![1].truncated).toBeUndefined();
    expect(res.truncated).toBe(true);
    expect(res.paginated).toBe(false);
  });

  it('applies the default cap to a script when the caller gives none', async () => {
    const { svc, calls } = scripted(() => [
      { rows: [], fields: [], rowCount: 0, command: 'CREATE' },
      { rows: [], fields: [field('id')], rowCount: 0, command: 'SELECT' },
    ]);
    await svc.execute('p1', 'create temp table x (id int); select * from x', 'u1');
    expect(calls[0].text).toBe(
      'create temp table x (id int);\nSELECT * FROM (\nselect * from x\n) AS _bf_capped LIMIT 10001',
    );
  });

  it('leaves statements that are not reads untouched, semicolons in strings included', async () => {
    const { svc, calls } = scripted(() => [
      { rows: [], fields: [], rowCount: 1 },
      { rows: [], fields: [], rowCount: 1 },
    ]);
    await svc.execute('p1', "insert into t values ('a;b'); update t set v = 'c' where v = 'a;b'", 'u1');
    expect(calls[0].text).toBe("insert into t values ('a;b');\nupdate t set v = 'c' where v = 'a;b'");
  });

  it('does not repeat a single statement in resultSets when asked to be compact', async () => {
    const { svc } = scripted(() => ({ rows: [[1]], fields: [field('a')], rowCount: 1 }));
    const res = await svc.execute('p1', 'select 1 as a', 'u1', { compact: true });
    expect(res.resultSets).toBeUndefined();
    const full = await svc.execute('p1', 'select 1 as a', 'u1');
    expect(full.resultSets).toHaveLength(1);
  });
});

describe('SqlService.execute — paging never repeats a write (#40)', () => {
  it('fetches another page inside a read-only transaction', async () => {
    const { svc, calls } = scripted(() => ({ rows: [], fields: [field('a')], rowCount: 0 }));
    await svc.execute('p1', 'select 1 as a', 'u1', { page: 2, readOnly: true });
    expect(calls.map((c) => firstLine(c.text))).toEqual(['BEGIN READ ONLY', 'SELECT * FROM (', 'COMMIT']);
  });

  it('explains, in words, when the page cannot be fetched without writing', async () => {
    const { svc } = scripted((text) =>
      text.startsWith('SELECT * FROM')
        ? Object.assign(new Error('cannot execute nextval() in a read-only transaction'), { code: '25006' })
        : undefined,
    );
    await expect(
      svc.execute('p1', 'select nextval(1)', 'u1', { page: 2, readOnly: true }),
    ).rejects.toThrow(/changes data/);
  });

  it('counts in a read-only transaction that is rolled back', async () => {
    const { svc, calls } = scripted((text) =>
      text.startsWith('SELECT COUNT') ? { rows: [{ total: 7 }], fields: [], rowCount: 1 } : undefined,
    );
    const res = await svc.execute('p1', 'select * from t', 'u1', { countTotal: true });
    expect(calls.slice(1).map((c) => firstLine(c.text))).toEqual([
      'BEGIN READ ONLY',
      'SELECT COUNT(*)::int AS total FROM (SELECT 1 FROM (',
      'ROLLBACK',
    ]);
    expect(res.total).toBe(7);
  });

  it('counts under a savepoint inside an API-key transaction, and keeps the statement', async () => {
    const { svc, calls } = scripted((text) =>
      text.startsWith('SELECT COUNT') ? new Error('boom') : undefined,
    );
    await svc.execute('p1', 'select * from t', undefined, { countTotal: true, rls: { role: 'anon' } });
    const texts = calls.map((c) => c.text);
    expect(texts).toContain('SAVEPOINT _bf_count');
    expect(texts).toContain('ROLLBACK TO SAVEPOINT _bf_count');
    expect(texts[texts.length - 1]).toBe('COMMIT');
  });
});

describe('SqlService.execute — tells open pages whether data may have changed (#149)', () => {
  it('broadcasts changes=false for a read and true for a write', async () => {
    const { svc, activity } = scripted(() => ({ rows: [], fields: [], rowCount: 0 }));
    await svc.execute('p1', 'select 1', 'u1');
    await svc.execute('p1', 'drop table t', 'u1');
    expect(activity.append.mock.calls[0][1].broadcast).toEqual({ changes: false });
    expect(activity.append.mock.calls[1][1].broadcast).toEqual({ changes: true });
  });
});

describe('SqlService — cancel, history and saved queries (#41)', () => {
  const RUN = '8a0f0c1e-2b8c-4d7e-9f00-000000000001';

  it('registers a run under its id while it executes, and forgets it after', async () => {
    let seenDuring: unknown;
    const h = scripted((text) => {
      if (text.startsWith('SELECT pg_backend_pid')) return { rows: [{ pid: 4242 }], fields: [], rowCount: 1 };
      seenDuring = (h.svc as any).running.get(RUN);
      return undefined;
    });
    await h.svc.execute('p1', 'select 1', 'u1', { runId: RUN });
    expect(seenDuring).toEqual({ projectId: 'p1', userId: 'u1', pid: 4242 });
    expect((h.svc as any).running.size).toBe(0);
  });

  it('will not cancel a run that belongs to someone else', async () => {
    const { svc } = scripted(() => undefined);
    (svc as any).running.set('r1', { projectId: 'p1', userId: 'someone-else', pid: 1 });
    await expect(svc.cancel('p1', 'r1', 'u1')).resolves.toEqual({ cancelled: false });
  });

  it('reads history for the signed-in user only', async () => {
    const { svc, prisma } = scripted(() => undefined);
    await svc.history('p1', 'u1', 999);
    expect(prisma.sqlAuditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: 'p1', userId: 'u1' }, take: 200 }),
    );
  });

  it('lets the author change a saved query, and refuses another member', async () => {
    const { svc, prisma } = scripted(() => undefined);
    prisma.sqlSnippet.findUnique.mockResolvedValue({
      id: 's1', projectId: 'p1', userId: 'author', name: 'n', query: 'select 1',
    });

    await expect(svc.updateSnippet('s1', 'author', { name: 'renamed' })).resolves.toMatchObject({ name: 'renamed' });
    await expect(svc.deleteSnippet('s1', 'u1')).rejects.toThrow(/author/);

    prisma.teamMember.findUnique.mockResolvedValue({ id: 'm2', role: 'ADMIN' });
    await expect(svc.deleteSnippet('s1', 'u1')).resolves.toEqual({ deleted: true });
  });

  it('refuses an empty saved query', async () => {
    const { svc } = scripted(() => undefined);
    await expect(svc.createSnippet('p1', 'u1', { name: 'x', query: '   ' })).rejects.toThrow(/empty/);
  });
});
