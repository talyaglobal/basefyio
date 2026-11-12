/**
 * The Postgres (JSONB) provider's filter compiler: every placeholder must
 * line up with its bind parameter, nested paths must use path arrays, and no
 * user-supplied text may reach the SQL string.
 */
import { PgFilterCompiler, sortExpr } from '../providers/postgres/postgres-engine';
import { normalizeFilterInput } from '../query/request-input';

function compile(filter: unknown, preset: unknown[] = ['p1', 'orders']) {
  const params = [...preset];
  const sql = new PgFilterCompiler(params).compile(normalizeFilterInput(filter)!);
  return { sql, params };
}

function placeholders(sql: string): number[] {
  return [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
}

describe('PgFilterCompiler', () => {
  it('numbers placeholders after the parameters already bound', () => {
    const { sql, params } = compile({ status: 'paid' });
    const used = placeholders(sql);
    expect(Math.min(...used)).toBe(3);
    expect(Math.max(...used)).toBe(params.length);
    expect(params[2]).toEqual(['status']);
    expect(params[3]).toBe('"paid"');
  });

  it('keeps placeholders aligned through nested logical filters', () => {
    const { sql, params } = compile({ $or: [{ a: 1 }, { $and: [{ 'b.c': { $gt: 2 } }, { d: { $in: ['x', 'y'] } }] }] });
    for (const n of placeholders(sql)) {
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(params.length);
    }
    expect(params).toContainEqual(['b', 'c']);
    expect(params).toContainEqual(['"x"', '"y"']);
  });

  it('binds nested paths as text[] instead of splicing them into SQL', () => {
    const { sql, params } = compile({ 'meta.city': 'Ankara' });
    expect(sql).toContain('data #> $3::text[]');
    expect(sql).not.toContain('meta');
    expect(params[2]).toEqual(['meta', 'city']);
  });

  it('matches array elements on equality', () => {
    const { sql } = compile({ tags: 'y' });
    expect(sql).toContain("jsonb_typeof");
    expect(sql).toContain('@> jsonb_build_array');
  });

  it('maps envelope paths to columns', () => {
    const { sql } = compile({ _status: 'active' });
    expect(sql).toContain('to_jsonb(status)');
  });

  it('compiles every operator', () => {
    const ops = ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$contains', '$containsAny', '$exists', '$regex', '$iregex', '$like', '$ilike'];
    for (const op of ops) {
      const value = ['$in', '$nin', '$containsAny'].includes(op) ? ['a'] : op === '$exists' ? true : 'a';
      expect(() => compile({ f: { [op]: value } })).not.toThrow();
    }
  });
});

describe('sortExpr', () => {
  it('maps envelope fields to columns and nested paths to jsonb paths', () => {
    expect(sortExpr('_createdAt')).toBe('created_at');
    expect(sortExpr('address.city')).toBe("(data #> '{address,city}')");
  });

  it('rejects unsafe paths', () => {
    expect(() => sortExpr("a'}') DESC; --")).toThrow();
  });
});
