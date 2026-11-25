import { BadRequestException } from '@nestjs/common';
import { AdvisorsController } from './advisors.controller';
import { AdvisorsService, runRules } from './advisors.service';
import { ADVISOR_RULES, rlsDisabledRule, unindexedForeignKeyRule } from './advisor-rules';

/** A fake pg client: answers each rule's SELECT from a map keyed by a fragment of its SQL. */
function fakeClient(answers: Map<string, any[] | Error>) {
  const calls: string[] = [];
  const client = {
    calls,
    query: jest.fn(async (sql: string) => {
      calls.push(sql);
      for (const [fragment, rows] of answers) {
        if (sql.includes(fragment)) {
          if (rows instanceof Error) throw rows;
          return { rows };
        }
      }
      return { rows: [] };
    }),
  };
  return client;
}

/** The acceptance case: one table with RLS off and an unindexed foreign key. */
const ACCEPTANCE = new Map<string, any[] | Error>([
  [rlsDisabledRule.sql, [{ schema: 'public', table: 'comments', writers: ['anon', 'authenticated'] }]],
  [unindexedForeignKeyRule.sql, [{ schema: 'public', table: 'comments', constraint: 'comments_post_id_fkey', columns: ['post_id'] }]],
]);

describe('runRules', () => {
  it('reports one security and one performance finding for RLS off plus an unindexed FK', async () => {
    const client = fakeClient(ACCEPTANCE);
    const report = await runRules(client as any, ADVISOR_RULES);
    expect(report.findings).toHaveLength(2);
    expect(report.counts).toMatchObject({ total: 2, security: 1, performance: 1, error: 1, warn: 1 });
    expect(report.findings.every((f) => f.fixSql.length > 0)).toBe(true);
    expect(report.skippedRules).toEqual([]);
  });

  it('runs in a read-only transaction with a timeout and always rolls back', async () => {
    const client = fakeClient(ACCEPTANCE);
    await runRules(client as any, ADVISOR_RULES);
    expect(client.calls[0]).toBe('BEGIN READ ONLY');
    expect(client.calls[1]).toMatch(/^SET LOCAL statement_timeout = \d+$/);
    expect(client.calls[client.calls.length - 1]).toBe('ROLLBACK');
    expect(client.calls).not.toContain('COMMIT');
  });

  it('skips a failing rule and keeps the others', async () => {
    const timeout = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const answers = new Map(ACCEPTANCE);
    answers.set(rlsDisabledRule.sql, timeout);
    const client = fakeClient(answers);
    const report = await runRules(client as any, ADVISOR_RULES);
    expect(report.skippedRules).toEqual([{ ruleId: 'rls_disabled', reason: 'timed out' }]);
    expect(report.findings.map((f) => f.ruleId)).toEqual(['unindexed_foreign_key']);
    expect(client.calls).toContain('ROLLBACK TO SAVEPOINT advisor_rule');
  });
});

describe('AdvisorsService', () => {
  function service() {
    const client = fakeClient(ACCEPTANCE);
    const db = { withProjectDb: jest.fn(async (_p: string, _u: string, fn: (c: any) => any) => fn(client)) };
    return { svc: new AdvisorsService(db as any), db };
  }

  it('checks membership through withProjectDb and caches for a minute', async () => {
    const { svc, db } = service();
    await svc.scan('p1', 'u1');
    await svc.scan('p1', 'u1');
    expect(db.withProjectDb).toHaveBeenCalledTimes(1);
    expect(db.withProjectDb).toHaveBeenCalledWith('p1', 'u1', expect.any(Function));
    await svc.scan('p1', 'u2');
    expect(db.withProjectDb).toHaveBeenCalledTimes(2);
    await svc.scan('p1', 'u1', { refresh: true });
    expect(db.withProjectDb).toHaveBeenCalledTimes(3);
  });

  it('filters by category and recounts', async () => {
    const { svc } = service();
    const report = await svc.scan('p1', 'u1', { category: 'performance' });
    expect(report.findings.map((f) => f.category)).toEqual(['performance']);
    expect(report.counts).toMatchObject({ total: 1, performance: 1, security: 0 });
  });
});

describe('AdvisorsController', () => {
  const scan = jest.fn(async () => ({ findings: [] }));
  const ctrl = new AdvisorsController({ scan } as any);
  const user = { sub: 'u1' } as any;

  beforeEach(() => scan.mockClear());

  it('passes the project, user, category and refresh flag', async () => {
    await ctrl.list('p1', user, 'security', 'true');
    expect(scan).toHaveBeenCalledWith('p1', 'u1', { category: 'security', refresh: true });
    await ctrl.list('p1', user);
    expect(scan).toHaveBeenLastCalledWith('p1', 'u1', { category: undefined, refresh: false });
  });

  it('refuses an unknown category', () => {
    expect(() => ctrl.list('p1', user, 'cost')).toThrow(BadRequestException);
    expect(scan).not.toHaveBeenCalled();
  });
});
