import { IntelligenceService } from './intelligence.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';

const makeDeps = () => ({
  prisma: {
    project: { findFirst: jest.fn() },
    appEntity: { findMany: jest.fn() },
  },
  ai: { complete: jest.fn() },
  config: { get: jest.fn() },
});

const PROJ = {
  id: 'p-1',
  status: 'ACTIVE',
  dbHost: 'localhost',
  dbPort: 5432,
  dbName: 'test',
  dbUser: 'test',
  dbPassword: 'test',
};
const ENTITIES = [
  {
    entityName: 'Customers',
    tableName: 'customers',
    description: '',
    metadata: { ddl: 'CREATE TABLE "customers" ("id" UUID PRIMARY KEY)' },
  },
];

describe('IntelligenceService', () => {
  it('throws 404 when project not found', async () => {
    const { prisma, ai, config } = makeDeps();
    prisma.project.findFirst.mockResolvedValue(null);
    const svc = new IntelligenceService(prisma as any, ai as any, config as any);
    await expect(svc.ask('u-1', 'p-1', 'how many customers?')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('throws 400 when no entities exist', async () => {
    const { prisma, ai, config } = makeDeps();
    prisma.project.findFirst.mockResolvedValue(PROJ);
    (prisma as any).appEntity = { findMany: jest.fn().mockResolvedValue([]) };
    const svc = new IntelligenceService(prisma as any, ai as any, config as any);
    await expect(svc.ask('u-1', 'p-1', 'how many customers?')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('throws 400 when AI generates unsafe SQL', async () => {
    const { prisma, ai, config } = makeDeps();
    prisma.project.findFirst.mockResolvedValue(PROJ);
    (prisma as any).appEntity = { findMany: jest.fn().mockResolvedValue(ENTITIES) };
    ai.complete.mockResolvedValue('DROP TABLE customers');
    const svc = new IntelligenceService(prisma as any, ai as any, config as any);
    await expect(svc.ask('u-1', 'p-1', 'drop all tables')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('detectChartHint returns line for date-named first column', () => {
    const svc = new IntelligenceService({} as any, {} as any, {} as any);
    const hint = svc.detectChartHint(['month', 'total'], [{ month: '2026-01', total: 100 }]);
    expect(hint).toBe('line');
  });

  it('detectChartHint returns bar for category-like first column', () => {
    const svc = new IntelligenceService({} as any, {} as any, {} as any);
    const hint = svc.detectChartHint(['status', 'count'], [{ status: 'active', count: 5 }]);
    expect(hint).toBe('bar');
  });

  it('detectChartHint returns table for non-2-column results', () => {
    const svc = new IntelligenceService({} as any, {} as any, {} as any);
    const hint = svc.detectChartHint(['a', 'b', 'c'], [{}]);
    expect(hint).toBe('table');
  });
});
