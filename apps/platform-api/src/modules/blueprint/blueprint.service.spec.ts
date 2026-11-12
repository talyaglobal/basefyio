import { BadRequestException } from '@nestjs/common';
import { BlueprintService } from './blueprint.service';
import { analyzeSheets } from './blueprint-builder';
import { DataModel } from './blueprint.types';

/** A pg client double: answers introspection from `liveTables`, records everything else. */
function fakeClient(liveTables: Record<string, Array<[string, string]>> = {}) {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    queries,
    query: jest.fn(async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      if (/information_schema\.columns/.test(text)) {
        const names = (values?.[0] as string[]) ?? [];
        return {
          rows: Object.entries(liveTables)
            .filter(([t]) => names.includes(t))
            .flatMap(([t, cols]) =>
              cols.map(([c, type]) => ({ table_name: t, column_name: c, data_type: type, is_nullable: 'YES' })),
            ),
        };
      }
      if (/SELECT EXISTS/.test(text)) return { rows: [{ has_rows: false }] };
      return { rows: [] };
    }),
  };
  return client;
}

const SHEETS = [
  { name: 'customers', headers: ['customer_id', 'name'], rows: [[1, 'Acme'], [2, 'Globex']] },
  { name: 'orders', headers: ['order_id', 'customer_id', 'amount'], rows: [[10, 1, '12,50'], [11, 2, '3,00']] },
];

function setup(opts: { status?: string; snapshot?: DataModel | null; live?: Record<string, Array<[string, string]>> } = {}) {
  const { dataModel, sources } = analyzeSheets({ teamId: 'team', sheets: SHEETS });
  const blueprint: any = {
    id: 'bp1',
    teamId: 'team',
    projectId: 'p1',
    name: 'Shop',
    status: opts.status ?? 'APPROVED',
    dataModel,
    applicationModel: { name: 'Shop', roles: [], navigation: [], tables: [] },
    generatedDataModel: opts.snapshot ?? null,
    versions: [],
  };
  const updates: any[] = [];
  const prisma: any = {
    teamMember: { findUnique: jest.fn().mockResolvedValue({ id: 'm' }) },
    blueprint: {
      findUnique: jest.fn(async () => ({ ...blueprint })),
      update: jest.fn(async ({ data }: any) => {
        updates.push(data);
        Object.assign(blueprint, data);
        return blueprint;
      }),
    },
    blueprintSource: {
      findUnique: jest.fn(async () => ({ sheets: sources, rowCount: 4 })),
    },
  };
  const client = fakeClient(opts.live);
  const projectDb: any = {
    withProjectDb: jest.fn(async (_p: string, _u: string, fn: (c: any) => Promise<unknown>) => fn(client)),
  };
  return { service: new BlueprintService(prisma, projectDb), blueprint, updates, client, prisma };
}

