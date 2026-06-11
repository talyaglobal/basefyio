/**
 * CouchDB Data Engine Provider
 *
 * Documents stored in one CouchDB database per project:
 *   {container}--{projectId}   (sanitized to CouchDB database-name rules)
 *
 * Document layout — CouchDB rejects custom top-level underscore fields, so
 * the Basefyio envelope lives under `envelope` and user data under `data`:
 *   { _id, _rev, type: 'basefy_record', envelope: {...}, data: {...} }
 *
 * Transport is plain HTTP/JSON via the global fetch (Node 18+) — no SDK
 * dependency. Selected by DATA_ENGINE_PROVIDER=couchdb.
 *
 * Query strategy: filters compile to Mango selectors and run server-side
 * (`_find` with bookmark paging). Mango has no COUNT and requires a matching
 * index for server-side sort, so matching documents are accumulated (capped
 * at SCAN_CAP) and sorted/paginated in memory. This keeps the provider
 * contract exact; for large collections add Mango indexes via ensureIndexes
 * to keep the server-side selector cheap.
 */

import { v4 as uuid } from 'uuid';
import type { DataEngine, EntityCollection } from '../../interfaces/data-engine';
import {
  ConcurrencyError,
  DataEngineError,
  DocumentNotFoundError,
  DocumentTooLargeError,
  TenantNotProvisionedError,
} from '../../interfaces/data-engine';
import type {
  DataEngineConfig,
  DocResult,
  DocumentStatus,
  IsolationTier,
  JsonObject,
  JsonValue,
  Page,
  ProviderCapabilities,
  TenantDataPlane,
  WriteOpts,
} from '../../interfaces/types';
import type {
  EntityAggregation,
  EntityQuery,
  FieldFilter,
  Filter,
  IndexDef,
  QueryExplainResult,
  SortClause,
} from '../../interfaces/query';

/** Hard cap on documents walked per query/count scan. */
const SCAN_CAP = 10_000;
/** Page size for `_find` bookmark loops. */
const SCAN_BATCH = 1_000;
const RECORD_TYPE = 'basefy_record';

