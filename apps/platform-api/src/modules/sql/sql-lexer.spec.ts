import { classifyStatement, splitStatements, tokenize } from './sql-lexer';

const kinds = (sql: string) => splitStatements(sql).map((s) => classifyStatement(s.tokens).kind);
const texts = (sql: string) => splitStatements(sql).map((s) => s.text);

describe('tokenize', () => {
  it('keeps words whole and drops comments, nested ones included', () => {
    const t = tokenize('select payload /* a /* b */ c */ -- x\n from t');
    expect(t.filter((x) => x.type === 'word').map((x) => x.upper)).toEqual(['SELECT', 'PAYLOAD', 'FROM', 'T']);
  });

  it('decodes the string forms Postgres accepts', () => {
    const values = (sql: string) => tokenize(sql).filter((x) => x.type === 'string').map((x) => x.value);
    expect(values("select 'it''s'")).toEqual(["it's"]);
    expect(values("select E'a\\nb\\x41\\'c'")).toEqual(["a\nbA'c"]);
    expect(values("select $$ a ' b $$, $q$ $$ $q$")).toEqual([" a ' b ", ' $$ ']);
    expect(values("select U&'d\\0061t\\+000061'")).toEqual(['data']);
  });

  it('tells a positional parameter from a dollar quote', () => {
    const t = tokenize('select $1, $a$x$a$, a$b');
    expect(t.map((x) => x.type)).toEqual(['word', 'param', 'punct', 'string', 'punct', 'word']);
  });
});

describe('splitStatements', () => {
  it('splits on top-level semicolons only', () => {
    expect(texts("select ';'; select 2 -- ; not here\n; select $$;$$")).toEqual([
      "select ';'",
      'select 2',
      'select $$;$$',
    ]);
  });

  it('keeps a BEGIN ATOMIC function body, CASE … END included, in one statement', () => {
    const sql = `CREATE FUNCTION f(x int) RETURNS int LANGUAGE sql
BEGIN ATOMIC
  SELECT CASE WHEN x > 0 THEN 1 ELSE 0 END;
  SELECT 2;
END;
SELECT f(1)`;
    const parts = texts(sql);
    expect(parts).toHaveLength(2);
    expect(parts[1]).toBe('SELECT f(1)');
  });

  it('does not treat a column called begin as a function body', () => {
    expect(texts('create table t (begin int); select 1')).toHaveLength(2);
  });

  it('ignores empty statements and trailing comments', () => {
    expect(texts(';; select 1 ; -- done')).toEqual(['select 1']);
  });
});

describe('classifyStatement', () => {
  it.each([
    ['select 1', 'select'],
    ['VALUES (1), (2)', 'select'],
    ['table t', 'select'],
    ['(select 1) union (select 2)', 'select'],
    ['with a as (select 1) select * from a', 'select'],
    ['with recursive r(n) as (select 1 union all select n + 1 from r where n < 3) select * from r', 'select'],
    ['with u as (update t set a = 1 returning id) select count(*) from u', 'select_with_dml'],
    ['with a as (select 1), d as (delete from t returning *) select * from d', 'select_with_dml'],
    ['with a as (with b as (insert into t default values returning *) select * from b) select * from a', 'select_with_dml'],
    ['with a as (select 1) insert into t select * from a', 'dml'],
    ['insert into t values (1)', 'dml'],
    ['update t set a = 1', 'dml'],
    ['delete from t', 'dml'],
    ['select * into t2 from t', 'other'],
    ['create table t (id int)', 'other'],
    ['explain select 1', 'other'],
    ['show search_path', 'other'],
    // A CTE may be named after an unreserved keyword.
    ['with update as (select 1) select * from update', 'select'],
  ])('%s → %s', (sql, kind) => {
    expect(kinds(sql)).toEqual([kind]);
  });

  it('finds a LIMIT on the primary query but not inside a CTE', () => {
    const info = (sql: string) => classifyStatement(splitStatements(sql)[0].tokens);
    expect(info('with u as (update t set a = 1 returning id) select * from u limit 5').hasTopLevelLimit).toBe(true);
    expect(info('with u as (select * from t limit 5) select * from u').hasTopLevelLimit).toBe(false);
  });
});
