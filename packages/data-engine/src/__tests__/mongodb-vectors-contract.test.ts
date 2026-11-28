/**
 * MongoDataEngine vector contract — against an in-memory mock of the
 * `mongodb` driver (an optional peer dependency, not installed here). The mock
 * evaluates the filters the engine sends, so a missing scope predicate shows
 * up as a leaked record, not just as a different call shape.
 *
 * What is checked: BinData (subtype 9, float32) storage of a unit vector, no
 * envelope change on a vector write, no `vectors` on any read path, scope on
 * every vector call, other projects/entities and soft-deleted records never
 * found, top-k equal to a brute-force reference, threshold, scan limit,
 * dimension mismatch, busy limit, and restore making a record searchable again.
 */

type Doc = Record<string, any>;

const calls: Record<string, unknown[]> = {};
let store: Doc[] = [];

function record(name: string, args: unknown) {
  (calls[name] ??= []).push(args);
}

class FakeBinary {
  static SUBTYPE_VECTOR = 9;
  constructor(public buffer: Uint8Array, public sub_type: number) {}
  static fromFloat32Array(values: Float32Array): FakeBinary {
    const out = new Uint8Array(2 + values.length * 4);
    out[0] = 0x27;
    const view = new DataView(out.buffer);
    values.forEach((v, i) => view.setFloat32(2 + i * 4, v, true));
    return new FakeBinary(out, 9);
  }
  toFloat32Array(): Float32Array {
    if (this.sub_type !== 9 || this.buffer[0] !== 0x27) throw new Error('not a float32 vector');
    const n = (this.buffer.length - 2) / 4;
    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
    return Float32Array.from({ length: n }, (_, i) => view.getFloat32(2 + i * 4, true));
  }
}

function clone<T>(v: T): T {
  if (v instanceof FakeBinary) return new FakeBinary(new Uint8Array(v.buffer), v.sub_type) as unknown as T;
  if (Array.isArray(v)) return v.map(clone) as unknown as T;
  if (v && typeof v === 'object') {
    const out: Doc = {};
    for (const [k, x] of Object.entries(v)) out[k] = clone(x);
    return out as T;
  }
  return v;
}

function getPath(doc: Doc, path: string): unknown {
  return path.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), doc);
}

function setPath(doc: Doc, path: string, value: unknown) {
  const keys = path.split('.');
  let o = doc;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys[keys.length - 1]] = value;
}

function unsetPath(doc: Doc, path: string): boolean {
  const keys = path.split('.');
  let o = doc;
  for (const k of keys.slice(0, -1)) {
    o = o?.[k];
    if (o == null) return false;
  }
  const last = keys[keys.length - 1];
  if (!(last in o)) return false;
  delete o[last];
  return true;
}

function matches(doc: Doc, filter: Doc): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$and') { if (!(cond as Doc[]).every((c) => matches(doc, c))) return false; continue; }
    if (key === '$or') { if (!(cond as Doc[]).some((c) => matches(doc, c))) return false; continue; }
    if (key === '$nor') { if ((cond as Doc[]).some((c) => matches(doc, c))) return false; continue; }
    const value = getPath(doc, key);
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      const ops = cond as Doc;
      for (const [op, arg] of Object.entries(ops)) {
        if (op === '$ne' && value === arg) return false;
        if (op === '$eq' && value !== arg) return false;
        if (op === '$gt' && !((value as number) > arg)) return false;
        if (op === '$gte' && !((value as number) >= arg)) return false;
        if (op === '$lt' && !((value as number) < arg)) return false;
        if (op === '$lte' && !((value as number) <= arg)) return false;
        if (op === '$in' && !(arg as unknown[]).includes(value)) return false;
        if (op === '$exists' && (value !== undefined) !== arg) return false;
      }
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

function applyProjection(doc: Doc, projection?: Doc): Doc {
  const d = clone(doc);
  if (!projection) return d;
  const values = Object.values(projection);
  if (values.every((v) => v === 0)) {
    for (const k of Object.keys(projection)) unsetPath(d, k);
    return d;
  }
  const out: Doc = { _id: d._id };
  for (const [k, v] of Object.entries(projection)) {
    if (v === 1 && k !== '_id') {
      const value = getPath(d, k);
      if (value !== undefined) setPath(out, k, value);
    }
  }
  return out;
}

