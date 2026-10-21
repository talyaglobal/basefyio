import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ProjectPoliciesService } from './project-policies.service';

/**
 * The service's only live dependency is a project database connection, which
 * ProjectDatabaseService.withProjectDb provides. Here it is a stub that hands
 * the body a fake client, so the tests can watch the exact statements that
 * would run, in order, and what happens when Postgres rejects one.
 */

type Answer = (sql: string, params?: unknown[]) => unknown;

function harness(answer: Answer = () => ({ rows: [], rowCount: 0 })) {
  const client = {
    query: jest.fn().mockImplementation(async (sql: string, params?: unknown[]) => answer(sql, params)),
  };
  const db = {
    withProjectDb: jest.fn((_projectId: string, _userId: string, fn: (c: any) => Promise<unknown>) =>
      fn(client),
    ),
  };
  const svc = new ProjectPoliciesService(db as any);
  return { svc, client, db };
}

const statements = (client: { query: jest.Mock }) =>
  client.query.mock.calls.map(([sql]: [string]) => sql.replace(/\s+/g, ' ').trim());

const pgError = (code: string, message = 'boom') => Object.assign(new Error(message), { code });

const policy = {
  table: 'todos',
  name: 'own_rows',
  command: 'SELECT',
  roles: ['authenticated'],
  using: 'auth.uid() = "user_id"::text',
};

describe('ProjectPoliciesService.listPolicies', () => {
  it('maps catalog rows to tables with their policies and the helper signatures', async () => {
    const { svc } = harness((sql) => {
      if (/FROM pg_class/.test(sql)) {
        return {
          rows: [
            { schema: 'public', name: 'notes', rlsEnabled: false, rlsForced: false },
            { schema: 'public', name: 'todos', rlsEnabled: true, rlsForced: true },
          ],
        };
      }
      if (/FROM pg_policies/.test(sql)) {
        return {
          rows: [
            {
              tablename: 'todos',
              policyname: 'anyone_reads',
              permissive: 'PERMISSIVE',
              roles: ['public'],
              cmd: 'SELECT',
              qual: 'true',
              with_check: null,
            },
            {
              tablename: 'todos',
              policyname: 'own_insert',
              permissive: 'RESTRICTIVE',
              roles: '{anon,authenticated}',
              cmd: 'INSERT',
              qual: null,
              with_check: '(auth.uid() = user_id)',
            },
          ],
        };
      }
      if (/FROM pg_proc/.test(sql)) {
        return {
          rows: [
            { proname: 'uid', returns: 'uuid', prosrc: " select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid " },
            { proname: 'jwt', returns: 'jsonb', prosrc: '...' },
          ],
        };
      }
      return { rows: [] };
    });

    const out = await svc.listPolicies('p1', 'u1');

    expect(out.tables.map((t) => t.name)).toEqual(['notes', 'todos']);
    expect(out.tables[0]).toMatchObject({ rlsEnabled: false, rlsForced: false, policies: [] });
    expect(out.tables[1]).toMatchObject({ rlsEnabled: true, rlsForced: true });
    expect(out.tables[1].policies).toEqual([
      {
        name: 'anyone_reads',
        command: 'SELECT',
        permissive: true,
        roles: ['public'],
        using: 'true',
        withCheck: null,
      },
      {
        name: 'own_insert',
        command: 'INSERT',
        permissive: false,
        roles: ['anon', 'authenticated'],
        using: null,
        withCheck: '(auth.uid() = user_id)',
      },
    ]);
    expect(out.helpers).toEqual({
      uid: 'uuid',
      jwt: true,
      role: false,
      email: false,
      uidReadsLegacyClaimKey: true,
    });
    expect(out.roles).toEqual(['anon', 'authenticated', 'service_role', 'public']);
  });

  it('reports a text auth.uid() and no helpers at all', async () => {
    const withText = harness((sql) =>
      /FROM pg_proc/.test(sql)
        ? { rows: [{ proname: 'uid', returns: 'text', prosrc: "SELECT (auth.jwt() ->> 'sub')" }] }
        : { rows: [] },
    );
    expect((await withText.svc.listPolicies('p1', 'u1')).helpers).toMatchObject({
      uid: 'text',
      uidReadsLegacyClaimKey: false,
    });

    const none = harness();
    expect((await none.svc.listPolicies('p1', 'u1')).helpers.uid).toBeNull();
  });
});

