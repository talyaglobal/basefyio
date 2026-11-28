/**
 * MongoDB Data Engine Provider
 *
 * Shared-tenant layout: one database (config.container), one collection
 * (config.namespace, default "records"). Every document carries the basefyio
 * envelope under `envelope` and user data under `data` — the same layout the
 * CouchDB provider uses, so DocResult mapping is identical:
 *   { _id: <uuid string>, envelope: {...}, data: {...} }
 *
 * The `mongodb` driver is an optional peer dependency loaded with require()
 * at first use (mirrors the postgres provider's `pg` handling), so deploys
 * that don't select DATA_ENGINE_PROVIDER=mongodb never need it installed.
 *
 * This is the first provider with aggregationPipeline: true — the dashboard
 * Query editor unlocks its Aggregation mode from this capability flag alone.
 *
 * Vectors: a record may carry one embedding beside `envelope` and `data`:
 *   vectors: { default: { dims, model, source, hash, updatedAt, f32_<dims>: BinData(9) } }
 * It is unit normalised at write, never part of `data`, excluded from every
 * read path, and a vector write never changes the envelope (version, event
 * sequence, updatedAt). Search is exact: candidates are streamed with only
 * their vector, scored in this process and the top k fetched afterwards.
 */

import { v4 as uuid } from 'uuid';
import type { DataEngine, EntityCollection } from '../../interfaces/data-engine';
import {
  ConcurrencyError,
  DataEngineError,
  DocumentNotFoundError,
  DocumentTooLargeError,
  QueryValidationError,
  VectorScanLimitError,
  VectorSearchBusyError,
  VectorSearchTimeoutError,
} from '../../interfaces/data-engine';
import type {
  VectorInfo,
  VectorSearchQuery,
  VectorSearchResult,
  VectorStats,
  VectorWrite,
  VectorWriteOptions,
  VectorWriteResult,
} from '../../interfaces/vector';
import {
  MAX_VECTOR_DIMENSIONS,
  TopK,
  decodeFloat32,
  dot,
  encodeFloat32,
  prepareVector,
} from '../../vector/vector-math';
import type {
  DataEngineConfig,
  DocResult,
  DocumentStatus,
  IsolationTier,
  JsonObject,
  Page,
  ProviderCapabilities,
  TenantDataPlane,
  WriteOpts,
} from '../../interfaces/types';
import type {
  EntityAggregation,
  EntityQuery,
  Filter,
  IndexDef,
  QueryExplainResult,
} from '../../interfaces/query';
import {
  aggregationToMongoPipeline,
  filterToMongo,
  selectToMongo,
  sortToMongo,
  toStoredPath,
} from './mongo-translate';

/** Upper bound for find()/count() totals — keeps huge scans bounded. */
const COUNT_LIMIT = 100_000;
const DEFAULT_COLLECTION = 'records';

/** Read paths never carry the stored vector. */
const NO_VECTORS = { vectors: 0 } as const;
const DEFAULT_VECTOR_MAX_SCAN = 10_000;
const DEFAULT_VECTOR_TIMEOUT_MS = 5_000;
const DEFAULT_VECTOR_CONCURRENCY = 4;
const VECTOR_BATCH_SIZE = 500;
const MAX_VECTOR_LIMIT = 100;
const MAX_VECTOR_BATCH = 100;
/** Server error code for an operation that exceeded maxTimeMS. */
const MAX_TIME_MS_EXPIRED = 50;

/** Stored field holding a vector of this width. */
export function vectorField(dims: number): string {
  return `f32_${dims}`;
}

// ── Minimal structural driver types ────────────────────────
// The mongodb package is optional; these cover exactly what we call.

interface MongoCursorLike extends AsyncIterable<Record<string, unknown>> {
  toArray(): Promise<Record<string, unknown>[]>;
  sort(spec: Record<string, 1 | -1>): MongoCursorLike;
  skip(n: number): MongoCursorLike;
  limit(n: number): MongoCursorLike;
  project(spec: Record<string, unknown>): MongoCursorLike;
  batchSize(n: number): MongoCursorLike;
  maxTimeMS(ms: number): MongoCursorLike;
  close(): Promise<void>;
}

