/**
 * Data Engine vectors against a real MongoDB (7.0, standalone). Skipped unless
 * MONGO_TEST_URL is set; CI runs it with a mongo:7.0.35 service container.
 *
 * Covers what the in-memory driver mock cannot: BSON vector (binary subtype 9,
 * float32) round trip through the server, the partial index, maxTimeMS being
 * honoured, the scan limit at its exact edge, and a 10 000 x 1536 search timing.
 */
import * as mongodb from 'mongodb';
import { createDataEngine, type DataEngine } from '@basefyio/data-engine';
import { DataVectorEmbedderService } from './data-vector-embedder.service';
import { buildSourceText, sourceHash } from './vector-source';

const URL = process.env.MONGO_TEST_URL;
const describeReal = URL ? describe : describe.skip;

const DB = `basefyio_vector_test_${process.pid}_${Date.now()}`;
const COLLECTION = 'records';
const DIMS = 1536;
const N = 10_000;

async function engineWith(vector: { maxScan?: number; timeoutMs?: number } = {}): Promise<DataEngine> {
  const engine = await createDataEngine({
    provider: 'mongodb',
    connectionString: URL,
    container: DB,
    namespace: COLLECTION,
    maxDocumentKb: 1024,
    maxNestingDepth: 8,
    maxArrayItems: 1000,
    vector,
  });
  // The package resolves `mongodb` from its own folder (the image links it there);
  // in the test tree it lives in this app's node_modules.
  (engine as any).driver = mongodb;
  return engine;
}

function randomUnit(dims: number, seed: { s: number }): Float32Array {
  const v = new Float32Array(dims);
  let sum = 0;
  for (let i = 0; i < dims; i++) {
    seed.s = (seed.s * 1103515245 + 12345) % 2147483648;
    v[i] = (seed.s / 2147483648) * 2 - 1;
    sum += v[i] * v[i];
  }
  const n = Math.sqrt(sum);
  for (let i = 0; i < dims; i++) v[i] /= n;
  return v;
}

