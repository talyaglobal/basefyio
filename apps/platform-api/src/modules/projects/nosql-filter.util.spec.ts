import {
  buildNoSqlFilter,
  buildNoSqlSort,
  buildNoSqlProjection,
} from './nosql-filter.util';

describe('nosql-filter.util', () => {
  describe('buildNoSqlFilter', () => {
    it('returns empty for null / empty filters', () => {
      expect(buildNoSqlFilter(null)).toEqual({ where: '', params: [] });
      expect(buildNoSqlFilter({})).toEqual({ where: '', params: [] });
    });

    it('parameterizes values (no raw value in the SQL string)', () => {
      const { where, params } = buildNoSqlFilter({ status: 'active' });
      expect(where).toContain('$1');
      // The value is bound as a JSONB parameter (data @> $1::jsonb), never
      // inlined into the SQL string — that is the injection-safe property.
      expect(where).not.toContain('active');
      expect(JSON.stringify(params)).toContain('active');
    });

    it('nests dotted paths for bare equality (#176)', () => {
      const { where, params } = buildNoSqlFilter({ 'meta.city': 'Ankara' });
      expect(params[0]).toBe(JSON.stringify({ meta: { city: 'Ankara' } }));
      expect(where).toContain("data #> '{meta,city}' @>");
    });

    it('matches a scalar against array membership for bare equality (#176)', () => {
      const { where, params } = buildNoSqlFilter({ tags: 'y' });
      expect(params).toEqual([JSON.stringify({ tags: 'y' }), JSON.stringify(['y'])]);
      expect(where).toContain("data->'tags' @> $2::jsonb");
    });

    it('keeps array equality exact', () => {
      const { where, params } = buildNoSqlFilter({ tags: ['a'] });
      expect(params).toHaveLength(1);
      expect(where).toBe('data @> $1::jsonb');
    });

    it('shifts placeholders by paramOffset', () => {
      const { where } = buildNoSqlFilter({ status: 'active' }, 5);
      expect(where).toContain('$6');
      expect(where).not.toContain('$1');
    });
  });

  describe('buildNoSqlSort', () => {
    it('returns empty string for null / empty sort', () => {
      expect(buildNoSqlSort(null)).toBe('');
      expect(buildNoSqlSort({})).toBe('');
    });

    it('maps -1 to DESC and uses real columns for meta fields', () => {
      expect(buildNoSqlSort({ created_at: -1 })).toContain('"created_at" DESC');
      expect(buildNoSqlSort({ name: 1 })).toContain('ASC');
    });

    it('rejects an injection attempt in the field name', () => {
      expect(() => buildNoSqlSort({ "a'; DROP TABLE x; --": 1 } as any)).toThrow();
    });
  });

  describe('buildNoSqlProjection', () => {
    it('returns null when there is nothing to project', () => {
      expect(buildNoSqlProjection(null)).toBeNull();
      expect(buildNoSqlProjection({})).toBeNull();
    });

    it('builds a jsonb_build_object of only included fields', () => {
      const proj = buildNoSqlProjection({ name: 1, secret: 0 });
      expect(proj).toContain('jsonb_build_object');
      expect(proj).toContain('name');
      expect(proj).not.toContain('secret');
    });

    it('rejects an injection attempt in a projected field', () => {
      expect(() => buildNoSqlProjection({ "x'; DROP": 1 } as any)).toThrow();
    });
  });
});

describe('buildNoSqlFilter — $like, $ilike, $all, $elemMatch (#176)', () => {
  it('$like / $ilike bind the pattern', () => {
    expect(buildNoSqlFilter({ name: { $like: 'An%' } })).toEqual({ where: "data->>'name' LIKE $1", params: ['An%'] });
    expect(buildNoSqlFilter({ name: { $ilike: '%bar' } }).where).toBe("data->>'name' ILIKE $1");
  });

  it('$all asks the array to hold every value', () => {
    expect(buildNoSqlFilter({ tags: { $all: ['x', 'y'] } })).toEqual({ where: "data->'tags' @> $1::jsonb", params: ['["x","y"]'] });
  });

  it('$elemMatch over element fields, guarded against non-arrays', () => {
    const { where, params } = buildNoSqlFilter({ items: { $elemMatch: { sku: 'b', qty: { $gt: 5 } } } });
    expect(where).toContain("CASE WHEN jsonb_typeof(data->'items') = 'array'");
    expect(where).toContain("FROM jsonb_array_elements(data->'items') AS e0");
    expect(where).toContain("(e0.value->>'qty')::numeric > $3");
    expect(params).toEqual(['{"sku":"b"}', '["b"]', 5]);
  });

  it('$elemMatch with operators applies them to the element itself', () => {
    const { where, params } = buildNoSqlFilter({ scores: { $elemMatch: { $gte: 8 } } });
    expect(where).toContain("((e0.value #>> '{}'))::numeric >= $1");
    expect(params).toEqual([8]);
  });

  it('rejects malformed operands', () => {
    expect(() => buildNoSqlFilter({ tags: { $all: [] } })).toThrow('$all requires a non-empty array');
    expect(() => buildNoSqlFilter({ tags: { $elemMatch: {} } })).toThrow('$elemMatch requires a non-empty object');
    expect(() => buildNoSqlFilter({ name: { $like: 3 } })).toThrow('$like requires a string pattern');
  });
});