interface UpdateResultLike {
  matchedCount: number;
  modifiedCount: number;
}

/** The driver's BSON Binary, as far as vectors need it. */
interface BinaryLike {
  sub_type: number;
  buffer: Uint8Array;
  toFloat32Array?(): Float32Array;
}

interface BinaryCtorLike {
  new (buffer: Uint8Array, subType: number): BinaryLike;
  fromFloat32Array?(values: Float32Array): BinaryLike;
}

interface MongoCollectionLike {
  insertOne(doc: Record<string, unknown>): Promise<unknown>;
  findOne(
    filter: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null>;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<UpdateResultLike>;
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null>;
  find(filter: Record<string, unknown>): MongoCursorLike;
  countDocuments(
    filter: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<number>;
  updateMany(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<UpdateResultLike>;
  aggregate(pipeline: Record<string, unknown>[]): MongoCursorLike;
  createIndex(
    spec: Record<string, 1 | -1>,
    options?: Record<string, unknown>,
  ): Promise<string>;
}

interface MongoDbLike {
  collection(name: string): MongoCollectionLike;
  command(cmd: Record<string, unknown>): Promise<unknown>;
}

interface MongoClientLike {
  connect(): Promise<unknown>;
  db(name: string): MongoDbLike;
  close(): Promise<void>;
}

interface StoredEnvelope {
  entity: string;
  projectId: string;
  schemaVersion: number;
  version: number;
  lastEventId: string | null;
  eventSequence: number;
  status: DocumentStatus;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  deletedAt: string | null;
}

interface StoredVector {
  dims: number;
  model: string;
  source: string;
  hash: string | null;
  updatedAt: string;
  [field: string]: unknown;
}

interface StoredDoc {
  _id: string;
  envelope: StoredEnvelope;
  data: JsonObject;
  vectors?: { default?: StoredVector };
}

interface DriverLike {
  MongoClient: new (uri: string) => MongoClientLike;
  Binary: BinaryCtorLike;
}

export class MongoDataEngine implements DataEngine {
  private client: MongoClientLike | null = null;
  private connecting: Promise<MongoClientLike> | null = null;
  private driver: DriverLike | null = null;
  private activeSearches = 0;

  /** Vector limits, from config with safe defaults. */
  readonly vectorLimits: { maxScan: number; timeoutMs: number; maxConcurrency: number };

  constructor(private readonly config: DataEngineConfig) {
    const v = config.vector ?? {};
    const positive = (n: number | undefined, d: number) =>
      typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : d;
    this.vectorLimits = {
      maxScan: positive(v.maxScan, DEFAULT_VECTOR_MAX_SCAN),
      timeoutMs: positive(v.timeoutMs, DEFAULT_VECTOR_TIMEOUT_MS),
      maxConcurrency: positive(v.maxConcurrency, DEFAULT_VECTOR_CONCURRENCY),
    };
  }

  private loadDriver(): DriverLike {
    if (this.driver) return this.driver;
    try {
      // Dynamic require keeps mongodb an optional peer dependency.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      this.driver = require('mongodb') as DriverLike;
      return this.driver;
    } catch {
      throw new DataEngineError(
        'DATA_ENGINE_PROVIDER=mongodb requires the "mongodb" package — npm install mongodb',
        'DRIVER_MISSING',
        500,
      );
    }
  }

  private async getClient(): Promise<MongoClientLike> {
    if (this.client) return this.client;
    if (!this.connecting) {
      const { MongoClient } = this.loadDriver();
      const uri = this.config.connectionString || 'mongodb://localhost:27017';
      const client = new MongoClient(uri);
      this.connecting = client.connect().then(() => {
        this.client = client;
        return client;
      });
    }
    return this.connecting;
  }

  private async records(): Promise<MongoCollectionLike> {
    const client = await this.getClient();
    const db = client.db(this.sanitizeDbName(this.config.container));
    return db.collection(this.config.namespace || DEFAULT_COLLECTION);
  }

  private sanitizeDbName(name: string): string {
    // MongoDB DB names reject /\. "$*<>:|? and spaces.
    return (name || 'basefyio').replace(/[/\\. "$*<>:|?]/g, '_').slice(0, 63);
  }

  // ── DataEngine ───────────────────────────────────────────

  async provisionTenant(
    projectId: string,
    tier?: IsolationTier,
  ): Promise<TenantDataPlane> {
    const col = await this.records();
    await col.createIndex(
      { 'envelope.projectId': 1, 'envelope.entity': 1, 'envelope.status': 1 },
      { name: 'idx_scope' },
    );
    await col.createIndex(
      { 'envelope.projectId': 1, 'envelope.entity': 1, 'envelope.createdAt': -1 },
      { name: 'idx_created' },
    );
    try {
      // Only records that carry a vector: the candidate set of a vector search.
      await col.createIndex(
        { 'envelope.projectId': 1, 'envelope.entity': 1 },
        {
          name: 'idx_vec_scope',
          partialFilterExpression: { 'vectors.default.dims': { $exists: true } },
        },
      );
    } catch {
      // Best effort: search still works without it, only slower.
    }
    return {
      projectId,
      tier: tier ?? 'shared',
      namespace: this.config.namespace || DEFAULT_COLLECTION,
      provisionedAt: new Date().toISOString(),
    };
  }

  async deprovisionTenant(projectId: string): Promise<void> {
    const col = await this.records();
    const now = new Date().toISOString();
    await col.updateMany(
      { 'envelope.projectId': projectId, 'envelope.status': { $ne: 'deleted' } },
      { $set: { 'envelope.status': 'deleted', 'envelope.deletedAt': now } },
    );
  }

  collection(projectId: string, entity: string): EntityCollection {
    return new MongoEntityCollection(this, projectId, entity, this.config);
  }

  capabilities(): ProviderCapabilities {
    return {
      // Multi-document transactions need a replica set; report what plain
      // standalone deployments actually deliver.
      transactions: false,
      fullTextSearch: false,
      vectorSearch: true,
      ttl: false,
      aggregationPipeline: true,
      vector: {
        embeddings: false,
        hybridSearch: false,
        strategy: 'exact',
        maxDimensions: MAX_VECTOR_DIMENSIONS,
        maxScan: this.vectorLimits.maxScan,
      },
    };
  }

  async ping(): Promise<boolean> {
    try {
      const client = await this.getClient();
      await client.db(this.sanitizeDbName(this.config.container)).command({ ping: 1 });
      return true;
    } catch {
      return false;
    }
  }

  async aggregate(
    projectId: string,
    aggregation: EntityAggregation,
  ): Promise<Page<JsonObject>> {
    const col = await this.records();
    const { pipeline, reshaped } = aggregationToMongoPipeline(aggregation, {
      projectId,
      entity: aggregation.entity,
    });

    const rows = await col.aggregate(pipeline).toArray();
    const data = reshaped
      ? (rows as JsonObject[])
      : rows.map((row) => flattenStored(row as unknown as StoredDoc));

    return { data, total: data.length, hasMore: false };
  }

  async explain(
    projectId: string,
    query: EntityQuery | EntityAggregation,
  ): Promise<QueryExplainResult> {
    return {
      mode: 'pipeline' in query ? 'aggregation' : 'sql',
      entity: query.entity,
      selectedPaths: [],
      filterPaths: [],
      unwindPaths: [],
      groupKeys: [],
      sortFields: [],
      matchingIndexes: [],
      recommendedIndexes: [],
      estimatedRisk: 'low',
      usesNestedPaths: false,
      usesArrayPaths: false,
    };
  }

  /** @internal — exposed for MongoEntityCollection */
  async _records(): Promise<MongoCollectionLike> {
    return this.records();
  }

  /** @internal — BSON vector (subtype 9, float32) for a normalised vector. */
  _encodeVector(values: Float64Array): BinaryLike {
    const { Binary } = this.loadDriver();
    const f32 = Float32Array.from(values);
    if (typeof Binary.fromFloat32Array === 'function') return Binary.fromFloat32Array(f32);
    return new Binary(encodeFloat32(f32), 9);
  }

  /** @internal — Float32Array from a stored vector field (driver Binary or raw bytes). */
  _decodeVector(value: unknown): Float32Array | null {
    if (!value || typeof value !== 'object') return null;
    const b = value as BinaryLike;
    if (typeof b.toFloat32Array === 'function') return b.toFloat32Array();
    if (b.buffer instanceof Uint8Array) return decodeFloat32(b.buffer);
    if (value instanceof Uint8Array) return decodeFloat32(value);
    return null;
  }

  /** @internal — per-process search slot; VectorSearchBusyError when all are taken. */
  _acquireSearchSlot(): () => void {
    if (this.activeSearches >= this.vectorLimits.maxConcurrency) {
      throw new VectorSearchBusyError();
    }
    this.activeSearches++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.activeSearches--;
      }
    };
  }

  /** @internal — test/shutdown hook. */
  async _close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.connecting = null;
    }
  }
}

/** Stored doc → public DocResult (user fields flat, envelope as _x fields). */
function flattenStored(doc: StoredDoc): DocResult {
  const e = doc.envelope;
  return {
    ...(doc.data ?? {}),
    _id: doc._id,
    _entity: e.entity,
    _projectId: e.projectId,
    _schemaVersion: e.schemaVersion,
    _version: e.version,
    _lastEventId: e.lastEventId,
    _eventSequence: e.eventSequence,
    _status: e.status,
    _createdAt: e.createdAt,
    _updatedAt: e.updatedAt,
    _createdBy: e.createdBy,
    _deletedAt: e.deletedAt,
  } as DocResult;
}

// ── Entity Collection ──────────────────────────────────────

class MongoEntityCollection implements EntityCollection {
  constructor(
    private readonly engine: MongoDataEngine,
    private readonly projectId: string,
    private readonly entity: string,
    private readonly config: DataEngineConfig,
  ) {}

