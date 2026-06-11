import { NotFoundException } from '@nestjs/common';
import { BlueprintService } from './blueprint.service';

function makePrisma(overrides: Record<string, any> = {}) {
  const blueprint = {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    ...overrides.blueprint,
  };
  const applicationVersion = {
    findUnique: jest.fn(),
    create: jest.fn().mockResolvedValue({ id: 'ver-1', version: 1 }),
    ...overrides.applicationVersion,
  };
  return {
    blueprint,
    applicationVersion,
    $transaction: jest.fn((cb: any) => cb({ blueprint, applicationVersion })),
  } as any;
}

const USER_ID = 'user-1';
const TEAM_ID = 'team-1';

describe('BlueprintService.analyze', () => {
  it('creates a blueprint with one table per sheet', async () => {
    const prisma = makePrisma();
    prisma.blueprint.create.mockResolvedValue({ id: 'bp-1', status: 'draft', dataModel: { tables: [] } });
    prisma.blueprint.update.mockResolvedValue({ id: 'bp-1' });

    const svc = new BlueprintService(prisma);
    const result = await svc.analyze(USER_ID, {
      teamId: TEAM_ID,
      sheets: [
        { sheet: 'Customers', headers: ['Name', 'Email'], sampleRows: [] },
        { sheet: 'Orders', headers: ['Order ID', 'Amount'], sampleRows: [] },
      ],
    });

    expect(result.blueprintId).toBe('bp-1');
    expect(prisma.blueprint.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          teamId: TEAM_ID,
          status: 'draft',
        }),
      }),
    );
  });

  it('excludes sheets in excludeSheets', async () => {
    const prisma = makePrisma();
    prisma.blueprint.create.mockResolvedValue({ id: 'bp-2', status: 'draft', dataModel: { tables: [] } });
    prisma.blueprint.update.mockResolvedValue({ id: 'bp-2' });
    const svc = new BlueprintService(prisma);

    await svc.analyze(USER_ID, {
      teamId: TEAM_ID,
      sheets: [
        { sheet: 'Customers', headers: ['Name'], sampleRows: [] },
        { sheet: 'Junk', headers: ['garbage'], sampleRows: [] },
      ],
      excludeSheets: ['Junk'],
    });

    const call = prisma.blueprint.create.mock.calls[0][0];
    const tables = call.data.dataModel.tables;
    expect(tables).toHaveLength(1);
    expect(tables[0].sourceSheet).toBe('Customers');
  });

  it('normalises sheet name to snake_case table name', async () => {
    const prisma = makePrisma();
    prisma.blueprint.create.mockResolvedValue({ id: 'bp-3', status: 'draft', dataModel: { tables: [] } });
    prisma.blueprint.update.mockResolvedValue({ id: 'bp-3' });
    const svc = new BlueprintService(prisma);

    await svc.analyze(USER_ID, {
      teamId: TEAM_ID,
      sheets: [{ sheet: 'Sales Orders', headers: ['ID'], sampleRows: [] }],
    });

    const call = prisma.blueprint.create.mock.calls[0][0];
    expect(call.data.dataModel.tables[0].name).toBe('sales_orders');
  });
});

describe('BlueprintService.getBlueprint', () => {
  it('throws 404 when not found', async () => {
    const prisma = makePrisma();
    prisma.blueprint.findUnique.mockResolvedValue(null);
    const svc = new BlueprintService(prisma);
    await expect(svc.getBlueprint(USER_ID, 'bp-x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns blueprint when found', async () => {
    const prisma = makePrisma();
    prisma.blueprint.findUnique.mockResolvedValue({ id: 'bp-1', status: 'draft', versions: [] });
    const svc = new BlueprintService(prisma);
    const result = await svc.getBlueprint(USER_ID, 'bp-1');
    expect(result.id).toBe('bp-1');
  });
});

describe('BlueprintService.approve', () => {
  it('creates a new ApplicationVersion and updates blueprint status', async () => {
    const VERSION_ID = 'ver-1';
    const prisma = makePrisma();
    prisma.blueprint.findUnique.mockResolvedValue({
      id: 'bp-1',
      currentVersionId: 'ver-0',
      status: 'draft',
      dataModel: { tables: [{ name: 'customers', displayName: 'Customers' }] },
    });
    (prisma as any).applicationVersion = {
      findUnique: jest.fn().mockResolvedValue({ id: 'ver-0', version: 1 }),
      create: jest.fn().mockResolvedValue({ id: VERSION_ID, version: 2 }),
    };
    prisma.blueprint.update = jest.fn().mockResolvedValue({ id: 'bp-1', status: 'approved' });

    const svc = new BlueprintService(prisma, null as any);
    const result = await svc.approve(USER_ID, 'bp-1', { name: 'My App' });

    expect(result.status).toBe('approved');
    expect((prisma as any).applicationVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ version: 2, aiGenerated: false }),
      }),
    );
  });

  it('throws 404 when blueprint not found', async () => {
    const prisma = makePrisma();
    prisma.blueprint.findUnique.mockResolvedValue(null);
    const svc = new BlueprintService(prisma, null as any);
    await expect(svc.approve(USER_ID, 'bp-x', {})).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('BlueprintService.detectDomain (via analyze)', () => {
  it('detects crm domain from table names', async () => {
    const prisma = makePrisma();
    prisma.blueprint.create.mockResolvedValue({ id: 'bp-1', status: 'draft', dataModel: { tables: [] } });
    prisma.blueprint.update.mockResolvedValue({ id: 'bp-1' });
    (prisma as any).applicationVersion = {
      create: jest.fn().mockResolvedValue({ id: 'ver-1', version: 1 }),
    };

    const svc = new BlueprintService(prisma, null as any);
    const result = await svc.analyze(USER_ID, {
      teamId: TEAM_ID,
      sheets: [{ sheet: 'Customers', headers: ['Name'], sampleRows: [] }],
    });

    expect(result.domain).toBe('crm');
  });
});
