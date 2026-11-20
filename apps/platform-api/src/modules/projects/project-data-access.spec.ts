import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_DATA_ACCESS,
  RLS_ON_NEW_TABLES_TRIGGER,
  dataAccessOf,
  renderDataAccessSql,
  renderRlsBootstrap,
  withDataAccessDefaults,
} from './project-data-access';

const TEMPLATE = readFileSync(join(__dirname, 'sql', 'rls-bootstrap.sql'), 'utf8');
const OWNER = 'kb_user_abc123';
const TABLE_PRIVS = 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER';

const norm = (sql: string) => sql.replace(/\s+/g, ' ');

describe('data access defaults', () => {
  it('are what every project had before the setting existed', () => {
    expect(DEFAULT_DATA_ACCESS).toEqual({ dataApi: true, autoGrantNewTables: true, rlsOnNewTables: false });
    expect(withDataAccessDefaults()).toEqual(DEFAULT_DATA_ACCESS);
    expect(withDataAccessDefaults({ rlsOnNewTables: true })).toEqual({ ...DEFAULT_DATA_ACCESS, rlsOnNewTables: true });
  });

  it('read a row with missing columns as the defaults', () => {
    expect(dataAccessOf({})).toEqual(DEFAULT_DATA_ACCESS);
    expect(dataAccessOf({ dataApiEnabled: false, autoGrantNewTables: null })).toEqual({
      ...DEFAULT_DATA_ACCESS,
      dataApi: false,
    });
  });
});

describe('renderRlsBootstrap', () => {
  it('with the defaults grants new and existing tables to anon and authenticated, as before', () => {
    const sql = norm(renderRlsBootstrap(TEMPLATE, OWNER, DEFAULT_DATA_ACCESS));
    expect(sql).toContain(`FOR ROLE "${OWNER}" IN SCHEMA public GRANT SELECT ON TABLES TO anon;`);
    expect(sql).toContain(`FOR ROLE "${OWNER}" IN SCHEMA public GRANT ${TABLE_PRIVS} ON TABLES TO authenticated;`);
    expect(sql).toContain('GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;');
    expect(sql).toContain('ON ALL TABLES IN SCHEMA public TO authenticated;');
    expect(sql).not.toContain(`REVOKE ${TABLE_PRIVS}`);
    expect(sql).not.toContain('CREATE EVENT TRIGGER');
  });

  it('leaves no placeholder or section marker behind', () => {
    for (const flags of [DEFAULT_DATA_ACCESS, { dataApi: true, autoGrantNewTables: false, rlsOnNewTables: true }]) {
      const sql = renderRlsBootstrap(TEMPLATE, OWNER, flags);
      expect(sql).not.toMatch(/%BF_/);
      expect(sql).not.toMatch(/\{\{[#/]autoGrant\}\}/);
    }
  });

  it('without automatic grants skips anon/authenticated grants but keeps service_role', () => {
    const sql = norm(renderRlsBootstrap(TEMPLATE, OWNER, { ...DEFAULT_DATA_ACCESS, autoGrantNewTables: false }));
    expect(sql).not.toContain('GRANT SELECT ON TABLES TO anon;');
    expect(sql).not.toContain('GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;');
    expect(sql).not.toMatch(/ON ALL TABLES IN SCHEMA public TO authenticated/);
    expect(sql).toContain(`REVOKE ${TABLE_PRIVS} ON TABLES FROM anon, authenticated;`);
    expect(sql).toContain('ON TABLES TO service_role;');
    expect(sql).toContain('ON ALL TABLES IN SCHEMA public TO service_role;');
  });

  it('installs the RLS event trigger only when asked, and drops it otherwise', () => {
    const on = renderRlsBootstrap(TEMPLATE, OWNER, { ...DEFAULT_DATA_ACCESS, rlsOnNewTables: true });
    expect(on).toContain(`CREATE EVENT TRIGGER ${RLS_ON_NEW_TABLES_TRIGGER} ON ddl_command_end`);
    expect(on).toContain('ENABLE ROW LEVEL SECURITY');
    expect(on).toContain('SECURITY DEFINER');
    expect(norm(on)).toContain(`FROM PUBLIC, anon, authenticated, service_role, "${OWNER}";`);
    const off = renderRlsBootstrap(TEMPLATE, OWNER, DEFAULT_DATA_ACCESS);
    expect(off).toContain(`DROP EVENT TRIGGER ${RLS_ON_NEW_TABLES_TRIGGER};`);
  });

  it('refuses an owner that is not a plain identifier', () => {
    expect(() => renderRlsBootstrap(TEMPLATE, 'x"; DROP', DEFAULT_DATA_ACCESS)).toThrow();
    expect(() => renderDataAccessSql('Bad-Owner', DEFAULT_DATA_ACCESS)).toThrow();
  });

  it('refuses a template without the data access placeholder', () => {
    expect(() => renderRlsBootstrap('SELECT 1;', OWNER, DEFAULT_DATA_ACCESS)).toThrow(/placeholder/);
  });
});