  /** Tenant + entity scope every operation is pinned to. */
  private scope(extra?: Record<string, unknown>): Record<string, unknown> {
    return {
      'envelope.projectId': this.projectId,
      'envelope.entity': this.entity,
      'envelope.status': { $ne: 'deleted' },
      ...extra,
    };
  }

  private checkDocSize(doc: JsonObject): void {
    const size = Buffer.byteLength(JSON.stringify(doc), 'utf8');
    const maxBytes = this.config.maxDocumentKb * 1024;
    if (size > maxBytes) {
      throw new DocumentTooLargeError(Math.ceil(size / 1024), this.config.maxDocumentKb);
    }
  }

  async insert(doc: JsonObject, opts?: WriteOpts): Promise<DocResult> {
    this.checkDocSize(doc);
    const col = await this.engine._records();
    const now = new Date().toISOString();
    const stored: StoredDoc = {
      _id: uuid(),
      envelope: {
        entity: this.entity,
        projectId: this.projectId,
        schemaVersion: 1,
        version: 1,
        lastEventId: null,
        eventSequence: 1,
        status: opts?.status ?? 'active',
        createdAt: now,
        updatedAt: now,
        createdBy: opts?.userId ?? '',
        deletedAt: null,
      },
      data: doc,
    };
    await col.insertOne(stored as unknown as Record<string, unknown>);
    return flattenStored(stored);
  }

