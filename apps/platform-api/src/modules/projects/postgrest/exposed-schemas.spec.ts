import {
  ExposedSchemasError,
  MAX_EXPOSED_SCHEMAS,
  chooseProfile,
  exposedProfiles,
  exposedSchemaProblem,
  qualifiedRelation,
  restSchemasView,
  validateExposedSchemas,
} from './exposed-schemas';

describe('exposed REST schemas (#264)', () => {
  describe('validateExposedSchemas', () => {
    it('accepts plain identifiers, keeps their order, drops duplicates and public', () => {
      expect(validateExposedSchemas(['r6s', 'public', 'billing_v2', 'r6s', ' Reports '])).toEqual(['r6s', 'billing_v2', 'Reports']);
      expect(validateExposedSchemas([])).toEqual([]);
    });

    it.each([
      'pg_catalog',
      'pg_toast',
      'pg_temp_3',
      'PG_CATALOG',
      'information_schema',
      'auth',
      'Auth',
      'storage',
      'realtime',
      'extensions',
      'graphql',
      'graphql_public',
      'vault',
      'pgsodium',
      'cron',
      'net',
      'nosql',
      'basefyio_internal',
      'basefyio_anything',
      'kolaybase',
      '_realtime',
      '_timescaledb_internal',
      'supabase_functions',
      'supabase_migrations',
    ])('refuses the system or platform schema %s', (name) => {
      expect(() => validateExposedSchemas([name])).toThrow(ExposedSchemasError);
      expect(() => validateExposedSchemas([name])).toThrow(/system or platform schema/);
    });

    it.each(['', ' ', '1abc', 'a-b', 'a.b', 'a"b', 'a;drop', 'a b', 'é', 'x'.repeat(64)])(
      'refuses the invalid identifier %j',
      (name) => {
        expect(() => validateExposedSchemas([name])).toThrow(/not a valid schema name/);
      },
    );

    it('refuses a value that is not a list of strings', () => {
      expect(() => validateExposedSchemas('r6s')).toThrow(ExposedSchemasError);
      expect(() => validateExposedSchemas([1])).toThrow(ExposedSchemasError);
      expect(() => validateExposedSchemas(null)).toThrow(ExposedSchemasError);
    });

    it(`caps the list at ${MAX_EXPOSED_SCHEMAS}`, () => {
      const many = Array.from({ length: MAX_EXPOSED_SCHEMAS + 1 }, (_, i) => `s${i}`);
      expect(() => validateExposedSchemas(many)).toThrow(/At most/);
      expect(validateExposedSchemas(many.slice(0, MAX_EXPOSED_SCHEMAS))).toHaveLength(MAX_EXPOSED_SCHEMAS);
    });

    it('allows a 63-character name', () => {
      expect(exposedSchemaProblem('a'.repeat(63))).toBeNull();
    });
  });

  describe('exposedProfiles', () => {
    it('is public only by default', () => {
      expect(exposedProfiles(undefined)).toEqual(['public']);
      expect(exposedProfiles(null)).toEqual(['public']);
      expect(exposedProfiles([])).toEqual(['public']);
    });

    it('puts public first and ignores anything that would not validate', () => {
      expect(exposedProfiles(['r6s', 'auth', 'public', 'a"b', 'r6s', 'pg_catalog', 'reports'])).toEqual(['public', 'r6s', 'reports']);
    });
  });

  describe('chooseProfile', () => {
    const exposed = ['public', 'r6s'];

    it('serves public when no header is sent', () => {
      expect(chooseProfile(undefined, exposed)).toEqual({ ok: true, schema: 'public' });
      expect(chooseProfile(undefined, ['public'])).toEqual({ ok: true, schema: 'public' });
    });

    it('serves a listed schema, matched exactly', () => {
      expect(chooseProfile('r6s', exposed)).toEqual({ ok: true, schema: 'r6s' });
      expect(chooseProfile('public', exposed)).toEqual({ ok: true, schema: 'public' });
    });

    it('refuses anything else, naming the listed schemas', () => {
      for (const h of ['R6S', 'auth', 'pg_catalog', '"r6s"', 'r6s,public']) {
        expect(chooseProfile(h, exposed)).toEqual({
          ok: false,
          message: 'The schema must be one of the following: public, r6s',
        });
      }
    });
  });

  it('qualifies a relation outside public only', () => {
    expect(qualifiedRelation(undefined, 'items')).toBe('"items"');
    expect(qualifiedRelation('public', 'items')).toBe('"items"');
    expect(qualifiedRelation('r6s', 'items')).toBe('"r6s"."items"');
  });

  it('answers the settings view with public first', () => {
    expect(restSchemasView([])).toEqual({ schemas: ['public'], exposedSchemas: [] });
    expect(restSchemasView(['r6s'])).toEqual({ schemas: ['public', 'r6s'], exposedSchemas: ['r6s'] });
  });
});
