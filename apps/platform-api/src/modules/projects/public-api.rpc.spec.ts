// ProjectsService reaches an ESM-only Keycloak client through its own imports,
// which Jest cannot load. Only its identity matters for construction here.
jest.mock('./projects.service', () => ({ ProjectsService: class {} }));

import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { PublicApiService } from './public-api.service';
import { PostgrestHttpError } from './postgrest/errors';

/**
 * Who may call a SECURITY DEFINER function.
 *
 * `rpc` runs under the caller's Postgres role like the rest of the data plane,
 * which is what makes row-level policy apply to it. A function declared
 * SECURITY DEFINER breaks that: it executes as its owner — here the database
 * owner — and the owner is not subject to policy. So such a function is a hole
 * straight through RLS, and `prokind = 'f'` does not notice it, which left it
 * callable with the anon key that ships in every browser bundle.
 */
describe('PublicApiService.rpc — SECURITY DEFINER', () => {
  /**
   * A service whose only live part is rpc: withRls is replaced with a stub
   * client that answers the catalogue lookup with the given function shape.
   */
  function serviceReturning(fn: { definer: boolean; argnames?: string[] } | null) {
    const svc = new PublicApiService({} as any, { get: () => undefined } as any, {} as any, {} as any);
    clearInterval((svc as any).poolCleanupTimer);

    const client = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (/FROM pg_proc/.test(sql)) {
          return fn
            ? { rowCount: 1, rows: [{ signature: 'f()', definer: fn.definer, argnames: fn.argnames ?? [] }] }
            : { rowCount: 0, rows: [] };
        }
        return { rowCount: 1, rows: [{ result: 'ran' }] };
      }),
    };
    jest
      .spyOn(svc as any, 'withRls')
      .mockImplementation((_p: any, _ctx: any, body: any) => body(client));
    return { svc, client };
  }

  const call = (svc: PublicApiService, role: 'anon' | 'authenticated' | 'service_role') =>
    svc.rpc('p1', 'secret_total', {}, { role } as any);

  it('refuses an anonymous caller', async () => {
    const { svc } = serviceReturning({ definer: true });
    await expect(call(svc, 'anon')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('says why, rather than reporting the function as missing', async () => {
    const { svc } = serviceReturning({ definer: true });
    await expect(call(svc, 'anon')).rejects.toThrow(/SECURITY DEFINER/);
  });

  it('never reaches the function body for an anonymous caller', async () => {
    const { svc, client } = serviceReturning({ definer: true });
    await expect(call(svc, 'anon')).rejects.toBeInstanceOf(ForbiddenException);
    const executed = client.query.mock.calls.filter(([sql]: [string]) => !/FROM pg_proc/.test(sql));
    expect(executed).toHaveLength(0);
  });

  it('allows a signed-in end user, whose identity the function can check', async () => {
    const { svc } = serviceReturning({ definer: true });
    await expect(call(svc, 'authenticated')).resolves.toBeDefined();
  });

  it('allows the service key, which is server-side and already bypasses policy', async () => {
    const { svc } = serviceReturning({ definer: true });
    await expect(call(svc, 'service_role')).resolves.toBeDefined();
  });

  it('leaves an ordinary invoker-rights function open to anyone, since policy still binds it', async () => {
    const { svc } = serviceReturning({ definer: false });
    await expect(call(svc, 'anon')).resolves.toBeDefined();
  });

  it('still reports a missing function as missing', async () => {
    const { svc } = serviceReturning(null);
    await expect(call(svc, 'anon')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a function name that is not an identifier before looking anything up', async () => {
    const { svc, client } = serviceReturning({ definer: false });
    await expect(svc.rpc('p1', 'drop; --', {}, { role: 'anon' } as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(client.query).not.toHaveBeenCalled();
  });
});

/**
 * Argument binding.
 *
 * The call used to be rendered as `"k" := 1` — the parameter index without
 * its `$` — so every argument reached Postgres as an integer literal: the
 * value sent was never bound at all, and a text argument was a syntax error.
 */
describe('PublicApiService.rpc — argument binding', () => {
  function serviceWith(rows: Record<string, unknown>[]) {
    const svc = new PublicApiService({} as any, { get: () => undefined } as any, {} as any, {} as any);
    clearInterval((svc as any).poolCleanupTimer);
    const client = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (/FROM pg_proc/.test(sql)) return { rowCount: rows.length, rows };
        return { rowCount: 1, rows: [{ ok: true }] };
      }),
    };
    jest.spyOn(svc as any, 'withRls').mockImplementation((_p: any, _ctx: any, body: any) => body(client));
    return { svc, client };
  }
  const callSql = (client: { query: jest.Mock }) =>
    client.query.mock.calls.find(([sql]: [string]) => !/FROM pg_proc/.test(sql))!;

  it('binds every argument as a $n parameter, by name, in declaration order', async () => {
    const { svc, client } = serviceWith([
      { signature: 'add_to_cart(product_id integer, qty integer)', definer: false, argnames: ['product_id', 'qty'], argmodes: [] },
    ]);
    await svc.rpc('p1', 'add_to_cart', { qty: 2, product_id: 42 }, { role: 'authenticated' } as any);
    const [sql, params] = callSql(client);
    expect(sql).toBe('SELECT * FROM "add_to_cart"("product_id" := $1, "qty" := $2)');
    expect(params).toEqual([42, 2]);
  });

  it('keeps ignoring keys the function does not name for an SDK caller, and still returns rows', async () => {
    const { svc, client } = serviceWith([
      { signature: 'greet(name text)', definer: false, argnames: ['name'], argmodes: [] },
    ]);
    await expect(svc.rpc('p1', 'greet', { name: 'x', extra: 1 }, { role: 'anon' } as any)).resolves.toEqual([{ ok: true }]);
    const [sql, params] = callSql(client);
    expect(sql).toBe('SELECT * FROM "greet"("name" := $1)');
    expect(params).toEqual(['x']);
  });

  it('chooses the overload the argument names address', async () => {
    const { svc, client } = serviceWith([
      { signature: 'f(a integer)', definer: false, argnames: ['a'], argmodes: [] },
      { signature: 'f(a integer, b text)', definer: false, argnames: ['a', 'b'], argmodes: [] },
    ]);
    await svc.rpc('p1', 'f', { a: 1, b: 'x' }, { role: 'anon' } as any);
    expect(callSql(client)[0]).toBe('SELECT * FROM "f"("a" := $1, "b" := $2)');
  });
});

/** The compat path: PostgREST's not-found code and result shaping. */
describe('PublicApiService.rpc — PostgREST caller', () => {
  function serviceWith(meta: Record<string, unknown>[], result: Record<string, unknown>[]) {
    const svc = new PublicApiService({} as any, { get: () => undefined } as any, {} as any, {} as any);
    clearInterval((svc as any).poolCleanupTimer);
    const client = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (/FROM pg_proc/.test(sql)) return { rowCount: meta.length, rows: meta };
        return { rowCount: result.length, rows: result };
      }),
    };
    jest.spyOn(svc as any, 'withRls').mockImplementation((_p: any, _ctx: any, body: any) => body(client));
    return { svc, client };
  }
  const compat = { compat: true as const, prefer: { raw: new Map() } };
  const sqlOf = (client: { query: jest.Mock }) =>
    client.query.mock.calls.find(([sql]: [string]) => !/FROM pg_proc/.test(sql))![0];

  it('reports a missing function as 404 PGRST202 naming the arguments', async () => {
    const { svc } = serviceWith([], []);
    const err = await svc.rpc('p1', 'nope', { a: 1 }, { role: 'anon' } as any, compat).catch((e) => e);
    expect(err).toBeInstanceOf(PostgrestHttpError);
    expect(err.getStatus()).toBe(404);
    expect(err.body.code).toBe('PGRST202');
    expect(err.body.message).toBe('Could not find the function public.nope(a) in the schema cache');
  });

  it('refuses an unknown argument the way PostgREST does, rather than ignoring it', async () => {
    const { svc } = serviceWith([{ signature: 'f(a integer)', definer: false, argnames: ['a'], argmodes: [] }], []);
    const err = await svc.rpc('p1', 'f', { a: 1, b: 2 }, { role: 'anon' } as any, compat).catch((e) => e);
    expect(err.body?.code).toBe('PGRST202');
  });

  it('returns a scalar bare, selected as a value rather than a row', async () => {
    const { svc, client } = serviceWith(
      [{ signature: 'total()', definer: false, argnames: [], argmodes: [], typtype: 'b', typname: 'int4', typrelid: 0 }],
      [{ v: 7 }],
    );
    await expect(svc.rpc('p1', 'total', {}, { role: 'anon' } as any, compat)).resolves.toEqual({ kind: 'scalar', value: 7, rows: 1 });
    expect(sqlOf(client)).toBe('SELECT "total"() AS v');
  });

  it('returns a SETOF composite as an array of objects and a SETOF scalar as bare values', async () => {
    const rows = serviceWith(
      [{ signature: 'list()', definer: false, argnames: [], argmodes: [], proretset: true, typtype: 'c', typname: 'posts', typrelid: 99 }],
      [{ id: 1 }, { id: 2 }],
    );
    await expect(rows.svc.rpc('p1', 'list', {}, { role: 'anon' } as any, compat)).resolves.toEqual({ kind: 'array', value: [{ id: 1 }, { id: 2 }], rows: 2 });
    const scalars = serviceWith(
      [{ signature: 'ids()', definer: false, argnames: [], argmodes: [], proretset: true, typtype: 'b', typname: 'int4', typrelid: 0 }],
      [{ _r: 1 }, { _r: 2 }],
    );
    await expect(scalars.svc.rpc('p1', 'ids', {}, { role: 'anon' } as any, compat)).resolves.toEqual({ kind: 'array', value: [1, 2], rows: 2 });
  });

  it('returns nothing for void', async () => {
    const { svc } = serviceWith([{ signature: 'ping()', definer: false, argnames: [], argmodes: [], typtype: 'p', typname: 'void' }], []);
    await expect(svc.rpc('p1', 'ping', {}, { role: 'anon' } as any, compat)).resolves.toEqual({ kind: 'void', value: null, rows: 0 });
  });

  it('passes the whole body to a single JSON parameter under Prefer: params=single-object', async () => {
    const { svc, client } = serviceWith(
      [{ signature: 'ingest(payload jsonb)', definer: false, argnames: ['payload'], argmodes: [], argtypes: ['jsonb'], typtype: 'p', typname: 'void' }],
      [],
    );
    await svc.rpc('p1', 'ingest', { a: 1, b: [2] }, { role: 'anon' } as any, { compat: true, prefer: { params: 'single-object', raw: new Map() } });
    const [sql, params] = client.query.mock.calls.find(([s]: [string]) => !/FROM pg_proc/.test(s))!;
    expect(sql).toBe('SELECT "ingest"($1::jsonb)');
    expect(params).toEqual(['{"a":1,"b":[2]}']);
  });

  it('emits the definer refusal as 403 with code 42501', async () => {
    const { svc } = serviceWith([{ signature: 'secret()', definer: true, argnames: [], argmodes: [] }], []);
    const err = await svc.rpc('p1', 'secret', {}, { role: 'anon' } as any, compat).catch((e) => e);
    expect(err.getStatus()).toBe(403);
    expect(err.body.code).toBe('42501');
  });
});
