import {
  batchSize,
  buildAccessStatements,
  buildCreateTable,
  buildForeignKey,
  buildGenerationSql,
  buildInsert,
  prepareRows,
  qi,
  sourceFor,
} from './blueprint-ddl';
import { buildDataModel } from './blueprint-builder';
import { DataModelTable } from './blueprint.types';

const col = (name: string, type: any = 'text', extra: Record<string, unknown> = {}) => ({
  name,
  originalName: name,
  type,
  nullable: true,
  sampleValues: [],
  ...extra,
});

describe('blueprint-ddl', () => {
  it('creates a natural primary key and unique columns without a generated id', () => {
    const sql = buildCreateTable({
      name: 'customers',
      label: 'customers',
      primaryKey: ['customer_id'],
      columns: [
        col('customer_id', 'integer', { nullable: false }),
        col('email', 'text', { unique: true }),
      ],
    });
    expect(sql).not.toMatch(/gen_random_uuid/);
    expect(sql).toMatch(/"customer_id" INTEGER NOT NULL/);
    expect(sql).toMatch(/CONSTRAINT "customers_pkey" PRIMARY KEY \("customer_id"\)/);
    expect(sql).toMatch(/CONSTRAINT "customers_email_key" UNIQUE \("email"\)/);
    expect(sql).toMatch(/"created_at" TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
  });

  it('falls back to a generated uuid id key', () => {
    const sql = buildCreateTable({ name: 'notes', label: 'notes', columns: [col('body')] });
    expect(sql).toMatch(/"id" UUID NOT NULL DEFAULT gen_random_uuid\(\)/);
    expect(sql).toMatch(/PRIMARY KEY \("id"\)/);
  });

  it('opens tables to signed-in users only as the access mode says', () => {
    const service = buildAccessStatements('t', 'service_role').join('\n');
    expect(service).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(service).not.toMatch(/TO authenticated USING/);
    expect(buildAccessStatements('t', 'authenticated_read').join('\n')).toMatch(
      /FOR SELECT TO authenticated USING \(true\)/,
    );
    expect(buildAccessStatements('t', 'authenticated_write').join('\n')).toMatch(
      /FOR ALL TO authenticated USING \(true\) WITH CHECK \(true\)/,
    );
  });

  it('adds foreign keys after every table in the generation SQL', () => {
    const model = buildDataModel({
      teamId: 't',
      sheets: [
        { name: 'orders', headers: ['order_id', 'customer_id'], rows: [[1, 1]] },
        { name: 'customers', headers: ['customer_id', 'name'], rows: [[1, 'A']] },
      ],
    });
    const sql = buildGenerationSql(model, 'service_role');
    const fkIdx = sql.findIndex((s) => /FOREIGN KEY/.test(s));
    const lastCreate = sql.map((s, i) => (/^CREATE TABLE/.test(s) ? i : -1)).filter((i) => i >= 0).pop()!;
    expect(fkIdx).toBeGreaterThan(lastCreate);
    expect(sql[fkIdx]).toBe(
      buildForeignKey('orders', { column: 'customer_id', refTable: 'customers', refColumn: 'customer_id' }),
    );
  });

  it('refuses unsafe identifiers', () => {
    expect(() => qi('a"; DROP TABLE x; --')).toThrow(/unsafe/);
  });

  it('casts rows with the file format and skips rows that cannot be stored (#109, #112)', () => {
    const table: DataModelTable = {
      name: 'sales',
      label: 'Satışlar',
      primaryKey: ['kod'],
      valueFormat: { decimalSeparator: ',', dateOrder: 'DMY' },
      columns: [
        col('kod', 'text', { nullable: false, sourceIndex: 0 }),
        col('tutar', 'numeric', { sourceIndex: 1 }),
        col('tarih', 'date', { sourceIndex: 2 }),
        col('extra', 'text'), // added in the editor: no source
      ],
    };
    const prepared = prepareRows(table, {
      table: 'sales',
      sheet: 'Satışlar',
      headers: ['Kod', 'Tutar', 'Tarih'],
      rows: [
        ['A', '12,50', '01.02.2026'],
        ['B', '1.234,75', '28.02.2026'],
        ['A', '1', '01.01.2026'], // repeated key
        ['C', 'abc', '01.01.2026'], // not a number
        ['', '', ''], // blank line
      ],
    });
    expect(prepared.columns).toEqual(['kod', 'tutar', 'tarih']);
    expect(prepared.rows).toEqual([
      ['A', '12.50', '2026-02-01'],
      ['B', '1234.75', '2026-02-28'],
    ]);
    expect(prepared.skipped).toBe(2);
    expect(prepared.errors[0]).toMatch(/^row 4: repeated primary key/);
    expect(prepared.errors[1]).toMatch(/^row 5: column "tutar"/);
  });

  it('finds the source by sheet name even after the table was renamed', () => {
    const sources = [{ table: 'old', sheet: 'Sheet A', headers: [], rows: [] }];
    expect(sourceFor({ name: 'renamed', label: 'Sheet A', columns: [] }, sources)).toBe(sources[0]);
    expect(sourceFor({ name: 'x', label: 'y', columns: [] }, sources)).toBeNull();
  });

  it('builds parameterized multi-row inserts within the bind limit', () => {
    const { text, values } = buildInsert('t', ['a', 'b'], [[1, 2], [3, null]]);
    expect(text).toBe('INSERT INTO "public"."t" ("a", "b") VALUES ($1, $2), ($3, $4)');
    expect(values).toEqual([1, 2, 3, null]);
    expect(batchSize(2) * 2).toBeLessThanOrEqual(65535);
    expect(batchSize(1000) * 1000).toBeLessThanOrEqual(65535);
  });
});