  async get(id: string): Promise<DocResult | null> {
    const col = await this.engine._records();
    const row = await col.findOne(this.scope({ _id: id }), { projection: NO_VECTORS });
    return row ? flattenStored(row as unknown as StoredDoc) : null;
  }

  async update(id: string, patch: JsonObject, opts?: WriteOpts): Promise<DocResult> {
    this.checkDocSize(patch);
    const col = await this.engine._records();

    if (opts?.ifMatch !== undefined) {
      await this.assertVersion(id, opts.ifMatch);
    }

    const set: Record<string, unknown> = {
      'envelope.updatedAt': new Date().toISOString(),
    };
    for (const [key, value] of Object.entries(patch)) {
      set[`data.${key}`] = value;
    }

    const updated = await col.findOneAndUpdate(
      this.scope({ _id: id }),
      {
        $set: set,
        $inc: { 'envelope.version': 1, 'envelope.eventSequence': 1 },
      },
      { returnDocument: 'after', projection: NO_VECTORS },
    );
    if (!updated) throw new DocumentNotFoundError(this.entity, id);
    return flattenStored(updated as unknown as StoredDoc);
  }

  async replace(id: string, doc: JsonObject, opts?: WriteOpts): Promise<DocResult> {
    this.checkDocSize(doc);
    const col = await this.engine._records();

    if (opts?.ifMatch !== undefined) {
      await this.assertVersion(id, opts.ifMatch);
    }

    const updated = await col.findOneAndUpdate(
      this.scope({ _id: id }),
      {
        $set: { data: doc, 'envelope.updatedAt': new Date().toISOString() },
        $inc: { 'envelope.version': 1, 'envelope.eventSequence': 1 },
      },
      { returnDocument: 'after', projection: NO_VECTORS },
    );
    if (!updated) throw new DocumentNotFoundError(this.entity, id);
    return flattenStored(updated as unknown as StoredDoc);
  }

