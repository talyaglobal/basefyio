import { ConflictException } from '@nestjs/common';
import { DataEngineService } from './data-engine.service';

function makeConfig(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'dataEngine.provider': 'mongodb',
    'dataEngine.maxDocumentKb': 1024,
    'dataEngine.maxNestingDepth': 8,
    'dataEngine.maxArrayItems': 1000,
    'dataEngine.schemaValidation': 'enforce',
    ...overrides,
  };
  return { get: (key: string) => values[key] } as any;
}

function makePrisma() {
  const created: Record<string, unknown[]> = { entity: [], version: [], outbox: [] };
  const tx = {
    entityDefinition: {
      create: jest.fn(async ({ data }: any) => {
        created.entity.push(data);
        return { id: 'e1', ...data };
      }),
      update: jest.fn(async ({ data }: any) => ({ id: 'e1', ...data })),
      delete: jest.fn(async () => ({})),
    },
    entitySchemaVersion: {
      create: jest.fn(async ({ data }: any) => {
        created.version.push(data);
        return data;
      }),
    },
    dataEngineOutbox: {
      create: jest.fn(async ({ data }: any) => {
        created.outbox.push(data);
        return data;
      }),
    },
  };
  const prisma = {
    ...tx,
    entityDefinition: { ...tx.entityDefinition, findFirst: jest.fn(async () => null), findUnique: jest.fn(async () => null) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { prisma: prisma as any, tx, created };
}

const definition = {
  fields: [
    { name: 'firstName', kind: 'scalar', type: 'text', required: true, validationRules: [] },
    { name: 'age', kind: 'scalar', type: 'number', required: false, validationRules: [] },
  ],
};

describe('DataEngineService.prepareWrite', () => {
  const svc = new DataEngineService(makeConfig(), makePrisma().prisma);

  it('accepts a valid document and strips envelope fields', async () => {
    await expect(svc.prepareWrite(definition, { firstName: 'A', _id: 'x', _version: 9 }, 'create')).resolves.toEqual({ firstName: 'A' });
  });

  it('rejects schema violations with 422', async () => {
    await expect(svc.prepareWrite(definition, { age: 'otuz' }, 'create')).rejects.toMatchObject({
      statusCode: 422,
      code: 'SCHEMA_VALIDATION_FAILED',
    });
  });

  it('rejects array and scalar bodies with 400', async () => {
    await expect(svc.prepareWrite(definition, [{ firstName: 'A' }], 'create')).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.prepareWrite(definition, 'x', 'create')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('enforces the size, depth and array limits', async () => {
    const small = new DataEngineService(
      makeConfig({ 'dataEngine.maxDocumentKb': 1, 'dataEngine.maxArrayItems': 3, 'dataEngine.maxNestingDepth': 2 }),
      makePrisma().prisma,
    );
    await expect(small.prepareWrite({ fields: [] }, { blob: 'x'.repeat(2000) }, 'create')).rejects.toMatchObject({ statusCode: 413 });
    await expect(small.prepareWrite({ fields: [] }, { tags: [1, 2, 3, 4] }, 'create')).rejects.toMatchObject({ statusCode: 422 });
    await expect(small.prepareWrite({ fields: [] }, { a: { b: { c: {} } } }, 'create')).rejects.toMatchObject({ statusCode: 422 });
  });

  it('DATA_ENGINE_SCHEMA_VALIDATION=off skips field checks but keeps limits', async () => {
    const off = new DataEngineService(makeConfig({ 'dataEngine.schemaValidation': 'off', 'dataEngine.maxArrayItems': 3 }), makePrisma().prisma);
    await expect(off.prepareWrite(definition, { age: 'otuz' }, 'create')).resolves.toEqual({ age: 'otuz' });
    await expect(off.prepareWrite(definition, { tags: [1, 2, 3, 4] }, 'create')).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('DataEngineService.createEntityDefinition', () => {
  it('normalises fields (the docs example without validationRules works) and writes in one transaction', async () => {
    const { prisma, created } = makePrisma();
    const svc = new DataEngineService(makeConfig(), prisma);
    const entity = await svc.createEntityDefinition('p1', {
      logicalName: 'patients',
      displayName: 'Patients',
      fields: [
        { name: 'firstName', kind: 'scalar', type: 'text', required: true },
        { name: 'address', kind: 'object', children: [{ name: 'city', kind: 'scalar', type: 'text', required: true }] },
        { name: 'tags', kind: 'array', itemSchema: { name: 'tag', kind: 'scalar', type: 'text' } },
      ],
    });
    expect(entity.logicalName).toBe('patients');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect((created.entity[0] as any).fields[0]).toMatchObject({ name: 'firstName', validationRules: [], required: true });
    expect((created.version[0] as any).snapshot.required).toEqual(['firstName']);
    expect(created.outbox[0]).toMatchObject({ type: 'entity.created', entity: 'patients' });
  });

  it('accepts a request without fields', async () => {
    const { prisma, created } = makePrisma();
    const svc = new DataEngineService(makeConfig(), prisma);
    await svc.createEntityDefinition('p1', { logicalName: 'notes', displayName: 'Notes' });
    expect((created.entity[0] as any).fields).toEqual([]);
  });

  it('rejects a malformed field list with 400 before writing anything', async () => {
    const { prisma } = makePrisma();
    const svc = new DataEngineService(makeConfig(), prisma);
    await expect(
      svc.createEntityDefinition('p1', { logicalName: 'x', displayName: 'X', fields: [{ kind: 'scalar' }] }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_ENTITY_DEFINITION' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('answers 409 for a duplicate or colliding name', async () => {
    const { prisma } = makePrisma();
    prisma.entityDefinition.findFirst.mockResolvedValueOnce({ logicalName: 'patients' });
    const svc = new DataEngineService(makeConfig(), prisma);
    await expect(svc.createEntityDefinition('p1', { logicalName: 'patients', displayName: 'P' })).rejects.toBeInstanceOf(ConflictException);

    prisma.entityDefinition.findFirst.mockResolvedValueOnce({ logicalName: 'qaE2eNeMin' });
    await expect(svc.createEntityDefinition('p1', { logicalName: 'qae2enemin', displayName: 'P' })).rejects.toThrow(/collides with the existing entity "qaE2eNeMin"/);
  });

  it('maps a racing unique violation to 409', async () => {
    const { prisma } = makePrisma();
    prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    const svc = new DataEngineService(makeConfig(), prisma);
    await expect(svc.createEntityDefinition('p1', { logicalName: 'a', displayName: 'A' })).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('DataEngineService entity update / delete', () => {
  const existing = { id: 'e1', projectId: 'p1', logicalName: 'orders', schemaVersion: 1, fields: [] };

  it('a field change publishes a new schema version', async () => {
    const { prisma, tx, created } = makePrisma();
    prisma.entityDefinition.findUnique.mockResolvedValue(existing);
    const svc = new DataEngineService(makeConfig(), prisma);
    await svc.updateEntityDefinition('p1', 'orders', { fields: [{ name: 'total', kind: 'scalar', type: 'number' }] });
    expect(tx.entityDefinition.update.mock.calls[0][0].data.schemaVersion).toBe(2);
    expect(created.version[0]).toMatchObject({ version: 2 });
    expect(created.outbox[0]).toMatchObject({ type: 'entity.schema.changed', schemaVersion: 2 });
  });

  it('refuses to delete an entity that still holds documents unless forced', async () => {
    const { prisma, tx } = makePrisma();
    prisma.entityDefinition.findUnique.mockResolvedValue(existing);
    const collection = { count: jest.fn(async () => 3), purge: jest.fn(async () => 3) };
    const svc = new DataEngineService(makeConfig(), prisma);
    (svc as any).engine = { collection: () => collection, provisionTenant: jest.fn(async () => ({})) };

    await expect(svc.deleteEntityDefinition('p1', 'orders', false)).rejects.toMatchObject({ status: 409 });
    expect(collection.purge).not.toHaveBeenCalled();
    expect(collection.count).toHaveBeenCalledWith(undefined, { includeSoftDeleted: true });

    await expect(svc.deleteEntityDefinition('p1', 'orders', true)).resolves.toMatchObject({ deleted: true, documentsRemoved: 3 });
    expect(tx.entityDefinition.delete).toHaveBeenCalledWith({ where: { id: 'e1' } });
  });

  it('deletes an empty entity without force', async () => {
    const { prisma } = makePrisma();
    prisma.entityDefinition.findUnique.mockResolvedValue(existing);
    const svc = new DataEngineService(makeConfig(), prisma);
    (svc as any).engine = { collection: () => ({ count: async () => 0 }), provisionTenant: async () => ({}) };
    await expect(svc.deleteEntityDefinition('p1', 'orders', false)).resolves.toMatchObject({ documentsRemoved: 0 });
  });
});
