/**
 * MongoDataEngine contract test — runs against a virtual in-memory mock of
 * the `mongodb` driver (the package is an optional peer dep and is NOT
 * installed). Verifies tenant scoping, the envelope/data document layout,
 * soft delete, and result flattening — the parts a translation unit test
 * cannot see.
 */

interface FakeDoc {
  _id: string;
  envelope: Record<string, unknown>;
  data: Record<string, unknown>;
}

const calls: Record<string, unknown[]> = {};
let store: FakeDoc[] = [];
let aggregateResult: Record<string, unknown>[] = [];

function record(name: string, args: unknown) {
  (calls[name] ??= []).push(args);
}

/** Matches only the exact filter shapes MongoEntityCollection generates. */
function matches(doc: FakeDoc, filter: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$and') {
      if (!(cond as Record<string, unknown>[]).every((c) => matches(doc, c))) return false;
      continue;
    }
    const value =
      key === '_id'
        ? doc._id
        : key.startsWith('envelope.')
          ? doc.envelope[key.slice('envelope.'.length)]
          : key.startsWith('data.')
            ? doc.data[key.slice('data.'.length)]
            : undefined;
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      const ops = cond as Record<string, unknown>;
      if ('$ne' in ops && value === ops.$ne) return false;
      if ('$eq' in ops && value !== ops.$eq) return false;
      if ('$gt' in ops && !((value as number) > (ops.$gt as number))) return false;
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

function makeCursor(rows: Record<string, unknown>[]) {
  let result = [...rows];
  const cursor = {
    sort: (spec: Record<string, number>) => {
      record('cursor.sort', spec);
      return cursor;
    },
    skip: (n: number) => {
      result = result.slice(n);
      return cursor;
    },
    limit: (n: number) => {
      result = result.slice(0, n);
      return cursor;
    },
    project: (spec: Record<string, unknown>) => {
      record('cursor.project', spec);
      return cursor;
    },
    toArray: async () => result,
  };
  return cursor;
}

const fakeCollection = {
  insertOne: async (doc: FakeDoc) => {
    record('insertOne', doc);
    store.push(doc);
    return { insertedId: doc._id };
  },
  findOne: async (filter: Record<string, unknown>) => {
    record('findOne', filter);
    return store.find((d) => matches(d, filter)) ?? null;
  },
  findOneAndUpdate: async (
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ) => {
    record('findOneAndUpdate', { filter, update });
    const doc = store.find((d) => matches(d, filter));
    if (!doc) return null;
    const set = (update.$set ?? {}) as Record<string, unknown>;
    for (const [path, value] of Object.entries(set)) {
      if (path === 'data') doc.data = value as Record<string, unknown>;
      else if (path.startsWith('data.')) doc.data[path.slice(5)] = value;
      else if (path.startsWith('envelope.')) doc.envelope[path.slice(9)] = value;
    }
    const inc = (update.$inc ?? {}) as Record<string, number>;
    for (const [path, by] of Object.entries(inc)) {
      if (path.startsWith('envelope.')) {
        const k = path.slice(9);
        doc.envelope[k] = ((doc.envelope[k] as number) ?? 0) + by;
      }
    }
    return doc;
  },
  find: (filter: Record<string, unknown>) => {
    record('find', filter);
    return makeCursor(store.filter((d) => matches(d, filter)) as unknown as Record<string, unknown>[]);
  },
  countDocuments: async (filter: Record<string, unknown>) => {
    record('countDocuments', filter);
    return store.filter((d) => matches(d, filter)).length;
  },
  updateMany: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
    record('updateMany', { filter, update });
    return { modifiedCount: 0 };
  },
  aggregate: (pipeline: Record<string, unknown>[]) => {
    record('aggregate', pipeline);
    return makeCursor(aggregateResult);
  },
  createIndex: async (spec: Record<string, number>, options?: Record<string, unknown>) => {
    record('createIndex', { spec, options });
    return 'ok';
  },
};

jest.mock(
  'mongodb',
  () => ({
    MongoClient: class {
      connect = async () => this;
      db = () => ({
        collection: () => fakeCollection,
        command: async () => ({ ok: 1 }),
      });
      close = async () => undefined;
    },
  }),
  { virtual: true },
);

import { MongoDataEngine } from '../providers/mongodb/mongodb-engine';
import type { DataEngineConfig } from '../interfaces/types';

const config: DataEngineConfig = {
  provider: 'mongodb',
  connectionString: 'mongodb://test:27017',
  container: 'basefyio-apps',
  namespace: 'records',
  maxDocumentKb: 64,
  maxNestingDepth: 8,
  maxArrayItems: 100,
};