interface RecordEnvelope {
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

interface CouchRecordDoc {
  _id: string;
  _rev?: string;
  type: typeof RECORD_TYPE;
  envelope: RecordEnvelope;
  data: JsonObject;
}

interface CouchResponse {
  status: number;
  json: any;
}

/** Map public envelope paths (_createdAt, …) to stored envelope fields. */
const ENVELOPE_PATHS: Record<string, string> = {
  _id: '_id',
  _entity: 'envelope.entity',
  _projectId: 'envelope.projectId',
  _schemaVersion: 'envelope.schemaVersion',
  _version: 'envelope.version',
  _lastEventId: 'envelope.lastEventId',
  _eventSequence: 'envelope.eventSequence',
  _status: 'envelope.status',
  _createdAt: 'envelope.createdAt',
  _updatedAt: 'envelope.updatedAt',
  _createdBy: 'envelope.createdBy',
  _deletedAt: 'envelope.deletedAt',
};

function mangoPath(path: string): string {
  return ENVELOPE_PATHS[path] ?? `data.${path}`;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** SQL LIKE pattern (% and _) to an anchored regex. */
function likeToRegex(pattern: string, caseInsensitive: boolean): string {
  const body = escapeRegex(pattern).replace(/%/g, '.*').replace(/_/g, '.');
  return `${caseInsensitive ? '(?i)' : ''}^${body}$`;
}

function filterToMango(filter: Filter): JsonObject {
  switch (filter.type) {
    case 'field':
      return fieldFilterToMango(filter);
    case 'and':
      return { $and: filter.conditions.map(filterToMango) };
    case 'or':
      return { $or: filter.conditions.map(filterToMango) };
    case 'not':
      return { $not: filterToMango(filter.condition) };
    default:
      return {};
  }
}

function fieldFilterToMango(filter: FieldFilter): JsonObject {
  const key = mangoPath(filter.path.path);
  const v = filter.value;
  switch (filter.operator) {
    case 'eq':
      return { [key]: { $eq: v } };
    case 'neq':
      return { [key]: { $ne: v } };
    case 'gt':
      return { [key]: { $gt: v } };
    case 'gte':
      return { [key]: { $gte: v } };
    case 'lt':
      return { [key]: { $lt: v } };
    case 'lte':
      return { [key]: { $lte: v } };
    case 'in':
      return { [key]: { $in: Array.isArray(v) ? v : [v] } };
    case 'nin':
      return { [key]: { $nin: Array.isArray(v) ? v : [v] } };
    case 'contains':
      return { [key]: { $elemMatch: { $eq: v } } };
    case 'containsAny':
      return { [key]: { $elemMatch: { $in: Array.isArray(v) ? v : [v] } } };
    case 'exists':
      return { [key]: { $exists: Boolean(v) } };
    case 'regex':
      return { [key]: { $regex: String(v) } };
    case 'iregex':
      return { [key]: { $regex: `(?i)${String(v)}` } };
    case 'like':
      return { [key]: { $regex: likeToRegex(String(v), false) } };
    case 'ilike':
      return { [key]: { $regex: likeToRegex(String(v), true) } };
    default:
      return { [key]: { $eq: v } };
  }
}

/** Resolve a sort path against a stored CouchDB record. */
function sortValue(doc: CouchRecordDoc, path: string): JsonValue | undefined {
  if (path === '_id') return doc._id;
  const mapped = ENVELOPE_PATHS[path];
  if (mapped && mapped.startsWith('envelope.')) {
    const key = mapped.slice('envelope.'.length) as keyof RecordEnvelope;
    return doc.envelope[key] as JsonValue;
  }
  let current: JsonValue | undefined = doc.data;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as JsonObject)[segment];
  }
  return current;
}

