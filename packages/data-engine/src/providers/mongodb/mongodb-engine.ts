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
 */

import { v4 as uuid } from 'uuid';
import type { DataEngine, EntityCollection } from '../../interfaces/data-engine';
import {
  ConcurrencyError,
  DataEngineError,
  DocumentNotDeletedError,
  DocumentNotFoundError,
  DocumentTooLargeError,
} from '../../interfaces/data-engine';
import type {
  DataEngineConfig,
  DocResult,
  DocumentStatus,
  IsolationTier,
  JsonObject,
  Page,
  ProviderCapabilities,
  ReadOpts,
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

// ── Minimal structural driver types ────────────────────────
// The mongodb package is optional; these cover exactly what we call.

interface MongoCursorLike {
  toArray(): Promise<Record<string, unknown>[]>;
  sort(spec: Record<string, 1 | -1>): MongoCursorLike;
  skip(n: number): MongoCursorLike;
  limit(n: number): MongoCursorLike;
  project(spec: Record<string, unknown>): MongoCursorLike;
}

interface MongoCollectionLike {
  insertOne(doc: Record<string, unknown>): Promise<unknown>;
  insertMany(
    docs: Record<string, unknown>[],
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  deleteMany(filter: Record<string, unknown>): Promise<{ deletedCount?: number }>;
  findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null>;
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
  ): Promise<unknown>;
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

interface StoredDoc {
  _id: string;
  envelope: StoredEnvelope;
  data: JsonObject;
}

export class MongoDataEngine implements DataEngine {
  private client: MongoClientLike | null = null;
  private connecting: Promise<MongoClientLike> | null = null;

  constructor(private readonly config: DataEngineConfig) {}

  private loadDriver(): { MongoClient: new (uri: string) => MongoClientLike } {
    try {
      // Dynamic require keeps mongodb an optional peer dependency.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('mongodb');
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
    // Serves the default list order (newest first, _id as the tiebreaker) without an in-memory sort.
    await col.createIndex(
      { 'envelope.projectId': 1, 'envelope.entity': 1, 'envelope.createdAt': -1, _id: 1 },
      { name: 'idx_created_id' },
    );
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
      vectorSearch: false,
      ttl: false,
      aggregationPipeline: true,
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
  private scope(extra?: Record<string, unknown>, includeSoftDeleted = false): Record<string, unknown> {
    return {
      'envelope.projectId': this.projectId,
      'envelope.entity': this.entity,
      ...(includeSoftDeleted ? {} : { 'envelope.status': { $ne: 'deleted' } }),
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

  private newStored(doc: JsonObject, opts: WriteOpts | undefined, now: string): StoredDoc {
    return {
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
  }

  async insert(doc: JsonObject, opts?: WriteOpts): Promise<DocResult> {
    this.checkDocSize(doc);
    const col = await this.engine._records();
    const stored = this.newStored(doc, opts, new Date().toISOString());
    await col.insertOne(stored as unknown as Record<string, unknown>);
    return flattenStored(stored);
  }

  async insertMany(docs: JsonObject[], opts?: WriteOpts): Promise<DocResult[]> {
    if (docs.length === 0) return [];
    for (const doc of docs) this.checkDocSize(doc);
    const col = await this.engine._records();
    const now = new Date().toISOString();
    const stored = docs.map((doc) => this.newStored(doc, opts, now));
    await col.insertMany(stored as unknown as Record<string, unknown>[], { ordered: true });
    return stored.map(flattenStored);
  }

  async get(id: string, opts?: ReadOpts): Promise<DocResult | null> {
    const col = await this.engine._records();
    const row = await col.findOne(this.scope({ _id: id }, opts?.includeSoftDeleted === true));
    return row ? flattenStored(row as unknown as StoredDoc) : null;
  }

  /**
   * One atomic conditional write. The expected version (If-Match) is part of
   * the match filter, so a concurrent writer can never slip in between the
   * check and the write. When nothing matched, a second read tells "not
   * found" apart from "version conflict".
   */
  private async writeOne(
    id: string,
    update: Record<string, unknown>,
    opts: WriteOpts | undefined,
    match: { deleted: boolean } = { deleted: false },
  ): Promise<StoredDoc> {
    const col = await this.engine._records();
    const filter: Record<string, unknown> = {
      'envelope.projectId': this.projectId,
      'envelope.entity': this.entity,
      'envelope.status': match.deleted ? 'deleted' : { $ne: 'deleted' },
      _id: id,
      ...(opts?.ifMatch !== undefined ? { 'envelope.version': opts.ifMatch } : {}),
    };
    const updated = await col.findOneAndUpdate(filter, update, { returnDocument: 'after' });
    if (updated) return updated as unknown as StoredDoc;

    const current = (await col.findOne(this.scope({ _id: id }, true))) as unknown as StoredDoc | null;
    if (!current) throw new DocumentNotFoundError(this.entity, id);
    const isDeleted = current.envelope.status === 'deleted';
    if (match.deleted && !isDeleted) throw new DocumentNotDeletedError(this.entity, id);
    if (!match.deleted && isDeleted) throw new DocumentNotFoundError(this.entity, id);
    if (opts?.ifMatch !== undefined && current.envelope.version !== opts.ifMatch) {
      throw new ConcurrencyError(this.entity, id, opts.ifMatch, current.envelope.version);
    }
    throw new DocumentNotFoundError(this.entity, id);
  }

  async update(id: string, patch: JsonObject, opts?: WriteOpts): Promise<DocResult> {
    this.checkDocSize(patch);
    const set: Record<string, unknown> = {
      'envelope.updatedAt': new Date().toISOString(),
    };
    for (const [key, value] of Object.entries(patch)) {
      set[`data.${key}`] = value;
    }
    const updated = await this.writeOne(
      id,
      { $set: set, $inc: { 'envelope.version': 1, 'envelope.eventSequence': 1 } },
      opts,
    );
    return flattenStored(updated);
  }

  async replace(id: string, doc: JsonObject, opts?: WriteOpts): Promise<DocResult> {
    this.checkDocSize(doc);
    const updated = await this.writeOne(
      id,
      {
        $set: { data: doc, 'envelope.updatedAt': new Date().toISOString() },
        $inc: { 'envelope.version': 1, 'envelope.eventSequence': 1 },
      },
      opts,
    );
    return flattenStored(updated);
  }

  async delete(id: string, opts?: WriteOpts): Promise<void> {
    const now = new Date().toISOString();
    await this.writeOne(
      id,
      {
        $set: {
          'envelope.status': 'deleted',
          'envelope.deletedAt': now,
          'envelope.updatedAt': now,
        },
        $inc: { 'envelope.version': 1, 'envelope.eventSequence': 1 },
      },
      opts,
    );
  }

  async restore(id: string, opts?: WriteOpts): Promise<DocResult> {
    const restored = await this.writeOne(
      id,
      {
        $set: {
          'envelope.status': 'active',
          'envelope.deletedAt': null,
          'envelope.updatedAt': new Date().toISOString(),
        },
        $inc: { 'envelope.version': 1, 'envelope.eventSequence': 1 },
      },
      opts,
      { deleted: true },
    );
    return flattenStored(restored);
  }

  async purge(): Promise<number> {
    const col = await this.engine._records();
    const result = await col.deleteMany({
      'envelope.projectId': this.projectId,
      'envelope.entity': this.entity,
    });
    return result?.deletedCount ?? 0;
  }

  async query(q: EntityQuery): Promise<Page<DocResult>> {
    const col = await this.engine._records();

    const base = this.scope(undefined, q.includeSoftDeleted === true);
    const filter = q.filter
      ? { $and: [base, filterToMongo(q.filter)] }
      : base;

    const limit = Math.min(Math.max(q.limit ?? 50, 1), 1000);
    const offset = Math.max(q.offset ?? 0, 0);

    // _id is the final tiebreaker so equal sort keys still page deterministically.
    const sort: Record<string, 1 | -1> = q.sort?.length
      ? sortToMongo(q.sort)
      : { 'envelope.createdAt': -1 };
    if (!('_id' in sort)) sort._id = 1;

    let cursor = col.find(filter).sort(sort);
    if (q.select?.length) cursor = cursor.project(selectToMongo(q.select));
    cursor = cursor.skip(offset).limit(limit);

    const [rows, total] = await Promise.all([
      cursor.toArray(),
      col.countDocuments(filter, { limit: COUNT_LIMIT }),
    ]);

    return {
      data: rows.map((r) => flattenStored(r as unknown as StoredDoc)),
      total,
      hasMore: offset + rows.length < total,
      nextCursor: offset + rows.length < total ? String(offset + rows.length) : undefined,
    };
  }

  async count(filter?: Filter, opts?: ReadOpts): Promise<number> {
    const col = await this.engine._records();
    const base = this.scope(undefined, opts?.includeSoftDeleted === true);
    const query = filter ? { $and: [base, filterToMongo(filter)] } : base;
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
}
