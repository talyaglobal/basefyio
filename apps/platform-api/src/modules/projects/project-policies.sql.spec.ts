import { BadRequestException } from '@nestjs/common';
import {
  assertPolicyExpression,
  buildCreatePolicySql,
  buildDropPolicySql,
  buildRlsSql,
  normalizePolicyDefinition,
  normalizeRlsToggle,
  renderRoles,
  renderScript,
} from './project-policies.sql';

/**
 * The policy editor sends parts; this module turns them into one statement.
 * Everything a customer types ends up inlined in DDL that runs as the owner of
 * their tables, so the tests pin both halves: the exact SQL that is produced,
 * and what is refused before any of it reaches Postgres.
 */

const base = {
  table: 'todos',
  name: 'own_rows',
  command: 'SELECT',
  roles: ['authenticated'],
  using: 'auth.uid() = "user_id"::text',
};

describe('buildCreatePolicySql', () => {
  it('renders a schema-qualified, permissive SELECT policy with no trailing semicolon', () => {
    const sql = buildCreatePolicySql(normalizePolicyDefinition(base));
    expect(sql).toBe(
      [
        'CREATE POLICY "own_rows" ON "public"."todos"',
        '  AS PERMISSIVE',
        '  FOR SELECT',
        '  TO "authenticated"',
        '  USING (auth.uid() = "user_id"::text)',
      ].join('\n'),
    );
    expect(sql.endsWith(';')).toBe(false);
  });

  it('renders RESTRICTIVE when asked', () => {
    const sql = buildCreatePolicySql(normalizePolicyDefinition({ ...base, permissive: false }));
    expect(sql).toContain('  AS RESTRICTIVE');
  });

  it('renders PUBLIC unquoted and other roles quoted, de-duplicated, in order', () => {
    expect(renderRoles(['public'])).toBe('PUBLIC');
    const def = normalizePolicyDefinition({
      ...base,
      roles: ['anon', 'anon', 'authenticated'],
    });
    expect(def.roles).toEqual(['anon', 'authenticated']);
    expect(buildCreatePolicySql(def)).toContain('  TO "anon", "authenticated"');
  });

  it('INSERT emits only WITH CHECK', () => {
    const sql = buildCreatePolicySql(
      normalizePolicyDefinition({
        ...base,
        command: 'INSERT',
        using: undefined,
        withCheck: 'auth.uid() = "user_id"::text',
      }),
    );
    expect(sql).toContain('  FOR INSERT');
    expect(sql).toContain('  WITH CHECK (auth.uid() = "user_id"::text)');
    expect(sql).not.toContain('USING');
  });

  it('UPDATE and ALL accept USING with or without WITH CHECK', () => {
    const both = buildCreatePolicySql(
      normalizePolicyDefinition({ ...base, command: 'UPDATE', withCheck: 'true' }),
    );
    expect(both).toContain('  USING (auth.uid() = "user_id"::text)');
    expect(both).toContain('  WITH CHECK (true)');

    const usingOnly = buildCreatePolicySql(normalizePolicyDefinition({ ...base, command: 'all' }));
    expect(usingOnly).toContain('  FOR ALL');
    expect(usingOnly).not.toContain('WITH CHECK');
  });
});

describe('normalizePolicyDefinition — command and expression combinations', () => {
  it('INSERT refuses USING and requires WITH CHECK', () => {
    expect(() => normalizePolicyDefinition({ ...base, command: 'INSERT' })).toThrow(
      /only a WITH CHECK/,
    );
    expect(() =>
      normalizePolicyDefinition({ ...base, command: 'INSERT', using: undefined }),
    ).toThrow(/need a WITH CHECK/);
  });

  it('SELECT and DELETE refuse WITH CHECK and require USING', () => {
    expect(() => normalizePolicyDefinition({ ...base, withCheck: 'true' })).toThrow(
      /cannot have a WITH CHECK/,
    );
    expect(() =>
      normalizePolicyDefinition({ ...base, command: 'DELETE', using: '   ' }),
    ).toThrow(/need a USING/);
  });

  it('defaults permissive to true and refuses a non-boolean', () => {
    expect(normalizePolicyDefinition(base).permissive).toBe(true);
    expect(() => normalizePolicyDefinition({ ...base, permissive: 'yes' })).toThrow(
      BadRequestException,
    );
  });

  it('refuses an unknown command, an unknown role and an empty role list', () => {
    expect(() => normalizePolicyDefinition({ ...base, command: 'TRUNCATE' })).toThrow(
      /Invalid command/,
    );
    expect(() => normalizePolicyDefinition({ ...base, roles: ['owner'] })).toThrow(/Invalid role/);
    expect(() => normalizePolicyDefinition({ ...base, roles: [] })).toThrow(/at least one role/);
  });

  it('refuses a body that is not an object', () => {
    expect(() => normalizePolicyDefinition(null)).toThrow(BadRequestException);
    expect(() => normalizePolicyDefinition('CREATE POLICY')).toThrow(BadRequestException);
  });
});