function compareValues(a: JsonValue | undefined, b: JsonValue | undefined): number {
  // Nulls/undefined sort last regardless of direction (matches NULLS LAST).
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

export class CouchDbDataEngine implements DataEngine {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(private readonly config: DataEngineConfig) {
    this.baseUrl = (config.connectionString || 'http://127.0.0.1:5984').replace(/\/+$/, '');
    const credentials = `${config.username ?? ''}:${config.password ?? ''}`;
    this.authHeader = `Basic ${Buffer.from(credentials).toString('base64')}`;
  }

  /** @internal */
  _dbName(projectId: string): string {
    const raw = `${this.config.container || 'basefyio-apps'}--${projectId}`.toLowerCase();
    // CouchDB db names: ^[a-z][a-z0-9_$()+/-]*$ — avoid / and + (URL noise).
    let name = raw.replace(/[^a-z0-9_$()-]/g, '-');
    if (!/^[a-z]/.test(name)) name = `bf-${name}`;
    return name;
  }

  /** @internal */
  async _request(method: string, path: string, body?: unknown): Promise<CouchResponse> {
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err: any) {
      throw new DataEngineError(
        `Document store unreachable: ${err?.message ?? 'connection error'}`,
        'STORE_UNREACHABLE',
        503,
      );
    }
    const text = await res.text();
    let json: any = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: res.status, json };
  }

  async provisionTenant(projectId: string, tier?: IsolationTier): Promise<TenantDataPlane> {
    const db = this._dbName(projectId);
    const res = await this._request('PUT', `/${db}`);
    // 201 created, 412 already exists — both fine (idempotent).
    if (res.status !== 201 && res.status !== 412) {
      throw new DataEngineError(
        `Failed to provision data plane: HTTP ${res.status} ${res.json?.reason ?? ''}`.trim(),
        'PROVISION_FAILED',
        502,
      );
    }

    // Baseline Mango indexes so `_find` selectors avoid full scans. Best effort.
    const baseline = [
      { name: 'de-entity-status', fields: ['type', 'envelope.entity', 'envelope.status'] },
      { name: 'de-created-at', fields: ['envelope.createdAt'] },
    ];
    for (const idx of baseline) {
      await this._request('POST', `/${db}/_index`, {
        index: { fields: idx.fields },
        name: idx.name,
        ddoc: idx.name,
        type: 'json',
      }).catch(() => undefined);
    }

    return {
      projectId,
      tier: tier ?? 'shared',
      namespace: db,
      provisionedAt: new Date().toISOString(),
    };
  }

  async deprovisionTenant(projectId: string): Promise<void> {
    const db = this._dbName(projectId);
    const now = new Date().toISOString();

    // Soft-delete every active record (purge happens after retention window).
    for (;;) {
      const res = await this._request('POST', `/${db}/_find`, {
        selector: { type: RECORD_TYPE, 'envelope.status': { $ne: 'deleted' } },
        limit: SCAN_BATCH,
      });
      if (res.status === 404) return; // never provisioned — nothing to do
      if (res.status !== 200) {
        throw new DataEngineError(
          `Deprovision scan failed: HTTP ${res.status}`,
          'DEPROVISION_FAILED',
          502,
        );
      }
      const docs = (res.json?.docs ?? []) as CouchRecordDoc[];
      if (docs.length === 0) return;

      const updated = docs.map((d) => ({
        ...d,
        envelope: {
          ...d.envelope,
          status: 'deleted' as DocumentStatus,
          deletedAt: now,
          updatedAt: now,
          version: d.envelope.version + 1,
          eventSequence: d.envelope.eventSequence + 1,
        },
      }));
      await this._request('POST', `/${db}/_bulk_docs`, { docs: updated });
      if (docs.length < SCAN_BATCH) return;
    }
  }

  collection(projectId: string, entity: string): EntityCollection {
    return new CouchDbEntityCollection(this, projectId, entity, this.config);
  }

  capabilities(): ProviderCapabilities {
    return {
      transactions: false,
      fullTextSearch: false,
      vectorSearch: false,
      ttl: false,
    };
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this._request('GET', '/_up');
      return res.status === 200;
    } catch {
      return false;
    }
  }

  async aggregate(
    projectId: string,
    aggregation: EntityAggregation,
  ): Promise<Page<JsonObject>> {
    // Mirrors the Postgres provider — full pipeline compilation is a later phase.
    return { data: [], total: 0, hasMore: false };
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
}

// ── CouchDB Entity Collection ──────────────────────────────

class CouchDbEntityCollection implements EntityCollection {
  constructor(
    private readonly engine: CouchDbDataEngine,
    private readonly projectId: string,
    private readonly entity: string,
    private readonly config: DataEngineConfig,
  ) {}

  private get db(): string {
    return this.engine._dbName(this.projectId);
  }

  private toDocResult(doc: CouchRecordDoc): DocResult {
    const env = doc.envelope;
    return {
      ...(doc.data ?? {}),
      _id: doc._id,
      _entity: env.entity,
      _projectId: env.projectId,
      _schemaVersion: env.schemaVersion,
      _version: env.version,
      _lastEventId: env.lastEventId ?? null,
      _eventSequence: env.eventSequence,
      _status: env.status,
      _createdAt: env.createdAt,
      _updatedAt: env.updatedAt,
      _createdBy: env.createdBy ?? '',
      _deletedAt: env.deletedAt ?? null,
    };
  }

