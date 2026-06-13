import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { StructureItemsController } from './structure-items.controller';
import { StructureItemsService } from './structure-items.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';

const NOW = new Date('2026-01-01T00:00:00.000Z');

const STORED_ROW = {
  id: 'item-1',
  data: { title: 'Hello' },
  createdAt: NOW,
  updatedAt: NOW,
};

const PAGE = { data: [STORED_ROW], nextCursor: null, total: 1 };

const USER = { sub: 'user-1', email: 'u@test.com' };

function buildService() {
  return {
    assertProjectMember: jest.fn<any>().mockResolvedValue(undefined),
    create: jest.fn<any>().mockResolvedValue(STORED_ROW),
    list: jest.fn<any>().mockResolvedValue(PAGE),
    get: jest.fn<any>().mockResolvedValue(STORED_ROW),
    update: jest.fn<any>().mockResolvedValue(STORED_ROW),
    delete: jest.fn<any>().mockResolvedValue({ deleted: true, id: 'item-1' }),
  };
}

async function buildController(serviceOverrides = {}) {
  const svc = { ...buildService(), ...serviceOverrides };
  const mod = await Test.createTestingModule({
    controllers: [StructureItemsController],
    providers: [{ provide: StructureItemsService, useValue: svc }],
  })
    .overrideGuard(JwtOrApiKeyGuard)
    .useValue({ canActivate: () => true })
    .compile();

  return { controller: mod.get(StructureItemsController), svc };
}

describe('StructureItemsController', () => {
  it('POST / → create', async () => {
    const { controller, svc } = await buildController();
    const result = await controller.create('proj-1', 'str-1', { title: 'Hello' }, USER as any);
    expect(svc.assertProjectMember).toHaveBeenCalledWith('proj-1', 'user-1');
    expect(svc.create).toHaveBeenCalledWith('proj-1', 'str-1', { title: 'Hello' });
    expect(result.id).toBe('item-1');
  });

  it('GET / → list with defaults', async () => {
    const { controller, svc } = await buildController();
    await controller.list('proj-1', 'str-1', undefined, undefined, USER as any);
    expect(svc.list).toHaveBeenCalledWith('proj-1', 'str-1', { limit: 20, cursor: undefined });
  });

  it('GET / → list with custom limit', async () => {
    const { controller, svc } = await buildController();
    await controller.list('proj-1', 'str-1', '5', 'cur-abc', USER as any);
    expect(svc.list).toHaveBeenCalledWith('proj-1', 'str-1', { limit: 5, cursor: 'cur-abc' });
  });

  it('GET /:itemId → getOne', async () => {
    const { controller } = await buildController();
    const result = await controller.getOne('proj-1', 'str-1', 'item-1', USER as any);
    expect(result.id).toBe('item-1');
  });

  it('PATCH /:itemId → update', async () => {
    const { controller, svc } = await buildController();
    await controller.update('proj-1', 'str-1', 'item-1', { title: 'New' }, USER as any);
    expect(svc.update).toHaveBeenCalledWith('proj-1', 'str-1', 'item-1', { title: 'New' });
  });

  it('DELETE /:itemId → remove', async () => {
    const { controller } = await buildController();
    const result = await controller.remove('proj-1', 'str-1', 'item-1', USER as any);
    expect(result).toEqual({ deleted: true, id: 'item-1' });
  });

  it('propagates NotFoundException from service', async () => {
    const { controller } = await buildController({
      get: jest.fn<any>().mockRejectedValue(new NotFoundException('Item not found')),
    });
    await expect(controller.getOne('proj-1', 'str-1', 'bad', USER as any)).rejects.toThrow(
      NotFoundException,
    );
  });
});