function makeCursor(source: () => Doc[], name: string) {
  let projection: Doc | undefined;
  let skip = 0;
  let limit = Infinity;
  const opts: Doc = {};
  const rows = () => source().slice(skip, skip + limit).map((d) => applyProjection(d, projection));
  const cursor: any = {
    sort: () => cursor,
    skip: (n: number) => { skip = n; return cursor; },
    limit: (n: number) => { limit = n; return cursor; },
    project: (spec: Doc) => { projection = spec; record(`${name}.project`, spec); return cursor; },
    batchSize: (n: number) => { opts.batchSize = n; record(`${name}.batchSize`, n); return cursor; },
    maxTimeMS: (n: number) => { opts.maxTimeMS = n; record(`${name}.maxTimeMS`, n); return cursor; },
    close: async () => undefined,
    toArray: async () => rows(),
    [Symbol.asyncIterator]: async function* () {
      for (const r of rows()) yield r;
    },
  };
  return cursor;
}

function applyUpdate(doc: Doc, update: Doc): boolean {
  let modified = false;
  for (const [path, value] of Object.entries(update.$set ?? {})) { setPath(doc, path, clone(value)); modified = true; }
  for (const [path, by] of Object.entries(update.$inc ?? {})) { setPath(doc, path, ((getPath(doc, path) as number) ?? 0) + (by as number)); modified = true; }
  for (const path of Object.keys(update.$unset ?? {})) { if (unsetPath(doc, path)) modified = true; }
  return modified;
}

const fakeCollection = {
  insertOne: async (doc: Doc) => { record('insertOne', doc); store.push(clone(doc)); return {}; },
  findOne: async (filter: Doc, options?: Doc) => {
    record('findOne', { filter, options });
    const doc = store.find((d) => matches(d, filter));
    return doc ? applyProjection(doc, options?.projection) : null;
  },
  findOneAndUpdate: async (filter: Doc, update: Doc, options: Doc) => {
    record('findOneAndUpdate', { filter, update, options });
    const doc = store.find((d) => matches(d, filter));
    if (!doc) return null;
    applyUpdate(doc, update);
    return applyProjection(doc, options?.projection);
  },
  updateOne: async (filter: Doc, update: Doc) => {
    record('updateOne', { filter, update });
    const doc = store.find((d) => matches(d, filter));
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    return { matchedCount: 1, modifiedCount: applyUpdate(doc, update) ? 1 : 0 };
  },
  updateMany: async (filter: Doc, update: Doc) => {
    record('updateMany', { filter, update });
    const docs = store.filter((d) => matches(d, filter));
    let modified = 0;
    for (const d of docs) if (applyUpdate(d, update)) modified++;
    return { matchedCount: docs.length, modifiedCount: modified };
  },
  find: (filter: Doc) => {
    record('find', filter);
    return makeCursor(() => store.filter((d) => matches(d, filter)), 'find');
  },
  countDocuments: async (filter: Doc, options?: Doc) => {
    record('countDocuments', { filter, options });
    const n = store.filter((d) => matches(d, filter)).length;
    return options?.limit ? Math.min(n, options.limit) : n;
  },
  aggregate: (pipeline: Doc[]) => {
    record('aggregate', pipeline);
    return makeCursor(() => [], 'aggregate');
  },
  createIndex: async (spec: Doc, options?: Doc) => { record('createIndex', { spec, options }); return 'ok'; },
};

jest.mock(
  'mongodb',
  () => ({
    Binary: FakeBinary,
    MongoClient: class {
      connect = async () => this;
      db = () => ({ collection: () => fakeCollection, command: async () => ({ ok: 1 }) });
      close = async () => undefined;
    },
  }),
  { virtual: true },
);

import { MongoDataEngine } from '../providers/mongodb/mongodb-engine';
import type { DataEngineConfig } from '../interfaces/types';
import type { EntityCollection } from '../interfaces/data-engine';

