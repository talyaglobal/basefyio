import {
  analyzeSheets,
  buildApplicationModel,
  buildDataModel,
  detectDomain,
  mergeDataModels,
  singularForms,
  validateDataModel,
} from './blueprint-builder';
import { DataModel } from './blueprint.types';

const customers = {
  name: 'customers',
  headers: ['customer_id', 'name', 'email'],
  rows: [
    [1, 'Acme', 'a@acme.test'],
    [2, 'Globex', 'g@globex.test'],
  ],
};
const orders = {
  name: 'orders',
  headers: ['order_id', 'customer_id', 'amount'],
  rows: [
    [10, 1, 5],
    [11, 2, 7.5],
    [12, 1, 3],
  ],
};

describe('blueprint-builder', () => {
  it('keeps a unique source id as the primary key and renames created_at instead of dropping it (#110)', () => {
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
    const t = dm.tables[0];
    const cols = t.columns.map((c) => c.name);
    expect(cols).toEqual(['id', 'name', 'email', 'source_created_at']);
    expect(t.primaryKey).toEqual(['id']);
    expect(t.columns.find((c) => c.name === 'source_created_at')?.type).toBe('date');
    expect(dm.warnings?.map((w) => w.code)).toContain('reserved_column_renamed');
  });

  it('renames a non-unique source id to source_id with a warning', () => {
    const dm = buildDataModel({
      teamId: 't',
      sheets: [{ name: 'Items', headers: ['id', 'title'], rows: [[1, 'a'], [1, 'b']] }],
    });
    const t = dm.tables[0];
    // A 0/1-only id column is a number, not a boolean.
    expect(t.columns[0].type).toBe('integer');
    expect(t.columns.map((c) => c.name)).toEqual(['source_id', 'title']);
    expect(t.primaryKey).toBeUndefined();
    expect(dm.warnings?.find((w) => w.code === 'duplicate_key_values')?.message).toMatch(/repeated/);
  });

  it('reads Turkish headers, decimal commas and day-first dates (#109)', () => {
    const dm = buildDataModel({
      teamId: 't',
      sheets: [
        {
          name: 'Müşteriler',
          headers: ['Müşteri Adı', 'Şehir', 'Tutar', 'Kayıt Tarihi'],
          rows: [
            ['Ayşe', 'İzmir', '12,50', '01.02.2026'],
            ['Can', 'Ankara', '1.234,75', '28.02.2026'],
          ],
        },
      ],
    });
    const t = dm.tables[0];
    expect(t.name).toBe('musteriler');
    expect(t.columns.map((c) => c.name)).toEqual(['musteri_adi', 'sehir', 'tutar', 'kayit_tarihi']);
    expect(t.columns.find((c) => c.name === 'tutar')?.type).toBe('numeric');
    expect(t.columns.find((c) => c.name === 'kayit_tarihi')?.type).toBe('date');
    expect(t.valueFormat).toEqual({ decimalSeparator: ',', dateOrder: 'DMY' });
  });

  it('detects natural keys and references between sheets (#112)', () => {
    const dm = buildDataModel({ teamId: 't', sheets: [customers, orders] });
    const c = dm.tables.find((t) => t.name === 'customers')!;
    const o = dm.tables.find((t) => t.name === 'orders')!;
    expect(c.primaryKey).toEqual(['customer_id']);
    expect(o.primaryKey).toEqual(['order_id']);
    expect(o.foreignKeys).toEqual([
      { column: 'customer_id', refTable: 'customers', refColumn: 'customer_id' },
    ]);
  });

  it('does not add a reference when some values have no match, and says why', () => {
    const dm = buildDataModel({
      teamId: 't',
      sheets: [customers, { ...orders, rows: [...orders.rows, [13, 99, 1]] }],
    });
    const o = dm.tables.find((t) => t.name === 'orders')!;
    expect(o.foreignKeys).toBeUndefined();
    expect(dm.warnings?.find((w) => w.code === 'reference_unmatched')?.message).toMatch(/1 value/);
  });

  it('matches "<singular>_id" columns to a table keyed by id', () => {
    const dm = buildDataModel({
      teamId: 't',
      sheets: [
        { name: 'categories', headers: ['id', 'title'], rows: [[1, 'A'], [2, 'B']] },
        { name: 'products', headers: ['sku', 'category_id'], rows: [['X1', 1], ['X2', 2]] },
      ],
    });
    const p = dm.tables.find((t) => t.name === 'products')!;
    expect(p.primaryKey).toEqual(['sku']);
    expect(p.foreignKeys).toEqual([{ column: 'category_id', refTable: 'categories', refColumn: 'id' }]);
  });

  it('keeps the source rows and the total row count of truncated sheets', () => {
    const { dataModel, sources } = analyzeSheets({
      teamId: 't',
      sheets: [{ ...customers, totalRows: 5000 }],
    });
    expect(sources[0]).toMatchObject({ table: 'customers', sheet: 'customers' });
    expect(sources[0].rows).toHaveLength(2);
    expect(dataModel.tables[0].rowCount).toBe(5000);
    expect(dataModel.warnings?.map((w) => w.code)).toContain('rows_truncated');
  });

  it('gives sheets that sanitize to the same name distinct table names', () => {
    const dm = buildDataModel({
      teamId: 't',
      sheets: [
        { name: 'Sales 2025', headers: ['a'], rows: [['1']] },
        { name: 'sales-2025', headers: ['a'], rows: [['1']] },
        { name: '***', headers: ['a'], rows: [['1']] },
      ],
    });
    expect(dm.tables.map((t) => t.name)).toEqual(['sales_2025', 'sales_2025_2', 'table_3']);
  });

  it('singularizes English and Turkish plurals', () => {
    expect(singularForms('customers')).toContain('customer');
    expect(singularForms('categories')).toContain('category');
    expect(singularForms('musteriler')).toContain('musteri');
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

describe('mergeDataModels (re-sync)', () => {
  const analyze = (sheets: any[]) => analyzeSheets({ teamId: 't', sheets });
  const rowsOf = (a: ReturnType<typeof analyze>) => new Map(a.sources.map((s) => [s.table, s.rows]));

  it('keeps draft edits and adds the new column (#113)', () => {
    const first = analyze([customers]).dataModel;
    // The owner renamed the table and a column, and made email unique.
    const edited: DataModel = JSON.parse(JSON.stringify(first));
    edited.tables[0].name = 'clients';
    edited.tables[0].columns.find((c) => c.name === 'name')!.name = 'full_name';
    edited.tables[0].columns.find((c) => c.name === 'email')!.unique = true;

    const second = analyze([
      { ...customers, headers: [...customers.headers, 'phone'], rows: customers.rows.map((r) => [...r, '555']) },
    ]);
    const { dataModel, tableNames } = mergeDataModels(edited, second.dataModel, rowsOf(second));
    const t = dataModel.tables[0];
    expect(t.name).toBe('clients');
    expect(tableNames.get('customers')).toBe('clients');
    expect(t.columns.map((c) => c.name)).toEqual(['customer_id', 'full_name', 'email', 'phone']);
    expect(t.columns.find((c) => c.name === 'email')?.unique).toBe(true);
    expect(t.primaryKey).toEqual(['customer_id']);
  });

  it('widens a kept type when new values no longer fit it', () => {
    const first = analyze([{ name: 's', headers: ['qty'], rows: [['1'], ['2']] }]).dataModel;
    const second = analyze([{ name: 's', headers: ['qty'], rows: [['1'], ['2,5']] }]);
    const { dataModel } = mergeDataModels(first, second.dataModel, rowsOf(second));
    expect(dataModel.tables[0].columns[0].type).toBe('numeric');
  });

  it('drops sheets and columns that left the file but keeps editor-added columns', () => {
    const first = analyze([customers, orders]).dataModel;
    first.tables[0].columns.push({
      name: 'notes',
      originalName: 'notes',
      type: 'text',
      nullable: true,
      sampleValues: [],
    });
    const second = analyze([{ ...customers, headers: ['customer_id', 'name'], rows: [[1, 'A']] }]);
    const { dataModel } = mergeDataModels(first, second.dataModel, rowsOf(second));
    expect(dataModel.tables.map((t) => t.name)).toEqual(['customers']);
    expect(dataModel.tables[0].columns.map((c) => c.name)).toEqual(['customer_id', 'name', 'notes']);
  });

  it('gives a legacy model (no version) full key and reference detection without clobbering its uuid id', () => {
    const legacy: DataModel = {
      tables: [
        {
          name: 'customers',
          label: 'customers',
          columns: [
            { name: 'customer_id', originalName: 'customer_id', type: 'integer', nullable: false, sampleValues: [] },
            { name: 'name', originalName: 'name', type: 'text', nullable: false, sampleValues: [] },
          ],
        },
        {
          name: 'orders',
          label: 'orders',
          columns: [
            { name: 'order_id', originalName: 'order_id', type: 'integer', nullable: false, sampleValues: [] },
            { name: 'customer_id', originalName: 'customer_id', type: 'integer', nullable: false, sampleValues: [] },
          ],
        },
      ],
    };
    const second = analyze([
      { name: 'customers', headers: ['id', 'customer_id', 'name', 'created_at'], rows: [[7, 1, 'A', '2026-01-01']] },
      { name: 'orders', headers: ['order_id', 'customer_id'], rows: [[10, 1]] },
    ]);
    const { dataModel } = mergeDataModels(legacy, second.dataModel, rowsOf(second));
    const c = dataModel.tables.find((t) => t.name === 'customers')!;
    const o = dataModel.tables.find((t) => t.name === 'orders')!;
    expect(c.columns.map((x) => x.name)).toEqual(['source_id', 'customer_id', 'name', 'source_created_at']);
    expect(c.primaryKey).toBeUndefined();
    expect(o.primaryKey).toEqual(['order_id']);
    expect(dataModel.version).toBe(2);
  });
});

describe('validateDataModel (draft editing, #111)', () => {
  const base = () => JSON.parse(JSON.stringify(buildDataModel({ teamId: 't', sheets: [customers, orders] })));

  it('accepts a valid edit and forces key columns to be required', () => {
    const m = base();
    m.tables[0].columns[1].name = 'company';
    m.tables[0].columns[0].nullable = true;
    const r = validateDataModel(m, null);
    expect(r.errors).toEqual([]);
    expect(r.model!.tables[0].columns[1].name).toBe('company');
    expect(r.model!.tables[0].columns[0].nullable).toBe(false);
  });

  it('rejects reserved, duplicate and invalid names', () => {
    const m = base();
    m.tables[0].columns[1].name = 'created_at';
    m.tables[0].columns[2].name = 'customer_id';
    m.tables[1].name = 'bad name';
    const r = validateDataModel(m, null);
    expect(r.model).toBeNull();
    expect(r.errors.join('\n')).toMatch(/reserved/);
    expect(r.errors.join('\n')).toMatch(/Two columns/);
    expect(r.errors.join('\n')).toMatch(/Invalid name/);
  });

  it('rejects a column named id on a table with a generated key', () => {
    const m = base();
    delete m.tables[0].primaryKey;
    m.tables[0].columns[0].name = 'id';
    delete m.tables[1].foreignKeys;
    expect(validateDataModel(m, null).errors.join()).toMatch(/reserved for the generated key/);
  });

  it('checks references: target must be a key or unique column of the same type', () => {
    const m = base();
    m.tables[1].foreignKeys = [{ column: 'amount', refTable: 'customers', refColumn: 'name' }];
    expect(validateDataModel(m, null).errors.join()).toMatch(/primary key or a unique column/);

    m.tables[0].columns.find((c: any) => c.name === 'name').unique = true;
    expect(validateDataModel(m, null).errors.join()).toMatch(/types differ/);

    m.tables[1].foreignKeys = [{ column: 'customer_id', refTable: 'customers', refColumn: 'customer_id' }];
    expect(validateDataModel(m, null).errors).toEqual([]);
  });

  it('rejects unknown types', () => {
    const m = base();
    m.tables[0].columns[1].type = 'varchar(9)';
    expect(validateDataModel(m, null).errors.join()).toMatch(/Unsupported type/);
  });
});
