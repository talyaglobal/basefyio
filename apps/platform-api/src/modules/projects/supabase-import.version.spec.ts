// Same reason as supabase-import.service.spec.ts: these imports reach ESM-only code.
jest.mock('./projects.service', () => ({ ProjectsService: class {} }));
jest.mock('../auth/keycloak-admin.service', () => ({ KeycloakAdminService: class {} }));
jest.mock('pg', () => ({ Pool: jest.fn() }));
jest.mock('dockerode', () => jest.fn());

import { readSourceMajorVersion } from './supabase-import.service';

/**
 * A fake source database. It answers like Postgres does: a query that does not
 * name its column gets the setting's own name, which is what broke
 * `show server_version` + `rows[0].v`.
 */
function source(version: string) {
  const queries: string[] = [];
  return {
    queries,
    pool: {
      query: async (sql: string) => {
        queries.push(sql);
        if (/show server_version/i.test(sql)) return { rows: [{ server_version: version }] };
        if (/current_setting\('server_version'\) as v/i.test(sql)) return { rows: [{ v: version }] };
        return { rows: [] };
      },
    },
  };
}

describe('readSourceMajorVersion', () => {
  it.each([
    ['17.6.1.071', 17],
    ['15.1', 15],
    ['16.4 (Debian 16.4-1.pgdg120+1)', 16],
  ])('reads the major version out of %s', async (raw, major) => {
    const { pool } = source(raw);
    await expect(readSourceMajorVersion(pool)).resolves.toEqual({ major, raw });
  });

  it('names the column, so it can never be read as empty again', async () => {
    const { pool, queries } = source('17.6.1.071');
    await readSourceMajorVersion(pool);
    expect(queries[0]).toMatch(/current_setting\('server_version'\) as v/i);
    expect(queries[0]).not.toMatch(/^\s*show /i);
  });

  it('reports an unreadable version as null, with what it saw', async () => {
    const { pool } = source('not a number');
    await expect(readSourceMajorVersion(pool)).resolves.toEqual({ major: null, raw: 'not a number' });
  });

  it('treats an empty answer as unreadable instead of throwing', async () => {
    const pool = { query: async () => ({ rows: [] }) };
    await expect(readSourceMajorVersion(pool)).resolves.toEqual({ major: null, raw: '' });
  });
});
