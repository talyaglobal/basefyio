import { BadRequestException } from '@nestjs/common';
import { sanitizeDataModel } from './blueprint.service';

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
