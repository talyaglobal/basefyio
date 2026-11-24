import { STARTER_KEYS, isStarterKey, starterSql, starterTables } from './starter-templates';

/** #240: the advisor's starters, created for real. Checked against PostgreSQL 16 by hand (rolled back). */
describe('starter templates', () => {
  it.each(STARTER_KEYS)('%s: every table is new-only, in public, with id, owner and time', (key) => {
    const sql = starterSql(key);
    expect(sql.length).toBe(starterTables(key).length);
    for (const stmt of sql) {
      expect(stmt).toMatch(/^CREATE TABLE IF NOT EXISTS public\.[a-z_]+ \(/);
      expect(stmt).toContain('id uuid PRIMARY KEY DEFAULT gen_random_uuid()');
      expect(stmt).toContain('owner_id text DEFAULT auth.uid()');
      expect(stmt).toContain('created_at timestamptz NOT NULL DEFAULT now()');
    }
  });

  it.each(STARTER_KEYS)('%s: a table is referenced only after it was created', (key) => {
    const created = new Set<string>();
    for (const stmt of starterSql(key)) {
      for (const m of stmt.matchAll(/REFERENCES public\.([a-z_]+)\(/g)) expect(created.has(m[1])).toBe(true);
      created.add(/public\.([a-z_]+) \(/.exec(stmt)![1]);
    }
  });

  it('accepts only the known keys', () => {
    expect(isStarterKey('CRM')).toBe(true);
    expect(isStarterKey('crm; anything')).toBe(false);
    expect(isStarterKey(undefined)).toBe(false);
  });
});