const config: DataEngineConfig = {
  provider: 'mongodb',
  connectionString: 'mongodb://test:27017',
  container: 'basefyio-apps',
  namespace: 'records',
  maxDocumentKb: 64,
  maxNestingDepth: 8,
  maxArrayItems: 100,
};

const SCOPE_KEYS = ['envelope.projectId', 'envelope.entity', 'envelope.status'];

/** Every leaf predicate object reachable through $and. */
function predicates(filter: Doc): Doc[] {
  const out: Doc[] = [filter];
  for (const c of (filter.$and as Doc[] | undefined) ?? []) out.push(...predicates(c));
  return out;
}

function expectScoped(filter: Doc, projectId: string, entity: string) {
  const all = predicates(filter);
  const scope = all.find((p) => SCOPE_KEYS.every((k) => k in p));
  expect(scope).toBeDefined();
  expect(scope!['envelope.projectId']).toBe(projectId);
  expect(scope!['envelope.entity']).toBe(entity);
  expect(scope!['envelope.status']).toEqual({ $ne: 'deleted' });
}

function norm(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}

describe('MongoDataEngine vectors', () => {
  let engine: MongoDataEngine;
  let col: EntityCollection;

  beforeEach(() => {
    store = [];
    for (const key of Object.keys(calls)) delete calls[key];
    engine = new MongoDataEngine({ ...config, vector: { maxScan: 50 } });
    col = engine.collection('p1', 'docs');
  });

  it('reports exact vector search in its capabilities', () => {
    const caps = engine.capabilities();
    expect(caps.vectorSearch).toBe(true);
    expect(caps.vector).toEqual({
      embeddings: false,
      hybridSearch: false,
      strategy: 'exact',
      maxDimensions: 2048,
      maxScan: 50,
    });
  });

  it('creates the partial vector index next to idx_scope', async () => {
    await engine.provisionTenant('p1');
    const idx = (calls.createIndex as Doc[]).find((c) => c.options?.name === 'idx_vec_scope');
    expect(idx).toEqual({
      spec: { 'envelope.projectId': 1, 'envelope.entity': 1 },
      options: { name: 'idx_vec_scope', partialFilterExpression: { 'vectors.default.dims': { $exists: true } } },
    });
  });

  it('stores a unit vector as BinData subtype 9 float32 beside envelope and data', async () => {
    const doc = await col.insert({ title: 'a' });
    const info = await col.setVector!(doc._id, [3, 4]);
    expect(info.dims).toBe(2);
    expect(info.vector[0]).toBeCloseTo(0.6, 6);
    expect(info.vector[1]).toBeCloseTo(0.8, 6);

    const stored = store[0];
    expect(Object.keys(stored).sort()).toEqual(['_id', 'data', 'envelope', 'vectors']);
    expect(stored.data).toEqual({ title: 'a' });
    const v = stored.vectors.default;
    expect(v).toMatchObject({ dims: 2, model: 'client', source: 'client', hash: null });
    expect(typeof v.updatedAt).toBe('string');
    expect(v.f32_2).toBeInstanceOf(FakeBinary);
    expect(v.f32_2.sub_type).toBe(9);
    expect(v.f32_2.buffer[0]).toBe(0x27);
    expect(v.f32_2.buffer.length).toBe(2 + 2 * 4);

    // Only vectors.default is written, through the scope.
    const { filter, update } = calls.updateOne![0] as Doc;
    expectScoped(filter, 'p1', 'docs');
    expect(filter._id).toBe(doc._id);
    expect(Object.keys(update)).toEqual(['$set']);
    expect(Object.keys(update.$set)).toEqual(['vectors.default']);
  });

  it('a vector write leaves version, event sequence and updatedAt alone', async () => {
    const doc = await col.insert({ title: 'a' });
    const before = clone(store[0].envelope);
    await col.setVector!(doc._id, [1, 2, 3]);
    await col.setVectors!([{ id: doc._id, vector: [3, 2, 1] }]);
    await col.deleteVector!(doc._id);
    expect(store[0].envelope).toEqual(before);
    expect((await col.get(doc._id))!._version).toBe(1);
  });

  it('get, list, update, replace, delete and restore never return or ship vectors', async () => {
    const doc = await col.insert({ title: 'a' });
    await col.setVector!(doc._id, [1, 0]);

    const got = await col.get(doc._id);
    expect(got).not.toHaveProperty('vectors');
    expect((calls.findOne!.at(-1) as Doc).options).toEqual({ projection: { vectors: 0 } });

    const page = await col.query({ entity: 'docs' });
    expect(page.data[0]).not.toHaveProperty('vectors');
    expect(calls['find.project']!.at(-1)).toEqual({ vectors: 0 });

    const updated = await col.update(doc._id, { title: 'b' });
    expect(updated).not.toHaveProperty('vectors');
    const replaced = await col.replace(doc._id, { title: 'c' });
    expect(replaced).not.toHaveProperty('vectors');
    await col.delete(doc._id);
    const restored = await col.restore!(doc._id);
    expect(restored).not.toHaveProperty('vectors');
    for (const c of calls.findOneAndUpdate as Doc[]) {
      expect(c.options.projection).toEqual({ vectors: 0 });
    }
    // The vector survives the document writes.
    expect(store[0].vectors.default.dims).toBe(2);
  });

  it('aggregate drops vectors right after the tenant $match', async () => {
    await engine.aggregate('p1', { entity: 'docs', pipeline: [{ $limit: 5 }] });
    const pipeline = calls.aggregate![0] as Doc[];
    expect(pipeline[0].$match['envelope.projectId']).toBe('p1');
    expect(pipeline[1]).toEqual({ $unset: 'vectors' });
  });

  it('getVector / deleteVector / setVectors answer only inside the project and entity', async () => {
    const mine = await col.insert({ n: 1 });
    await col.setVector!(mine._id, [1, 0]);

    const otherProject = engine.collection('p2', 'docs');
    const otherEntity = engine.collection('p1', 'notes');
    for (const other of [otherProject, otherEntity]) {
      await expect(other.getVector!(mine._id)).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
      await expect(other.setVector!(mine._id, [0, 1])).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
      await expect(other.deleteVector!(mine._id)).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
      expect(await other.setVectors!([{ id: mine._id, vector: [0, 1] }])).toEqual({ written: [], missing: [mine._id] });
    }
    // Untouched by the foreign calls.
    const info = await col.getVector!(mine._id);
    expect(info!.vector[0]).toBeCloseTo(1, 6);

    for (const c of calls.updateOne as Doc[]) expectScoped(c.filter, (c.filter as Doc)['envelope.projectId'], (c.filter as Doc)['envelope.entity']);
    for (const c of calls.findOne as Doc[]) expect(SCOPE_KEYS.every((k) => k in (c as Doc).filter)).toBe(true);
  });

  it('getVector is null for a record without a vector, and 404 for a soft-deleted one', async () => {
    const a = await col.insert({ n: 1 });
    expect(await col.getVector!(a._id)).toBeNull();
    await col.setVector!(a._id, [1, 1]);
    await col.delete(a._id);
    await expect(col.getVector!(a._id)).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
    await expect(col.setVector!(a._id, [1, 1])).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
  });

  it('setVectors reports missing ids and validates every item before writing', async () => {
    const a = await col.insert({ n: 1 });
    expect(await col.setVectors!([{ id: a._id, vector: [1, 0] }, { id: 'nope', vector: [0, 1] }])).toEqual({
      written: [a._id],
      missing: ['nope'],
    });
    calls.updateOne = [];
    await expect(col.setVectors!([{ id: a._id, vector: [1, 0] }, { id: 'x', vector: [0, 0] }])).rejects.toMatchObject({ code: 'VECTOR_INVALID' });
    expect(calls.updateOne).toEqual([]);
    await expect(col.setVectors!(Array.from({ length: 101 }, (_, i) => ({ id: `i${i}`, vector: [1] })))).rejects.toThrow(/at most 100/);
  });

  it('dimension mismatch against the configured width is a typed 400', async () => {
    const a = await col.insert({ n: 1 });
    await expect(col.setVector!(a._id, [1, 2, 3], { dimensions: 4 })).rejects.toMatchObject({ code: 'VECTOR_DIMENSION_MISMATCH', statusCode: 400 });
    await expect(col.vectorSearch!({ vector: [1, 2, 3], dimensions: 4 })).rejects.toMatchObject({ code: 'VECTOR_DIMENSION_MISMATCH' });
  });

  it('search never returns other projects, other entities or soft-deleted records', async () => {
    const q = [1, 0, 0];
    const live = await col.insert({ who: 'live' });
    const gone = await col.insert({ who: 'deleted' });
    const otherP = engine.collection('p2', 'docs');
    const otherE = engine.collection('p1', 'notes');
    const foreignP = await otherP.insert({ who: 'other-project' });
    const foreignE = await otherE.insert({ who: 'other-entity' });
    // The foreign and deleted ones are the exact match; the live one is not.
    await col.setVector!(live._id, [0.5, 1, 0]);
    await col.setVector!(gone._id, q);
    await otherP.setVector!(foreignP._id, q);
    await otherE.setVector!(foreignE._id, q);
    await col.delete(gone._id);

    const res = await col.vectorSearch!({ vector: q, limit: 10 });
    expect(res.hits.map((h) => h.doc.who)).toEqual(['live']);
    expect(res.scanned).toBe(1);
    expect(res.strategy).toBe('exact');
    expect(res.hits[0].doc).not.toHaveProperty('vectors');

    // count, scan and fetch are all scoped.
    for (const c of calls.countDocuments as Doc[]) expectScoped(c.filter, 'p1', 'docs');
    const finds = (calls.find as Doc[]).slice(-2);
    for (const f of finds) expectScoped(f, 'p1', 'docs');
    // The scan only carries _id and the vector, in batches, with a time limit.
    expect(calls['find.project']!.at(-2)).toEqual({ _id: 1, 'vectors.default.f32_3': 1 });
    expect(calls['find.batchSize']!.at(-1)).toBe(500);
    expect(calls['find.maxTimeMS']!.at(-1)).toBe(5000);
    expect(calls['find.project']!.at(-1)).toEqual({ vectors: 0 });

    // Restore makes it searchable again.
    await col.restore!(gone._id);
    const again = await col.vectorSearch!({ vector: q, limit: 1 });
    expect(again.hits[0].doc.who).toBe('deleted');
    expect(again.hits[0].distance).toBeCloseTo(0, 6);
    expect(again.hits[0].score).toBeCloseTo(1, 6);
  });

  it('only vectors of the query width are candidates', async () => {
    const a = await col.insert({ n: 'a' });
    const b = await col.insert({ n: 'b' });
    await col.setVector!(a._id, [1, 0]);
    await col.setVector!(b._id, [1, 0, 0]);
    const res = await col.vectorSearch!({ vector: [1, 0] });
    expect(res.hits.map((h) => h.doc.n)).toEqual(['a']);
    expect(res.scanned).toBe(1);
  });

  it('top-k equals a brute-force reference', async () => {
    const rnd = (() => { let s = 42; return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1; })();
    const dims = 8;
    const vecs: Record<string, number[]> = {};
    for (let i = 0; i < 40; i++) {
      const d = await col.insert({ i });
      vecs[d._id] = Array.from({ length: dims }, rnd);
      await col.setVector!(d._id, vecs[d._id]);
    }
    const q = Array.from({ length: dims }, rnd);
    const qn = norm(q);
    const reference = Object.entries(vecs)
      .map(([id, v]) => {
        const f32 = Float32Array.from(norm(v));
        const score = f32.reduce((s, x, j) => s + x * qn[j], 0);
        return { id, score };
      })
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
      .slice(0, 7);

    const res = await col.vectorSearch!({ vector: q, limit: 7 });
    expect(res.scanned).toBe(40);
    expect(res.hits.map((h) => h.doc._id)).toEqual(reference.map((r) => r.id));
    res.hits.forEach((h, j) => {
      expect(h.score).toBeCloseTo(reference[j].score, 9);
      expect(h.distance).toBeCloseTo(1 - reference[j].score, 9);
    });
  });

  it('threshold keeps only hits closer than the maximum distance', async () => {
    const near = await col.insert({ n: 'near' });
    const mid = await col.insert({ n: 'mid' });
    const far = await col.insert({ n: 'far' });
    await col.setVector!(near._id, [1, 0.05]);
    await col.setVector!(mid._id, [1, 1]); // distance ~0.29
    await col.setVector!(far._id, [-1, 0]); // distance 2
    const res = await col.vectorSearch!({ vector: [1, 0], maxDistance: 0.2 });
    expect(res.hits.map((h) => h.doc.n)).toEqual(['near']);
    expect(res.scanned).toBe(3);
    const all = await col.vectorSearch!({ vector: [1, 0], maxDistance: 2.0 });
    expect(all.hits.map((h) => h.doc.n)).toEqual(['near', 'mid']);
    await expect(col.vectorSearch!({ vector: [1, 0], maxDistance: 3 })).rejects.toThrow(/threshold/);
  });

  it('applies the user filter before scoring', async () => {
    const a = await col.insert({ kind: 'faq' });
    const b = await col.insert({ kind: 'blog' });
    await col.setVector!(a._id, [0, 1]);
    await col.setVector!(b._id, [1, 0]);
    const res = await col.vectorSearch!({
      vector: [1, 0],
      filter: { type: 'field', path: { path: 'kind', isArrayPath: false }, operator: 'eq', value: 'faq' },
    });
    expect(res.hits.map((h) => h.doc.kind)).toEqual(['faq']);
    expect(res.scanned).toBe(1);
  });

  it('refuses with VECTOR_SCAN_LIMIT instead of scoring a partial set', async () => {
    for (let i = 0; i < 51; i++) {
      const d = await col.insert({ i });
      await col.setVector!(d._id, [1, i + 1]);
    }
    calls.find = [];
    await expect(col.vectorSearch!({ vector: [1, 0] })).rejects.toMatchObject({ code: 'VECTOR_SCAN_LIMIT', statusCode: 422 });
    // Refused on the count: no scan happened.
    expect(calls.find).toEqual([]);
    const count = (calls.countDocuments as Doc[]).at(-1)!;
    expect(count.options).toEqual({ limit: 51, maxTimeMS: 5000 });
  });

  it('validates limit and rejects a zero query vector', async () => {
    await expect(col.vectorSearch!({ vector: [1, 0], limit: 0 })).rejects.toThrow(/limit/);
    await expect(col.vectorSearch!({ vector: [1, 0], limit: 101 })).rejects.toThrow(/limit/);
    await expect(col.vectorSearch!({ vector: [0, 0] })).rejects.toMatchObject({ code: 'VECTOR_INVALID' });
  });

  it('refuses a search beyond the per-process concurrency with VECTOR_SEARCH_BUSY', async () => {
    const busy = new MongoDataEngine({ ...config, vector: { maxConcurrency: 1 } });
    const release = busy._acquireSearchSlot();
    await expect(busy.collection('p1', 'docs').vectorSearch!({ vector: [1] })).rejects.toMatchObject({ code: 'VECTOR_SEARCH_BUSY', statusCode: 429 });
    release();
    await expect(busy.collection('p1', 'docs').vectorSearch!({ vector: [1] })).resolves.toMatchObject({ hits: [] });
  });

  it('maps a server time-out to VECTOR_SEARCH_TIMEOUT and frees the slot', async () => {
    const original = fakeCollection.countDocuments;
    fakeCollection.countDocuments = async () => { throw Object.assign(new Error('operation exceeded time limit'), { code: 50 }); };
    try {
      await expect(col.vectorSearch!({ vector: [1, 0] })).rejects.toMatchObject({ code: 'VECTOR_SEARCH_TIMEOUT' });
    } finally {
      fakeCollection.countDocuments = original;
    }
    for (let i = 0; i < 5; i++) await col.vectorSearch!({ vector: [1, 0] });
  });

  it('vectorStats counts live records with and without vectors', async () => {
    const a = await col.insert({});
    const b = await col.insert({});
    await col.insert({});
    await col.setVector!(a._id, [1]);
    await col.setVector!(b._id, [1]);
    await col.delete(b._id);
    expect(await col.vectorStats!()).toEqual({ embedded: 1, total: 2 });
  });

  it('clearVectors removes every vector of the entity, deleted records included, and nothing else', async () => {
    const a = await col.insert({});
    const b = await col.insert({});
    await col.setVector!(a._id, [1]);
    await col.setVector!(b._id, [1]);
    await col.delete(b._id);
    const other = engine.collection('p2', 'docs');
    const c = await other.insert({});
    await other.setVector!(c._id, [1]);

    expect(await col.clearVectors!()).toBe(2);
    expect(store.filter((d) => d.vectors).map((d) => d._id)).toEqual([c._id]);
    const { filter } = (calls.updateMany as Doc[]).at(-1)!;
    expect(filter).toMatchObject({ 'envelope.projectId': 'p1', 'envelope.entity': 'docs' });
  });

  // ── Platform vectors (Stage 2) ──────────────────────────

  it('a platform vector carries source, model and hash, and supersedes a marker', async () => {
    const doc = await col.insert({ title: 'a' });
    await col.setVectorMarker!(doc._id, { kind: 'failed', model: 'openai/m', hash: 'h0', error: 'x' });
    const info = await col.setVector!(doc._id, [1, 0], { source: 'platform', model: 'openai/m', hash: 'h1' });
    expect(info).toMatchObject({ source: 'platform', model: 'openai/m', hash: 'h1' });
    expect(store[0].vectors.default).toMatchObject({ source: 'platform', model: 'openai/m', hash: 'h1' });
    expect(store[0].vectors.marker).toBeUndefined();
    expect(store[0].envelope.version).toBe(1);
    // A client write never stores a hash.
    const c = await col.setVector!(doc._id, [1, 0], { hash: 'ignored' });
    expect(c).toMatchObject({ source: 'client', model: 'client', hash: null });
  });

  it('ifVersion writes only at that version: ConcurrencyError after a change, not found when gone', async () => {
    const doc = await col.insert({ title: 'a' });
    await col.update(doc._id, { title: 'b' });
    await expect(
      col.setVector!(doc._id, [1, 0], { source: 'platform', model: 'm', hash: 'h', ifVersion: 1 }),
    ).rejects.toMatchObject({ code: 'CONCURRENCY_CONFLICT' });
    expect(store[0].vectors).toBeUndefined();
    await col.setVector!(doc._id, [1, 0], { source: 'platform', model: 'm', hash: 'h', ifVersion: 2 });
    expect(store[0].vectors.default.hash).toBe('h');
    await col.delete(doc._id);
    await expect(col.setVector!(doc._id, [1, 0], { ifVersion: 3 })).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
  });

  it('getVectorMeta reads the metadata without the vector field', async () => {
    const doc = await col.insert({});
    expect(await col.getVectorMeta!(doc._id)).toBeNull();
    await col.setVector!(doc._id, [1, 2, 3], { source: 'platform', model: 'm', hash: 'abc' });
    const meta = await col.getVectorMeta!(doc._id);
    expect(meta).toMatchObject({ id: doc._id, dims: 3, model: 'm', source: 'platform', hash: 'abc' });
    expect((meta as any).vector).toBeUndefined();
    const { filter, options } = (calls.findOne as Doc[]).at(-1)!;
    expectScoped(filter, 'p1', 'docs');
    expect(Object.keys(options.projection).some((k) => k.includes('f32_'))).toBe(false);
    await expect(engine.collection('p2', 'docs').getVectorMeta!(doc._id)).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
  });

  it('vectorSources pages live in-scope ids with only the requested data paths', async () => {
    const a = await col.insert({ title: 'A', body: { text: 'x', secret: 's' }, other: 1 });
    const b = await col.insert({ title: 'B' });
    const gone = await col.insert({ title: 'C' });
    await col.delete(gone._id);
    const foreign = await engine.collection('p2', 'docs').insert({ title: 'P2' });
    await engine.collection('p1', 'notes').insert({ title: 'N' });
    await col.setVector!(a._id, [1, 0], { source: 'platform', model: 'm', hash: 'h' });

    const rows = await col.vectorSources!({ paths: ['title', 'body.text', 'body'], limit: 10 });
    expect(rows.map((r) => r.id).sort()).toEqual([a._id, b._id].sort());
    const ra = rows.find((r) => r.id === a._id)!;
    // body.text is covered by body: no path collision in the projection.
    expect(ra.data).toEqual({ title: 'A', body: { text: 'x', secret: 's' } });
    expect(ra.version).toBe(1);
    expect(ra.vector).toMatchObject({ model: 'm', hash: 'h' });
    expect((ra.vector as any).vector).toBeUndefined();
    const projection = (calls['find.project'] as Doc[]).at(-1)!;
    expect(projection).toMatchObject({ 'data.title': 1, 'data.body': 1 });
    expect(projection['data.body.text']).toBeUndefined();
    expect(Object.keys(projection).some((k) => k.includes('f32_'))).toBe(false);
    expectScoped((calls.find as Doc[]).at(-1)!, 'p1', 'docs');

    // ids are still pinned to the scope: another project's id is never returned.
    expect(await col.vectorSources!({ paths: ['title'], ids: [foreign._id, gone._id] })).toEqual([]);
    await expect(col.vectorSources!({ paths: ['tags[]'] })).rejects.toMatchObject({ code: 'QUERY_VALIDATION_FAILED' });
    await expect(col.vectorSources!({ paths: [] })).rejects.toMatchObject({ code: 'QUERY_VALIDATION_FAILED' });
    await expect(col.vectorSources!({ paths: ['__proto__'] })).rejects.toBeDefined();
  });

  it('setVectorMarker: empty removes the vector, failed keeps it; scoped and version-checked', async () => {
    const doc = await col.insert({});
    await col.setVector!(doc._id, [1, 0], { source: 'platform', model: 'm', hash: 'h' });
    expect(await col.setVectorMarker!(doc._id, { kind: 'failed', model: 'm', hash: 'h2', error: 'boom' })).toBe(true);
    expect(store[0].vectors.default).toBeDefined();
    expect(store[0].vectors.marker).toMatchObject({ kind: 'failed', model: 'm', hash: 'h2', error: 'boom' });
    expect(await col.setVectorMarker!(doc._id, { kind: 'empty', model: 'm', hash: null }, { ifVersion: 9 })).toBe(false);
    expect(await col.setVectorMarker!(doc._id, { kind: 'empty', model: 'm', hash: null }, { ifVersion: 1 })).toBe(true);
    expect(store[0].vectors.default).toBeUndefined();
    expect(store[0].vectors.marker).toMatchObject({ kind: 'empty', error: null });
    expect(await engine.collection('p2', 'docs').setVectorMarker!(doc._id, { kind: 'empty', model: 'm', hash: null })).toBe(false);
    expect(store[0].envelope.version).toBe(1);
  });

  it('vectorStats with a model counts pending and failed', async () => {
    const done = await col.insert({});
    const old = await col.insert({});
    const none = await col.insert({});
    const empty = await col.insert({});
    const failed = await col.insert({});
    const deleted = await col.insert({});
    await col.setVector!(done._id, [1], { source: 'platform', model: 'new', hash: 'h' });
    await col.setVector!(old._id, [1], { source: 'platform', model: 'old', hash: 'h' });
    await col.setVectorMarker!(empty._id, { kind: 'empty', model: 'new', hash: null });
    await col.setVectorMarker!(failed._id, { kind: 'failed', model: 'new', hash: 'h', error: 'x' });
    await col.delete(deleted._id);
    void none;
    expect(await col.vectorStats!({ model: 'new' })).toEqual({ embedded: 2, total: 5, pending: 2, failed: 1 });
    // Without a model: Stage 1's shape.
    expect(await col.vectorStats!()).toEqual({ embedded: 2, total: 5 });
  });
});
