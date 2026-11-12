// ProjectsService reaches an ESM-only Keycloak client through its own imports,
// which Jest cannot load. Only its identity matters for construction here.
jest.mock('./projects.service', () => ({ ProjectsService: class {} }));

import { BadRequestException } from '@nestjs/common';
import { EXACT_COUNT_THRESHOLD, PublicApiService } from './public-api.service';

/**
 * The REST data API end to end, against a scripted database client: the RPC
 * call that returned 500 for every argument, the count that ran on every read,
 * the batch that broke past 65,535 parameters, and the upsert that did not
 * exist.
 */

type Handler = (sql: string, params: unknown[] | undefined) => { rows: any[]; rowCount?: number } | undefined;

function service(handler: Handler = () => undefined) {
  const realtime = { publishChange: jest.fn() };
  const svc = new PublicApiService({} as any, { get: () => undefined } as any, {} as any, realtime as any);
  clearInterval((svc as any).poolCleanupTimer);

  const client = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      const custom = handler(sql, params);
      if (custom) return { rowCount: custom.rows.length, ...custom };
      if (/information_schema\.columns/.test(sql)) {
        return {
          rows: ['id', 'name', 'price'].map((column_name) => ({ table_name: 'items', column_name })),
        };
      }
      if (/PRIMARY KEY/.test(sql)) return { rows: [{ table_name: 'items', column_name: 'id' }] };
      if (/pg_constraint/.test(sql)) return { rows: [] };
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn(),
  };
  jest.spyOn(svc as any, 'getPool').mockResolvedValue({ connect: async () => client });
  const sqls = () => client.query.mock.calls.map(([sql]) => sql as string);
  return { svc, client, realtime, sqls };
}

const anon = { role: 'anon' as const };

