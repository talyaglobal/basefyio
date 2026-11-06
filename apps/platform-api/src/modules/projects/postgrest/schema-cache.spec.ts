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
    const client: any = {
      query: jest.fn(async (q: string) => {
        sql.push(q);
        return { rows: [] };
      }),
    };
    await new SchemaCache().get('p1', client, true);
    const fkSql = sql.find((q) => /pg_constraint/.test(q))!;
    expect(fkSql).toMatch(/join pg_namespace fns on fns\.oid = fcl\.relnamespace/);
    expect(fkSql).toMatch(/fns\.nspname = 'public'/);
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
