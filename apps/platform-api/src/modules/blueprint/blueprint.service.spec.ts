import { BadRequestException } from '@nestjs/common';
import { BlueprintService, rowsForTable, sanitizeDataModel } from './blueprint.service';

const col = (name: string, type = 'text') => ({ name, originalName: name, type, nullable: true, sampleValues: [] });
const model = (tables: unknown) => ({ tables }) as never;

describe('sanitizeDataModel', () => {
  it('accepts edited names and types and drops unknown fields', () => {
    const dm = sanitizeDataModel(model([{ name: 'clients', label: 'Müşteriler', evil: 1, columns: [col('full_name'), col('total', 'numeric')] }]));
    expect(dm.tables[0]).toEqual({
      name: 'clients',
      label: 'Müşteriler',
      columns: [
        { name: 'full_name', originalName: 'full_name', type: 'text', nullable: true, sampleValues: [] },
        { name: 'total', originalName: 'total', type: 'numeric', nullable: true, sampleValues: [] },
      ],
    });
  });

  it.each([
    ['an injected table name', [{ name: 'a"; drop table x;--', columns: [col('c')] }]],
    ['a duplicate table', [{ name: 't', columns: [col('c')] }, { name: 't', columns: [col('c')] }]],
    ['a duplicate column', [{ name: 't', columns: [col('c'), col('c')] }]],
    ['a system column name', [{ name: 't', columns: [col('created_at')] }]],
    ['an unknown type', [{ name: 't', columns: [col('c', 'money; drop')] }]],
    ['no columns', [{ name: 't', columns: [] }]],
  ])('rejects %s', (_label, tables) => {
    expect(() => sanitizeDataModel(model(tables))).toThrow(BadRequestException);
  });
});

describe('relations in an edited model', () => {
  const rel = { fromTable: 'orders', fromColumn: 'customer_id', toTable: 'customers', toColumn: 'customer_id' };
  const tables = (renamed = 'customer_id') => [
    { name: 'customers', columns: [col('customer_id')] },
    { name: 'orders', columns: [col(renamed)] },
  ];
  it('keeps a link whose columns still exist', () => {
    expect(sanitizeDataModel({ tables: tables(), relations: [rel] } as never).relations).toEqual([rel]);
  });
  it('drops a link when a column was renamed', () => {
    expect(sanitizeDataModel({ tables: tables('buyer'), relations: [rel] } as never).relations).toBeUndefined();
  });
});

describe('rowsForTable', () => {
  it('casts rows to the column types and counts rows that do not fit', () => {
    const table = {
      name: 't',
      label: 'T',
      columns: [
        { name: 'n', originalName: 'N', type: 'integer', nullable: false, sampleValues: [] },
        { name: 'when', originalName: 'When', type: 'date', nullable: true, sampleValues: [] },
      ],
    } as never;
    const sheet = { name: 'T', headers: ['N', 'When'], rows: [['1', '2026-01-02'], ['x', null], ['3', null]] };
    const r = rowsForTable(table, sheet);
    expect(r.columns).toEqual(['n', 'when']);
    expect(r.rows).toEqual([[1, '2026-01-02'], [3, null]]);
    expect(r.skipped).toBe(1);
  });
});

describe('generate keeps the migration snapshot', () => {
  const tbl = (cols: string[]) => ({ name: 'clients', label: 'clients', columns: cols.map((c) => col(c)) });
  it('does not advance the snapshot for a table that already exists, so a column change stays plannable', async () => {
    const generatedBefore = { tables: [tbl(['name'])] };
    const bp = {
      id: 'b', teamId: 't', projectId: 'p', status: 'APPROVED',
      dataModel: { tables: [tbl(['name', 'phone'])] }, generatedDataModel: generatedBefore,
    };
    const updates: any[] = [];
    const prisma = {
      blueprint: { findUnique: async () => bp, update: async (a: any) => (updates.push(a.data), bp) },
      teamMember: { findUnique: async () => ({ id: 'm' }) },
    };
    const collections = { createRelationalTable: async () => ({ created: false, reason: 'exists' }) };
    const svc = new BlueprintService(prisma as never, collections as never);
    const res = await svc.generate('b', undefined, 'u');
    expect(res.skipped).toBe(1);
    expect(res.pendingChanges).toBe(true);
    expect(updates.at(-1).generatedDataModel.tables).toEqual(generatedBefore.tables);
  });
});
