/**
 * Tests for the JS query parser (SDK-style query text → EntityQuery).
 *
 * This parser is a security boundary: it receives raw text from the query
 * editor and must never evaluate it. The error-path tests below are as
 * important as the happy paths.
 */

import { QueryValidationError } from '../interfaces/data-engine';
import type { FieldFilter, Filter, FilterOperator } from '../interfaces/query';
import { JsQueryParseError, parseJsQuery } from '../query/js-query-parser';

/** Parse and expect failure; returns the typed error for further assertions. */
function parseError(source: string): JsQueryParseError {
  let caught: unknown;
  try {
    parseJsQuery(source);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(JsQueryParseError);
  return caught as JsQueryParseError;
}

describe('parseJsQuery — happy paths', () => {
  test('minimal collection().find()', () => {
    const r = parseJsQuery("collection('a').find()");
    expect(r).toEqual({ entity: 'a', action: 'find', query: { entity: 'a' } });
  });

  test('bare root with no chain is a match-all find', () => {
    const r = parseJsQuery('collection("orders")');
    expect(r).toEqual({ entity: 'orders', action: 'find', query: { entity: 'orders' } });
  });

  test('find({}) compiles to no filter (match all)', () => {
    const r = parseJsQuery("collection('a').find({})");
    expect(r.query).toEqual({ entity: 'a' });
  });

  test('full chain with every method', () => {
    const r = parseJsQuery(`
      collection('orders')
        .find({ status: 'active', total: { $gte: 100 } })
        .sort({ createdAt: -1 })
        .sort('total', 'asc')
        .limit(10)
        .skip(5)
        .select({ id: 1, 'customer.name': 1, 'items[].sku': 1 });
    `);
    expect(r.entity).toBe('orders');
    expect(r.action).toBe('find');
    expect(r.query).toEqual({
      entity: 'orders',
      filter: {
        type: 'and',
        conditions: [
          {
            type: 'field',
            path: { path: 'status', isArrayPath: false },
            operator: 'eq',
            value: 'active',
          },
          {
            type: 'field',
            path: { path: 'total', isArrayPath: false },
            operator: 'gte',
            value: 100,
          },
        ],
      },
      sort: [
        { path: { path: 'createdAt', isArrayPath: false }, direction: 'desc' },
        { path: { path: 'total', isArrayPath: false }, direction: 'asc' },
      ],
      limit: 10,
      offset: 5,
      select: [
        { path: 'id', isArrayPath: false },
        { path: 'customer.name', isArrayPath: false },
        { path: 'items[].sku', isArrayPath: true },
      ],
    });
  });

  test('db.<name> root alias', () => {
    const r = parseJsQuery('db.users.find({ active: true }).limit(1)');
    expect(r.entity).toBe('users');
    expect(r.query.limit).toBe(1);
    expect(r.query.filter).toEqual({
      type: 'field',
      path: { path: 'active', isArrayPath: false },
      operator: 'eq',
      value: true,
    });
  });

  test('where() is an alias for find()', () => {
    const r = parseJsQuery("db.users.where({ role: 'admin' })");
    expect((r.query.filter as FieldFilter).value).toBe('admin');
  });

  test('offset() is an alias for skip()', () => {
    const r = parseJsQuery("collection('a').find().offset(3)");
    expect(r.query.offset).toBe(3);
  });

  test('both quote styles and all supported escapes', () => {
    const src = `collection('a').find({ name: 'O\\'Brien', q: "say \\"hi\\"", w: 'a\\nb\\tc', s: 'back\\\\slash' })`;
    const r = parseJsQuery(src);
    const conditions = (r.query.filter as { conditions: FieldFilter[] }).conditions;
    expect(conditions.map((c) => c.value)).toEqual([
      "O'Brien",
      'say "hi"',
      'a\nb\tc',
      'back\\slash',
    ]);
  });

  test('comments everywhere', () => {
    const r = parseJsQuery(`
      // leading line comment
      collection('a') /* inline block */
        .find({ a: 1 }) // trailing comment
        /* multi
           line block */
        .limit(5);
    `);
    expect(r.query.limit).toBe(5);
    expect((r.query.filter as FieldFilter).value).toBe(1);
  });

  test('trailing commas in object and array literals', () => {
    const r = parseJsQuery("collection('a').find({ a: 1, b: { $in: [1, 2,] }, })");
    const conditions = (r.query.filter as { conditions: FieldFilter[] }).conditions;
    expect(conditions[1].operator).toBe('in');
    expect(conditions[1].value).toEqual([1, 2]);
  });

  test('negative numbers, decimals and exponents', () => {
    const r = parseJsQuery("collection('a').find({ a: -5, b: -1.5, c: 1e3, d: 2.5e-2 })");
    const conditions = (r.query.filter as { conditions: FieldFilter[] }).conditions;
    expect(conditions.map((c) => c.value)).toEqual([-5, -1.5, 1000, 0.025]);
  });

  test('nested $and / $or / $not', () => {
    const r = parseJsQuery(
      "collection('a').find({ $or: [{ a: 1 }, { $and: [{ b: { $gt: 2 } }, { $not: { c: 'x' } }] }] })",
    );
    expect(r.query.filter).toEqual({
      type: 'or',
      conditions: [
        { type: 'field', path: { path: 'a', isArrayPath: false }, operator: 'eq', value: 1 },
        {
          type: 'and',
          conditions: [
            { type: 'field', path: { path: 'b', isArrayPath: false }, operator: 'gt', value: 2 },
            {
              type: 'not',
              condition: {
                type: 'field',
                path: { path: 'c', isArrayPath: false },
                operator: 'eq',
                value: 'x',
              },
            },
          ],
        },
      ],
    });
  });

  // Every Mongo-style operator supported by filter-object.ts OPERATOR_MAP.
  const operatorCases: Array<[string, FilterOperator, unknown]> = [
    ['$eq', 'eq', 5],
    ['$ne', 'neq', 5],
    ['$neq', 'neq', 5],
    ['$gt', 'gt', 5],
    ['$gte', 'gte', 5],
    ['$lt', 'lt', 5],
    ['$lte', 'lte', 5],
    ['$in', 'in', [1, 2]],
    ['$nin', 'nin', ['a']],
    ['$contains', 'contains', 'a'],
    ['$containsAny', 'containsAny', ['a', 'b']],
    ['$exists', 'exists', true],
    ['$regex', 'regex', '^abc'],
    ['$iregex', 'iregex', 'abc$'],
    ['$like', 'like', 'a%'],
    ['$ilike', 'ilike', '%a'],
  ];

  test.each(operatorCases)('operator %s maps to "%s"', (op, expected, value) => {
    const r = parseJsQuery(`collection('t').find({ f: { ${op}: ${JSON.stringify(value)} } })`);
    const filter = r.query.filter as FieldFilter;
    expect(filter).toEqual({
      type: 'field',
      path: { path: 'f', isArrayPath: op === '$contains' || op === '$containsAny' },
      operator: expected,
      value,
    });
  });

  test('dotted and [] array paths in filters', () => {
    const r = parseJsQuery(
      "collection('a').find({ 'customer.address.city': 'Berlin', 'tags[]': { $contains: 'new' } })",
    );
    const conditions = (r.query.filter as { conditions: FieldFilter[] }).conditions;
    expect(conditions[0].path).toEqual({ path: 'customer.address.city', isArrayPath: false });
    expect(conditions[1].path).toEqual({ path: 'tags[]', isArrayPath: true });
  });

  test('sort object form accepts 1, -1, "asc" and "desc"', () => {
    const r = parseJsQuery("collection('a').sort({ a: 1, b: -1, c: 'asc', d: 'desc' })");
    expect(r.query.sort?.map((s) => `${s.path.path}:${s.direction}`)).toEqual([
      'a:asc',
      'b:desc',
      'c:asc',
      'd:desc',
    ]);
  });

  test('multiple sort() calls concatenate in call order', () => {
    const r = parseJsQuery("collection('a').sort({ a: 1 }).sort('b', 'desc').sort({ c: -1 })");
    expect(r.query.sort?.map((s) => `${s.path.path}:${s.direction}`)).toEqual([
      'a:asc',
      'b:desc',
      'c:desc',
    ]);
  });

  test('count() without find', () => {
    const r = parseJsQuery("collection('logs').count()");
    expect(r).toEqual({ entity: 'logs', action: 'count', query: { entity: 'logs' } });
  });

  test('count() with find keeps ONLY entity + filter', () => {
    const r = parseJsQuery("collection('logs').find({ level: 'error' }).count();");
    expect(r.action).toBe('count');
    expect(Object.keys(r.query).sort()).toEqual(['entity', 'filter']);
    expect((r.query.filter as FieldFilter).value).toBe('error');
  });

  test('limit(0) and skip(0) are valid', () => {
    const r = parseJsQuery("collection('a').limit(0).skip(0)");
    expect(r.query.limit).toBe(0);
    expect(r.query.offset).toBe(0);
  });

  test('optional trailing semicolon', () => {
    expect(parseJsQuery("collection('a').find();").entity).toBe('a');
  });

  test('limit/offset are absent from the query unless present in the text', () => {
    const r = parseJsQuery("collection('a').find({ x: 1 })");
    expect('limit' in r.query).toBe(false);
    expect('offset' in r.query).toBe(false);
    expect('sort' in r.query).toBe(false);
    expect('select' in r.query).toBe(false);
  });
});

describe('parseJsQuery — error type contract', () => {
  test('JsQueryParseError extends QueryValidationError with code/status and position', () => {
    const e = parseError("collection('a').find(x => x.a > 1)");
    expect(e).toBeInstanceOf(QueryValidationError);
    expect(e.code).toBe('QUERY_VALIDATION_FAILED');
    expect(e.statusCode).toBe(400);
    expect(e.name).toBe('JsQueryParseError');
    expect(typeof e.line).toBe('number');
    expect(typeof e.column).toBe('number');
    expect(e.message).toMatch(/\(line \d+, col \d+\)$/);
  });
});

describe('parseJsQuery — error paths', () => {
  test('arrow function in find', () => {
    const e = parseError("collection('a').find(x => x.a > 1)");
    expect(e.message).toContain('arrow functions are not supported');
    expect(e.line).toBe(1);
    expect(e.column).toBe(24);
  });

  test('template literal', () => {
    const e = parseError("collection('a').find({ a: `x` })");
    expect(e.message).toContain('template literals are not supported');
  });

  test('identifier as value', () => {
    const e = parseError("collection('a').find({ a: b })");
    expect(e.message).toContain('unexpected identifier "b"');
  });

  test('error position is correct on multiline sources', () => {
    const e = parseError("collection('a')\n  .find({ a: b })");
    expect(e.line).toBe(2);
    expect(e.column).toBe(14);
  });

  test('NaN and Infinity are rejected as values', () => {
    expect(parseError("collection('a').find({ a: NaN })").message).toContain(
      'unexpected identifier "NaN"',
    );
    expect(parseError("collection('a').find({ a: Infinity })").message).toContain(
      'unexpected identifier "Infinity"',
    );
    expect(parseError("collection('a').find({ a: -Infinity })").message).toContain(
      'unexpected character "-"',
    );
  });

  test('number overflowing to Infinity is rejected', () => {
    expect(parseError("collection('a').find({ a: 1e999 })").message).toContain('too large');
  });

  test('unknown method lists the supported ones', () => {
    const e = parseError("collection('a').explode()");
    expect(e.message).toContain('unknown method "explode"()');
    expect(e.message).toContain('find, where, sort, limit, skip, offset, select, count');
  });

  test('unknown $operator', () => {
    const e = parseError("collection('a').find({ a: { $frob: 1 } })");
    expect(e.message).toContain('unknown operator "$frob"');
  });

  test('unknown top-level $operator', () => {
    const e = parseError("collection('a').find({ $where: 'x' })");
    expect(e.message).toContain('unknown top-level operator "$where"');
  });

  test('mixed operators and plain keys', () => {
    const e = parseError("collection('a').find({ a: { $gt: 1, b: 2 } })");
    expect(e.message).toContain('cannot mix operators and plain keys on "a"');
  });

  test('nested plain object value', () => {
    const e = parseError("collection('a').find({ a: { b: 1 } })");
    expect(e.message).toContain('nested object match on "a" is not supported');
  });

  test.each(['__proto__', 'constructor', 'prototype'])(
    '%s as object key is rejected at parse time',
    (key) => {
      expect(parseError(`collection('a').find({ ${key}: 1 })`).message).toContain(
        `key "${key}" is not allowed`,
      );
      expect(parseError(`collection('a').find({ "${key}": 1 })`).message).toContain(
        `key "${key}" is not allowed`,
      );
      expect(parseError(`collection('a').select({ ${key}: 1 })`).message).toContain(
        `key "${key}" is not allowed`,
      );
    },
  );

  test('forbidden path segment inside a dotted path', () => {
    const e = parseError("collection('a').find({ 'a.constructor.b': 1 })");
    expect(e.message).toContain('segment "constructor" is not allowed');
  });

  test('forbidden path via two-string sort form', () => {
    const e = parseError("collection('a').sort('__proto__', 'asc')");
    expect(e.message).toContain('not allowed');
  });

  test('paren imbalance', () => {
    const e = parseError("collection('a'");
    expect(e.message).toContain('expected ")"');
    expect(e.message).toContain('end of input');
  });

  test('brace imbalance inside find', () => {
    const e = parseError("collection('a').find({ a: 1 )");
    expect(e.message).toContain('expected "," or "}"');
  });

  test('unterminated string', () => {
    const e = parseError("collection('a");
    expect(e.message).toContain('unterminated string literal');
    expect(e.line).toBe(1);
    expect(e.column).toBe(12);
  });

  test('string spanning a line break is unterminated', () => {
    const e = parseError("collection('a\n')");
    expect(e.message).toContain('strings cannot span lines');
  });

  test('unsupported escape sequence', () => {
    const e = parseError("collection('a').find({ a: 'b\\qc' })");
    expect(e.message).toContain('unsupported escape sequence "\\q"');
  });

  test('unterminated block comment', () => {
    const e = parseError("collection('a') /* never closed");
    expect(e.message).toContain('unterminated block comment');
  });

  test('garbage after the chain', () => {
    const e = parseError("collection('a').find() banana");
    expect(e.message).toContain('unexpected "banana" after the query');
  });

  test('tokens after the trailing semicolon', () => {
    const e = parseError("collection('a');x");
    expect(e.message).toContain('after the query — expected end of input');
  });

  test('count().limit(5) — count must be terminal', () => {
    const e = parseError("collection('a').count().limit(5)");
    expect(e.message).toContain('count() must be the last method in the chain');
  });

  test('count() combined with sort/limit/skip/select', () => {
    for (const prefix of ["sort({ a: 1 })", 'limit(5)', 'skip(2)', 'select({ a: 1 })']) {
      const e = parseError(`collection('a').${prefix}.count()`);
      expect(e.message).toContain('count() cannot be combined with sort/limit/skip/select');
    }
  });

  test('count() takes no arguments', () => {
    const e = parseError("collection('a').count(1)");
    expect(e.message).toContain('count() takes no arguments');
  });

  test('duplicate find()/where()', () => {
    expect(parseError("collection('a').find({}).find({})").message).toContain(
      'duplicate find()/where()',
    );
    expect(parseError("collection('a').find({}).where({ a: 1 })").message).toContain(
      'duplicate find()/where()',
    );
  });

  test('duplicate limit / select / skip-offset', () => {
    expect(parseError("collection('a').limit(1).limit(2)").message).toContain(
      'duplicate limit()',
    );
    expect(parseError("collection('a').select({ a: 1 }).select({ b: 1 })").message).toContain(
      'duplicate select()',
    );
    expect(parseError("collection('a').skip(1).offset(2)").message).toContain(
      'duplicate skip()/offset()',
    );
  });

  test('select with 0 value — exact exclusion message', () => {
    const e = parseError("collection('a').select({ a: 0 })");
    expect(e.message).toContain(
      'exclusion projections are not supported — list the fields you want with 1',
    );
  });

  test('select with a non-1 value', () => {
    const e = parseError("collection('a').select({ a: true })");
    expect(e.message).toContain('invalid select value for "a" — use 1 to include a field');
  });

  test('select with empty object', () => {
    const e = parseError("collection('a').select({})");
    expect(e.message).toContain('select() requires at least one field');
  });

  test('empty source', () => {
    const e = parseError('');
    expect(e.message).toContain('query is empty');
    expect(e.line).toBe(1);
    expect(e.column).toBe(1);
  });

  test('whitespace-only source', () => {
    expect(parseError('   \n\t  ').message).toContain('query is empty');
  });

  test('collection() with non-string argument', () => {
    const e = parseError('collection(users)');
    expect(e.message).toContain('collection() requires a string literal entity name');
  });

  test('root must be collection(...) or db.<name>', () => {
    const e = parseError("table('a').find()");
    expect(e.message).toContain('queries must start with collection("entity") or db.entity');
  });

  test('db. without a collection name', () => {
    const e = parseError('db.');
    expect(e.message).toContain('expected a collection name after "db."');
  });

  test('invalid entity names', () => {
    expect(parseError("collection('my-coll')").message).toContain(
      'invalid entity name "my-coll"',
    );
    expect(parseError("collection('')").message).toContain('invalid entity name');
    expect(parseError('db.$bad.find()').message).toContain('invalid entity name "$bad"');
  });

  test('SQL-injection-shaped field path is rejected by safe-path validation', () => {
    const e = parseError(`collection('a').find({ "x'); DROP TABLE users; --": 1 })`);
    expect(e.message).toContain('invalid field path');
  });

  test('paths with spaces, quotes or semicolons are rejected in select and sort', () => {
    expect(parseError("collection('a').select({ 'a b': 1 })").message).toContain(
      'invalid field path',
    );
    expect(parseError("collection('a').sort('a;b', 'asc')").message).toContain(
      'invalid field path',
    );
  });

  test('limit(-1)', () => {
    const e = parseError("collection('a').limit(-1)");
    expect(e.message).toContain('limit() must be a non-negative integer (got -1)');
  });

  test('limit(1.5)', () => {
    const e = parseError("collection('a').limit(1.5)");
    expect(e.message).toContain('limit() must be a non-negative integer (got 1.5)');
  });

  test('limit with no argument', () => {
    const e = parseError("collection('a').limit()");
    expect(e.message).toContain('limit() requires a non-negative integer argument');
  });

  test("skip('x')", () => {
    const e = parseError("collection('a').skip('x')");
    expect(e.message).toContain('skip() requires a non-negative integer argument');
  });

  test('sort with invalid direction string', () => {
    const e = parseError("collection('a').sort('a', 'up')");
    expect(e.message).toContain('invalid sort direction "up" — use "asc" or "desc"');
  });

  test('sort with a single string argument', () => {
    const e = parseError("collection('a').sort('a')");
    expect(e.message).toContain('expected ","');
  });

  test('sort with no arguments', () => {
    const e = parseError("collection('a').sort()");
    expect(e.message).toContain('sort() requires an object like { field: 1 }');
  });

  test('sort object with invalid direction value', () => {
    const e = parseError("collection('a').sort({ a: 2 })");
    expect(e.message).toContain('invalid sort direction for "a"');
  });

  test('more than 5 sort fields across calls', () => {
    const e = parseError("collection('a').sort({ a: 1, b: 1, c: 1 }).sort({ d: 1, e: 1, f: 1 })");
    expect(e.message).toContain('sort supports at most 5 fields in total');
  });

  test('find with a non-object argument', () => {
    const e = parseError("collection('a').find('x')");
    expect(e.message).toContain('find() requires an object literal argument');
  });

  test('find with two arguments', () => {
    const e = parseError("collection('a').find({}, {})");
    expect(e.message).toContain('expected ")"');
  });

  test('duplicate key in object literal', () => {
    const e = parseError("collection('a').find({ a: 1, a: 2 })");
    expect(e.message).toContain('duplicate key "a" in object literal');
  });

  test('unexpected operator characters', () => {
    expect(parseError("collection('a').find({ a: +1 })").message).toContain(
      'unexpected character "+"',
    );
    expect(parseError("collection('a').find({ a: 1 + 2 })").message).toContain(
      'unexpected character "+"',
    );
  });

  test('filter nesting beyond the depth cap', () => {
    let inner = '{ a: 1 }';
    for (let i = 0; i < 8; i++) inner = `{ $not: ${inner} }`;
    const e = parseError(`collection('a').find(${inner})`);
    expect(e.message).toContain('filter nesting exceeds 8 levels');
  });

  test('literal nesting beyond the parser depth cap', () => {
    const deep = `${'['.repeat(40)}1${']'.repeat(40)}`;
    const e = parseError(`collection('a').find({ a: { $in: ${deep} } })`);
    expect(e.message).toContain('literal nesting is too deep');
  });

  test('$in requires an array value', () => {
    const e = parseError("collection('a').find({ a: { $in: 1 } })");
    expect(e.message).toContain('requires an array value');
  });

  test('invalid regular expression', () => {
    const e = parseError("collection('a').find({ a: { $regex: '(' } })");
    expect(e.message).toContain('invalid regular expression');
  });

  test('$and requires a non-empty array', () => {
    const e = parseError("collection('a').find({ $and: [] })");
    expect(e.message).toContain('"$and" requires a non-empty array');
  });

  test('query text length cap', () => {
    const e = parseError(`collection('a').find({ a: '${'x'.repeat(100_001)}' })`);
    expect(e.message).toContain('query text is too long');
  });
});
