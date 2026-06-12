import { compileRLS } from './rls-compiler';

describe('compileRLS', () => {
  const roles = [
    { name: 'admin', permissions: { customers: ['read', 'write', 'delete'] } },
    { name: 'viewer', permissions: { customers: ['read'] } },
  ];

  it('emits ENABLE ROW LEVEL SECURITY for each table', () => {
    const sql = compileRLS(['customers'], roles);
    expect(sql.some(s => s.includes('ENABLE ROW LEVEL SECURITY'))).toBe(true);
  });

  it('emits SELECT policy for read permission', () => {
    const sql = compileRLS(['customers'], roles);
    expect(sql.some(s => s.includes('customers_admin_select') && s.includes('FOR SELECT'))).toBe(true);
    expect(sql.some(s => s.includes('customers_viewer_select') && s.includes('FOR SELECT'))).toBe(true);
  });

  it('emits INSERT/UPDATE policy only for write permission', () => {
    const sql = compileRLS(['customers'], roles);
    expect(sql.some(s => s.includes('customers_admin_insert'))).toBe(true);
    expect(sql.some(s => s.includes('customers_viewer_insert'))).toBe(false);
  });

  it('emits DELETE policy only for delete permission', () => {
    const sql = compileRLS(['customers'], roles);
    expect(sql.some(s => s.includes('customers_admin_delete'))).toBe(true);
    expect(sql.some(s => s.includes('customers_viewer_delete'))).toBe(false);
  });

  it('skips unsafe table names', () => {
    const sql = compileRLS(['valid_table', 'DROP TABLE users--'], roles);
    expect(sql.some(s => s.includes('DROP'))).toBe(false);
    expect(sql.some(s => s.includes('"valid_table"'))).toBe(true);
  });
});
