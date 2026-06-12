import { describe, it, expect, jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { DataStructuresController } from './data-structures.controller';
import { DataStructuresService } from './data-structures.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { DataStructureKindDto } from './dto/create-data-structure.dto';
import { ConflictException, NotFoundException } from '@nestjs/common';

const NOW = new Date('2026-01-01T00:00:00.000Z');

const VIEW = {
  id: 'ds-1',
  projectId: 'proj-1',
  name: 'orders',
  kind: 'relational' as const,
  badge: 'SQL' as const,
  editorMode: 'sql' as const,
  dataEditorMode: 'row' as const,
  aiRecommended: false,
  aiReasons: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const USER = { sub: 'user-1', email: 'u@example.com' };

function buildService() {
  return {
    assertProjectMember: jest.fn<any>().mockResolvedValue(undefined),
    list: jest.fn<any>().mockResolvedValue([VIEW]),
    get: jest.fn<any>().mockResolvedValue(VIEW),
    create: jest.fn<any>().mockResolvedValue(VIEW),
    update: jest.fn<any>().mockResolvedValue({ ...VIEW, name: 'customers' }),
    delete: jest.fn<any>().mockResolvedValue(undefined),
  };
}

async function buildController(svcOverrides: Record<string, any> = {}) {
  const svc = { ...buildService(), ...svcOverrides };
  const module = await Test.createTestingModule({
    controllers: [DataStructuresController],
    providers: [{ provide: DataStructuresService, useValue: svc }],
  })
    .overrideGuard(JwtOrApiKeyGuard)
    .useValue({ canActivate: () => true })
    .compile();
  return { ctrl: module.get(DataStructuresController), svc };
}

// ── list ──────────────────────────────────────────────────────

describe('DataStructuresController.list()', () => {
  it('asserts membership then delegates to service', async () => {
    const { ctrl, svc } = await buildController();
    const result = await ctrl.list('proj-1', USER as any);
    expect(svc.assertProjectMember).toHaveBeenCalledWith('proj-1', 'user-1');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('orders');
  });
});

// ── get ───────────────────────────────────────────────────────

describe('DataStructuresController.get()', () => {
  it('returns a single structure by id', async () => {
    const { ctrl } = await buildController();
    const result = await ctrl.get('proj-1', 'ds-1', USER as any);
    expect(result.id).toBe('ds-1');
    expect(result.badge).toBe('SQL');
  });

  it('propagates NotFoundException from service', async () => {
    const { ctrl } = await buildController({
      get: jest.fn<any>().mockRejectedValue(new NotFoundException()),
    });
    await expect(ctrl.get('proj-1', 'ghost', USER as any)).rejects.toThrow(NotFoundException);
  });
});

// ── create ────────────────────────────────────────────────────

describe('DataStructuresController.create()', () => {
  it('asserts membership then creates', async () => {
    const { ctrl, svc } = await buildController();
    const body = { name: 'orders', kind: DataStructureKindDto.RELATIONAL };
    const result = await ctrl.create('proj-1', body, USER as any);
    expect(svc.create).toHaveBeenCalledWith('proj-1', body);
    expect(result.badge).toBe('SQL');
  });

  it('propagates ConflictException when name already exists', async () => {
    const { ctrl } = await buildController({
      create: jest.fn<any>().mockRejectedValue(new ConflictException()),
    });
    await expect(
      ctrl.create('proj-1', { name: 'orders', kind: DataStructureKindDto.RELATIONAL }, USER as any),
    ).rejects.toThrow(ConflictException);
  });
});

// ── update ────────────────────────────────────────────────────

describe('DataStructuresController.update()', () => {
  it('renames and returns updated view', async () => {
    const { ctrl } = await buildController();
    const result = await ctrl.update('proj-1', 'ds-1', { name: 'customers' }, USER as any);
    expect(result.name).toBe('customers');
  });

  it('propagates NotFoundException for unknown id', async () => {
    const { ctrl } = await buildController({
      update: jest.fn<any>().mockRejectedValue(new NotFoundException()),
    });
    await expect(
      ctrl.update('proj-1', 'ghost', { name: 'x' }, USER as any),
    ).rejects.toThrow(NotFoundException);
  });
});

// ── delete ────────────────────────────────────────────────────

describe('DataStructuresController.delete()', () => {
  it('delegates to service.delete and returns void', async () => {
    const { ctrl, svc } = await buildController();
    await expect(ctrl.delete('proj-1', 'ds-1', USER as any)).resolves.toBeUndefined();
    expect(svc.delete).toHaveBeenCalledWith('proj-1', 'ds-1');
  });

  it('propagates NotFoundException for unknown id', async () => {
    const { ctrl } = await buildController({
      delete: jest.fn<any>().mockRejectedValue(new NotFoundException()),
    });
    await expect(ctrl.delete('proj-1', 'ghost', USER as any)).rejects.toThrow(NotFoundException);
  });
});