describe('rpc with arguments (#13)', () => {
  it('calls the function with the argument bound, and returns its rows', async () => {
    const { svc, client } = service((sql) => {
      if (/FROM pg_proc/.test(sql)) {
        return { rows: [{ signature: 'qa_e2e_hello(text)', definer: false, argnames: ['name'], argmodes: [], argtypes: ['text'], ndefaults: 0 }] };
      }
      if (/qa_e2e_hello/.test(sql)) return { rows: [{ qa_e2e_hello: 'Hello QA' }] };
      return undefined;
    });

    await expect(svc.rpc('p1', 'qa_e2e_hello', { name: 'QA' }, anon)).resolves.toEqual([{ qa_e2e_hello: 'Hello QA' }]);
    const call = client.query.mock.calls.find(([sql]) => /SELECT \* FROM "qa_e2e_hello"/.test(sql))!;
    expect(call[0]).toBe('SELECT * FROM "qa_e2e_hello"("name" := $1)');
    expect(call[1]).toEqual(['QA']);
  });

  it('answers 400 with the available signature when the arguments do not fit', async () => {
    const { svc } = service((sql) =>
      /FROM pg_proc/.test(sql)
        ? { rows: [{ signature: 'qa_e2e_hello(text)', definer: false, argnames: ['name'], argtypes: ['text'] }] }
        : undefined,
    );
    const err = await svc.rpc('p1', 'qa_e2e_hello', { args: { name: 'QA' } }, anon).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toMatch(/qa_e2e_hello\(text\)/);
  });

  it('refuses a body that is not an object', async () => {
    const { svc } = service();
    await expect(svc.rpc('p1', 'f', [1, 2] as never, anon)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('select count (#186, #132)', () => {
  const dataRows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));

  it('runs no count query when the page itself holds the total', async () => {
    const { svc, sqls } = service((sql) => (/^SELECT .* FROM "items"/.test(sql) ? { rows: dataRows(3) } : undefined));
    const res = await svc.select('p1', 'items', {}, anon);
    expect(res.count).toBe(3);
    expect(res.countMethod).toBe('exact');
    expect(sqls().some((s) => /COUNT\(\*\)|EXPLAIN/.test(s))).toBe(false);
  });

  it('counts a full page exactly up to the threshold, cheaply', async () => {
    const { svc, sqls } = service((sql) => {
      if (/_bf_bounded/.test(sql)) return { rows: [{ total: 1234 }] };
      if (/^SELECT .* FROM "items"/.test(sql)) return { rows: dataRows(1) };
      return undefined;
    });
    const res = await svc.select('p1', 'items', { limit: '1' }, anon);
    expect(res.count).toBe(1234);
    expect(sqls().some((s) => /^SELECT COUNT\(\*\)::int AS total FROM "items"/.test(s))).toBe(false);
  });

  it('falls back to the planner estimate past the threshold', async () => {
    const { svc, sqls } = service((sql) => {
      if (/_bf_bounded/.test(sql)) return { rows: [{ total: EXACT_COUNT_THRESHOLD + 1 }] };
      if (/^EXPLAIN/.test(sql)) return { rows: [{ 'QUERY PLAN': [{ Plan: { 'Plan Rows': 1_000_000 } }] }] };
      if (/^SELECT .* FROM "items"/.test(sql)) return { rows: dataRows(1) };
      return undefined;
    });
    const res = await svc.select('p1', 'items', { limit: '1' }, anon);
    expect(res.count).toBe(1_000_000);
    expect(res.countMethod).toBe('planned');
    expect(sqls()).toContain('SAVEPOINT _bf_count');
  });

  it('counts every row when asked for count=exact', async () => {
    const { svc } = service((sql) => {
      if (/^SELECT COUNT\(\*\)::int AS total FROM "items"/.test(sql)) return { rows: [{ total: 50_000 }] };
      if (/^SELECT .* FROM "items"/.test(sql)) return { rows: dataRows(1) };
      return undefined;
    });
    const res = await svc.select('p1', 'items', { limit: '1' }, anon, { count: 'exact' });
    expect(res.count).toBe(50_000);
  });

  it('skips the count for count=none', async () => {
    const { svc, sqls } = service((sql) => (/^SELECT .* FROM "items"/.test(sql) ? { rows: dataRows(1) } : undefined));
    const res = await svc.select('p1', 'items', { limit: '1', count: 'none' }, anon);
    expect(res.count).toBeNull();
    expect(sqls().some((s) => /COUNT|EXPLAIN/.test(s))).toBe(false);
  });

  it('answers a malformed filter with 400, not 500 (#131)', async () => {
    const { svc } = service();
    await expect(svc.select('p1', 'items', { id: '5' }, anon)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.select('p1', 'items', { order: 'id.sideways' }, anon)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('applies a Range header when the query sets no limit', async () => {
    const { svc, client } = service((sql) => (/^SELECT .* FROM "items"/.test(sql) ? { rows: dataRows(10) } : undefined));
    const res = await svc.select('p1', 'items', {}, anon, { range: '20-29' });
    expect(res.offset).toBe(20);
    const data = client.query.mock.calls.find(([sql]) => /^SELECT .* FROM "items"/.test(sql))!;
    expect(data[1]).toEqual(expect.arrayContaining([10, 20]));
  });
});

describe('insert and upsert (#186, #133)', () => {
  it('runs a large batch as several statements in one transaction', async () => {
    const { svc, sqls } = service((sql, params) =>
      /^INSERT/.test(sql) ? { rows: [], rowCount: (params?.length ?? 0) / 7 } : undefined,
    );
    const rows = Array.from({ length: 10_000 }, (_, i) =>
      Object.fromEntries(Array.from({ length: 7 }, (_, c) => [`c${c}`, i])),
    );
    const res = await svc.insert('p1', 'items', rows, { returnRepresentation: false }, anon);
    expect(res).toEqual({ count: 10_000 });
    const all = sqls();
    expect(all.filter((s) => /^INSERT/.test(s))).toHaveLength(2);
    expect(all[0]).toBe('BEGIN');
    expect(all[all.length - 1]).toBe('COMMIT');
  });

  it('upserts on the primary key when no on_conflict is given', async () => {
    const { svc, client, realtime } = service((sql) =>
      /^INSERT/.test(sql)
        ? { rows: [{ id: 1, name: 'a', __bf_inserted: false }, { id: 2, name: 'b', __bf_inserted: true }] }
        : undefined,
    );
    const res = await svc.insert(
      'p1',
      'items',
      [{ id: 1, name: 'a' }, { id: 2, name: 'b' }],
      { returnRepresentation: true, resolution: 'merge-duplicates' },
      anon,
    );
    const insert = client.query.mock.calls.find(([sql]) => /^INSERT/.test(sql))![0];
    expect(insert).toContain('ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name"');
    expect(res).toEqual([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
    expect(realtime.publishChange.mock.calls.map(([, e]) => e.type)).toEqual(['UPDATE', 'INSERT']);
  });

  it('runs the upsert under the caller role, inside the RLS transaction', async () => {
    const { svc, sqls } = service((sql) => (/^INSERT/.test(sql) ? { rows: [] } : undefined));
    await svc.insert('p1', 'items', { id: 1, name: 'a' }, { returnRepresentation: false, resolution: 'ignore-duplicates', onConflict: 'name' }, anon);
    const all = sqls();
    expect(all[1]).toBe('SET LOCAL ROLE "anon"');
    expect(all.find((s) => /^INSERT/.test(s))).toContain('ON CONFLICT ("name") DO NOTHING');
  });

  it('still accepts the original boolean argument from in-process callers', async () => {
    const { svc } = service((sql) => (/^INSERT/.test(sql) ? { rows: [{ id: 1 }] } : undefined));
    await expect(svc.insert('p1', 'items', { name: 'a' }, true, anon)).resolves.toEqual([{ id: 1 }]);
  });

  it('narrows the returned rows to ?select', async () => {
    const { svc } = service((sql) => (/^INSERT/.test(sql) ? { rows: [{ id: 1, name: 'a', price: 3 }] } : undefined));
    await expect(
      svc.insert('p1', 'items', { name: 'a' }, { returnRepresentation: true, select: 'id,name' }, anon),
    ).resolves.toEqual([{ id: 1, name: 'a' }]);
  });
});

describe('update and delete', () => {
  it('still refuses a write with no filter', async () => {
    const { svc } = service();
    await expect(svc.update('p1', 'items', {}, { name: 'x' }, false, anon)).rejects.toThrow(/at least one filter/);
    await expect(svc.delete('p1', 'items', {}, false, anon)).rejects.toThrow(/at least one filter/);
  });

  it('refuses an array body on PATCH', async () => {
    const { svc } = service();
    await expect(svc.update('p1', 'items', { id: 'eq.1' }, [{ name: 'x' }], false, anon)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
