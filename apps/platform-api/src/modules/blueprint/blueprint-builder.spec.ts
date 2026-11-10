import { buildDataModel, detectDomain, buildApplicationModel } from './blueprint-builder';

describe('blueprint-builder', () => {
  it('keeps a source column that collides with a system column under a new name, with a warning', () => {
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
    expect(cols).toEqual(['source_id', 'name', 'email', 'source_created_at']);
    expect(dm.warnings).toHaveLength(2);
    expect(dm.warnings![1]).toContain('source_created_at');
  });

  it('reads Turkish decimals and dates as numbers and dates, and folds Turkish letters', () => {
    const dm = buildDataModel({
      teamId: 't',
      sheets: [
        {
          name: 'musteriler',
          headers: ['Müşteri Adı', 'Şehir', 'Tutar', 'Kayıt Tarihi'],
          rows: [
            ['Ayşe', 'İzmir', '12,50', '01.02.2026'],
            ['Can', 'Ankara', '7,25', '15.03.2026'],
          ],
        },
      ],
    });
    const byName = Object.fromEntries(dm.tables[0].columns.map((c) => [c.name, c.type]));
    expect(byName).toEqual({
      musteri_adi: 'text',
      sehir: 'text',
      tutar: 'numeric',
      kayit_tarihi: 'date',
    });
    expect(dm.warnings).toBeUndefined();
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

  it('links orders.customer_id to the customers table that has the same column', () => {
    const dm = buildDataModel({
      teamId: 't',
      sheets: [
        { name: 'customers', headers: ['customer_id', 'name'], rows: [[1, 'Acme'], [2, 'Bolt']] },
        { name: 'orders', headers: ['order_id', 'customer_id'], rows: [[10, 1], [11, 2]] },
      ],
    });
    expect(dm.relations).toEqual([
      { fromTable: 'orders', fromColumn: 'customer_id', toTable: 'customers', toColumn: 'customer_id' },
    ]);
  });

  it('adds no link when no table matches the column prefix', () => {
    const dm = buildDataModel({
      teamId: 't',
      sheets: [
        { name: 'products', headers: ['sku', 'name'], rows: [['a', 'x']] },
        { name: 'orders', headers: ['order_id', 'customer_id'], rows: [[10, 1]] },
      ],
    });
    expect(dm.relations).toBeUndefined();
  });
});