describe('MongoDataEngine contract', () => {
  let engine: MongoDataEngine;

  beforeEach(() => {
    store = [];
    aggregateResult = [];
    for (const key of Object.keys(calls)) delete calls[key];
    engine = new MongoDataEngine(config);
  });

  it('reports aggregationPipeline capability', () => {
    expect(engine.capabilities().aggregationPipeline).toBe(true);
  });

  it('insert stores envelope/data layout and returns a flattened DocResult', async () => {
    const col = engine.collection('p1', 'orders');
    const doc = await col.insert({ status: 'paid', total: 42 }, { userId: 'u1' });

    const stored = (calls.insertOne![0]) as FakeDoc;
    expect(stored.envelope).toMatchObject({
      projectId: 'p1',
      entity: 'orders',
      version: 1,
      status: 'active',
      createdBy: 'u1',
    });
    expect(stored.data).toEqual({ status: 'paid', total: 42 });

    expect(doc._projectId).toBe('p1');
    expect(doc._entity).toBe('orders');
    expect(doc._version).toBe(1);
    expect(doc.status).toBe('paid');
    expect(doc.total).toBe(42);
  });

  it('get scopes by project, entity, and non-deleted status', async () => {
    const col = engine.collection('p1', 'orders');
    const created = await col.insert({ x: 1 });
    const fetched = await col.get(created._id);
    expect(fetched?._id).toBe(created._id);

    const otherTenant = engine.collection('p2', 'orders');
    expect(await otherTenant.get(created._id)).toBeNull();
  });

  it('update merges fields under data., bumps version, returns merged doc', async () => {
    const col = engine.collection('p1', 'orders');
    const created = await col.insert({ status: 'new', total: 1 });
    const updated = await col.update(created._id, { status: 'paid' });

    const { update } = (calls.findOneAndUpdate![0]) as { update: Record<string, unknown> };
    expect((update.$set as Record<string, unknown>)['data.status']).toBe('paid');
    expect((update.$inc as Record<string, unknown>)['envelope.version']).toBe(1);

    expect(updated._version).toBe(2);
    expect(updated.status).toBe('paid');
    expect(updated.total).toBe(1);
  });

  it('delete soft-deletes; the document disappears from get/query', async () => {
    const col = engine.collection('p1', 'orders');
    const created = await col.insert({ x: 1 });
    await col.delete(created._id);

    expect(await col.get(created._id)).toBeNull();
    expect(await col.count()).toBe(0);
  });

  it('query composes scope + translated filter and flattens rows', async () => {
    const col = engine.collection('p1', 'orders');
    await col.insert({ status: 'paid', total: 10 });
    await col.insert({ status: 'open', total: 5 });

    const page = await col.query({
      entity: 'orders',
      filter: {
        type: 'field',
        path: { path: 'status', isArrayPath: false },
        operator: 'eq',
        value: 'paid',
      },
    });

    const filter = (calls.find![0]) as Record<string, unknown>;
    expect(filter.$and).toBeDefined();
    expect(page.data).toHaveLength(1);
    expect(page.data[0].status).toBe('paid');
    expect(page.data[0]._projectId).toBe('p1');
    expect(page.total).toBe(1);
  });

  it('aggregate prepends tenant scope and flattens when not reshaped', async () => {
    aggregateResult = [
      {
        _id: 'a',
        envelope: {
          entity: 'orders', projectId: 'p1', schemaVersion: 1, version: 1,
          lastEventId: null, eventSequence: 1, status: 'active',
          createdAt: 't', updatedAt: 't', createdBy: '', deletedAt: null,
        },
        data: { total: 5 },
      },
    ];
    const page = await engine.aggregate('p1', {
      entity: 'orders',
      pipeline: [{ $limit: 5 }],
    });

    const pipeline = (calls.aggregate![0]) as Record<string, unknown>[];
    expect(pipeline[0]).toEqual({
      $match: {
        'envelope.projectId': 'p1',
        'envelope.entity': 'orders',
        'envelope.status': { $ne: 'deleted' },
      },
    });
    expect(page.data[0].total).toBe(5);
    expect(page.data[0]._projectId).toBe('p1');
  });

  it('aggregate returns reshaped rows untouched after $group', async () => {
    aggregateResult = [{ _id: 'IST', revenue: 100 }];
    const page = await engine.aggregate('p1', {
      entity: 'orders',
      pipeline: [
        {
          $group: {
            _id: { path: 'city', isArrayPath: false },
            accumulators: { revenue: { op: '$sum', path: { path: 'total', isArrayPath: false } } },
          },
        },
      ],
    });
    expect(page.data).toEqual([{ _id: 'IST', revenue: 100 }]);
  });

  it('ifMatch mismatch raises ConcurrencyError', async () => {
    const col = engine.collection('p1', 'orders');
    const created = await col.insert({ x: 1 });
    await expect(
      col.update(created._id, { x: 2 }, { ifMatch: 99 }),
    ).rejects.toMatchObject({ code: 'CONCURRENCY_CONFLICT' });
  });

  it('rejects oversized documents', async () => {
    const col = engine.collection('p1', 'orders');
    await expect(
      col.insert({ blob: 'x'.repeat(70 * 1024) }),
    ).rejects.toMatchObject({ code: 'DOCUMENT_TOO_LARGE' });
  });
});