  async delete(id: string, _opts?: WriteOpts): Promise<void> {
    const col = await this.engine._records();
    const updated = await col.findOneAndUpdate(
      this.scope({ _id: id }),
      {
        $set: {
          'envelope.status': 'deleted',
          'envelope.deletedAt': new Date().toISOString(),
          'envelope.updatedAt': new Date().toISOString(),
        },
        $inc: { 'envelope.version': 1, 'envelope.eventSequence': 1 },
      },
      { returnDocument: 'after', projection: NO_VECTORS },
    );
    if (!updated) throw new DocumentNotFoundError(this.entity, id);
  }

  async restore(id: string, _opts?: WriteOpts): Promise<DocResult> {
    const col = await this.engine._records();
    const now = new Date().toISOString();
    const updated = await col.findOneAndUpdate(
      {
        'envelope.projectId': this.projectId,
        'envelope.entity': this.entity,
        'envelope.status': 'deleted',
        _id: id,
      },
      {
        $set: { 'envelope.status': 'active', 'envelope.deletedAt': null, 'envelope.updatedAt': now },
        $inc: { 'envelope.version': 1, 'envelope.eventSequence': 1 },
      },
      { returnDocument: 'after', projection: NO_VECTORS },
    );
    if (!updated) throw new DocumentNotFoundError(this.entity, id);
    return flattenStored(updated as unknown as StoredDoc);
  }

  async query(q: EntityQuery): Promise<Page<DocResult>> {
    const col = await this.engine._records();

    const base = q.includeSoftDeleted
      ? {
          'envelope.projectId': this.projectId,
          'envelope.entity': this.entity,
        }
      : this.scope();
    const filter = q.filter
      ? { $and: [base, filterToMongo(q.filter)] }
      : base;

    const limit = Math.min(Math.max(q.limit ?? 50, 1), 1000);
    const offset = Math.max(q.offset ?? 0, 0);

    let cursor = col.find(filter);
    cursor = q.sort?.length
      ? cursor.sort(sortToMongo(q.sort))
      : cursor.sort({ 'envelope.createdAt': -1 });
    // A selection is an inclusion projection (no vectors); otherwise exclude them.
    cursor = cursor.project(q.select?.length ? selectToMongo(q.select) : NO_VECTORS);
    cursor = cursor.skip(offset).limit(limit);

    const [rows, total] = await Promise.all([
      cursor.toArray(),
      col.countDocuments(filter, { limit: COUNT_LIMIT }),
    ]);

    return {
      data: rows.map((r) => flattenStored(r as unknown as StoredDoc)),
      total,
      hasMore: offset + rows.length < total,
      nextCursor: offset + rows.length < total ? String(offset + limit) : undefined,
    };
  }

  async count(filter?: Filter): Promise<number> {
    const col = await this.engine._records();
    const query = filter
      ? { $and: [this.scope(), filterToMongo(filter)] }
      : this.scope();
    return col.countDocuments(query, { limit: COUNT_LIMIT });
  }

