jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataEngineService } from './data-engine.service';

/** #173: creating an entity writes nothing when it fails, and a duplicate name is 409. */
function build(txImpl?: (fn: any) => Promise<unknown>) {
  const tx = {
    entityDefinition: { create: jest.fn(async () => ({ id: 'e1' })) },
    entitySchemaVersion: { create: jest.fn(async () => ({})) },
    dataEngineOutbox: { create: jest.fn(async () => ({})) },
  };
  const prisma = { $transaction: jest.fn(txImpl ?? (async (fn: any) => fn(tx))) };
  const svc = new DataEngineService({ get: () => undefined } as any, prisma as any);
  return { svc, prisma, tx };
}

describe('DataEngineService.createEntityDefinition', () => {
  it('creates the entity, its schema version and the outbox event in one transaction', async () => {
    const { svc, prisma, tx } = build();
    await svc.createEntityDefinition('p1', { logicalName: 'note', displayName: 'Note', fields: [] });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.entityDefinition.create).toHaveBeenCalled();
    expect(tx.entitySchemaVersion.create).toHaveBeenCalled();
    expect(tx.dataEngineOutbox.create).toHaveBeenCalled();
  });

  it('accepts a missing field list as empty', async () => {
    const { svc, tx } = build();
    await svc.createEntityDefinition('p1', { logicalName: 'note', displayName: 'Note' } as any);
    expect((tx.entityDefinition.create.mock.calls as any)[0][0].data.fields).toEqual([]);
  });

  it('refuses a field list that is not an array before writing anything', async () => {
    const { svc, prisma } = build();
    await expect(svc.createEntityDefinition('p1', { logicalName: 'n', displayName: 'N', fields: 'x' as any })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('answers 409 for a name that already exists', async () => {
    const { svc } = build(async () => {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    });
    await expect(svc.createEntityDefinition('p1', { logicalName: 'note', displayName: 'Note', fields: [] })).rejects.toBeInstanceOf(ConflictException);
  });
});
