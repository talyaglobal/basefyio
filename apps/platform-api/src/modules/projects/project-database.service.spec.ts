import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ProjectDatabaseService, sqlLiteral } from './project-database.service';

/**
 * No database here: withProjectDb is stubbed to hand each action a fake client,
 * so the tests see the exact statements that would run and can make Postgres
 * "fail" with a real-looking error (an Error carrying a SQLSTATE `code`).
 */

type Answer = (sql: string, params?: unknown[]) => unknown;

function harness(answer: Answer = () => ({ rows: [], rowCount: 0 })) {
  const client = {
    query: jest.fn().mockImplementation(async (sql: string, params?: unknown[]) => answer(sql, params)),
  };
  const svc = new ProjectDatabaseService({} as any, {} as any);
  jest
    .spyOn(svc, 'withProjectDb')
    .mockImplementation(async (_projectId, _userId, fn) => fn(client as any));
  return { svc, client };
}

const statements = (client: { query: jest.Mock }) =>
  client.query.mock.calls.map(([sql]: [string]) => sql.replace(/\s+/g, ' ').trim());

const pgError = (fields: Record<string, unknown>) =>
  Object.assign(new Error(String(fields.message ?? 'boom')), fields);

const failWith = (fields: Record<string, unknown>): Answer => () => {
  throw pgError(fields);
};

async function caught(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to fail');
}

