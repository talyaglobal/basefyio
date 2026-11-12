import { HttpException } from '@nestjs/common';
import { EntityNotFoundError, QueryValidationError } from '@basefyio/data-engine';
import { DataEngineController } from './data-engine.controller';

function makeCollection() {
  return {
    insert: jest.fn(async (doc: any) => ({ _id: 'd1', _version: 1, ...doc })),
    insertMany: jest.fn(async (docs: any[]) => docs.map((d, i) => ({ _id: `d${i}`, _version: 1, ...d }))),
    get: jest.fn(async () => ({ _id: 'd1', _version: 3, _status: 'deleted', name: 'n' })),
    update: jest.fn(async (_id: string, patch: any) => ({ _id: 'd1', _version: 5, ...patch })),
    replace: jest.fn(async (_id: string, doc: any) => ({ _id: 'd1', _version: 5, ...doc })),
    delete: jest.fn(async () => undefined),
    restore: jest.fn(async () => ({ _id: 'd1', _version: 4, _status: 'active' })),
    query: jest.fn(async () => ({ data: [{ _id: 'd1', _version: 1, name: 'n', secret: 's' }], total: 1, hasMore: false })),
    count: jest.fn(async () => 7),
  };
}

function makeController(collection = makeCollection()) {
  const service = {
    isAvailable: () => true,
    resolveEntity: jest.fn(async () => ({ definition: { fields: [] }, collection })),
    prepareWrite: jest.fn(async (_def: unknown, body: any) => {
      if (Array.isArray(body) || typeof body !== 'object' || body === null) {
        throw Object.assign(new Error('Document must be a JSON object'), { code: 'INVALID_DOCUMENT', statusCode: 400 });
      }
      return body;
    }),
  };
  return { controller: new DataEngineController(service as any), service, collection };
}

const res = () => ({ setHeader: jest.fn() }) as any;

async function statusOf(p: Promise<unknown>): Promise<number> {
  try {
    await p;
  } catch (err) {
    return (err as HttpException).getStatus();
  }
  return 200;
}

describe('DataEngineController', () => {
  it('queries with the documented filter and sort formats (no 503)', async () => {
    const { controller, collection } = makeController();
    await controller.listRecords('p1', 'orders', {
      filter: '{"grp":"g1"}',
      sort: '[{"path":"_createdAt","direction":"desc"}]',
    });
    const q = (collection.query.mock.calls as any)[0][0];
    expect(q.filter).toMatchObject({ type: 'field', operator: 'eq', value: 'g1' });
    expect(q.sort[0]).toMatchObject({ direction: 'desc' });
  });

  it('answers 400 for an invalid filter instead of 503 with internal text', async () => {
    const { controller } = makeController();
    expect(await statusOf(controller.listRecords('p1', 'orders', { filter: '{"a":{"$bogus":1}}' }))).toBe(400);
    expect(await statusOf(controller.listRecords('p1', 'orders', { filter: '{"a":' }))).toBe(400);
  });

  it('applies select as a projection', async () => {
    const { controller } = makeController();
    const page = await controller.listRecords('p1', 'orders', { select: 'name' });
    expect(page.data[0]).toEqual({ _id: 'd1', _version: 1, name: 'n' });
  });

  it('answers 404 with guidance for an unregistered entity', async () => {
    const { controller, service } = makeController();
    service.resolveEntity.mockRejectedValueOnce(new EntityNotFoundError('posts'));
    const err = await controller.listRecords('p1', 'posts', {}).catch((e) => e);
    expect(err.getStatus()).toBe(404);
    expect(err.getResponse().message).toContain('/collections/posts/documents');
  });

  it('inserts an array body as a bulk insert, never as {"0": …}', async () => {
    const { controller, collection } = makeController();
    const out = await controller.createRecord('p1', 'orders', [{ n: 1 }, { n: 2 }], res());
    expect(collection.insertMany).toHaveBeenCalledWith([{ n: 1 }, { n: 2 }], { userId: undefined });
    expect(out).toHaveLength(2);
    expect(await statusOf(controller.createRecord('p1', 'orders', [], res()))).toBe(400);
  });

  it('names the failing element of a bulk insert and writes nothing', async () => {
    const { controller, collection } = makeController();
    const err = await controller.createRecord('p1', 'orders', [{ n: 1 }, 'x'], res()).catch((e) => e);
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse().message).toMatch(/^Document \[1\]/);
    expect(collection.insertMany).not.toHaveBeenCalled();
  });

  it('passes If-Match to writes and returns an ETag', async () => {
    const { controller, collection } = makeController();
    const r = res();
    await controller.updateRecord('p1', 'orders', 'd1', { x: 1 }, '"4"', r);
    expect(collection.update).toHaveBeenCalledWith('d1', { x: 1 }, { userId: undefined, ifMatch: 4 });
    expect(r.setHeader).toHaveBeenCalledWith('ETag', '"5"');

    await controller.replaceRecord('p1', 'orders', 'd1', { x: 1 }, 'W/"5"', res());
    expect((collection.replace.mock.calls as any)[0][2]).toEqual({ userId: undefined, ifMatch: 5 });

    await controller.deleteRecord('p1', 'orders', 'd1', '6');
    expect(collection.delete).toHaveBeenCalledWith('d1', { userId: undefined, ifMatch: 6 });
  });

  it('maps a version conflict to 409 and a missing document to 404', async () => {
    const collection = makeCollection();
    collection.update.mockRejectedValueOnce(
      Object.assign(new Error('Concurrency conflict'), { code: 'CONCURRENCY_CONFLICT', statusCode: 409 }),
    );
    collection.delete.mockRejectedValueOnce(
      Object.assign(new Error('Document "x" not found'), { code: 'DOCUMENT_NOT_FOUND', statusCode: 404 }),
    );
    const { controller } = makeController(collection);
    expect(await statusOf(controller.updateRecord('p1', 'orders', 'd1', { x: 1 }, '1', res()))).toBe(409);
    expect(await statusOf(controller.deleteRecord('p1', 'orders', 'x', undefined))).toBe(404);
  });

  it('reads soft-deleted documents on request and restores them', async () => {
    const { controller, collection } = makeController();
    await controller.getRecord('p1', 'orders', 'd1', 'true', res());
    expect(collection.get).toHaveBeenCalledWith('d1', { includeSoftDeleted: true });
    const restored = await controller.restoreRecord('p1', 'orders', 'd1', undefined, res());
    expect(restored._status).toBe('active');
  });

  it('counts with a filter', async () => {
    const { controller, collection } = makeController();
    await expect(controller.countRecords('p1', 'orders', '{"status":"paid"}')).resolves.toEqual({ count: 7 });
    expect((collection.count.mock.calls as any)[0][0]).toMatchObject({ type: 'field', value: 'paid' });
  });

  it('turns unexpected engine failures into a generic 500', async () => {
    const collection = makeCollection();
    collection.query.mockRejectedValueOnce(new TypeError("Cannot read properties of undefined (reading 'replace')"));
    const { controller } = makeController(collection);
    const err = await controller.listRecords('p1', 'orders', {}).catch((e) => e);
    expect(err.getStatus()).toBe(500);
    expect(JSON.stringify(err.getResponse())).not.toContain('replace');
  });

  it('keeps QueryValidationError a 400 when thrown by a provider', async () => {
    const collection = makeCollection();
    collection.query.mockRejectedValueOnce(new QueryValidationError('Unsupported filter operator'));
    const { controller } = makeController(collection);
    expect(await statusOf(controller.listRecords('p1', 'orders', {}))).toBe(400);
  });
});