describe('identifiers', () => {
  it.each(['with-hyphen', '9starts_with_digit', 'quote"inside', 'a'.repeat(64), '', 'sp ace'])(
    'refuses %p as a table or policy name',
    (bad) => {
      expect(() => normalizePolicyDefinition({ ...base, table: bad })).toThrow(/Invalid table name/);
      expect(() => normalizePolicyDefinition({ ...base, name: bad })).toThrow(/Invalid policy name/);
    },
  );

  it('accepts an identifier of letters, digits and underscores', () => {
    const def = normalizePolicyDefinition({ ...base, table: '_tmp_table9', name: 'P1' });
    expect(buildCreatePolicySql(def)).toContain('CREATE POLICY "P1" ON "public"."_tmp_table9"');
  });
});

describe('assertPolicyExpression', () => {
  it.each([
    ['a statement terminator', 'true; DROP TABLE todos', /single expression/],
    ['a line comment', 'true -- hide the rest', /comments/],
    ['a block comment opener', 'true /* x', /comments/],
    ['a block comment closer', 'true */', /comments/],
    ['an over-long expression', `(${'a'.repeat(4001)})`, /longer than 4000/],
    ['unbalanced parentheses', '((a = b)', /unbalanced/],
    ['a stray closing parenthesis', 'a = b)', /unbalanced/],
    ['an unterminated literal', "a = 'oops", /unbalanced/],
    ['a console-denylisted call', "pg_read_file('/etc/passwd') IS NOT NULL", /pg_read_file/],
    ['a NUL byte', 'a = \u0000', /control characters/],
    ['an empty string', '   ', /empty/],
    ['a non-string', 42, /must be a string/],
  ])('refuses %s', (_label, expr, message) => {
    expect(() => assertPolicyExpression(expr, 'USING')).toThrow(message);
  });

  it.each([
    'auth.uid() = "user_id"::text',
    "(auth.jwt() ->> 'email') = email",
    "(status = 'open' AND (owner = auth.uid() OR (visibility = 'team')))",
    "note = 'it''s fine'",
    "label = ')'",
    "(current_setting('request.jwt.claims', true)::jsonb ->> 'sub') = \"user_id\"::text",
  ])('accepts %s', (expr) => {
    expect(assertPolicyExpression(expr, 'USING')).toBe(expr);
  });

  it('trims surrounding whitespace', () => {
    expect(assertPolicyExpression('  true  ', 'WITH CHECK')).toBe('true');
  });
});

describe('buildDropPolicySql / buildRlsSql / normalizeRlsToggle', () => {
  it('drops by quoted name on the qualified table', () => {
    expect(buildDropPolicySql('todos', 'own_rows')).toBe(
      'DROP POLICY "own_rows" ON "public"."todos"',
    );
  });

  it('builds the exact ALTER TABLE statements for each RLS state', () => {
    expect(buildRlsSql('todos', true)).toEqual([
      'ALTER TABLE "public"."todos" ENABLE ROW LEVEL SECURITY',
    ]);
    expect(buildRlsSql('todos', true, true)).toEqual([
      'ALTER TABLE "public"."todos" ENABLE ROW LEVEL SECURITY',
      'ALTER TABLE "public"."todos" FORCE ROW LEVEL SECURITY',
    ]);
    expect(buildRlsSql('todos', false)).toEqual([
      'ALTER TABLE "public"."todos" DISABLE ROW LEVEL SECURITY',
    ]);
    expect(buildRlsSql('todos', false, false)).toEqual([
      'ALTER TABLE "public"."todos" DISABLE ROW LEVEL SECURITY',
      'ALTER TABLE "public"."todos" NO FORCE ROW LEVEL SECURITY',
    ]);
  });

  it('validates the toggle body', () => {
    expect(normalizeRlsToggle({ table: 'todos', enabled: true })).toEqual({
      table: 'todos',
      enabled: true,
      force: undefined,
    });
    expect(() => normalizeRlsToggle({ table: 'todos', enabled: 'yes' })).toThrow(/enabled/);
    expect(() => normalizeRlsToggle({ table: 'todos', enabled: true, force: 1 })).toThrow(/force/);
    expect(() => normalizeRlsToggle({ table: 'bad-name', enabled: true })).toThrow(/table name/);
  });

  it('renders a script with every statement terminated', () => {
    expect(renderScript(['A', 'B'])).toBe('A;\n\nB;');
  });
});