  async ensureIndexes(defs: IndexDef[]): Promise<void> {
    const col = await this.engine._records();
    for (const def of defs) {
      const spec: Record<string, 1 | -1> = {
        'envelope.projectId': 1,
        'envelope.entity': 1,
      };
      for (const field of def.fields) {
        spec[toStoredPath(field.path)] = field.order === 'desc' ? -1 : 1;
      }
      const safeName = `de_${def.name.replace(/[^a-zA-Z0-9_]/g, '')}`.slice(0, 60);
      try {
        await col.createIndex(spec, { name: safeName });
      } catch {
        // Index creation is best-effort (name/spec conflicts are non-fatal).
      }
    }
  }

  // ── Vectors ────────────────────────────────────────────
  // Every call below starts from this.scope(): project + entity + not deleted.
  // Only `vectors.default` is written; the envelope is never touched, so the
  // document's version (its ETag), event sequence and updatedAt stay as they are.

  private storedVector(vec: Float64Array, model?: string): StoredVector {
    return {
      dims: vec.length,
      model: model || 'client',
      source: 'client',
      hash: null,
      updatedAt: new Date().toISOString(),
      [vectorField(vec.length)]: this.engine._encodeVector(vec),
    };
  }

  private toInfo(id: string, stored: StoredVector | undefined): VectorInfo | null {
    if (!stored || typeof stored.dims !== 'number') return null;
    const values = this.engine._decodeVector(stored[vectorField(stored.dims)]);
    if (!values) return null;
    return {
      id,
      dims: stored.dims,
      model: stored.model,
      source: stored.source,
      updatedAt: stored.updatedAt,
      vector: Array.from(values),
    };
  }

  async setVector(id: string, vector: number[], opts?: VectorWriteOptions): Promise<VectorInfo> {
    const vec = prepareVector(vector, { expected: opts?.dimensions });
    const col = await this.engine._records();
    const stored = this.storedVector(vec, opts?.model);
    const res = await col.updateOne(this.scope({ _id: id }), {
      $set: { 'vectors.default': stored },
    });
    if (!res.matchedCount) throw new DocumentNotFoundError(this.entity, id);
    return this.toInfo(id, stored) as VectorInfo;
  }

  async setVectors(items: VectorWrite[], opts?: VectorWriteOptions): Promise<VectorWriteResult> {
    if (!Array.isArray(items) || items.length === 0) {
      throw new QueryValidationError('items must be a non-empty array');
    }
    if (items.length > MAX_VECTOR_BATCH) {
      throw new QueryValidationError(`at most ${MAX_VECTOR_BATCH} vectors per request`);
    }
    // Validate everything before the first write: a bad item fails the whole batch.
    const prepared = items.map((item, i) => {
      if (typeof item?.id !== 'string' || item.id === '') {
        throw new QueryValidationError(`items[${i}].id must be a non-empty string`);
      }
      return { id: item.id, vec: prepareVector(item.vector, { expected: opts?.dimensions }) };
    });
    const col = await this.engine._records();
    const written: string[] = [];
    const missing: string[] = [];
    for (const { id, vec } of prepared) {
      const res = await col.updateOne(this.scope({ _id: id }), {
        $set: { 'vectors.default': this.storedVector(vec, opts?.model) },
      });
      (res.matchedCount ? written : missing).push(id);
    }
    return { written, missing };
  }

  async getVector(id: string): Promise<VectorInfo | null> {
    const col = await this.engine._records();
    const row = await col.findOne(this.scope({ _id: id }), {
      projection: { _id: 1, 'vectors.default': 1 },
    });
    if (!row) throw new DocumentNotFoundError(this.entity, id);
    return this.toInfo(id, (row as unknown as StoredDoc).vectors?.default);
  }

  async deleteVector(id: string): Promise<boolean> {
    const col = await this.engine._records();
    const res = await col.updateOne(this.scope({ _id: id }), {
      $unset: { 'vectors.default': '' },
    });
    if (!res.matchedCount) throw new DocumentNotFoundError(this.entity, id);
    return res.modifiedCount > 0;
  }

  async clearVectors(): Promise<number> {
    const col = await this.engine._records();
    // Soft-deleted records too: removing an entity's vector setup leaves none behind.
    const res = await col.updateMany(
      {
        'envelope.projectId': this.projectId,
        'envelope.entity': this.entity,
        vectors: { $exists: true },
      },
      { $unset: { vectors: '' } },
    );
    return res.modifiedCount;
  }

