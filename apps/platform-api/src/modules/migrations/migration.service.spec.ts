import { BadRequestException } from '@nestjs/common';
import { MigrationService } from './migration.service';
import { DataModel } from '../blueprint/blueprint.types';

const col = (name: string, type: any = 'text') => ({
  name,
  originalName: name,
  type,
  nullable: true,
  sampleValues: [],
});

function setup(liveCols: Array<[string, string]>, opts: { failOn?: RegExp } = {}) {
  const target: DataModel = {
    version: 2,
    tables: [{ name: 'customers', label: 'customers', columns: [col('name'), col('phone')] }],
  };
  // The snapshot claims phone exists — the state the old generate bug left behind.
  const blueprint: any = {
    id: 'bp1',
    projectId: 'p1',
    dataModel: target,
    generatedDataModel: { ...target, access: 'authenticated_read' },
  };
  const queries: string[] = [];
  const client = {
    query: jest.fn(async (text: string) => {
      queries.push(text);
      if (opts.failOn?.test(text)) throw new Error('relation is locked');
      if (/information_schema\.columns/.test(text)) {
        return {
          rows: liveCols.map(([c, t]) => ({ table_name: 'customers', column_name: c, data_type: t, is_nullable: 'YES' })),
        };
      }
      if (/pg_constraint/.test(text)) {
        return { rows: [{ conname: 'customers_pkey', contype: 'p', table_name: 'customers', columns: ['id'], ref_table: null, ref_columns: null }] };
      }
      return { rows: [] };
    }),
  };
  const runs: any[] = [];
  const prisma: any = {
    migrationRun: {
      create: jest.fn(async ({ data }: any) => {
        const run = { id: 'r1', ...data };
        runs.push(run);
        return run;
      }),
      findUnique: jest.fn(async () => runs[0]),
      update: jest.fn(async ({ data }: any) => Object.assign(runs[0], data)),
    },
    blueprint: { update: jest.fn(async ({ data }: any) => Object.assign(blueprint, data)) },
  };
  const blueprints: any = {
    get: jest.fn(async () => blueprint),
    getSourceSheets: jest.fn(async () => null),
  };
  const projectDb: any = {
    withProjectDb: jest.fn(async (_p: string, _u: string, fn: (c: any) => Promise<unknown>) => fn(client)),
  };
  return { service: new MigrationService(prisma, blueprints, projectDb), queries, blueprint, runs };
}

const LIVE: Array<[string, string]> = [
  ['id', 'uuid'],
  ['name', 'text'],
  ['created_at', 'timestamp with time zone'],
  ['updated_at', 'timestamp with time zone'],
];

describe('MigrationService (#113)', () => {
  it('plans the column the database is missing even when the snapshot claims it', async () => {
    const { service } = setup(LIVE);
    const run: any = await service.plan('bp1', 'u1');
    expect(run.plan.changes).toEqual([
      expect.objectContaining({ kind: 'add_column', column: 'phone' }),
    ]);
    expect(run.plan.targetModel.tables[0].name).toBe('customers');
  });

  it('applies the plan in one transaction and advances the snapshot', async () => {
    const { service, queries, blueprint } = setup(LIVE);
    await service.plan('bp1', 'u1');
    const applied: any = await service.apply('r1', false, 'u1');
    expect(applied.status).toBe('APPLIED');
    expect(queries.filter((q) => /^(BEGIN|COMMIT|ALTER)/.test(q))).toEqual([
      'BEGIN',
      'ALTER TABLE "public"."customers" ADD COLUMN "phone" TEXT',
      'COMMIT',
    ]);
    expect(blueprint.status).toBe('GENERATED');
    expect(blueprint.generatedDataModel.access).toBe('authenticated_read');
  });

  it('rolls back and records the error when a statement fails', async () => {
    const { service, queries, runs } = setup(LIVE, { failOn: /ADD COLUMN/ });
    await service.plan('bp1', 'u1');
    await expect(service.apply('r1', false, 'u1')).rejects.toBeInstanceOf(BadRequestException);
    expect(queries).toContain('ROLLBACK');
    expect(runs[0].status).toBe('FAILED');
    expect(runs[0].error).toMatch(/locked/);
  });
});