describe('ProjectPoliciesService.createPolicy', () => {
  it('a dry run returns the SQL and never opens a connection', async () => {
    const { svc, db } = harness();
    const r = await svc.createPolicy('p1', 'u1', policy, { dryRun: true });
    expect(r).toMatchObject({ applied: false, checked: false });
    expect(r.sql).toBe(
      'CREATE POLICY "own_rows" ON "public"."todos"\n  AS PERMISSIVE\n  FOR SELECT\n  TO "authenticated"\n  USING (auth.uid() = "user_id"::text);',
    );
    expect(db.withProjectDb).not.toHaveBeenCalled();
  });

  it('a checked dry run runs the statement inside a transaction and rolls it back', async () => {
    const { svc, client } = harness();
    const r = await svc.createPolicy('p1', 'u1', policy, { dryRun: true, check: true });
    expect(r).toMatchObject({ applied: false, checked: true });
    const ran = statements(client);
    expect(ran[0]).toBe('BEGIN');
    expect(ran[1]).toMatch(/^SET LOCAL lock_timeout/);
    expect(ran[2]).toMatch(/^CREATE POLICY "own_rows"/);
    expect(ran[3]).toBe('ROLLBACK');
    expect(ran).not.toContain('COMMIT');
  });

  it('an apply runs BEGIN, lock_timeout, CREATE POLICY, COMMIT in order', async () => {
    const { svc, client } = harness();
    const r = await svc.createPolicy('p1', 'u1', policy);
    expect(r).toMatchObject({ applied: true, checked: true });
    expect(r.message).toMatch(/created/);
    expect(statements(client)).toEqual([
      'BEGIN',
      "SET LOCAL lock_timeout = '5s'",
      'CREATE POLICY "own_rows" ON "public"."todos" AS PERMISSIVE FOR SELECT TO "authenticated" USING (auth.uid() = "user_id"::text)',
      'COMMIT',
    ]);
  });

  it('an invalid body is refused before any connection is opened', async () => {
    const { svc, db } = harness();
    await expect(svc.createPolicy('p1', 'u1', { ...policy, table: 'bad-table' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.createPolicy('p1', 'u1', { ...policy, using: 'true; DROP TABLE todos' })).rejects.toThrow(
      /single expression/,
    );
    expect(db.withProjectDb).not.toHaveBeenCalled();
  });

  it.each([
    ['42501', ForbiddenException, /own this table/],
    ['42710', ConflictException, /already exists/],
    ['42601', BadRequestException, /syntax error at or near/],
    ['42703', BadRequestException, /column "nope" does not exist/],
    ['55P03', ConflictException, /busy/],
  ])('rolls back and maps Postgres %s', async (code, type, message) => {
    const pgMessage =
      code === '42601' ? 'syntax error at or near ")"' : code === '42703' ? 'column "nope" does not exist' : 'boom';
    const { svc, client } = harness((sql) => {
      if (/^CREATE POLICY/.test(sql)) throw pgError(code, pgMessage);
      return { rows: [] };
    });
    await expect(svc.createPolicy('p1', 'u1', policy)).rejects.toBeInstanceOf(type);
    await expect(svc.createPolicy('p1', 'u1', policy)).rejects.toThrow(message);
    const ran = statements(client);
    expect(ran).toContain('ROLLBACK');
    expect(ran).not.toContain('COMMIT');
  });
});

describe('ProjectPoliciesService.replacePolicy', () => {
  it('refuses to touch a policy that does not exist', async () => {
    const { svc, client } = harness((sql) =>
      /FROM pg_policies/.test(sql) ? { rows: [], rowCount: 0 } : { rows: [] },
    );
    await expect(
      svc.replacePolicy('p1', 'u1', 'todos', 'missing', { ...policy, name: 'renamed' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(statements(client).some((s) => /^(DROP|CREATE) POLICY/.test(s))).toBe(false);
  });

  it('drops the old policy and creates the new one in a single transaction', async () => {
    const { svc, client } = harness((sql, params) => {
      if (/FROM pg_policies/.test(sql)) {
        expect(params).toEqual(['public', 'todos', 'own_rows']);
        return { rows: [{ '?column?': 1 }], rowCount: 1 };
      }
      return { rows: [] };
    });
    const r = await svc.replacePolicy('p1', 'u1', 'todos', 'own_rows', {
      ...policy,
      name: 'own_rows_v2',
      table: 'ignored_in_favour_of_the_path',
    });
    expect(r.applied).toBe(true);
    const ran = statements(client).filter((s) => !/FROM pg_policies/.test(s));
    expect(ran).toEqual([
      'BEGIN',
      "SET LOCAL lock_timeout = '5s'",
      'DROP POLICY "own_rows" ON "public"."todos"',
      'CREATE POLICY "own_rows_v2" ON "public"."todos" AS PERMISSIVE FOR SELECT TO "authenticated" USING (auth.uid() = "user_id"::text)',
      'COMMIT',
    ]);
  });

  it('a rejected CREATE rolls the DROP back too', async () => {
    const { svc, client } = harness((sql) => {
      if (/FROM pg_policies/.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/^CREATE POLICY/.test(sql)) throw pgError('42703', 'column "nope" does not exist');
      return { rows: [] };
    });
    await expect(
      svc.replacePolicy('p1', 'u1', 'todos', 'own_rows', { ...policy, using: 'nope = 1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const ran = statements(client);
    expect(ran[ran.length - 1]).toBe('ROLLBACK');
    expect(ran).not.toContain('COMMIT');
  });
});

describe('ProjectPoliciesService.dropPolicy / setRowLevelSecurity', () => {
  it('drops by name', async () => {
    const { svc, client } = harness();
    const r = await svc.dropPolicy('p1', 'u1', 'todos', 'own_rows');
    expect(r.applied).toBe(true);
    expect(statements(client)[2]).toBe('DROP POLICY "own_rows" ON "public"."todos"');
  });

  it('enables, forces and disables row-level security with the exact statements', async () => {
    const enable = harness();
    await enable.svc.setRowLevelSecurity('p1', 'u1', { table: 'todos', enabled: true });
    expect(statements(enable.client)[2]).toBe('ALTER TABLE "public"."todos" ENABLE ROW LEVEL SECURITY');

    const force = harness();
    const r = await force.svc.setRowLevelSecurity('p1', 'u1', { table: 'todos', enabled: true, force: true });
    expect(statements(force.client).slice(2, 4)).toEqual([
      'ALTER TABLE "public"."todos" ENABLE ROW LEVEL SECURITY',
      'ALTER TABLE "public"."todos" FORCE ROW LEVEL SECURITY',
    ]);
    expect(r.message).toMatch(/enabled and forced/);

    const disable = harness();
    await disable.svc.setRowLevelSecurity('p1', 'u1', { table: 'todos', enabled: false });
    expect(statements(disable.client)[2]).toBe('ALTER TABLE "public"."todos" DISABLE ROW LEVEL SECURITY');
  });

  it('a bad toggle body is a 400 before any connection', async () => {
    const { svc, db } = harness();
    await expect(
      svc.setRowLevelSecurity('p1', 'u1', { table: 'todos', enabled: 'yes' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.withProjectDb).not.toHaveBeenCalled();
  });

  it('a missing table surfaces as 404', async () => {
    const { svc } = harness((sql) => {
      if (/^ALTER TABLE/.test(sql)) throw pgError('42P01', 'relation "public.nope" does not exist');
      return { rows: [] };
    });
    await expect(
      svc.setRowLevelSecurity('p1', 'u1', { table: 'nope', enabled: true }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
