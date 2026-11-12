import { parseQuery, parseSelect } from './parser';
import { SelectBuilder } from './builder';
import { SchemaCache, ProjectSchema } from './schema-cache';
import { PostgrestParseError } from './types';
import { assertRows, buildInsertStatements, parseOnConflict, PG_MAX_PARAMS } from './write';
import { contentRange, parsePrefer, parseRangeHeader, projectRows, toCsv, wantsCsv } from './response';
import { planRpcCall } from './rpc';

/**
 * The REST data API's answers to malformed input, its counts, its upserts and
 * its large batches — the behaviour the QA pass found returning 500s or wrong
 * numbers.
 */

function fixture(): { schema: ProjectSchema; cache: SchemaCache } {
  const tables = new Map();
  const mk = (name: string, cols: string[], pk: string[]) =>
    tables.set(name, { name, columns: new Set(cols), primaryKey: pk });
  mk('items', ['id', 'name', 'category', 'price', 'meta'], ['id']);
  mk('reviews', ['id', 'item_id', 'rating'], ['id']);
  const schema: ProjectSchema = {
    tables,
    foreignKeys: [
      { constraint: 'reviews_item_fk', table: 'reviews', columns: ['item_id'], foreignTable: 'items', foreignColumns: ['id'] },
    ],
    loadedAt: Date.now(),
  };
  return { schema, cache: new SchemaCache() };
}

const builder = () => {
  const { schema, cache } = fixture();
  return new SelectBuilder(schema, cache);
};

const parseError = (fn: () => unknown): PostgrestParseError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PostgrestParseError);
    return e as PostgrestParseError;
  }
  throw new Error('expected a PostgrestParseError');
};

describe('malformed queries are parse errors (→ 400), never server errors', () => {
  it.each([
    ['a filter with no operator', { id: '5' }],
    ['an unknown operator', { id: 'foo.1' }],
    ['an unknown order modifier', { order: 'id.sideways' }],
    ['a character no column name holds', { select: 'id;drop' }],
    ['a limit that is not a number', { limit: 'abc' }],
    ['a negative limit', { limit: '-1' }],
    ['a negative offset', { offset: '-5' }],
    ['a query parameter parsed as an object', { id: { foo: '1' } as never }],
    ['select given twice', { select: ['id', 'name'] }],
  ])('%s', (_label, qs) => {
    parseError(() => parseQuery(qs as Record<string, string>));
  });

  it('names the parameter in a limit error', () => {
    expect(parseError(() => parseQuery({ limit: 'abc' })).message).toMatch(/limit/);
  });

  it('still caps a large limit at 1000 rather than refusing it', () => {
    expect(parseQuery({ limit: '5000' }).limit.get('')).toBe(1000);
  });
});

describe('count preference in the query string', () => {
  it('reads ?count=exact as a preference, not a filter', () => {
    const q = parseQuery({ count: 'exact' });
    expect(q.count).toBe('exact');
    expect(q.filters.get('') ?? []).toHaveLength(0);
  });

  it('still treats count=eq.5 as a filter on a column called count', () => {
    const q = parseQuery({ count: 'eq.5' });
    expect(q.count).toBeUndefined();
    expect(q.filters.get('')).toHaveLength(1);
  });
});

