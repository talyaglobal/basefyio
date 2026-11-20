import { ForeignKey, ProjectSchema, SchemaCache } from './schema-cache';

const fk = (constraint: string, table: string, column: string, foreignTable: string): ForeignKey => ({
  constraint,
  table,
  columns: [column],
  foreignTable,
  foreignColumns: ['id'],
});

const schemaOf = (foreignKeys: ForeignKey[]): ProjectSchema => ({ tables: new Map(), foreignKeys, loadedAt: Date.now() });

describe('SchemaCache foreign keys', () => {
  it('reads only keys between public tables (a key into auth.users is not one into public.users)', async () => {
    const sql: string[] = [];
    const args: unknown[][] = [];
    const client: any = {
      query: jest.fn(async (q: string, p: unknown[] = []) => {
        sql.push(q);
        args.push(p);
        return { rows: [] };
      }),
    };
    const loaded = await new SchemaCache().get('p1', client, true);
    const i = sql.findIndex((q) => /pg_constraint/.test(q));
    expect(sql[i]).toMatch(/join pg_namespace fns on fns\.oid = fcl\.relnamespace/);
    expect(sql[i]).toMatch(/ns\.nspname = \$1 and fns\.nspname = \$1/);
    // Every catalogue read is bound to `public` unless a profile chose another schema.
    expect(args.every((p) => p.length === 1 && p[0] === 'public')).toBe(true);
    expect(loaded.schema).toBeUndefined();
  });

  it('reads an exposed schema on its own and caches it apart from public (#264)', async () => {
    const args: unknown[][] = [];
    const client: any = {
      query: jest.fn(async (_q: string, p: unknown[] = []) => {
        args.push(p);
        return { rows: [] };
      }),
    };
    const cache = new SchemaCache();
    const pub = await cache.get('p1', client);
    const r6s = await cache.get('p1', client, false, 'r6s');
    expect(r6s.schema).toBe('r6s');
    expect(pub).not.toBe(r6s);
    expect(args.filter((p) => p[0] === 'r6s')).toHaveLength(3);
    // Cached: a second read of either schema runs no query.
    const n = client.query.mock.calls.length;
    await cache.get('p1', client, false, 'r6s');
    await cache.get('p1', client);
    expect(client.query.mock.calls.length).toBe(n);
    // invalidate() drops every schema of the project.
    cache.invalidate('p1');
    await cache.get('p1', client, false, 'r6s');
    expect(client.query.mock.calls.length).toBe(n + 3);
  });

  it('embeds a child that has one key to public.users once the auth.users keys are not counted', () => {
    // applications.user_id → public.users; assigned_auditor_id etc. → auth.users (dropped by the query).
    const cache = new SchemaCache();
    const rel = cache.resolveRelationship(schemaOf([fk('applications_user_id_fkey', 'applications', 'user_id', 'users')]), 'users', 'applications');
    expect(rel).toEqual({ cardinality: 'toMany', local: ['id'], foreign: ['user_id'] });
  });

  it('still picks one of two keys to the same table by hint', () => {
    const cache = new SchemaCache();
    const schema = schemaOf([
      fk('conversations_user1_id_fkey', 'conversations', 'user1_id', 'users'),
      fk('conversations_user2_id_fkey', 'conversations', 'user2_id', 'users'),
    ]);
    expect(cache.resolveRelationship(schema, 'conversations', 'users', 'conversations_user1_id_fkey')).toEqual({
      cardinality: 'toOne',
      local: ['user1_id'],
      foreign: ['id'],
    });
  });
});
