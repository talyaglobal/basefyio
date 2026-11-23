jest.mock('./projects.service', () => ({ ProjectsService: class {} }));
jest.mock('../realtime-data/realtime-data.service', () => ({ RealtimeDataService: class {} }));

import { BadRequestException } from '@nestjs/common';
import { MAX_BIND_PARAMS, PublicApiService, tooManyValues } from './public-api.service';
import { fixtureSchema } from './postgrest/test-fixtures';

/** #186: bulk inserts past Postgres's 65,535 bound values, and Prefer: count=none. */
function harness() {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      if (/COUNT\(\*\)::int AS total/.test(sql)) return { rows: [{ total: 7 }], rowCount: 1 };
      const n = (sql.match(/\),\s*\(/g)?.length ?? 0) + 1;
      return { rows: /^INSERT/.test(sql) ? Array.from({ length: n }, () => ({})) : [], rowCount: n };
    }),
  };
  const svc = new PublicApiService({} as any, { get: () => undefined } as any, {} as any, { publishChange: jest.fn() } as any);
  clearInterval((svc as any).poolCleanupTimer);
  (svc as any).withRls = (_p: string, _c: unknown, fn: (c: unknown) => unknown) => fn(client);
  (svc as any).withSchemaRetry = (_p: string, run: (force: boolean) => unknown) => run(false);
  const fx = fixtureSchema();
  (svc as any).schemaCache = Object.assign(fx.cache, { get: async () => fx.schema });
  (svc as any).publishChange = jest.fn();
  return { svc, statements };
}

const ctx = { role: 'authenticated', schema: 'public' } as any;
const rowsOf = (n: number, cols: number) =>
  Array.from({ length: n }, (_, i) => Object.fromEntries(Array.from({ length: cols }, (_, c) => [`c${c}`, i])));

describe('PublicApiService.insert past the bind-parameter ceiling (#186)', () => {
  it('splits 10,000 rows x 7 columns into statements under 65,535 values, all in one call', async () => {
    const { svc, statements } = harness();
    const r: any = await svc.insert('p1', 'notes', rowsOf(10_000, 7), false, ctx);
    const inserts = statements.filter((s) => /^INSERT/.test(s.sql));
    expect(inserts.length).toBe(2);
    for (const s of inserts) expect(s.params.length).toBeLessThanOrEqual(MAX_BIND_PARAMS);
    expect(inserts.reduce((n, s) => n + s.params.length, 0)).toBe(70_000);
    expect(r.count).toBe(10_000);
  });

  it('keeps one statement when it fits', async () => {
    const { svc, statements } = harness();
    await svc.insert('p1', 'notes', rowsOf(9_300, 7), false, ctx);
    expect(statements.filter((s) => /^INSERT/.test(s.sql)).length).toBe(1);
  });

  it('names the batch that fits when it cannot split', () => {
    const e = tooManyValues(10_000, 7) as BadRequestException;
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.message).toContain('70,000 values');
    expect(e.message).toContain('at most 9,362 rows');
  });
});

describe('PublicApiService.select with Prefer: count=none (#186)', () => {
  it('skips the count query and answers count: null', async () => {
    const { svc, statements } = harness();
    const r = await svc.select('p1', 'posts', {}, ctx, true);
    expect(r.count).toBeNull();
    expect(statements.some((s) => /COUNT\(\*\)/.test(s.sql))).toBe(false);
  });

  it('still counts by default', async () => {
    const { svc, statements } = harness();
    const r = await svc.select('p1', 'posts', {}, ctx);
    expect(r.count).toBe(7);
    expect(statements.some((s) => /COUNT\(\*\)/.test(s.sql))).toBe(true);
  });
});
