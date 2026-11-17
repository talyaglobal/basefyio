import { isAlreadyPresentError, makeIdempotent, sanitizeSchemaDump } from './supabase-schema-dump.util';

describe('sanitizeSchemaDump', () => {
  // A dump from a Postgres 17.6 pg_dump, replayed into 16.
  const dump = [
    '\\restrict Tz9aBcDeFgHiJkLmNoPqRsTuVwXyZ',
    '',
    'SET statement_timeout = 0;',
    'SET transaction_timeout = 0;',
    'SET client_encoding = \'UTF8\';',
    'CREATE TABLE public.t (id integer);',
    '\\unrestrict Tz9aBcDeFgHiJkLmNoPqRsTuVwXyZ',
  ].join('\n');

  it('drops the psql meta-commands, which are a syntax error in SQL', () => {
    const out = sanitizeSchemaDump(dump);
    expect(out).not.toMatch(/restrict/);
    expect(out.split('\n').some((l) => l.startsWith('\\'))).toBe(false);
  });

  it('drops transaction_timeout, which Postgres 16 rejects, and keeps the other settings', () => {
    const out = sanitizeSchemaDump(dump);
    expect(out).not.toMatch(/transaction_timeout/);
    expect(out).toContain('SET statement_timeout = 0;');
    expect(out).toContain("SET client_encoding = 'UTF8';");
  });

  it('leaves the schema itself untouched', () => {
    expect(sanitizeSchemaDump(dump)).toContain('CREATE TABLE public.t (id integer);');
  });

  it('does not touch a backslash that is inside a statement', () => {
    const sql = "SELECT 'a\\nb';\n  \\restrict x";
    expect(sanitizeSchemaDump(sql)).toBe("SELECT 'a\\nb';\n  \\restrict x");
  });
});

describe('makeIdempotent', () => {
  it('replaces functions and procedures instead of failing when they exist', () => {
    expect(makeIdempotent('CREATE FUNCTION public.f() RETURNS int AS $$ select 1 $$ LANGUAGE sql')[0]).toMatch(
      /^CREATE OR REPLACE FUNCTION public\.f\(\)/,
    );
    expect(makeIdempotent('CREATE PROCEDURE public.p() LANGUAGE sql AS $$ select 1 $$')[0]).toMatch(
      /^CREATE OR REPLACE PROCEDURE/,
    );
  });

  it('does not double an OR REPLACE that is already there', () => {
    const s = 'CREATE OR REPLACE FUNCTION public.f() RETURNS int AS $$ select 1 $$ LANGUAGE sql';
    expect(makeIdempotent(s)).toEqual([s]);
  });

  it('replaces views but not materialized views', () => {
    expect(makeIdempotent('CREATE VIEW public.v AS SELECT 1')[0]).toMatch(/^CREATE OR REPLACE VIEW public\.v/);
    expect(makeIdempotent('CREATE MATERIALIZED VIEW public.m AS SELECT 1')[0]).toBe(
      'CREATE MATERIALIZED VIEW public.m AS SELECT 1',
    );
  });

  it('creates schemas, tables, sequences and indexes only when missing', () => {
    expect(makeIdempotent('CREATE SCHEMA public')[0]).toBe('CREATE SCHEMA IF NOT EXISTS public');
    expect(makeIdempotent('CREATE TABLE public.t (id int)')[0]).toBe('CREATE TABLE IF NOT EXISTS public.t (id int)');
    expect(makeIdempotent('CREATE SEQUENCE public.s')[0]).toBe('CREATE SEQUENCE IF NOT EXISTS public.s');
    expect(makeIdempotent('CREATE UNIQUE INDEX i ON public.t (id)')[0]).toBe(
      'CREATE UNIQUE INDEX IF NOT EXISTS i ON public.t (id)',
    );
    expect(makeIdempotent('CREATE INDEX i ON public.t (id)')[0]).toBe('CREATE INDEX IF NOT EXISTS i ON public.t (id)');
  });

  it('leaves statements that already say IF NOT EXISTS alone', () => {
    const s = 'CREATE TABLE IF NOT EXISTS public.t (id int)';
    expect(makeIdempotent(s)).toEqual([s]);
  });

  it('drops a policy before creating it, with quoted names', () => {
    const s = 'CREATE POLICY "Own rows" ON public.todos FOR SELECT TO authenticated USING (true)';
    expect(makeIdempotent(s)).toEqual(['DROP POLICY IF EXISTS "Own rows" ON public.todos', s]);
    const q = 'CREATE POLICY p ON "public"."My Table" FOR ALL USING (true)';
    expect(makeIdempotent(q)[0]).toBe('DROP POLICY IF EXISTS p ON "public"."My Table"');
  });

  it('drops a trigger before creating it', () => {
    const s = 'CREATE TRIGGER set_updated BEFORE UPDATE ON public.t FOR EACH ROW EXECUTE FUNCTION public.touch()';
    expect(makeIdempotent(s)).toEqual(['DROP TRIGGER IF EXISTS set_updated ON public.t', s]);
  });

  it('returns an unknown statement unchanged', () => {
    const s = 'ALTER TABLE ONLY public.t ADD CONSTRAINT t_pkey PRIMARY KEY (id)';
    expect(makeIdempotent(s)).toEqual([s]);
  });
});

describe('isAlreadyPresentError', () => {
  it.each(['42P06', '42P07', '42701', '42710', '42723', '42P16'])('treats SQLSTATE %s as already present', (code) => {
    expect(isAlreadyPresentError({ code, message: 'whatever' })).toBe(true);
  });

  it('recognises the messages the re-import reported', () => {
    expect(isAlreadyPresentError({ message: 'schema "public" already exists' })).toBe(true);
    expect(isAlreadyPresentError({ message: 'function "x" already exists with same argument types' })).toBe(true);
    expect(isAlreadyPresentError({ message: 'column "id" of relation "t" is already an identity column' })).toBe(true);
  });

  it('does not hide a real failure', () => {
    expect(isAlreadyPresentError({ code: '42601', message: 'syntax error at or near "restrict"' })).toBe(false);
    expect(isAlreadyPresentError({ code: '42P01', message: 'relation "x" does not exist' })).toBe(false);
    expect(isAlreadyPresentError({ code: '23505', message: 'duplicate key value' })).toBe(false);
    expect(isAlreadyPresentError(null)).toBe(false);
  });
});