describe('BlueprintService.generate (#112)', () => {
  it('creates tables with natural keys, loads the rows, then adds the reference', async () => {
    const { service, client, blueprint } = setup();
    const res = await service.generate('bp1', { projectId: 'p1', loadData: true, access: 'authenticated_read' }, 'u1');

    expect(res.created).toBe(2);
    expect(res.rowsLoaded).toBe(4);
    expect(res.foreignKeys).toEqual([
      expect.objectContaining({ table: 'orders', column: 'customer_id', refTable: 'customers', created: true }),
    ]);
    expect(res.accessDescription).toMatch(/Signed-in users can read/);

    const texts = client.queries.map((q) => q.text);
    const create = texts.find((t) => /CREATE TABLE "public"."customers"/.test(t))!;
    expect(create).toMatch(/PRIMARY KEY \("customer_id"\)/);
    const insert = client.queries.find((q) => /INSERT INTO "public"."orders"/.test(q.text))!;
    expect(insert.values).toEqual([10, 1, '12.50', 11, 2, '3.00']);
    expect(texts.findIndex((t) => /FOREIGN KEY/.test(t))).toBeGreaterThan(
      texts.findIndex((t) => /INSERT INTO "public"."orders"/.test(t)),
    );
    expect(texts.some((t) => /CREATE POLICY "authenticated_read"/.test(t))).toBe(true);

    expect(blueprint.status).toBe('GENERATED');
    expect(blueprint.generatedDataModel.tables.map((t: any) => t.name)).toEqual(['customers', 'orders']);
    expect(blueprint.generatedDataModel.access).toBe('authenticated_read');
  });

  it('keeps the old snapshot for skipped tables so their changes stay pending (#113)', async () => {
    // customers was generated before, without "name"; the model now has it.
    const snapshot: DataModel = {
      version: 2,
      tables: [{ name: 'customers', label: 'customers', primaryKey: ['customer_id'], columns: [
        { name: 'customer_id', originalName: 'customer_id', type: 'integer', nullable: false, sampleValues: [] },
      ] }],
    };
    const { service, blueprint } = setup({
      status: 'GENERATED',
      snapshot,
      live: { customers: [['customer_id', 'integer'], ['created_at', 'timestamp with time zone'], ['updated_at', 'timestamp with time zone']] },
    });
    const res = await service.generate('bp1', { projectId: 'p1' }, 'u1');

    const skipped = res.tables.find((t) => t.table === 'customers')!;
    expect(skipped.created).toBe(false);
    expect(skipped.pendingChanges).toBeGreaterThan(0);
    const snapCustomers = blueprint.generatedDataModel.tables.find((t: any) => t.name === 'customers');
    expect(snapCustomers.columns.map((c: any) => c.name)).toEqual(['customer_id']);
  });

  it('records tables created before a failure and marks the blueprint FAILED', async () => {
    const { service, client, blueprint } = setup();
    client.query.mockImplementation(async (text: string) => {
      if (/CREATE TABLE "public"."orders"/.test(text)) throw new Error('boom');
      return { rows: [] };
    });
    await expect(service.generate('bp1', { projectId: 'p1' }, 'u1')).rejects.toBeInstanceOf(BadRequestException);
    expect(blueprint.status).toBe('FAILED');
    expect(blueprint.generatedDataModel.tables.map((t: any) => t.name)).toEqual(['customers']);
  });

  it('allows retrying a FAILED blueprint', async () => {
    const { service } = setup({ status: 'FAILED' });
    await expect(service.generate('bp1', { projectId: 'p1' }, 'u1')).resolves.toMatchObject({ status: 'GENERATED' });
  });
});

describe('BlueprintService.resync (#113)', () => {
  it('keeps a generated blueprint GENERATED and stores the new rows', async () => {
    const { service, blueprint, updates } = setup({ status: 'GENERATED', snapshot: { tables: [] } });
    await service.resync('bp1', { sheets: [{ ...SHEETS[0], headers: [...SHEETS[0].headers, 'phone'], rows: [[1, 'Acme', '555']] }] }, 'u1');
    expect(blueprint.status).toBe('GENERATED');
    expect(blueprint.dataModel.tables[0].columns.map((c: any) => c.name)).toContain('phone');
    expect(updates[0].source.upsert.update.sheets[0].rows).toEqual([[1, 'Acme', '555']]);
  });

  it('sends an approved, never generated blueprint back to DRAFT', async () => {
    const { service, blueprint } = setup({ status: 'APPROVED' });
    await service.resync('bp1', { sheets: SHEETS }, 'u1');
    expect(blueprint.status).toBe('DRAFT');
  });
});

describe('BlueprintService.update (#111)', () => {
  it('saves an edited model and requires approval again', async () => {
    const { service, blueprint } = setup({ status: 'APPROVED' });
    const model = JSON.parse(JSON.stringify(blueprint.dataModel));
    model.tables[0].columns[1].name = 'company';
    await service.update('bp1', { dataModel: model }, 'u1');
    expect(blueprint.status).toBe('DRAFT');
    expect(blueprint.dataModel.tables[0].columns[1].name).toBe('company');
  });

  it('rejects an invalid model with the reasons', async () => {
    const { service, blueprint } = setup();
    const model = JSON.parse(JSON.stringify(blueprint.dataModel));
    model.tables[0].columns[1].name = 'updated_at';
    await expect(service.update('bp1', { dataModel: model }, 'u1')).rejects.toThrow(/reserved/);
  });

  it('keeps a generated blueprint GENERATED (the edit becomes a pending migration)', async () => {
    const { service, blueprint } = setup({ status: 'GENERATED', snapshot: { tables: [] } });
    const res = await service.update('bp1', { name: 'Renamed' }, 'u1');
    expect(blueprint.status).toBe('GENERATED');
    expect(res.name).toBe('Renamed');
  });
});