  /** Fetch the raw stored doc for this entity, or null. No status filtering. */
  private async fetchRaw(id: string): Promise<CouchRecordDoc | null> {
    const res = await this.engine._request('GET', `/${this.db}/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (res.status !== 200) {
      throw new DataEngineError(`Read failed: HTTP ${res.status}`, 'READ_FAILED', 502);
    }
    const doc = res.json as CouchRecordDoc;
    if (doc?.type !== RECORD_TYPE) return null;
    if (doc.envelope?.entity !== this.entity || doc.envelope?.projectId !== this.projectId) {
      return null;
    }
    return doc;
  }

  private async putDoc(doc: CouchRecordDoc): Promise<CouchResponse> {
    return this.engine._request('PUT', `/${this.db}/${encodeURIComponent(doc._id)}`, doc);
  }

  async insert(doc: JsonObject, opts?: WriteOpts): Promise<DocResult> {
    this.checkDocSize(doc);
    const now = new Date().toISOString();
    const record: CouchRecordDoc = {
      _id: uuid(),
      type: RECORD_TYPE,
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

    const res = await this.putDoc(record);
    if (res.status === 404) throw new TenantNotProvisionedError(this.projectId);
    if (res.status !== 201) {
      throw new DataEngineError(
        `Insert failed: HTTP ${res.status} ${res.json?.reason ?? ''}`.trim(),
        'INSERT_FAILED',
        502,
      );
    }
    return this.toDocResult(record);
  }

  async get(id: string): Promise<DocResult | null> {
    const doc = await this.fetchRaw(id);
    if (!doc || doc.envelope.status === 'deleted') return null;
    return this.toDocResult(doc);
  }

  async update(id: string, patch: JsonObject, opts?: WriteOpts): Promise<DocResult> {
    this.checkDocSize(patch);
    return this.mutate(id, opts, (current) => ({ ...current.data, ...patch }));
  }

  async replace(id: string, doc: JsonObject, opts?: WriteOpts): Promise<DocResult> {
    this.checkDocSize(doc);
    return this.mutate(id, opts, () => doc);
  }

  async delete(id: string, opts?: WriteOpts): Promise<void> {
    await this.mutate(id, opts, (current) => current.data, {
      status: 'deleted',
      deletedAt: new Date().toISOString(),
    });
  }

  /**
   * Shared read-modify-write with CAS. The envelope `version` implements the
   * public optimistic-concurrency contract; the CouchDB `_rev` guards the
   * physical write — a 409 means a concurrent writer won the race.
   */
  private async mutate(
    id: string,
    opts: WriteOpts | undefined,
    nextData: (current: CouchRecordDoc) => JsonObject,
    statusOverride?: { status: DocumentStatus; deletedAt: string },
  ): Promise<DocResult> {
    const maxAttempts = opts?.ifMatch !== undefined ? 1 : 3;

    for (let attempt = 1; ; attempt++) {
      const current = await this.fetchRaw(id);
      if (!current || current.envelope.status === 'deleted') {
        throw new DocumentNotFoundError(this.entity, id);
      }
      if (opts?.ifMatch !== undefined && current.envelope.version !== opts.ifMatch) {
        throw new ConcurrencyError(this.entity, id, opts.ifMatch, current.envelope.version);
      }

      const now = new Date().toISOString();
      const updated: CouchRecordDoc = {
        ...current,
        envelope: {
          ...current.envelope,
          version: current.envelope.version + 1,
          eventSequence: current.envelope.eventSequence + 1,
          updatedAt: now,
          ...(statusOverride
            ? { status: statusOverride.status, deletedAt: statusOverride.deletedAt }
            : {}),
        },
        data: nextData(current),
      };

      const res = await this.putDoc(updated);
      if (res.status === 201) return this.toDocResult(updated);
      if (res.status === 409) {
        if (opts?.ifMatch !== undefined) {
          const fresh = await this.fetchRaw(id);
          throw new ConcurrencyError(
            this.entity,
            id,
            opts.ifMatch,
            fresh?.envelope.version ?? current.envelope.version + 1,
          );
        }
        if (attempt < maxAttempts) continue; // re-read fresh _rev and retry
        throw new ConcurrencyError(
          this.entity,
          id,
          current.envelope.version,
          current.envelope.version + 1,
        );
      }
      throw new DataEngineError(
        `Write failed: HTTP ${res.status} ${res.json?.reason ?? ''}`.trim(),
        'WRITE_FAILED',
        502,
      );
    }
  }

  // ── Query ────────────────────────────────────────────

  private baseSelector(includeSoftDeleted: boolean, filter?: Filter): JsonObject {
    const conditions: JsonObject[] = [
      { type: { $eq: RECORD_TYPE } },
      { 'envelope.entity': { $eq: this.entity } },
      { 'envelope.projectId': { $eq: this.projectId } },
    ];
    if (!includeSoftDeleted) {
      conditions.push({ 'envelope.status': { $ne: 'deleted' } });
    }
    if (filter) conditions.push(filterToMango(filter));
    return { $and: conditions };
  }

  /** Walk `_find` with bookmark paging, accumulating matches up to SCAN_CAP. */
  private async scanAll(selector: JsonObject): Promise<CouchRecordDoc[]> {
    const all: CouchRecordDoc[] = [];
    let bookmark: string | undefined;

    while (all.length < SCAN_CAP) {
      const res = await this.engine._request('POST', `/${this.db}/_find`, {
        selector,
        limit: Math.min(SCAN_BATCH, SCAN_CAP - all.length),
        ...(bookmark ? { bookmark } : {}),
      });
      if (res.status === 404) throw new TenantNotProvisionedError(this.projectId);
      if (res.status !== 200) {
        throw new DataEngineError(
          `Query failed: HTTP ${res.status} ${res.json?.reason ?? ''}`.trim(),
          'QUERY_FAILED',
          502,
        );
      }
      const docs = (res.json?.docs ?? []) as CouchRecordDoc[];
      all.push(...docs);
      bookmark = res.json?.bookmark;
      if (docs.length < SCAN_BATCH || !bookmark) break;
    }
    return all;
  }

  async query(q: EntityQuery): Promise<Page<DocResult>> {
    const selector = this.baseSelector(q.includeSoftDeleted ?? false, q.filter);
    const matches = await this.scanAll(selector);

    const sortClauses: SortClause[] =
      q.sort && q.sort.length > 0
        ? q.sort
        : [{ path: { path: '_createdAt', isArrayPath: false }, direction: 'desc' }];

    matches.sort((a, b) => {
      for (const clause of sortClauses) {
        const cmp = compareValues(
          sortValue(a, clause.path.path),
          sortValue(b, clause.path.path),
        );
        if (cmp !== 0) return clause.direction === 'desc' ? -cmp : cmp;
      }
      return 0;
    });

    const limit = Math.min(Math.max(q.limit ?? 50, 1), 1000);
    const offset = Math.max(q.offset ?? 0, 0);
    const total = matches.length;
    const slice = matches.slice(offset, offset + limit);

    return {
      data: slice.map((d) => this.toDocResult(d)),
      total,
      hasMore: offset + limit < total,
      nextCursor: offset + limit < total ? String(offset + limit) : undefined,
    };
  }

  async count(filter?: Filter): Promise<number> {
    const selector = this.baseSelector(false, filter);
    const matches = await this.scanAll(selector);
    return matches.length;
  }

  async ensureIndexes(defs: IndexDef[]): Promise<void> {
    for (const def of defs) {
      const safeName = `de-${def.name.replace(/[^a-zA-Z0-9_-]/g, '')}`;
      const fields = def.fields.map((f) => mangoPath(f.path));
      try {
        await this.engine._request('POST', `/${this.db}/_index`, {
          index: { fields },
          name: safeName,
          ddoc: safeName,
          type: 'json',
        });
      } catch {
        // Index creation is best effort — mirrors the Postgres provider.
      }
    }
  }

  private checkDocSize(doc: JsonObject): void {
    const size = Buffer.byteLength(JSON.stringify(doc), 'utf8');
    const maxBytes = this.config.maxDocumentKb * 1024;
    if (size > maxBytes) {
      throw new DocumentTooLargeError(Math.ceil(size / 1024), this.config.maxDocumentKb);
    }
  }
}
