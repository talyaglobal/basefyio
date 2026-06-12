import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { MigrationsService } from './migrations.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';

// ── Fixtures ──────────────────────────────────────────────────

const V1_DATA_MODEL = {
  version: 1,
  tables: [
    {
      name: 'customers',
      displayName: 'Customers',
      fields: [
        { name: 'name', type: 'string', nullable: false, unique: false },
        { name: 'email', type: 'string', nullable: true, unique: false },
      ],
    },
  ],
};

const V2_DATA_MODEL = {
  version: 1,
  tables: [
    {
      name: 'customers',
      displayName: 'Customers',
      fields: [
        { name: 'name', type: 'string', nullable: false, unique: false },
        { name: 'email', type: 'string', nullable: true, unique: false },
        { name: 'phone', type: 'string', nullable: true, unique: false },
      ],
    },
  ],
};

const ACTIVE_PROJECT = {
  id: 'proj-1',
  status: 'ACTIVE',
  dbHost: 'localhost',
  dbPort: 5432,
  dbName: 'testdb',
  dbUser: 'user',
  dbPassword: 'pass',
};

function buildPrisma(overrides: Record<string, any> = {}) {
  return {
    project: {
      findFirst: jest.fn<any>().mockResolvedValue(ACTIVE_PROJECT),
    },
    applicationVersion: {
      findMany: jest.fn<any>().mockResolvedValue([
        { id: 'av-1', version: 1, dataModel: V1_DATA_MODEL, blueprint: { projectId: 'proj-1' } },
        { id: 'av-2', version: 2, dataModel: V2_DATA_MODEL, blueprint: { projectId: 'proj-1' } },
      ]),
    },
    migrationRun: {
      create: jest.fn<any>().mockResolvedValue({ id: 'run-1', sqlStatements: [], planJson: { operations: [], hasDestructive: false } }),
      findFirst: jest.fn<any>().mockResolvedValue(null),
      findMany: jest.fn<any>().mockResolvedValue([]),
      update: jest.fn<any>().mockResolvedValue({}),
    },
    ...overrides,
  };
}

async function buildService(prismaOverrides: Record<string, any> = {}) {
  const prisma = buildPrisma(prismaOverrides);
  const module = await Test.createTestingModule({
    providers: [
      MigrationsService,
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();
  return { svc: module.get(MigrationsService), prisma };
}

// ── plan() ────────────────────────────────────────────────────

describe('MigrationsService.plan()', () => {
  it('returns a plan with migrationRunId and sql', async () => {
    const { svc, prisma } = await buildService();
    (prisma as any).migrationRun.create.mockResolvedValue({
      id: 'run-42',
      sqlStatements: ['ALTER TABLE "customers" ADD COLUMN "phone" text;'],
      planJson: {},
    });

    const result = await svc.plan('proj-1');
    expect(result.migrationRunId).toBe('run-42');
    expect(result.fromVersion).toBe(1);
    expect(result.toVersion).toBe(2);
    expect(result.plan.operations.length).toBeGreaterThan(0);
    expect(result.sqlStatements.length).toBeGreaterThan(0);
  });

  it('throws NotFoundException for unknown project', async () => {
    const { svc } = await buildService({
      project: { findFirst: jest.fn<any>().mockResolvedValue(null) },
    });
    await expect(svc.plan('bad-id')).rejects.toThrow(NotFoundException);
  });

  it('throws BadRequestException when fewer than 2 versions exist', async () => {
    const { svc } = await buildService({
      applicationVersion: {
        findMany: jest.fn<any>().mockResolvedValue([
          { id: 'av-1', version: 1, dataModel: V1_DATA_MODEL, blueprint: { projectId: 'proj-1' } },
        ]),
      },
    });
    await expect(svc.plan('proj-1')).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequestException when fromVersion >= toVersion', async () => {
    const { svc } = await buildService();
    await expect(svc.plan('proj-1', 2, 1)).rejects.toThrow(BadRequestException);
  });

  it('creates a MigrationRun record in PENDING status', async () => {
    const { svc, prisma } = await buildService();
    await svc.plan('proj-1');
    expect((prisma as any).migrationRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PENDING', projectId: 'proj-1' }),
      }),
    );
  });
});

// ── apply() ───────────────────────────────────────────────────

describe('MigrationsService.apply()', () => {
  const pendingRun = {
    id: 'run-1',
    projectId: 'proj-1',
    status: 'PENDING',
    planJson: {
      operations: [],
      hasDestructive: false,
      warnings: [],
      breakingChanges: [],
    },
    sqlStatements: [],
  };

  it('throws NotFoundException when run not found', async () => {
    const { svc } = await buildService({
      migrationRun: {
        findFirst: jest.fn<any>().mockResolvedValue(null),
        update: jest.fn<any>().mockResolvedValue({}),
      },
    });
    await expect(svc.apply('proj-1', 'no-such-run')).rejects.toThrow(NotFoundException);
  });

  it('throws ConflictException when already APPLIED', async () => {
    const { svc } = await buildService({
      migrationRun: {
        findFirst: jest.fn<any>().mockResolvedValue({ ...pendingRun, status: 'APPLIED' }),
        update: jest.fn<any>().mockResolvedValue({}),
      },
    });
    await expect(svc.apply('proj-1', 'run-1')).rejects.toThrow(ConflictException);
  });

  it('throws BadRequestException for destructive plan without force', async () => {
    const { svc } = await buildService({
      migrationRun: {
        findFirst: jest.fn<any>().mockResolvedValue({
          ...pendingRun,
          planJson: { ...pendingRun.planJson, hasDestructive: true, breakingChanges: ['Table removed'] },
        }),
        update: jest.fn<any>().mockResolvedValue({}),
      },
    });
    await expect(svc.apply('proj-1', 'run-1', false)).rejects.toThrow(BadRequestException);
  });

  it('scopes apply() to the correct projectId', async () => {
    const { svc, prisma } = await buildService({
      migrationRun: {
        findFirst: jest.fn<any>().mockResolvedValue(pendingRun),
        update: jest.fn<any>().mockResolvedValue({}),
      },
    });
    // project lookup should use the provided projectId
    await svc.apply('proj-1', 'run-1').catch(() => {}); // may fail on pool connection
    expect((prisma as any).migrationRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ projectId: 'proj-1' }) }),
    );
  });
});