describe('count follows !inner embeds (#132)', () => {
  const qs = {
    select: 'id,reviews!inner(rating)',
    'reviews.rating': 'eq.5',
  } as Record<string, string>;

  it('adds the EXISTS predicate to the exact count', () => {
    const { sql, params } = builder().buildCount('items', parseQuery(qs));
    expect(sql).toMatch(/EXISTS \(SELECT 1 FROM "reviews"/);
    expect(sql).toMatch(/"rating" = \$1/);
    expect(params).toEqual(['5']);
  });

  it('binds only what the count uses — no projection parameters', () => {
    const { sql, params } = builder().buildCount(
      'items',
      parseQuery({ ...qs, select: 'id,meta->>color,reviews!inner(rating)' }),
    );
    expect(sql).not.toMatch(/json_agg|row_to_json/);
    expect(params).toEqual(['5']);
  });

  it('leaves a plain (non-inner) embed out of the count', () => {
    const { sql } = builder().buildCount(
      'items',
      parseQuery({ select: 'id,reviews(rating)', 'reviews.rating': 'eq.5' } as Record<string, string>),
    );
    expect(sql).not.toMatch(/EXISTS/);
  });

  it('bounds the cheap count and binds the cap', () => {
    const { sql, params } = builder().buildBoundedCount('items', parseQuery(qs), 10_000);
    expect(sql).toMatch(/FROM \(SELECT 1 FROM "items" .* LIMIT \$2\) _bf_bounded/);
    expect(params).toEqual(['5', 10_001]);
  });

  it('asks the planner for an estimate with the same filters', () => {
    const { sql } = builder().buildPlannedCount('items', parseQuery(qs));
    expect(sql).toMatch(/^EXPLAIN \(FORMAT JSON\) SELECT 1 FROM "items"/);
    expect(sql).toMatch(/EXISTS/);
  });
});

describe('NULL ordering follows PostgreSQL (#132)', () => {
  it('leaves NULL placement to the database when not asked', () => {
    expect(builder().build('items', parseQuery({ order: 'category.asc' })).sql).toMatch(/"category" ASC LIMIT/);
    expect(builder().build('items', parseQuery({ order: 'price.desc' })).sql).toMatch(/"price" DESC LIMIT/);
  });

  it('keeps an explicit nullsfirst / nullslast', () => {
    expect(builder().build('items', parseQuery({ order: 'category.asc.nullsfirst' })).sql).toMatch(/ASC NULLS FIRST/);
    expect(builder().build('items', parseQuery({ order: 'price.desc.nullslast' })).sql).toMatch(/DESC NULLS LAST/);
  });
});

describe('JSON path labels (#134)', () => {
  it('labels meta->>color as "color"', () => {
    expect(builder().build('items', parseQuery({ select: 'id,meta->>color' })).sql).toMatch(/AS "color"/);
  });

  it('keeps an explicit alias', () => {
    expect(builder().build('items', parseQuery({ select: 'tint:meta->>color' })).sql).toMatch(/AS "tint"/);
  });

  it('quotes a key holding a double quote safely', () => {
    const { sql } = builder().build('items', parseQuery({ select: 'meta->>a"b' }));
    expect(sql).toContain('AS "a""b"');
  });
});

const quote = (name: string) => `"${name.replace(/[^a-zA-Z0-9_]/g, '')}"`;

describe('bulk inserts stay under the parameter ceiling (#186)', () => {
  const rows = (n: number, cols: number) =>
    Array.from({ length: n }, (_, i) =>
      Object.fromEntries(Array.from({ length: cols }, (_, c) => [`c${c}`, `${i}-${c}`])),
    );

  it('splits 10,000 seven-column rows into statements Postgres accepts', () => {
    const statements = buildInsertStatements({ table: 't', rows: rows(10_000, 7), quote });
    expect(statements.length).toBe(2);
    for (const s of statements) expect(s.params.length).toBeLessThanOrEqual(PG_MAX_PARAMS);
    expect(statements.reduce((n, s) => n + s.params.length, 0)).toBe(70_000);
  });

  it('numbers each statement from $1', () => {
    const statements = buildInsertStatements({ table: 't', rows: rows(5, 2), quote, maxParams: 4 });
    expect(statements).toHaveLength(3);
    expect(statements[1].sql).toContain('VALUES ($1, $2), ($3, $4)');
    expect(statements[2].sql).toContain('VALUES ($1, $2) RETURNING *');
  });

  it('keeps a small insert as one statement, as before', () => {
    const [only, ...rest] = buildInsertStatements({ table: 't', rows: [{ a: 1, b: 'x' }], quote });
    expect(rest).toHaveLength(0);
    expect(only.sql).toBe('INSERT INTO "t" ("a", "b") VALUES ($1, $2) RETURNING *');
  });

  it('refuses a body that is not objects', () => {
    expect(() => assertRows([1, 2])).toThrow(PostgrestParseError);
    expect(() => assertRows('x')).toThrow(PostgrestParseError);
    expect(() => assertRows([])).toThrow(/Empty body/);
  });
});

describe('upsert (#133)', () => {
  it('merges on the given target, updating every other column', () => {
    const [s] = buildInsertStatements({
      table: 'items',
      rows: [{ id: 1, name: 'a', price: 2 }],
      quote,
      upsert: { resolution: 'merge-duplicates', target: ['id'] },
    });
    expect(s.sql).toContain('ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name", "price" = EXCLUDED."price"');
    expect(s.sql).toContain('RETURNING *, (xmax = 0) AS "__bf_inserted"');
    expect(s.params).toEqual([1, 'a', 2]);
  });

  it('does nothing — rather than emit an empty SET — when the row is only its key', () => {
    const [s] = buildInsertStatements({
      table: 'items',
      rows: [{ id: 1 }],
      quote,
      upsert: { resolution: 'merge-duplicates', target: ['id'] },
    });
    expect(s.sql).toContain('ON CONFLICT ("id") DO NOTHING');
    expect(s.sql).not.toMatch(/SET\s+RETURNING/);
  });

  it('ignores duplicates with or without a target', () => {
    const withTarget = buildInsertStatements({
      table: 'items', rows: [{ id: 1, name: 'a' }], quote,
      upsert: { resolution: 'ignore-duplicates', target: ['name'] },
    })[0].sql;
    expect(withTarget).toContain('ON CONFLICT ("name") DO NOTHING');
    const without = buildInsertStatements({
      table: 'items', rows: [{ id: 1 }], quote,
      upsert: { resolution: 'ignore-duplicates', target: null },
    })[0].sql;
    expect(without).toContain('ON CONFLICT DO NOTHING');
  });

  it('needs a target to merge', () => {
    expect(() =>
      buildInsertStatements({
        table: 'items', rows: [{ name: 'a' }], quote,
        upsert: { resolution: 'merge-duplicates', target: null },
      }),
    ).toThrow(/on_conflict/);
  });

  it('parses on_conflict and refuses anything but column names', () => {
    expect(parseOnConflict('name, category')).toEqual(['name', 'category']);
    expect(parseOnConflict(undefined)).toBeUndefined();
    expect(() => parseOnConflict('name); drop table x; --')).toThrow(PostgrestParseError);
    expect(() => parseOnConflict(['a'])).toThrow(PostgrestParseError);
  });
});

describe('Prefer, Range and response shaping (#134, #186)', () => {
  it('reads several preferences from one header', () => {
    expect(parsePrefer('return=representation, count=exact,resolution=merge-duplicates')).toEqual({
      return: 'representation',
      count: 'exact',
      resolution: 'merge-duplicates',
    });
    expect(parsePrefer(undefined)).toEqual({});
    expect(parsePrefer('handling=lenient, count=bogus')).toEqual({});
  });

  it('turns a Range header into offset and limit', () => {
    expect(parseRangeHeader('0-9', 'items')).toEqual({ offset: 0, limit: 10 });
    expect(parseRangeHeader('20-', undefined)).toEqual({ offset: 20 });
    expect(parseRangeHeader(undefined, undefined)).toBeNull();
    expect(() => parseRangeHeader('9-0', undefined)).toThrow(PostgrestParseError);
    expect(() => parseRangeHeader('abc', undefined)).toThrow(PostgrestParseError);
  });

  it('writes Content-Range', () => {
    expect(contentRange(0, 25, 3573)).toBe('0-24/3573');
    expect(contentRange(10, 5, null)).toBe('10-14/*');
    expect(contentRange(0, 0, 0)).toBe('*/0');
  });

  it('writes CSV with quoting', () => {
    expect(wantsCsv('text/csv')).toBe(true);
    expect(wantsCsv('application/json')).toBe(false);
    expect(toCsv([{ id: 1, name: 'a,b', note: null, tags: ['x'] }, { id: 2, name: 'say "hi"', note: 'ok', tags: [] }]))
      .toBe('id,name,note,tags\r\n1,"a,b",,"[""x""]"\r\n2,"say ""hi""",ok,[]\r\n');
  });

  it('narrows the rows a write returns to ?select columns', () => {
    const rows = [{ id: 1, name: 'a', price: 2 }];
    expect(projectRows(rows, parseSelect('id,label:name'))).toEqual([{ id: 1, label: 'a' }]);
    expect(projectRows(rows, parseSelect('*'))).toBe(rows);
    expect(() => projectRows(rows, parseSelect('id,reviews(rating)'))).toThrow(PostgrestParseError);
    expect(() => projectRows(rows, parseSelect('nope'))).toThrow(PostgrestParseError);
  });
});

describe('rpc call planning (#13)', () => {
  const hello = { signature: 'qa_hello(text)', definer: false, argnames: ['name'], argmodes: [], argtypes: ['text'], ndefaults: 0 };

  it('binds each named argument to a real placeholder', () => {
    // The 500 in production: the call was written `"name" := 1`, a literal,
    // while "QA" was sent as a parameter nothing referenced.
    const plan = planRpcCall('qa_hello', [hello], { name: 'QA' });
    expect(plan.named).toBe('"name" := $1');
    expect(plan.params).toEqual(['QA']);
  });

  it('ignores a key no overload knows, as before', () => {
    const plan = planRpcCall('noarg', [{ signature: 'noarg()', definer: false, argnames: [] }], { extra: 1 });
    expect(plan.named).toBe('');
    expect(plan.params).toEqual([]);
  });

  it('says which arguments exist when a required one is missing', () => {
    const err = parseError(() => planRpcCall('qa_hello', [hello], { args: { name: 'QA' } }));
    expect(err.message).toMatch(/qa_hello\(text\)/);
    expect(err.message).toMatch(/Unknown argument name: args/);
  });

  it('lets an argument with a default be left out', () => {
    const plan = planRpcCall(
      'greet',
      [{ signature: 'greet(text, text)', definer: false, argnames: ['name', 'greeting'], argtypes: ['text', 'text'], ndefaults: 1 }],
      { name: 'x' },
    );
    expect(plan.named).toBe('"name" := $1');
  });

  it('skips OUT arguments of a RETURNS TABLE function', () => {
    const plan = planRpcCall(
      'items_for',
      [{ signature: 'items_for(integer)', definer: false, argnames: ['min_price', 'id', 'name'], argmodes: ['i', 't', 't'], argtypes: ['integer', 'integer', 'text'] }],
      { min_price: 5 },
    );
    expect(plan.named).toBe('"min_price" := $1');
  });

  it('sends a json/jsonb argument as JSON text', () => {
    const plan = planRpcCall(
      'save',
      [{ signature: 'save(jsonb)', definer: false, argnames: ['doc'], argtypes: ['jsonb'] }],
      { doc: [1, { a: 2 }] },
    );
    expect(plan.params).toEqual(['[1,{"a":2}]']);
  });

  it('marks a variadic argument passed by name', () => {
    const plan = planRpcCall(
      'least_of',
      [{ signature: 'least_of(numeric[])', definer: false, argnames: ['xs'], argmodes: ['v'], argtypes: ['numeric[]'] }],
      { xs: [3, 1] },
    );
    expect(plan.named).toBe('VARIADIC "xs" := $1');
  });

  it('judges SECURITY DEFINER by the overloads the call can reach', () => {
    const rows = [
      { signature: 'f(integer)', definer: true, argnames: ['a'], argtypes: ['integer'] },
      { signature: 'f(text, text)', definer: false, argnames: ['b', 'c'], argtypes: ['text', 'text'] },
    ];
    expect(planRpcCall('f', rows, { b: 'x', c: 'y' }).definer).toBe(false);
    expect(planRpcCall('f', rows, { a: 1 }).definer).toBe(true);
  });
});
