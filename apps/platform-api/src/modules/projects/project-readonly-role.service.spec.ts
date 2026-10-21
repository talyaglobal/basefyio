/**
 * The mocked driver records every statement together with the database the
 * pool was opened on, so the tests can assert both what was run and where.
 */
const calls: { database: string; sql: string; params?: unknown[] }[] = [];
let answer: (database: string, sql: string, params?: unknown[]) => Promise<any> = async () => ({ rows: [], rowCount: 0 });
const poolEnd = jest.fn();
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation((opts: { database: string }) => ({
    connect: async () => ({
      query: (sql: string, params?: unknown[]) => {
        calls.push({ database: opts.database, sql, params });
        return answer(opts.database, sql, params);
      },
      release: jest.fn(),
    }),
    end: poolEnd,
  })),
}));

import { BadRequestException } from '@nestjs/common';
import {
  ProjectReadonlyRoleService,
  readonlyRoleNameFor,
} from './project-readonly-role.service';

const target = { host: 'postgres', port: 5432, user: 'admin', password: 'pw' };
const svc = () => new ProjectReadonlyRoleService();
const sqlOn = (database: string) => calls.filter((c) => c.database === database).map((c) => c.sql);

beforeEach(() => {
  calls.length = 0;
  poolEnd.mockReset().mockResolvedValue(undefined);
  answer = async (_db, sql) => {
    if (/FROM pg_roles/.test(sql)) return { rows: [], rowCount: 0 };
    if (/FROM pg_namespace/.test(sql)) return { rows: [{ nspname: 'public' }], rowCount: 1 };
    if (/FROM pg_database/.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
});

describe('readonlyRoleNameFor', () => {
  it('appends _readonly to the owner role', () => {
    expect(readonlyRoleNameFor('kb_user_0123456789abcdef')).toBe('kb_user_0123456789abcdef_readonly');
  });

  it('stays within 63 characters for a long legacy owner name', () => {
    const name = readonlyRoleNameFor('kb_user_' + 'x'.repeat(60));
    expect(name).toHaveLength(63);
    expect(name.endsWith('_readonly')).toBe(true);
  });

  it('strips characters Postgres identifiers cannot carry unquoted', () => {
    expect(readonlyRoleNameFor('Kb-User.1')).toBe('kbuser1_readonly');
    expect(() => readonlyRoleNameFor('---')).toThrow(BadRequestException);
  });
});

describe('provision', () => {
  const p = { ...target, dbName: 'kb_p1', ownerUser: 'kb_user_p1', readonlyRole: 'kb_user_p1_readonly', password: 'pw' };

  it('creates a login role with no write-capable attribute, read-only transactions and CONNECT', async () => {
    await svc().provision(p);
    const admin = sqlOn('postgres');
    expect(admin[0]).toMatch(/SELECT 1 FROM pg_roles/);
    expect(admin[1]).toBe(
      `CREATE ROLE "kb_user_p1_readonly" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS PASSWORD 'pw'`,
    );
    expect(admin[2]).toBe('ALTER ROLE "kb_user_p1_readonly" SET default_transaction_read_only = on');
    expect(admin[3]).toBe('GRANT CONNECT ON DATABASE "kb_p1" TO "kb_user_p1_readonly"');
  });

  it('resets an existing role instead of creating it again', async () => {
    answer = async (_db, sql) => {
      if (/FROM pg_roles/.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      if (/FROM pg_namespace/.test(sql)) return { rows: [{ nspname: 'public' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    await svc().provision(p);
    const admin = sqlOn('postgres');
    expect(admin.some((s) => s.startsWith('CREATE ROLE'))).toBe(false);
    expect(admin[1]).toMatch(/^ALTER ROLE "kb_user_p1_readonly" WITH LOGIN NOSUPERUSER .* PASSWORD 'pw'$/);
  });

  it('doubles single quotes in the password', async () => {
    await svc().provision({ ...p, password: "it's" });
    expect(sqlOn('postgres')[1]).toContain(`PASSWORD 'it''s'`);
  });

  it('grants SELECT in every non-system schema with default privileges tied to the owner', async () => {
    answer = async (_db, sql) => {
      if (/FROM pg_roles/.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM pg_namespace/.test(sql)) return { rows: [{ nspname: 'public' }, { nspname: 'auth' }], rowCount: 2 };
      return { rows: [], rowCount: 0 };
    };
    const { warnings } = await svc().provision(p);
    const inDb = sqlOn('kb_p1');
    expect(inDb[0]).toMatch(/FROM pg_namespace[\s\S]*NOT IN \('pg_catalog', 'information_schema'\)[\s\S]*NOT LIKE 'pg\\_%'/);
    expect(inDb.slice(1)).toEqual([
      'GRANT USAGE ON SCHEMA "public" TO "kb_user_p1_readonly"',
      'GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO "kb_user_p1_readonly"',
      'GRANT SELECT ON ALL SEQUENCES IN SCHEMA "public" TO "kb_user_p1_readonly"',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "kb_user_p1" IN SCHEMA "public" GRANT SELECT ON TABLES TO "kb_user_p1_readonly"',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "kb_user_p1" IN SCHEMA "public" GRANT SELECT ON SEQUENCES TO "kb_user_p1_readonly"',
      'GRANT USAGE ON SCHEMA "auth" TO "kb_user_p1_readonly"',
      'GRANT SELECT ON ALL TABLES IN SCHEMA "auth" TO "kb_user_p1_readonly"',
      'GRANT SELECT ON ALL SEQUENCES IN SCHEMA "auth" TO "kb_user_p1_readonly"',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "kb_user_p1" IN SCHEMA "auth" GRANT SELECT ON TABLES TO "kb_user_p1_readonly"',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "kb_user_p1" IN SCHEMA "auth" GRANT SELECT ON SEQUENCES TO "kb_user_p1_readonly"',
    ]);
    expect(warnings).toEqual([]);
  });

  it('keeps going when one grant fails and reports it as a warning', async () => {
    answer = async (_db, sql) => {
      if (/FROM pg_roles/.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM pg_namespace/.test(sql)) return { rows: [{ nspname: 'public' }], rowCount: 1 };
      if (/ON ALL SEQUENCES/.test(sql)) throw new Error('no sequences for you');
      return { rows: [], rowCount: 0 };
    };
    const { warnings } = await svc().provision(p);
    expect(warnings).toEqual(['public: no sequences for you']);
    expect(sqlOn('kb_p1').filter((s) => s.startsWith('ALTER DEFAULT PRIVILEGES'))).toHaveLength(2);
  });

  it('refuses unsafe identifiers before touching the database', async () => {
    await expect(svc().provision({ ...p, ownerUser: 'kb_user"; DROP ROLE x; --' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc().provision({ ...p, dbName: 'Kb_P1' })).rejects.toBeInstanceOf(BadRequestException);
    expect(calls).toHaveLength(0);
  });

  it('closes every pool it opened', async () => {
    await svc().provision(p);
    expect(poolEnd).toHaveBeenCalledTimes(2);
  });
});

describe('setPassword', () => {
  it('alters only the password', async () => {
    await svc().setPassword({ ...target, readonlyRole: 'kb_user_p1_readonly', password: 'n3w' });
    expect(sqlOn('postgres')).toEqual([`ALTER ROLE "kb_user_p1_readonly" WITH PASSWORD 'n3w'`]);
  });
});

describe('drop', () => {
  it('revokes inside a still-existing database before dropping the role', async () => {
    const { warnings } = await svc().drop({ ...target, readonlyRole: 'kb_user_p1_readonly', dbName: 'kb_p1' });
    expect(sqlOn('kb_p1')).toEqual(['DROP OWNED BY "kb_user_p1_readonly"']);
    const admin = sqlOn('postgres');
    expect(admin[0]).toMatch(/FROM pg_database/);
    expect(admin[1]).toBe('DROP ROLE IF EXISTS "kb_user_p1_readonly"');
    expect(warnings).toEqual([]);
  });

  it('only drops the role once the database is gone', async () => {
    answer = async (_db, sql) => (/FROM pg_database/.test(sql) ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 0 });
    await svc().drop({ ...target, readonlyRole: 'kb_user_p1_readonly', dbName: 'kb_p1' });
    expect(sqlOn('kb_p1')).toEqual([]);
    expect(sqlOn('postgres').pop()).toBe('DROP ROLE IF EXISTS "kb_user_p1_readonly"');
  });

  it('skips the database step entirely when none is named (teardown after DROP DATABASE)', async () => {
    await svc().drop({ ...target, readonlyRole: 'kb_user_p1_readonly' });
    expect(calls.map((c) => c.sql)).toEqual(['DROP ROLE IF EXISTS "kb_user_p1_readonly"']);
  });

  it('turns failures into warnings rather than exceptions', async () => {
    answer = async (_db, sql) => {
      if (/DROP ROLE/.test(sql)) throw new Error('role "kb_user_p1_readonly" cannot be dropped');
      if (/FROM pg_database/.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    const { warnings } = await svc().drop({ ...target, readonlyRole: 'kb_user_p1_readonly', dbName: 'kb_p1' });
    expect(warnings).toEqual([expect.stringMatching(/dropping role: role "kb_user_p1_readonly" cannot be dropped/)]);
  });
});