describe('ProjectDatabaseService — Postgres errors become 4xx', () => {
  it('turns an index on a missing column into a 400 carrying Postgres\' message', async () => {
    const { svc } = harness(failWith({ code: '42703', message: 'column "nope" does not exist' }));
    const err = await caught(svc.createIndex('p1', 'u1', { table: 'users', columns: ['nope'] }));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('Failed to create index: column "nope" does not exist');
  });

  it('points a syntax error in CREATE FUNCTION at its line and column in the user\'s statement', async () => {
    const sql = 'CREATE FUNCTION f()\nRETURNS int\nLANGUAG sql AS $$ SELECT 1 $$';
    // Postgres reports positions in the text it received, which is the trimmed statement.
    const position = sql.indexOf('LANGUAG') + 1;
    const { svc, client } = harness(
      failWith({ code: '42601', message: 'syntax error at or near "LANGUAG"', position: String(position) }),
    );
    const err = await caught(svc.createFunction('p1', 'u1', `\n   ${sql}\n`));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toContain('Failed to create function: syntax error at or near "LANGUAG" (line 3, column 1)');
    expect(client.query).toHaveBeenCalledWith(sql);
  });

  it('refuses anything other than a single CREATE FUNCTION before touching the database', async () => {
    const { svc, client } = harness();
    await expect(svc.createFunction('p1', 'u1', 'DROP TABLE users')).rejects.toBeInstanceOf(BadRequestException);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('reports a schema that still holds objects as a 400 with the dependency detail', async () => {
    const { svc } = harness(
      failWith({
        code: '2BP01',
        message: 'cannot drop schema reports because other objects depend on it',
        detail: 'table reports.daily depends on schema reports',
        hint: 'Use DROP ... CASCADE to drop the dependent objects too.',
      }),
    );
    const err = await caught(svc.dropSchema('p1', 'u1', 'reports'));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toContain('table reports.daily depends on schema reports');
  });

  it('answers a duplicate enum value with 409', async () => {
    const { svc } = harness(failWith({ code: '42710', message: 'enum label "happy" already exists' }));
    const err = await caught(svc.addEnumValue('p1', 'u1', 'public', 'mood', { value: 'happy' }));
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toContain('enum label "happy" already exists');
  });

  it('leaves a connection failure alone so it still surfaces as a server error', async () => {
    const conn = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const { svc } = harness(() => {
      throw conn;
    });
    await expect(svc.listSchemas('p1', 'u1')).rejects.toBe(conn);
  });
});

describe('ProjectDatabaseService — identifiers', () => {
  const name63 = `s${'x'.repeat(62)}`;
  const name64 = `s${'x'.repeat(63)}`;

  it('creates a schema with a quoted identifier', async () => {
    const { svc, client } = harness();
    await expect(svc.createSchema('p1', 'u1', { name: ' reports ' })).resolves.toEqual({ message: 'Schema created' });
    expect(statements(client)).toEqual(['CREATE SCHEMA "reports"']);
  });

  it('accepts 63 characters and refuses 64 instead of letting Postgres truncate the name', async () => {
    const { svc, client } = harness();
    await svc.createSchema('p1', 'u1', { name: name63 });
    expect(statements(client)).toEqual([`CREATE SCHEMA "${name63}"`]);

    const err = await caught(svc.createSchema('p1', 'u1', { name: name64 }));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toContain('at most 63 characters');

    await expect(svc.createEnum('p1', 'u1', { name: name64, values: ['a'] })).rejects.toThrow('at most 63 characters');
    await expect(
      svc.createIndex('p1', 'u1', { table: 'users', columns: ['email'], name: name64 }),
    ).rejects.toThrow('at most 63 characters');
    await expect(
      svc.createTrigger('p1', 'u1', { name: name64, table: 't', timing: 'AFTER', events: ['INSERT'], functionName: 'f' }),
    ).rejects.toThrow('at most 63 characters');
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('refuses empty, malformed and reserved schema names', async () => {
    const { svc, client } = harness();
    await expect(svc.createSchema('p1', 'u1', { name: '' })).rejects.toThrow('A schema name is required');
    await expect(svc.createSchema('p1', 'u1', { name: 'bad-name' })).rejects.toThrow('Invalid schema name "bad-name"');
    await expect(svc.createSchema('p1', 'u1', { name: '1st' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.createSchema('p1', 'u1', { name: 'x"; DROP SCHEMA public; --' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.createSchema('p1', 'u1', { name: 'pg_stuff' })).rejects.toThrow('reserved by Postgres');
    await expect(svc.createSchema('p1', 'u1', { name: 'information_schema' })).rejects.toThrow('reserved by Postgres');
    expect(client.query).not.toHaveBeenCalled();
  });

  it('refuses a missing identifier rather than quoting the word "undefined"', async () => {
    const { svc, client } = harness();
    await expect(
      svc.createIndex('p1', 'u1', { table: undefined as any, columns: ['email'] }),
    ).rejects.toThrow('Invalid table name');
    await expect(
      svc.createIndex('p1', 'u1', { table: 'users', columns: 'email' as any }),
    ).rejects.toThrow('At least one column required');
    expect(client.query).not.toHaveBeenCalled();
  });

  it('builds CREATE INDEX with a chosen name, or a generated one when none is given', async () => {
    const { svc, client } = harness();
    await svc.createIndex('p1', 'u1', { table: 'users', columns: ['email'], unique: true, method: 'BTREE', name: ' users_email_key ' });
    await svc.createIndex('p1', 'u1', { table: 'users', columns: ['last_name', 'first_name'], method: 'gin', name: '  ' });
    expect(statements(client)).toEqual([
      'CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email")',
      'CREATE INDEX "idx_users_last_name_first_name" ON "users" USING gin ("last_name", "first_name")',
    ]);
    await expect(svc.createIndex('p1', 'u1', { table: 'users', columns: ['email'], method: 'rtree' })).rejects.toThrow('Invalid index method');
  });
});

describe('ProjectDatabaseService — schemas', () => {
  it.each(['public', 'auth', 'nosql'])('never drops the protected "%s" schema', async (name) => {
    const { svc, client } = harness();
    const err = await caught(svc.dropSchema('p1', 'u1', name, true));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toContain(`The "${name}" schema cannot be dropped`);
    expect(client.query).not.toHaveBeenCalled();
  });

  it.each(['pg_catalog', 'pg_toast', 'information_schema'])('never drops the system schema %s', async (name) => {
    const { svc, client } = harness();
    await expect(svc.dropSchema('p1', 'u1', name)).rejects.toThrow('Postgres system schema');
    expect(client.query).not.toHaveBeenCalled();
  });

  it('drops with RESTRICT by default and CASCADE only when asked', async () => {
    const { svc, client } = harness();
    await svc.dropSchema('p1', 'u1', 'reports');
    await svc.dropSchema('p1', 'u1', 'archive', true);
    expect(statements(client)).toEqual([
      'DROP SCHEMA "reports" RESTRICT',
      'DROP SCHEMA "archive" CASCADE',
    ]);
  });

  it('flags the protected schemas in the list', async () => {
    const { svc } = harness(() => ({
      rows: [
        { name: 'public', owner: 'proj', tableCount: 3, comment: null },
        { name: 'reports', owner: 'proj', tableCount: 0, comment: null },
      ],
    }));
    const rows = await svc.listSchemas('p1', 'u1');
    expect(rows.map((r: any) => [r.name, r.protected])).toEqual([
      ['public', true],
      ['reports', false],
    ]);
  });
});

describe('ProjectDatabaseService — enums', () => {
  it('creates an enum in public by default with every label quoted as a literal', async () => {
    const { svc, client } = harness();
    await svc.createEnum('p1', 'u1', { name: 'mood', values: ['happy', "it's", 'back\\slash'] });
    expect(statements(client)).toEqual([
      `CREATE TYPE "public"."mood" AS ENUM ('happy', 'it''s', E'back\\\\slash')`,
    ]);
  });

  it('honours an explicit schema and refuses a system one', async () => {
    const { svc, client } = harness();
    await svc.createEnum('p1', 'u1', { schema: 'billing', name: 'status', values: ['open'] });
    expect(statements(client)).toEqual([`CREATE TYPE "billing"."status" AS ENUM ('open')`]);
    await expect(svc.createEnum('p1', 'u1', { schema: 'pg_catalog', name: 'x', values: ['a'] })).rejects.toThrow('Postgres system schema');
  });

  it('validates labels: present, unique, non-empty text, at most 63 bytes', async () => {
    const { svc, client } = harness();
    await expect(svc.createEnum('p1', 'u1', { name: 'mood', values: [] })).rejects.toThrow('at least one value');
    await expect(svc.createEnum('p1', 'u1', { name: 'mood', values: undefined as any })).rejects.toThrow('at least one value');
    await expect(svc.createEnum('p1', 'u1', { name: 'mood', values: ['a', 'a'] })).rejects.toThrow('Duplicate enum value "a"');
    await expect(svc.createEnum('p1', 'u1', { name: 'mood', values: [''] })).rejects.toThrow('non-empty text');
    await expect(svc.createEnum('p1', 'u1', { name: 'mood', values: [42 as any] })).rejects.toThrow('non-empty text');
    // 32 two-byte characters = 64 bytes, one over Postgres' limit.
    await expect(svc.createEnum('p1', 'u1', { name: 'mood', values: ['ş'.repeat(32)] })).rejects.toThrow('too long');
    await expect(svc.createEnum('p1', 'u1', { name: 'mood', values: ['ş'.repeat(31)] })).resolves.toEqual({ message: 'Enum created' });
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('adds a value at the end, or before/after an existing one, but not both', async () => {
    const { svc, client } = harness();
    await svc.addEnumValue('p1', 'u1', 'public', 'mood', { value: 'meh' });
    await svc.addEnumValue('p1', 'u1', 'public', 'mood', { value: 'ok', after: 'happy' });
    await svc.addEnumValue('p1', 'u1', 'public', 'mood', { value: "can't", before: 'sad' });
    expect(statements(client)).toEqual([
      `ALTER TYPE "public"."mood" ADD VALUE 'meh'`,
      `ALTER TYPE "public"."mood" ADD VALUE 'ok' AFTER 'happy'`,
      `ALTER TYPE "public"."mood" ADD VALUE 'can''t' BEFORE 'sad'`,
    ]);
    await expect(
      svc.addEnumValue('p1', 'u1', 'public', 'mood', { value: 'x', before: 'a', after: 'b' }),
    ).rejects.toThrow('either "before" or "after"');
  });

  it('answers 404 when the enum to drop does not exist, without running DROP TYPE', async () => {
    const { svc, client } = harness(() => ({ rows: [], rowCount: 0 }));
    const err = await caught(svc.dropEnum('p1', 'u1', 'public', 'ghost'));
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.message).toBe('Enum "public.ghost" not found');
    expect(statements(client).some((s) => s.startsWith('DROP TYPE'))).toBe(false);
    expect(client.query.mock.calls[0][1]).toEqual(['public', 'ghost']);
  });

  it('drops an existing enum by its qualified name', async () => {
    const { svc, client } = harness((sql) => (/FROM pg_type/.test(sql) ? { rows: [{}], rowCount: 1 } : { rows: [], rowCount: 0 }));
    await expect(svc.dropEnum('p1', 'u1', 'public', 'mood')).resolves.toEqual({ message: 'Enum dropped' });
    expect(statements(client)[1]).toBe('DROP TYPE "public"."mood"');
  });
});

describe('sqlLiteral', () => {
  it('quotes plain text', () => {
    expect(sqlLiteral('happy')).toBe("'happy'");
    expect(sqlLiteral('')).toBe("''");
  });

  it('doubles single quotes', () => {
    expect(sqlLiteral("it's")).toBe("'it''s'");
    expect(sqlLiteral("'); DROP TABLE users; --")).toBe("'''); DROP TABLE users; --'");
  });

  it('switches to E\'\' with doubled backslashes when a backslash is present', () => {
    expect(sqlLiteral('a\\b')).toBe("E'a\\\\b'");
    expect(sqlLiteral("\\'")).toBe("E'\\\\'''");
  });

  it('refuses NUL characters', () => {
    expect(() => sqlLiteral('a\0b')).toThrow(BadRequestException);
  });
});

describe('ProjectDatabaseService — triggers', () => {
  const base = {
    name: 'audit_orders',
    table: 'orders',
    timing: 'AFTER' as const,
    events: ['INSERT', 'UPDATE'] as ('INSERT' | 'UPDATE' | 'DELETE')[],
    functionName: 'log_change',
  };

  it('builds FOR EACH STATEMENT with a schema-qualified function', async () => {
    const { svc, client } = harness();
    await svc.createTrigger('p1', 'u1', { ...base, forEach: 'STATEMENT', functionSchema: 'audit' });
    expect(statements(client)).toEqual([
      'CREATE TRIGGER "audit_orders" AFTER INSERT OR UPDATE ON "orders" FOR EACH STATEMENT EXECUTE FUNCTION "audit"."log_change"()',
    ]);
  });

  it('defaults to FOR EACH ROW and an unqualified function', async () => {
    const { svc, client } = harness();
    await svc.createTrigger('p1', 'u1', { ...base, timing: 'BEFORE', events: ['DELETE'] });
    expect(statements(client)).toEqual([
      'CREATE TRIGGER "audit_orders" BEFORE DELETE ON "orders" FOR EACH ROW EXECUTE FUNCTION "log_change"()',
    ]);
  });

  it('refuses a bad timing, no events or a malformed function schema', async () => {
    const { svc, client } = harness();
    await expect(svc.createTrigger('p1', 'u1', { ...base, timing: 'INSTEAD' as any })).rejects.toThrow('Invalid timing');
    await expect(svc.createTrigger('p1', 'u1', { ...base, events: ['TRUNCATE' as any] })).rejects.toThrow('At least one event required');
    await expect(svc.createTrigger('p1', 'u1', { ...base, functionSchema: 'a.b' })).rejects.toThrow('Invalid schema name');
    expect(client.query).not.toHaveBeenCalled();
  });

  it('reports a missing trigger function in Postgres\' words', async () => {
    const { svc } = harness(failWith({ code: '42883', message: 'function log_change() does not exist' }));
    const err = await caught(svc.createTrigger('p1', 'u1', base));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('Failed to create trigger: function log_change() does not exist');
  });
});
