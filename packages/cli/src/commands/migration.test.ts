import { describe, expect, it, vi } from 'vitest';
import {
  buildApplySql,
  buildRollbackSql,
  computePending,
  fetchAppliedSet,
  serverErrorMessage,
  type SqlExecutor,
} from './migration';

// A stand-in for the SQL endpoint that pages exactly like the server: it slices
// `names` by the (page, limit) it is handed and only returns a total when the
// caller asks (countTotal). Optionally fails on the Nth call or lies about the
// total, to exercise the failure and guard paths.
function mockServer(
  names: string[],
  opts: { failOnCall?: number; totalOverride?: number } = {},
): { exec: SqlExecutor; calls: () => number; lastOpts: () => any } {
  let calls = 0;
  let lastOpts: any;
  const exec: SqlExecutor = async (_query, o) => {
    calls += 1;
    lastOpts = o;
    if (opts.failOnCall && calls === opts.failOnCall) {
      throw new Error('simulated read failure');
    }
    const page = o?.page ?? 1;
    const limit = o?.limit ?? 100;
    const start = (page - 1) * limit;
    const rows = names.slice(start, start + limit).map((name) => ({ name }));
    const total = o?.countTotal ? (opts.totalOverride ?? names.length) : undefined;
    return { rows, total };
  };
  return { exec, calls: () => calls, lastOpts: () => lastOpts };
}

const makeNames = (n: number) =>
  Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(4, '0')}_m.sql`);

describe('fetchAppliedSet — paging (Bug 1: applied set was capped at 100)', () => {
  for (const n of [0, 99, 100, 101, 250, 1000, 1001, 2500]) {
    it(`reads all ${n} applied rows exactly`, async () => {
      const names = makeNames(n);
      const { exec, calls } = mockServer(names);
      const set = await fetchAppliedSet(exec);
      expect(set.size).toBe(n);
      for (const name of names) expect(set.has(name)).toBe(true);
      // One page per 1000 rows, plus the final short page; 0 rows is one call.
      const expectedCalls = n === 0 ? 1 : Math.floor(n / 1000) + 1;
      expect(calls()).toBe(expectedCalls);
    });
  }

  it('requests an exact count only on the first page', async () => {
    const { exec } = mockServer(makeNames(5));
    const seen: boolean[] = [];
    const wrapped: SqlExecutor = async (q, o) => {
      seen.push(o?.countTotal === true);
      return exec(q, o);
    };
    await fetchAppliedSet(wrapped);
    expect(seen[0]).toBe(true);
  });

  it('asks for the maximum page size (1000) each call', async () => {
    const { exec, lastOpts } = mockServer(makeNames(10));
    await fetchAppliedSet(exec);
    expect(lastOpts().limit).toBe(1000);
  });
});

describe('fetchAppliedSet — failure handling (Bug 2: read failure must not look empty)', () => {
  it('propagates a read failure instead of returning an empty set', async () => {
    const { exec } = mockServer(makeNames(50), { failOnCall: 1 });
    await expect(fetchAppliedSet(exec)).rejects.toThrow(/simulated read failure/);
  });

  it('propagates a failure on a later page too', async () => {
    const { exec } = mockServer(makeNames(1500), { failOnCall: 2 });
    await expect(fetchAppliedSet(exec)).rejects.toThrow(/simulated read failure/);
  });

  it('aborts when the server reports more rows than it returned', async () => {
    // 3 rows come back but the count says 5 — do not proceed with a short list.
    const { exec } = mockServer(makeNames(3), { totalOverride: 5 });
    await expect(fetchAppliedSet(exec)).rejects.toThrow(/Read 3 of 5/);
  });

  it('does not over-guard when the count is the server-capped approximation', async () => {
    // total > 10000 is approximate; a short read is not evidence of truncation.
    const { exec } = mockServer(makeNames(1500), { totalOverride: 10001 });
    const set = await fetchAppliedSet(exec);
    expect(set.size).toBe(1500);
  });
});

describe('computePending', () => {
  const local = ['001_a.sql', '002_b.sql', '003_c.sql', '004_d.sql'];

  it('returns files not yet applied, in order', () => {
    const applied = new Set(['001_a.sql', '002_b.sql']);
    expect(computePending(local, applied, Infinity)).toEqual(['003_c.sql', '004_d.sql']);
  });

  it('honours --step', () => {
    const applied = new Set(['001_a.sql']);
    expect(computePending(local, applied, 1)).toEqual(['002_b.sql']);
  });

  it('is empty when everything is applied (nothing re-runs)', () => {
    const applied = new Set(local);
    expect(computePending(local, applied, Infinity)).toEqual([]);
  });
});

describe('buildApplySql / buildRollbackSql (Bug 3: apply + record in one transaction)', () => {
  it('puts the up SQL and the tracking INSERT in one body', () => {
    const sql = buildApplySql('_bf_migrations', '001_init.sql', 'CREATE TABLE x ();');
    expect(sql).toContain('CREATE TABLE x ()');
    expect(sql).toContain(`INSERT INTO "_bf_migrations" (name) VALUES ('001_init.sql')`);
    // One request carries both — they are separated by exactly one ';' boundary
    // so the server runs the body unpaginated in a single transaction.
    expect(sql.split(';\nINSERT INTO').length).toBe(2);
  });

  it('strips a trailing semicolon from the up SQL before joining', () => {
    const sql = buildApplySql('_bf_migrations', 'f.sql', 'CREATE TABLE x ();\n');
    expect(sql).toBe(`CREATE TABLE x ();\nINSERT INTO "_bf_migrations" (name) VALUES ('f.sql')`);
  });

  it('escapes single quotes in the migration name', () => {
    const sql = buildApplySql('_bf_migrations', "o'brien.sql", 'SELECT 1');
    expect(sql).toContain(`VALUES ('o''brien.sql')`);
  });

  it('rollback pairs the down SQL with the tracking DELETE', () => {
    const sql = buildRollbackSql('_bf_migrations', '001_init.sql', 'DROP TABLE x;');
    expect(sql).toContain('DROP TABLE x');
    expect(sql).toContain(`DELETE FROM "_bf_migrations" WHERE name = '001_init.sql'`);
  });
});

describe('serverErrorMessage (Bug 3: show the server body, not the axios string)', () => {
  it('shows the status and the server message', () => {
    const err = { response: { status: 400, data: { message: 'SQL error: duplicate key' } } };
    expect(serverErrorMessage(err)).toBe('400 — SQL error: duplicate key');
  });

  it('falls back to the server error field', () => {
    const err = { response: { status: 500, data: { error: 'internal' } } };
    expect(serverErrorMessage(err)).toBe('500 — internal');
  });

  it('uses the plain message when there is no response (network error)', () => {
    expect(serverErrorMessage({ message: 'Network Error' })).toBe('Network Error');
  });
});
