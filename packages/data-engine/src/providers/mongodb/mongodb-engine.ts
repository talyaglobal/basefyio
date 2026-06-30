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
    const row = await col.findOne(this.scope({ _id: id }));
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
      { returnDocument: 'after' },
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
      { returnDocument: 'after' },
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
      { returnDocument: 'after' },
    );
    if (!updated) throw new DocumentNotFoundError(this.entity, id);
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

  private async assertVersion(id: string, expected: number): Promise<void> {
    const col = await this.engine._records();
    const current = await col.findOne(this.scope({ _id: id }));
    if (!current) throw new DocumentNotFoundError(this.entity, id);
    const actual = (current as unknown as StoredDoc).envelope.version;
    if (actual !== expected) {
      throw new ConcurrencyError(this.entity, id, expected, actual);
    }
  }
}