describeReal('Data Engine vectors on a real MongoDB', () => {
  jest.setTimeout(300_000);

  let client: mongodb.MongoClient;
  let raw: mongodb.Collection;
  let engine: DataEngine;

  beforeAll(async () => {
    client = new mongodb.MongoClient(URL as string);
    await client.connect();
    raw = client.db(DB).collection(COLLECTION);
    engine = await engineWith();
    await engine.provisionTenant('p1');
  });

  afterAll(async () => {
    await client?.db(DB).dropDatabase().catch(() => undefined);
    await (engine as any)?._close?.();
    await client?.close();
  });

  it('creates the partial vector index next to idx_scope', async () => {
    const indexes = await raw.indexes();
    const vec = indexes.find((i) => i.name === 'idx_vec_scope');
    expect(vec).toBeDefined();
    expect(vec!.key).toEqual({ 'envelope.projectId': 1, 'envelope.entity': 1 });
    expect(vec!.partialFilterExpression).toEqual({ 'vectors.default.dims': { $exists: true } });
    expect(indexes.some((i) => i.name === 'idx_scope')).toBe(true);
  });

  it('round-trips a vector as BinData subtype 9 float32, outside the record and without a version bump', async () => {
    const col = engine.collection('p1', 'small');
    const doc = await col.insert({ title: 'a' });
    await col.setVector!(doc._id, [3, 4, 0]);

    const stored = (await raw.findOne({ _id: doc._id as any })) as any;
    const bin = stored.vectors.default.f32_3 as mongodb.Binary;
    expect(bin).toBeInstanceOf(mongodb.Binary);
    expect(bin.sub_type).toBe(9);
    expect(bin.buffer[0]).toBe(0x27);
    const back = Array.from(bin.toFloat32Array());
    expect(back[0]).toBeCloseTo(0.6, 6);
    expect(back[1]).toBeCloseTo(0.8, 6);
    expect(stored.data).toEqual({ title: 'a' });
    expect(stored.envelope.version).toBe(1);

    const got = await col.get(doc._id);
    expect(got).not.toHaveProperty('vectors');
    expect(got!._version).toBe(1);
    const page = await col.query({ entity: 'small' });
    expect(page.data[0]).not.toHaveProperty('vectors');
    const agg = await engine.aggregate('p1', { entity: 'small', pipeline: [{ $limit: 5 }] });
    expect(agg.data[0]).not.toHaveProperty('vectors');

    const res = await col.vectorSearch!({ vector: [1, 1, 0], limit: 1 });
    expect(res.hits[0].doc._id).toBe(doc._id);
    expect(res.hits[0].doc).not.toHaveProperty('vectors');

    // Another project never sees it.
    const other = engine.collection('p2', 'small');
    await expect(other.getVector!(doc._id)).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
    expect((await other.vectorSearch!({ vector: [1, 1, 0] })).hits).toEqual([]);
  });

  describe('platform vectors (Stage 2)', () => {
    const TAG = 'test/model-a';
    const CONFIG = { mode: 'platform', dimensions: 3, sourcePaths: ['title', 'body.text'], modelTag: TAG, updatedAt: 't' };

    /** The worker, over the real engine; the provider is a deterministic fake. */
    function worker() {
      const embed = jest.fn(async (_p: unknown, texts: string[]) => ({
        vectors: texts.map((t) => [t.length, 1, 0.5]),
        tokenCount: texts.length,
        perItemTokens: 1,
        tag: TAG,
        nativeDimensions: 3,
      }));
      const dataEngine = {
        getEntityCollection: async (p: string, e: string) => engine.collection(p, e),
        getVectorConfig: async () => CONFIG,
        getVectorSetup: async () => ({ config: CONFIG, reembed: null }),
        setVectorReembedState: async () => undefined,
        setVectorConfig: async () => undefined,
      };
      const projectEmbedding = {
        loadProject: async (id: string) => ({ id }),
        resolve: () => ({ tag: TAG, keySource: 'platform' }),
        dimensions: async () => 3,
        assertPlatformKeyAllowed: async () => undefined,
        embedForProject: embed,
      };
      const svc = new DataVectorEmbedderService(dataEngine as any, projectEmbedding as any, { add: jest.fn() } as any);
      return { svc, embed };
    }

    it('round-trips source, model and hash; vectorSources returns only the requested paths and no vector', async () => {
      const col = engine.collection('p1', 'plat');
      const doc = await col.insert({ title: 'Red shoes', body: { text: 'Leather', secret: 's' }, price: 3 });
      await col.setVector!(doc._id, [1, 2, 3], { source: 'platform', model: TAG, hash: 'abc', ifVersion: 1 });

      const meta = await col.getVectorMeta!(doc._id);
      expect(meta).toMatchObject({ id: doc._id, dims: 3, model: TAG, source: 'platform', hash: 'abc' });
      expect(meta).not.toHaveProperty('vector');

      const [row] = await col.vectorSources!({ paths: ['title', 'body.text', 'body'], ids: [doc._id] });
      expect(row).toMatchObject({ id: doc._id, version: 1, data: { title: 'Red shoes', body: { text: 'Leather', secret: 's' } } });
      expect(row.data).not.toHaveProperty('price');
      expect(row.vector).toMatchObject({ hash: 'abc', model: TAG });

      // A stale version is refused and nothing is written.
      await col.update(doc._id, { title: 'Blue shoes' });
      await expect(
        col.setVector!(doc._id, [3, 2, 1], { source: 'platform', model: TAG, hash: 'def', ifVersion: 1 }),
      ).rejects.toMatchObject({ code: 'CONCURRENCY_CONFLICT' });
      expect((await col.getVectorMeta!(doc._id))!.hash).toBe('abc');
      const stored = (await raw.findOne({ _id: doc._id as any })) as any;
      expect(stored.envelope.version).toBe(2);
    });

    it('counts pending and failed against a model', async () => {
      const col = engine.collection('p1', 'pend');
      const ids = [];
      for (let i = 0; i < 5; i++) ids.push((await col.insert({ title: `t${i}` }))._id);
      await col.setVector!(ids[0], [1, 0, 0], { source: 'platform', model: TAG, hash: 'h' });
      await col.setVector!(ids[1], [1, 0, 0], { source: 'platform', model: 'test/old', hash: 'h' });
      await col.setVectorMarker!(ids[2], { kind: 'empty', model: TAG, hash: null });
      await col.setVectorMarker!(ids[3], { kind: 'failed', model: TAG, hash: 'h', error: 'x' });
      // ids[4]: no vector at all.
      expect(await col.vectorStats!({ model: TAG })).toEqual({ embedded: 2, total: 5, pending: 2, failed: 1 });
      expect(await col.vectorStats!()).toEqual({ embedded: 2, total: 5 });
      // Searching only sees vectors of the queried width; the empty record left search.
      expect((await col.vectorSearch!({ vector: [1, 0, 0], limit: 10, maxDistance: 2 })).hits.map((h) => h.doc._id).sort())
        .toEqual([ids[0], ids[1]].sort());
    });

    it('the worker skips an unchanged record by its hash and re-embeds a changed one', async () => {
      const col = engine.collection('p1', 'hashes');
      const doc = await col.insert({ title: 'Red shoes', body: { text: 'Leather' } });
      const { svc, embed } = worker();
      expect(await svc.embedRecord({ projectId: 'p1', entity: 'hashes', id: doc._id })).toBe('embedded');
      const first = await col.getVectorMeta!(doc._id);
      expect(first!.hash).toBe(sourceHash(buildSourceText({ title: 'Red shoes', body: { text: 'Leather' } }, CONFIG.sourcePaths)));

      expect(await svc.embedRecord({ projectId: 'p1', entity: 'hashes', id: doc._id })).toBe('unchanged');
      expect(embed).toHaveBeenCalledTimes(1);

      // A field outside the source paths does not change the hash.
      await col.update(doc._id, { price: 9 });
      expect(await svc.embedRecord({ projectId: 'p1', entity: 'hashes', id: doc._id })).toBe('unchanged');

      await col.update(doc._id, { title: 'Blue shoes' });
      expect(await svc.embedRecord({ projectId: 'p1', entity: 'hashes', id: doc._id })).toBe('embedded');
      expect(embed).toHaveBeenCalledTimes(2);
      expect((await col.getVectorMeta!(doc._id))!.hash).not.toBe(first!.hash);
      expect((await col.get(doc._id))!._version).toBe(3);
    });

    it('the worker cannot write a vector to a record of another project or entity, even given its id', async () => {
      const foreign = await engine.collection('p2', 'hashes').insert({ title: 'P2 secret' });
      const sibling = await engine.collection('p1', 'other').insert({ title: 'Other entity' });
      const { svc, embed } = worker();
      expect(await svc.embedRecord({ projectId: 'p1', entity: 'hashes', id: foreign._id })).toBe('missing');
      expect(await svc.embedRecord({ projectId: 'p1', entity: 'hashes', id: sibling._id })).toBe('missing');
      expect(embed).not.toHaveBeenCalled();
      for (const id of [foreign._id, sibling._id]) {
        const stored = (await raw.findOne({ _id: id as any })) as any;
        expect(stored.vectors).toBeUndefined();
      }
      // And a re-embed of p1/hashes never touches them.
      await svc.reembedEntity({ projectId: 'p1', entity: 'hashes' });
      for (const id of [foreign._id, sibling._id]) {
        expect(((await raw.findOne({ _id: id as any })) as any).vectors).toBeUndefined();
      }
    });
  });

  describe(`${N} x ${DIMS}`, () => {
    const seed = { s: 7 };
    let probe: { id: string; vector: number[] };

    beforeAll(async () => {
      const now = new Date().toISOString();
      for (let start = 0; start < N; start += 500) {
        const docs = [];
        for (let i = start; i < Math.min(N, start + 500); i++) {
          const v = randomUnit(DIMS, seed);
          const id = `big-${String(i).padStart(5, '0')}`;
          if (i === 4321) probe = { id, vector: Array.from(v) };
          docs.push({
            _id: id,
            envelope: {
              entity: 'big', projectId: 'p1', schemaVersion: 1, version: 1, lastEventId: null,
              eventSequence: 1, status: 'active', createdAt: now, updatedAt: now, createdBy: '', deletedAt: null,
            },
            data: { i, bucket: i % 10 },
            vectors: {
              default: { dims: DIMS, model: 'client', source: 'client', hash: null, updatedAt: now, [`f32_${DIMS}`]: mongodb.Binary.fromFloat32Array(v) },
            },
          });
        }
        await raw.insertMany(docs as any[]);
      }
    });

    it('finds the exact match first over the full 10 000, and prints the timing', async () => {
      const col = engine.collection('p1', 'big');
      const runs: number[] = [];
      let res;
      for (let r = 0; r < 3; r++) {
        const t0 = Date.now();
        res = await col.vectorSearch!({ vector: probe.vector, limit: 10 });
        runs.push(Date.now() - t0);
      }
      expect(res!.scanned).toBe(N);
      expect(res!.hits[0].doc._id).toBe(probe.id);
      expect(res!.hits[0].distance).toBeCloseTo(0, 5);
      expect(res!.hits).toHaveLength(10);

      const filtered = Date.now();
      const narrow = await col.vectorSearch!({
        vector: probe.vector,
        filter: { type: 'field', path: { path: 'bucket', isArrayPath: false }, operator: 'eq', value: 1 },
      });
      const filteredMs = Date.now() - filtered;
      expect(narrow.scanned).toBe(N / 10);
      expect(narrow.hits[0].doc._id).toBe(probe.id);

      // eslint-disable-next-line no-console
      console.log(`[vector timing] ${N} x ${DIMS} exact search: ${runs.join(' ms, ')} ms; filtered to ${N / 10}: ${filteredMs} ms`);
    });

    it('refuses one record above the scan limit instead of returning a partial result', async () => {
      const col = engine.collection('p1', 'big');
      const extra = await col.insert({ i: N });
      await col.setVector!(extra._id, probe.vector);
      await expect(col.vectorSearch!({ vector: probe.vector })).rejects.toMatchObject({ code: 'VECTOR_SCAN_LIMIT', statusCode: 422 });
      await col.deleteVector!(extra._id);
      await expect(col.vectorSearch!({ vector: probe.vector, limit: 1 })).resolves.toMatchObject({ scanned: N });
    });

    it('honours maxTimeMS as VECTOR_SEARCH_TIMEOUT', async () => {
      const hasty = await engineWith({ timeoutMs: 1 });
      try {
        await expect(hasty.collection('p1', 'big').vectorSearch!({ vector: probe.vector })).rejects.toMatchObject({
          code: 'VECTOR_SEARCH_TIMEOUT',
        });
      } finally {
        await (hasty as any)._close();
      }
    });
  });
});
