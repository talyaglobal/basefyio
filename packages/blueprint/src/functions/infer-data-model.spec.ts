import { describe, expect, it } from 'vitest';
import { detectForeignKey, inferDataModel, inferFieldType } from './infer-data-model.js';

// ---------------------------------------------------------------------------
// inferFieldType
// ---------------------------------------------------------------------------
describe('inferFieldType', () => {
  it('detects number type from numeric strings', () => {
    expect(inferFieldType(['1', '2', '3', '42', '100'])).toBe('number');
  });

  it('detects number type from actual numbers', () => {
    expect(inferFieldType([1, 2, 3, 4])).toBe('number');
  });

  it('detects date type from ISO date strings', () => {
    expect(inferFieldType(['2024-01-15', '2023-12-01', '2025-06-10'])).toBe('date');
  });

  it('detects date type from d/m/yyyy format', () => {
    expect(inferFieldType(['01/01/2024', '15/06/2023', '31/12/2022'])).toBe('date');
  });

  it('detects boolean type from true/false strings', () => {
    expect(inferFieldType(['true', 'false', 'true', 'true'])).toBe('boolean');
  });

  it('detects boolean type from yes/no strings', () => {
    expect(inferFieldType(['yes', 'no', 'yes', 'no'])).toBe('boolean');
  });

  it('detects uuid type from uuid-formatted strings', () => {
    expect(inferFieldType([
      '550e8400-e29b-41d4-a716-446655440000',
      'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    ])).toBe('uuid');
  });

  it('detects text type for strings longer than 255 chars', () => {
    const longStr = 'a'.repeat(300);
    expect(inferFieldType([longStr, longStr, longStr])).toBe('text');
  });

  it('falls back to string for short mixed text', () => {
    expect(inferFieldType(['Alice', 'Bob', 'Charlie', 'Dave'])).toBe('string');
  });

  it('returns string for empty cells array', () => {
    expect(inferFieldType([])).toBe('string');
  });

  it('returns string when all cells are null or empty', () => {
    expect(inferFieldType([null, undefined, '', null])).toBe('string');
  });

  it('uses majority vote: 3 numbers vs 1 string → number', () => {
    expect(inferFieldType([42, 7, 100, 'foo'])).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// detectForeignKey
// ---------------------------------------------------------------------------
describe('detectForeignKey', () => {
  it('detects FK when column ends with _id and matches a known table', () => {
    expect(detectForeignKey('customer_id', ['customers', 'orders'])).toBe('customers');
  });

  it('detects FK when column ends with id (no underscore) and matches', () => {
    expect(detectForeignKey('orderid', ['order', 'products'])).toBe('order');
  });

  it('returns undefined when base name does not match any table', () => {
    expect(detectForeignKey('product_id', ['customers', 'orders'])).toBeUndefined();
  });

  it('returns undefined for a non-id column name', () => {
    expect(detectForeignKey('name', ['names', 'customers'])).toBeUndefined();
  });

  it('is case-insensitive in matching', () => {
    expect(detectForeignKey('Customer_ID', ['customers'])).toBe('customers');
  });

  it('returns undefined for empty known tables list', () => {
    expect(detectForeignKey('customer_id', [])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// inferDataModel
// ---------------------------------------------------------------------------
describe('inferDataModel', () => {
  it('creates one table per sheet', () => {
    const model = inferDataModel([
      { sheet: 'Customers', headers: ['id', 'name'], sampleRows: [] },
      { sheet: 'Orders', headers: ['id', 'total'], sampleRows: [] },
    ]);
    expect(model.tables).toHaveLength(2);
  });

  it('converts sheet names to snake_case for table names', () => {
    const model = inferDataModel([
      { sheet: 'Sales Orders', headers: ['id'], sampleRows: [] },
    ]);
    expect(model.tables[0].name).toBe('sales_orders');
    expect(model.tables[0].displayName).toBe('Sales Orders');
  });

  it('infers field types from sample rows', () => {
    const model = inferDataModel([
      {
        sheet: 'Products',
        headers: ['id', 'price', 'name', 'active'],
        sampleRows: [
          [1, 9.99, 'Widget', 'true'],
          [2, 14.5, 'Gadget', 'false'],
          [3, 3.0, 'Donut', 'true'],
        ],
      },
    ]);
    const fields = model.tables[0].fields;
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(byName['price'].type).toBe('number');
    expect(byName['name'].type).toBe('string');
    expect(byName['active'].type).toBe('boolean');
  });

  it('detects FK from column names referencing another table', () => {
    const model = inferDataModel([
      { sheet: 'Customers', headers: ['id', 'name'], sampleRows: [] },
      {
        sheet: 'Orders',
        headers: ['id', 'customer_id', 'total'],
        sampleRows: [
          [1, 10, 99.9],
          [2, 11, 45.0],
        ],
      },
    ]);
    const ordersTable = model.tables.find((t) => t.name === 'orders')!;
    const customerIdField = ordersTable.fields.find((f) => f.name === 'customer_id')!;
    expect(customerIdField.foreignKey).toBe('customers');
  });

  it('marks id field as primaryKey', () => {
    const model = inferDataModel([
      { sheet: 'Items', headers: ['id', 'label'], sampleRows: [] },
    ]);
    const idField = model.tables[0].fields.find((f) => f.name === 'id')!;
    expect(idField.primaryKey).toBe(true);
  });

  it('sets version to 1', () => {
    const model = inferDataModel([
      { sheet: 'Foo', headers: ['id'], sampleRows: [] },
    ]);
    expect(model.version).toBe(1);
  });

  it('handles sheets with no sample rows gracefully', () => {
    expect(() =>
      inferDataModel([{ sheet: 'Empty', headers: ['id', 'name'], sampleRows: [] }]),
    ).not.toThrow();
  });

  it('converts header names to snake_case for field names', () => {
    const model = inferDataModel([
      { sheet: 'Foo', headers: ['First Name', 'Last Name', 'Date Of Birth'], sampleRows: [] },
    ]);
    const names = model.tables[0].fields.map((f) => f.name);
    expect(names).toEqual(['first_name', 'last_name', 'date_of_birth']);
  });
});
