import {
  buildNoSqlFilter,
  buildNoSqlSort,
  buildNoSqlProjection,
  parseJsonQueryParam,
} from './nosql-filter.util';
import { describeIndex } from './collection.service';

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

    it('matches a nested dotted path with plain equality (not the first segment)', () => {
      const { where, params } = buildNoSqlFilter({ 'meta.city': 'Ankara' });
      expect(where).toContain('data @> $1::jsonb');
      expect(params[0]).toBe(JSON.stringify({ meta: { city: 'Ankara' } }));
      // …and an array element at that path
      expect(params[1]).toBe(JSON.stringify({ meta: { city: ['Ankara'] } }));
    });

    it('plain equality on an array field matches an element', () => {
      const { where, params } = buildNoSqlFilter({ tags: 'y' });
      expect(where).toBe('(data @> $1::jsonb OR data @> $2::jsonb)');
      expect(params).toEqual([JSON.stringify({ tags: 'y' }), JSON.stringify({ tags: ['y'] })]);
    });

    it('$in and $eq also look inside array fields', () => {
      const inF = buildNoSqlFilter({ tags: { $in: ['x'] } });
      expect(inF.where).toContain('jsonb_array_elements_text');
      expect(inF.params).toEqual(['x']);
      const eqF = buildNoSqlFilter({ 'meta.city': { $eq: 'Ankara' } });
      expect(eqF.where).toContain("data #>> '{meta,city}' = $1");
    });

    it('$nin keeps documents where the field is missing', () => {
      const { where } = buildNoSqlFilter({ tags: { $nin: ['x'] } });
      expect(where.startsWith('NOT COALESCE(')).toBe(true);
    });

    it('supports $like, $ilike, $all and $elemMatch', () => {
      expect(buildNoSqlFilter({ name: { $like: 'A%' } }).where).toBe("data->>'name' LIKE $1");
      expect(buildNoSqlFilter({ name: { $ilike: 'a%' } }).where).toBe("data->>'name' ILIKE $1");
      const all = buildNoSqlFilter({ tags: { $all: ['x', 'y'] } });
      expect(all.where).toBe("data->'tags' @> $1::jsonb");
      expect(all.params).toEqual([JSON.stringify(['x', 'y'])]);

      const objects = buildNoSqlFilter({ items: { $elemMatch: { sku: 'A', qty: { $gt: 2 } } } });
      expect(objects.where).toContain('EXISTS (SELECT 1 FROM jsonb_array_elements(');
      expect(objects.where).toContain('AS el1(value)');
      expect(objects.where).toContain('el1.value @> $1::jsonb');
      expect(objects.where).toContain("el1.value->>'qty'");

      const scalars = buildNoSqlFilter({ scores: { $elemMatch: { $gte: 80, $lt: 85 } } });
      expect(scalars.where).toContain("(el1.value #>> '{}')");
    });

    it('matches a sub-document with containment', () => {
      const { where, params } = buildNoSqlFilter({ address: { city: 'Ankara' } });
      expect(where).toBe('data @> $1::jsonb');
      expect(params).toEqual([JSON.stringify({ address: { city: 'Ankara' } })]);
    });

    it('$exists on a nested path checks the path, not a literal dotted key', () => {
      expect(buildNoSqlFilter({ 'a.b': { $exists: true } }).where).toBe("data #> '{a,b}' IS NOT NULL");
      expect(buildNoSqlFilter({ a: { $exists: false } }).where).toBe("NOT (data ? 'a')");
    });

    it('rejects malformed logical operators and operator values with 400s', () => {
      expect(() => buildNoSqlFilter({ $and: [] })).toThrow(/non-empty array/);
      expect(() => buildNoSqlFilter({ $or: ['x'] as any })).toThrow(/filter object/);
      expect(() => buildNoSqlFilter({ a: { $gt: 'abc' } })).toThrow(/number/);
      expect(() => buildNoSqlFilter({ a: { $exists: 'yes' } })).toThrow(/true or false/);
      expect(() => buildNoSqlFilter({ a: { $like: 5 } as any })).toThrow(/string/);
      expect(() => buildNoSqlFilter({ a: { $between: 1 } } as any)).toThrow(/Unknown filter operator/);
      expect(() => buildNoSqlFilter({ a: { $gt: 1, b: 2 } })).toThrow(/Cannot mix/);
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

    it('accepts "asc"/"desc" and rejects other directions', () => {
      expect(buildNoSqlSort({ name: 'desc' })).toContain('DESC');
      expect(() => buildNoSqlSort({ name: 'sideways' })).toThrow(/Invalid sort direction/);
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

  describe('parseJsonQueryParam', () => {
    it('answers 400 for broken JSON instead of a 500', () => {
      expect(() => parseJsonQueryParam('{"a":', 'sort')).toThrow(/sort is not valid JSON/);
      expect(() => parseJsonQueryParam('[1]', 'filter')).toThrow(/must be a JSON object/);
      expect(parseJsonQueryParam(undefined, 'filter')).toBeUndefined();
      expect(parseJsonQueryParam('{"a":1}', 'filter')).toEqual({ a: 1 });
    });
  });

  describe('describeIndex', () => {
    it('reads the field path and flags the indexes every collection has', () => {
      expect(describeIndex('idx_posts_status', "CREATE INDEX idx_posts_status ON nosql.posts USING btree (((data ->> 'status'::text)))").fieldPath).toBe('status');
      const nested = describeIndex('idx_posts_meta_city', "CREATE INDEX idx_posts_meta_city ON nosql.posts USING btree (((data #>> '{meta,city}'::text[])))");
      expect(nested).toMatchObject({ fieldPath: 'meta.city', system: false });
      expect(describeIndex('idx_posts_data_gin', 'CREATE INDEX idx_posts_data_gin ON nosql.posts USING gin (data)').system).toBe(true);
      expect(describeIndex('posts_pkey', 'CREATE UNIQUE INDEX posts_pkey ON nosql.posts USING btree (id)').system).toBe(true);
      expect(describeIndex('idx_posts-order', 'CREATE INDEX "idx_posts-order" ON nosql.posts USING btree (created_at, id)').system).toBe(true);
    });
  });
});
