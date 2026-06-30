import { buildDataModel, detectDomain, buildApplicationModel } from './blueprint-builder';

describe('blueprint-builder', () => {
  it('infers tables and drops reserved columns (id/created_at/updated_at)', () => {
    const dm = buildDataModel({
      teamId: 't',
      sheets: [
        {
          name: 'Customers',
          headers: ['id', 'name', 'email', 'created_at'],
          rows: [[1, 'Acme', 'a@b.com', '2020-01-01']],
        },
      ],
    });
    expect(dm.tables).toHaveLength(1);
    const cols = dm.tables[0].columns.map((c) => c.name);
    expect(cols).toContain('name');
    expect(cols).toContain('email');
    expect(cols).not.toContain('id');
    expect(cols).not.toContain('created_at');
  });

  it('detects the orders domain from sheet/column names', () => {
    const dm = buildDataModel({
      teamId: 't',
      sheets: [{ name: 'Orders', headers: ['order_no', 'amount'], rows: [['1', '5']] }],
    });
    expect(detectDomain(dm)).toBe('orders');
  });

  it('builds an application model with roles and per-table navigation', () => {
    const dm = buildDataModel({
      teamId: 't',
      sheets: [{ name: 'Products', headers: ['title', 'price'], rows: [['x', '1']] }],
    });
    const app = buildApplicationModel(dm, detectDomain(dm));
    expect(app.roles.map((r) => r.name)).toEqual(['Admin', 'Member']);
    expect(app.navigation.length).toBe(dm.tables.length);
    expect(app.tables).toEqual(dm.tables.map((t) => t.name));
  });
});
