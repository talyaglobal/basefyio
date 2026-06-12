import { describe, it, expect, jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { DataStructuresService } from './data-structures.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { CreateDataStructureDto, DataStructureKindDto } from './dto/create-data-structure.dto';

// ── Fixtures ──────────────────────────────────────────────────

const NOW = new Date('2026-01-01T00:00:00.000Z');

const RELATIONAL_ROW = {
  id: 'ds-1',
  projectId: 'proj-1',
  name: 'orders',
  kind: 'RELATIONAL',
  aiRecommended: false,
  aiReasons: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const JSON_ROW = {
  id: 'ds-2',
  projectId: 'proj-1',
  name: 'logs',
  kind: 'JSON',
  aiRecommended: true,
  aiReasons: { reason: 'document store fits better' },
  createdAt: NOW,
  updatedAt: NOW,
};

function buildPrisma(overrides: Record<string, any> = {}) {
  return {
    project: {
      findUnique: jest.fn<any>().mockResolvedValue({ teamId: 'team-1' }),
    },
    teamMember: {
      findUnique: jest.fn<any>().mockResolvedValue({ id: 'tm-1' }),
    },
    dataStructure: {
      findMany: jest.fn<any>().mockResolvedValue([RELATIONAL_ROW, JSON_ROW]),
      findUnique: jest.fn<any>().mockResolvedValue(null),
      create: jest.fn<any>().mockResolvedValue(RELATIONAL_ROW),
    },
    ...overrides,
  };
}

async function buildService(prismaOverrides: Record<string, any> = {}) {
  const prisma = buildPrisma(prismaOverrides);
  const module = await Test.createTestingModule({
    providers: [
      DataStructuresService,
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();
  return { svc: module.get(DataStructuresService), prisma };
}

// ── list() ────────────────────────────────────────────────────

describe('DataStructuresService.list()', () => {
  it('returns mapped views with correct badge (RELATIONAL → SQL, JSON → JSON)', async () => {
    const { svc } = await buildService();
    const result = await svc.list('proj-1');

    expect(result).toHaveLength(2);

    const relational = result.find((v) => v.name === 'orders');
    expect(relational).toBeDefined();
    expect(relational!.badge).toBe('SQL');
    expect(relational!.kind).toBe('relational');
    expect(relational!.editorMode).toBe('sql');
    expect(relational!.dataEditorMode).toBe('row');

    const json = result.find((v) => v.name === 'logs');
    expect(json).toBeDefined();
    expect(json!.badge).toBe('JSON');
    expect(json!.kind).toBe('json');
    expect(json!.editorMode).toBe('js-query');
    expect(json!.dataEditorMode).toBe('document');
  });

  it('omits jsonBackend from output', async () => {
    const rowWithBackend = { ...RELATIONAL_ROW, jsonBackend: 'mongodb' };
    const { svc } = await buildService({
      dataStructure: {
        findMany: jest.fn<any>().mockResolvedValue([rowWithBackend]),
        findUnique: jest.fn<any>().mockResolvedValue(null),
        create: jest.fn<any>().mockResolvedValue(rowWithBackend),
      },
    });
    const result = await svc.list('proj-1');

    expect(result).toHaveLength(1);
    expect(Object.keys(result[0])).not.toContain('jsonBackend');
  });
});

// ── create() ──────────────────────────────────────────────────

describe('DataStructuresService.create()', () => {
  it('with kind=relational — badge is SQL, editorMode is sql', async () => {
    const dto: CreateDataStructureDto = { name: 'orders', kind: DataStructureKindDto.RELATIONAL };
    const { svc } = await buildService({
      dataStructure: {
        findUnique: jest.fn<any>().mockResolvedValue(null),
        create: jest.fn<any>().mockResolvedValue(RELATIONAL_ROW),
      },
    });

    const result = await svc.create('proj-1', dto);

    expect(result.badge).toBe('SQL');
    expect(result.editorMode).toBe('sql');
    expect(result.kind).toBe('relational');
    expect(result.dataEditorMode).toBe('row');
  });

  it('with kind=json — badge is JSON, editorMode is js-query', async () => {
    const dto: CreateDataStructureDto = { name: 'logs', kind: DataStructureKindDto.JSON };
    const { svc } = await buildService({
      dataStructure: {
        findUnique: jest.fn<any>().mockResolvedValue(null),
        create: jest.fn<any>().mockResolvedValue(JSON_ROW),
      },
    });

    const result = await svc.create('proj-1', dto);

    expect(result.badge).toBe('JSON');
    expect(result.editorMode).toBe('js-query');
    expect(result.kind).toBe('json');
    expect(result.dataEditorMode).toBe('document');
  });

  it('throws ConflictException when name already exists', async () => {
    const dto: CreateDataStructureDto = { name: 'orders', kind: DataStructureKindDto.RELATIONAL };
    const { svc } = await buildService({
      dataStructure: {
        findUnique: jest.fn<any>().mockResolvedValue(RELATIONAL_ROW),
        create: jest.fn<any>().mockResolvedValue(RELATIONAL_ROW),
      },
    });

    await expect(svc.create('proj-1', dto)).rejects.toThrow(ConflictException);
  });

  it('sets jsonBackend=mongodb internally when kind=json', async () => {
    const dto: CreateDataStructureDto = { name: 'logs', kind: DataStructureKindDto.JSON };
    const { svc, prisma } = await buildService({
      dataStructure: {
        findUnique: jest.fn<any>().mockResolvedValue(null),
        create: jest.fn<any>().mockResolvedValue(JSON_ROW),
      },
    });

    await svc.create('proj-1', dto);

    expect((prisma as any).dataStructure.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ jsonBackend: 'mongodb' }),
      }),
    );
  });

  it('sets jsonBackend=null when kind=relational', async () => {
    const dto: CreateDataStructureDto = { name: 'orders', kind: DataStructureKindDto.RELATIONAL };
    const { svc, prisma } = await buildService({
      dataStructure: {
        findUnique: jest.fn<any>().mockResolvedValue(null),
        create: jest.fn<any>().mockResolvedValue(RELATIONAL_ROW),
      },
    });

    await svc.create('proj-1', dto);

    expect((prisma as any).dataStructure.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ jsonBackend: null }),
      }),
    );
  });
});

// ── assertProjectMember() ─────────────────────────────────────

describe('DataStructuresService.assertProjectMember()', () => {
  it('throws NotFoundException when project not found', async () => {
    const { svc } = await buildService({
      project: { findUnique: jest.fn<any>().mockResolvedValue(null) },
    });

    await expect(svc.assertProjectMember('no-such-proj', 'user-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws ForbiddenException when user is not a team member', async () => {
    const { svc } = await buildService({
      project: { findUnique: jest.fn<any>().mockResolvedValue({ teamId: 'team-1' }) },
      teamMember: { findUnique: jest.fn<any>().mockResolvedValue(null) },
    });

    await expect(svc.assertProjectMember('proj-1', 'outsider')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('resolves without error when project and membership are valid', async () => {
    const { svc } = await buildService();

    await expect(svc.assertProjectMember('proj-1', 'user-1')).resolves.toBeUndefined();
  });
});