// ── list() ────────────────────────────────────────────────────

describe('MigrationsService.list()', () => {
  it('returns runs ordered by createdAt desc', async () => {
    const runs = [
      { id: 'r2', fromBlueprintVersion: 2, toBlueprintVersion: 3, status: 'APPLIED', createdAt: new Date() },
      { id: 'r1', fromBlueprintVersion: 1, toBlueprintVersion: 2, status: 'APPLIED', createdAt: new Date() },
    ];
    const { svc } = await buildService({
      migrationRun: {
        findMany: jest.fn<any>().mockResolvedValue(runs),
        findFirst: jest.fn<any>().mockResolvedValue(null),
        create: jest.fn<any>().mockResolvedValue({}),
        update: jest.fn<any>().mockResolvedValue({}),
      },
    });
    const result = await svc.list('proj-1');
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('r2');
  });

  it('throws NotFoundException for unknown project', async () => {
    const { svc } = await buildService({
      project: { findFirst: jest.fn<any>().mockResolvedValue(null) },
    });
    await expect(svc.list('bad-proj')).rejects.toThrow(NotFoundException);
  });
});

// ── get() ─────────────────────────────────────────────────────

describe('MigrationsService.get()', () => {
  it('throws NotFoundException when run not found', async () => {
    const { svc } = await buildService({
      migrationRun: {
        findFirst: jest.fn<any>().mockResolvedValue(null),
        findMany: jest.fn<any>().mockResolvedValue([]),
        create: jest.fn<any>().mockResolvedValue({}),
        update: jest.fn<any>().mockResolvedValue({}),
      },
    });
    await expect(svc.get('proj-1', 'no-run')).rejects.toThrow(NotFoundException);
  });

  it('scopes lookup to projectId', async () => {
    const run = { id: 'run-1', projectId: 'proj-1', status: 'APPLIED' };
    const { svc, prisma } = await buildService({
      migrationRun: {
        findFirst: jest.fn<any>().mockResolvedValue(run),
        findMany: jest.fn<any>().mockResolvedValue([]),
        create: jest.fn<any>().mockResolvedValue({}),
        update: jest.fn<any>().mockResolvedValue({}),
      },
    });
    await svc.get('proj-1', 'run-1');
    expect((prisma as any).migrationRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ projectId: 'proj-1' }) }),
    );
  });
});
