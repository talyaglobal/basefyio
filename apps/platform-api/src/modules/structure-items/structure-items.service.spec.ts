import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { StructureItemsService } from './structure-items.service';
import { PostgresJsonbProvider } from './storage/postgres-jsonb.provider';
import { PrismaService } from '../../prisma/prisma.service';

const NOW = new Date('2026-01-01T00:00:00.000Z');

const STRUCTURE = {
  id: 'str-1',
  projectId: 'proj-1',
  fields: [
    { name: 'title', type: 'string', required: true },
    { name: 'count', type: 'number', required: false, default: 0 },
  ],
};

const STORED_ROW = {
  id: 'item-1',
  data: { title: 'Hello', count: 1 },
  createdAt: NOW,
  updatedAt: NOW,
};

function buildPrisma(overrides: Record<string, any> = {}) {
  return {
    project: {
      findUnique: jest.fn<any>().mockResolvedValue({ teamId: 'team-1' }),
    },
    teamMember: {
      findUnique: jest.fn<any>().mockResolvedValue({ userId: 'user-1', teamId: 'team-1' }),
    },
    dataStructure: {
      findFirst: jest.fn<any>().mockResolvedValue(STRUCTURE),
    },
    ...overrides,
  };
}

function buildProvider(overrides: Record<string, any> = {}) {
  return {
    insertRow: jest.fn<any>().mockResolvedValue(STORED_ROW),
    getRow: jest.fn<any>().mockResolvedValue(STORED_ROW),
    listRows: jest.fn<any>().mockResolvedValue({ data: [STORED_ROW], nextCursor: null, total: 1 }),
    updateRow: jest.fn<any>().mockResolvedValue(STORED_ROW),
    deleteRow: jest.fn<any>().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function buildService(prismaOverrides = {}, providerOverrides = {}) {
  const prisma = buildPrisma(prismaOverrides);
  const provider = buildProvider(providerOverrides);
  const mod = await Test.createTestingModule({
    providers: [
      StructureItemsService,
      { provide: PrismaService, useValue: prisma },
      { provide: PostgresJsonbProvider, useValue: provider },
    ],
  }).compile();
  return {
    service: mod.get(StructureItemsService),
    prisma,
    provider,
  };
}

describe('StructureItemsService', () => {
  describe('assertProjectMember', () => {
    it('passes when user is a member', async () => {
      const { service } = await buildService();
      await expect(service.assertProjectMember('proj-1', 'user-1')).resolves.toBeUndefined();
    });

    it('throws NotFoundException when project not found', async () => {
      const { service } = await buildService({
        project: { findUnique: jest.fn<any>().mockResolvedValue(null) },
      });
      await expect(service.assertProjectMember('proj-1', 'user-1')).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when not a member', async () => {
      const { service } = await buildService({
        teamMember: { findUnique: jest.fn<any>().mockResolvedValue(null) },
      });
      await expect(service.assertProjectMember('proj-1', 'user-1')).rejects.toThrow(ForbiddenException);
    });
  });

  describe('create', () => {
    it('inserts a valid row', async () => {
      const { service, provider } = await buildService();
      const result = await service.create('proj-1', 'str-1', { title: 'Hello', count: 1 });
      expect(provider.insertRow).toHaveBeenCalledWith(
        expect.objectContaining({ structureId: 'str-1', projectId: 'proj-1' }),
      );
      expect(result.id).toBe('item-1');
    });

    it('applies default value for optional field', async () => {
      const { service, provider } = await buildService();
      await service.create('proj-1', 'str-1', { title: 'Hello' });
      const call = (provider.insertRow as jest.Mock).mock.calls[0][0] as any;
      expect(call.data.count).toBe(0);
    });

    it('throws BadRequestException for missing required field', async () => {
      const { service } = await buildService();
      await expect(service.create('proj-1', 'str-1', {})).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for wrong type', async () => {
      const { service } = await buildService();
      await expect(
        service.create('proj-1', 'str-1', { title: 42 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when structure not found', async () => {
      const { service } = await buildService({
        dataStructure: { findFirst: jest.fn<any>().mockResolvedValue(null) },
      });
      await expect(service.create('proj-1', 'str-1', { title: 'x' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('list', () => {
    it('returns paginated rows', async () => {
      const { service } = await buildService();
      const result = await service.list('proj-1', 'str-1', { limit: 10 });
      expect(result.total).toBe(1);
      expect(result.data).toHaveLength(1);
    });
  });

  describe('get', () => {
    it('returns the row', async () => {
      const { service } = await buildService();
      const result = await service.get('proj-1', 'str-1', 'item-1');
      expect(result.id).toBe('item-1');
    });

    it('throws NotFoundException when item not found', async () => {
      const { service } = await buildService(
        {},
        { getRow: jest.fn<any>().mockResolvedValue(null) },
      );
      await expect(service.get('proj-1', 'str-1', 'item-x')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('merges data and returns updated row', async () => {
      const { service, provider } = await buildService();
      await service.update('proj-1', 'str-1', 'item-1', { count: 5 });
      expect(provider.updateRow).toHaveBeenCalledWith(
        expect.objectContaining({ itemId: 'item-1', data: { count: 5 } }),
      );
    });

    it('translates NOT_FOUND to NotFoundException', async () => {
      const { service } = await buildService(
        {},
        { updateRow: jest.fn<any>().mockRejectedValue(new Error('NOT_FOUND')) },
      );
      await expect(service.update('proj-1', 'str-1', 'item-x', {})).rejects.toThrow(NotFoundException);
    });
  });

  describe('delete', () => {
    it('returns deleted: true', async () => {
      const { service } = await buildService();
      const result = await service.delete('proj-1', 'str-1', 'item-1');
      expect(result).toEqual({ deleted: true, id: 'item-1' });
    });

    it('translates NOT_FOUND to NotFoundException', async () => {
      const { service } = await buildService(
        {},
        { deleteRow: jest.fn<any>().mockRejectedValue(new Error('NOT_FOUND')) },
      );
      await expect(service.delete('proj-1', 'str-1', 'item-x')).rejects.toThrow(NotFoundException);
    });
  });

  describe('tenant isolation', () => {
    it('structure lookup is scoped to projectId', async () => {
      const { service, prisma } = await buildService();
      await service.list('proj-1', 'str-1', {});
      expect(prisma.dataStructure.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ projectId: 'proj-1' }) }),
      );
    });
  });
});