  async vectorStats(): Promise<VectorStats> {
    const col = await this.engine._records();
    const [embedded, total] = await Promise.all([
      col.countDocuments(this.scope({ 'vectors.default.dims': { $exists: true } }), { limit: COUNT_LIMIT }),
      col.countDocuments(this.scope(), { limit: COUNT_LIMIT }),
    ]);
    return { embedded, total };
  }

  async vectorSearch(q: VectorSearchQuery): Promise<VectorSearchResult> {
    const query = prepareVector(q.vector, { expected: q.dimensions });
    const limit = q.limit === undefined ? 10 : q.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_VECTOR_LIMIT) {
      throw new QueryValidationError(`limit must be a whole number from 1 to ${MAX_VECTOR_LIMIT}`);
    }
    const maxDistance = q.maxDistance;
    if (maxDistance !== undefined && !(Number.isFinite(maxDistance) && maxDistance >= 0 && maxDistance <= 2)) {
      throw new QueryValidationError('threshold must be a number from 0 to 2');
    }
    const dims = query.length;
    const field = `vectors.default.${vectorField(dims)}`;
    const candidates: Record<string, unknown> = {
      $and: [
        this.scope({ 'vectors.default.dims': dims }),
        ...(q.filter ? [filterToMongo(q.filter)] : []),
      ],
    };
    const { maxScan, timeoutMs } = this.engine.vectorLimits;

    const release = this.engine._acquireSearchSlot();
    try {
      const col = await this.engine._records();
      // Refuse before scoring anything: no partial results.
      const count = await col.countDocuments(candidates, { limit: maxScan + 1, maxTimeMS: timeoutMs });
      if (count > maxScan) throw new VectorScanLimitError(count, maxScan);

      const top = new TopK<{ id: string; score: number; distance: number }>(limit);
      let scanned = 0;
      const cursor = col
        .find(candidates)
        .project({ _id: 1, [field]: 1 })
        .batchSize(VECTOR_BATCH_SIZE)
        .maxTimeMS(timeoutMs);
      try {
        for await (const row of cursor) {
          scanned++;
          // Records written between the count and the scan: still never partial.
          if (scanned > maxScan) throw new VectorScanLimitError(scanned, maxScan);
          const stored = (row as unknown as StoredDoc).vectors?.default;
          const values = stored ? this.engine._decodeVector(stored[vectorField(dims)]) : null;
          if (!values || values.length !== dims) continue;
          const distance = Math.min(2, Math.max(0, 1 - dot(values, query)));
          if (maxDistance !== undefined && !(distance < maxDistance)) continue;
          top.push({ id: String(row._id), score: 1 - distance, distance });
        }
      } finally {
        await cursor.close().catch(() => undefined);
      }

      const best = top.sorted();
      if (best.length === 0) return { hits: [], scanned, strategy: 'exact' };
      const rows = await col
        .find({ $and: [this.scope(), { _id: { $in: best.map((b) => b.id) } }] })
        .project(NO_VECTORS)
        .toArray();
      const byId = new Map(rows.map((r) => [String(r._id), r as unknown as StoredDoc]));
      const hits = best
        .filter((b) => byId.has(b.id))
        .map((b) => ({ doc: flattenStored(byId.get(b.id)!), distance: b.distance, score: b.score }));
      return { hits, scanned, strategy: 'exact' };
    } catch (err: any) {
      if (err?.code === MAX_TIME_MS_EXPIRED || err?.codeName === 'MaxTimeMSExpired') {
        throw new VectorSearchTimeoutError(timeoutMs);
      }
      throw err;
    } finally {
      release();
    }
  }

  private async assertVersion(id: string, expected: number): Promise<void> {
    const col = await this.engine._records();
    const current = await col.findOne(this.scope({ _id: id }), { projection: { envelope: 1 } });
    if (!current) throw new DocumentNotFoundError(this.entity, id);
    const actual = (current as unknown as StoredDoc).envelope.version;
    if (actual !== expected) {
      throw new ConcurrencyError(this.entity, id, expected, actual);
    }
  }
}
