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
