// The policy filter opens its own small pool per project; the pool is a fake
// that answers the catalogue lookup and the visibility select.
const pg = { pool: null as any };
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => pg.pool),
}));

import { Logger } from '@nestjs/common';
import { RealtimePolicyService, policyGroupOf } from './realtime-policy.service';
import type { DataChangeEvent, PolicySubscriber } from './realtime-data.types';

/**
 * Row-level security reaches the stream.
 *
 * A table without RLS is delivered to every subscriber, as it always was. A
 * table with RLS is re-selected under each subscriber group's role and claims,
 * and delivered only where the row comes back. The filter never widens.
 */
interface FakeDb {
  meta: { rls: boolean; pk: string[] } | null | Error;
  /** Decide visibility from the claims JSON the check set and the pk values asked for. */
  visible: (claimsJson: string, role: string, pkValues: unknown[][]) => unknown[][];
  roleError?: Error;
}

function fakePool(db: FakeDb) {
  const state = { claims: '{}', role: '' };
  const client = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      if (/SET LOCAL ROLE/.test(sql)) {
        if (db.roleError) throw db.roleError;
        state.role = sql.match(/"(\w+)"/)![1];
        return { rows: [] };
      }
      if (/request\.jwt\.claims/.test(sql)) {
        state.claims = params![0] as string;
        return { rows: [] };
      }
      if (/^SELECT .* FROM "/.test(sql)) {
        const placeholders = (sql.match(/\$\d+/g) ?? []).length;
        const pkCount = (sql.match(/ AS c\d+/g) ?? []).length;
        const tuples: unknown[][] = [];
        for (let i = 0; i < placeholders; i += pkCount) tuples.push(params!.slice(i, i + pkCount));
        const vis = db.visible(state.claims, state.role, tuples);
        return { rows: vis.map((t) => Object.fromEntries(t.map((v, i) => [`c${i}`, String(v)]))) };
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  const pool = {
    query: jest.fn(async (_sql: string, _params?: unknown[]) => {
      if (db.meta instanceof Error) throw db.meta;
      return { rows: db.meta ? [db.meta] : [] };
    }),
    connect: jest.fn(async () => client),
    on: jest.fn(),
    end: jest.fn().mockResolvedValue(undefined),
  };
  return { pool, client };
}

const prisma = {
  project: {
    findFirst: jest.fn().mockResolvedValue({ dbHost: 'h', dbPort: 5432, dbUser: 'u', dbPassword: 'p', dbName: 'd' }),
  },
} as any;

const built: RealtimePolicyService[] = [];

function build(db: FakeDb, env: Record<string, string> = {}) {
  const fake = fakePool(db);
  pg.pool = fake.pool;
  const svc = new RealtimePolicyService(prisma, { get: (k: string) => env[k] } as any);
  built.push(svc);
  return { svc, ...fake };
}

afterEach(() => {
  for (const svc of built.splice(0)) svc.onModuleDestroy();
});

const insert = (over: Partial<DataChangeEvent> = {}): DataChangeEvent => ({
  eventId: 'e1',
  type: 'INSERT',
  kind: 'table',
  entity: 'orders',
  new: { id: 7, owner: 'u1', total: 10 },
  old: null,
  commitTimestamp: 't',
  ...over,
});

const sub = (id: string, role: PolicySubscriber['role'], claims?: Record<string, unknown>): PolicySubscriber => ({
  id,
  role,
  jwtClaims: claims,
  policyGroup: policyGroupOf(role, claims),
});

const ids = (subs: PolicySubscriber[]) => subs.map((s) => s.id).sort();

describe('policyGroupOf', () => {
  it('ignores per-token noise so two tabs of one user share a group', () => {
    const a = policyGroupOf('authenticated', { sub: 'u1', exp: 1, iat: 2, jti: 'x', sid: 's1' });
    const b = policyGroupOf('authenticated', { sub: 'u1', exp: 9, iat: 8, jti: 'y', sid: 's2' });
    expect(a).toBe(b);
  });
  it('separates users, roles and the service key', () => {
    expect(policyGroupOf('authenticated', { sub: 'u1' })).not.toBe(policyGroupOf('authenticated', { sub: 'u2' }));
    expect(policyGroupOf('anon')).not.toBe(policyGroupOf('authenticated', {}));
    expect(policyGroupOf('service_role', { sub: 'x' })).toBe('service');
  });
});

describe('RealtimePolicyService.filterByPolicy', () => {
  afterEach(() => jest.restoreAllMocks());

  it('a table without RLS is delivered to everyone after one catalogue read and no role switch', async () => {
    const { svc, pool, client } = build({ meta: { rls: false, pk: ['id'] }, visible: () => [] }, { REALTIME_RLS_FILTER: 'all' });
    const subs = [sub('a', 'anon'), sub('u', 'authenticated', { sub: 'u1' }), sub('s', 'service_role')];
    const event = insert();
    const r = await svc.filterByPolicy('p1', event, subs);
    expect(ids(r.deliverTo)).toEqual(['a', 's', 'u']);
    expect(r.event).toBe(event);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][1]).toEqual(['public', 'orders']);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('caches the catalogue facts for the TTL and refetches after it', async () => {
    const { svc, pool } = build({ meta: { rls: false, pk: ['id'] }, visible: () => [] }, { REALTIME_RLS_FILTER: 'all' });
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    await svc.filterByPolicy('p1', insert(), [sub('a', 'anon')]);
    await svc.filterByPolicy('p1', insert(), [sub('a', 'anon')]);
    expect(pool.query).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_000 + 60_001);
    await svc.filterByPolicy('p1', insert(), [sub('a', 'anon')]);
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('on an RLS table, re-selects once per (role, claims) group and delivers only where the row is visible', async () => {
    const { svc, client } = build(
      {
        meta: { rls: true, pk: ['id'] },
        visible: (claims, role, tuples) => (role === 'authenticated' && claims.includes('"u1"') ? tuples : []),
      },
      { REALTIME_RLS_FILTER: 'all' },
    );
    const subs = [
      sub('anon', 'anon'),
      sub('u1a', 'authenticated', { sub: 'u1', exp: 1 }),
      sub('u1b', 'authenticated', { sub: 'u1', exp: 2 }),
      sub('u2', 'authenticated', { sub: 'u2' }),
      sub('svc', 'service_role'),
    ];
    const r = await svc.filterByPolicy('p1', insert(), subs);
    expect(ids(r.deliverTo)).toEqual(['svc', 'u1a', 'u1b']);
    const roleSwitches = client.query.mock.calls.filter(([sql]) => /SET LOCAL ROLE/.test(sql)).map(([sql]) => sql);
    expect(roleSwitches.sort()).toEqual([
      'SET LOCAL ROLE "anon"',
      'SET LOCAL ROLE "authenticated"',
      'SET LOCAL ROLE "authenticated"',
    ]);
    const claimsSet = client.query.mock.calls.filter(([sql]) => /request\.jwt\.claims/.test(sql)).map(([, p]) => p![0]);
    expect(claimsSet).toEqual(expect.arrayContaining(['{}', JSON.stringify({ sub: 'u1', exp: 1 }), JSON.stringify({ sub: 'u2' })]));
    // every check is rolled back, never committed
    expect(client.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
    expect(client.query.mock.calls.filter(([sql]) => sql === 'ROLLBACK')).toHaveLength(3);
  });

  it('by default (jwt mode) anon subscribers are not checked; signed-in ones are', async () => {
    const { svc, client } = build({ meta: { rls: true, pk: ['id'] }, visible: () => [] });
    expect(svc.getMode()).toBe('jwt');
    const r = await svc.filterByPolicy('p1', insert(), [sub('a', 'anon'), sub('u', 'authenticated', { sub: 'u1' })]);
    expect(ids(r.deliverTo)).toEqual(['a']);
    const roles = client.query.mock.calls.filter(([sql]) => /SET LOCAL ROLE/.test(sql));
    expect(roles).toHaveLength(1);
    expect(roles[0][0]).toBe('SET LOCAL ROLE "authenticated"');
  });

  it('in jwt mode with only anon subscribers nothing is read from the project database at all', async () => {
    const { svc, pool } = build({ meta: { rls: true, pk: ['id'] }, visible: () => [] });
    const r = await svc.filterByPolicy('p1', insert(), [sub('a', 'anon'), sub('b', 'anon')]);
    expect(ids(r.deliverTo)).toEqual(['a', 'b']);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('REALTIME_RLS_FILTER=off checks nobody', async () => {
    const { svc, pool } = build({ meta: { rls: true, pk: ['id'] }, visible: () => [] }, { REALTIME_RLS_FILTER: 'off' });
    const r = await svc.filterByPolicy('p1', insert(), [sub('u', 'authenticated', { sub: 'u1' })]);
    expect(ids(r.deliverTo)).toEqual(['u']);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('a failing role switch withholds the event from that group only, and says what to run', async () => {
    const roleError: any = new Error('permission denied to set role');
    roleError.code = '42501';
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { svc } = build({ meta: { rls: true, pk: ['id'] }, visible: () => [], roleError }, { REALTIME_RLS_FILTER: 'all' });
    const r = await svc.filterByPolicy('p1', insert(), [sub('u', 'authenticated', { sub: 'u1' }), sub('s', 'service_role')]);
    expect(ids(r.deliverTo)).toEqual(['s']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ensure-rls-bootstrap'));
  });

  it('an RLS table without a primary key reaches service subscribers only, with one warning', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { svc, client } = build({ meta: { rls: true, pk: [] }, visible: () => [] }, { REALTIME_RLS_FILTER: 'all' });
    const subs = [sub('a', 'anon'), sub('s', 'service_role')];
    const r1 = await svc.filterByPolicy('p1', insert(), subs);
    const r2 = await svc.filterByPolicy('p1', insert(), subs);
    expect(ids(r1.deliverTo)).toEqual(['s']);
    expect(ids(r2.deliverTo)).toEqual(['s']);
    expect(client.query).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/no primary key/);
  });

  it('a DELETE on an RLS table carries only the primary key and reaches everyone; without RLS it is untouched', async () => {
    const del = insert({ type: 'DELETE', new: null, old: { id: 7, owner: 'u1', total: 10 } });
    const rls = build({ meta: { rls: true, pk: ['id'] }, visible: () => [] }, { REALTIME_RLS_FILTER: 'all' });
    const r = await rls.svc.filterByPolicy('p1', del, [sub('a', 'anon'), sub('u', 'authenticated', { sub: 'u2' })]);
    expect(ids(r.deliverTo)).toEqual(['a', 'u']);
    expect(r.event.old).toEqual({ id: 7 });
    expect(rls.client.query).not.toHaveBeenCalled();

    const plain = build({ meta: { rls: false, pk: ['id'] }, visible: () => [] }, { REALTIME_RLS_FILTER: 'all' });
    const r2 = await plain.svc.filterByPolicy('p1', del, [sub('a', 'anon')]);
    expect(r2.event.old).toEqual({ id: 7, owner: 'u1', total: 10 });
  });

  it('looks a collection up in the nosql schema', async () => {
    const { svc, pool } = build({ meta: { rls: false, pk: ['id'] }, visible: () => [] }, { REALTIME_RLS_FILTER: 'all' });
    await svc.filterByPolicy('p1', insert({ kind: 'collection', entity: 'posts' }), [sub('a', 'anon')]);
    expect(pool.query.mock.calls[0][1]).toEqual(['nosql', 'posts']);
  });

  it('batches concurrent checks of one group into a single select and resolves each event on its own', async () => {
    const { svc, client } = build(
      { meta: { rls: true, pk: ['id'] }, visible: (_c, _r, tuples) => tuples.filter((t) => Number(t[0]) % 2 === 1) },
      { REALTIME_RLS_FILTER: 'all' },
    );
    const subs = [sub('u', 'authenticated', { sub: 'u1' })];
    const results = await Promise.all([1, 2, 3].map((id) => svc.filterByPolicy('p1', insert({ eventId: `e${id}`, new: { id } }), subs)));
    expect(results.map((r) => r.deliverTo.length)).toEqual([1, 0, 1]);
    const selects = client.query.mock.calls.filter(([sql]) => /^SELECT .* FROM "public"\."orders"/.test(sql));
    expect(selects).toHaveLength(1);
    expect(selects[0][0]).toContain('IN ($1, $2, $3)');
    expect(selects[0][1]).toEqual([1, 2, 3]);
    expect(client.query.mock.calls.filter(([sql]) => /SET LOCAL ROLE/.test(sql))).toHaveLength(1);
  });

  it('a composite primary key is matched as a row value', async () => {
    const { svc, client } = build(
      { meta: { rls: true, pk: ['tenant', 'id'] }, visible: (_c, _r, tuples) => tuples },
      { REALTIME_RLS_FILTER: 'all' },
    );
    const r = await svc.filterByPolicy('p1', insert({ new: { tenant: 't1', id: 5 } }), [sub('u', 'authenticated', { sub: 'u1' })]);
    expect(r.deliverTo).toHaveLength(1);
    const select = client.query.mock.calls.find(([sql]) => /^SELECT .* FROM "public"/.test(sql))!;
    expect(select[0]).toContain('WHERE ("tenant", "id") IN (($1, $2))');
    expect(select[1]).toEqual(['t1', 5]);
  });

  it('when the catalogue cannot be read and nothing is cached, only unchecked subscribers receive the event', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { svc } = build({ meta: new Error('connection refused'), visible: () => [] }, { REALTIME_RLS_FILTER: 'all' });
    const r = await svc.filterByPolicy('p1', insert(), [sub('a', 'anon'), sub('s', 'service_role')]);
    expect(ids(r.deliverTo)).toEqual(['s']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not read catalogue facts'));
  });

  it('a stale cached answer is used when a refresh fails', async () => {
    const db: FakeDb = { meta: { rls: false, pk: ['id'] }, visible: () => [] };
    const { svc } = build(db, { REALTIME_RLS_FILTER: 'all' });
    const now = jest.spyOn(Date, 'now').mockReturnValue(5_000);
    await svc.filterByPolicy('p1', insert(), [sub('a', 'anon')]);
    db.meta = new Error('timeout');
    now.mockReturnValue(5_000 + 120_000);
    const r = await svc.filterByPolicy('p1', insert(), [sub('a', 'anon')]);
    expect(ids(r.deliverTo)).toEqual(['a']);
  });
});
