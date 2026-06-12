/**
 * NoSQL Store Data Engine Provider (Couchbase)
 *
 * VENDOR-CONFINED: This is the ONLY directory where the vendor SDK is imported.
 * The vendor name MUST NOT appear outside providers/nosql/.
 *
 * Tenancy model:
 *   Bucket: basefyio-apps (single, shared)
 *   Scope: "projects" (shared-tier) or "prj_<id>" (dedicated-scope)
 *   Collection: "records" (shared-records) or "<entity>" (promoted)
 *
 * Every query includes mandatory _projectId predicate injected server-side.
 */

import { v4 as uuid } from 'uuid';
import type {
  Cluster,
  Scope,
  Collection,
  CasValue,
} from './couchbase-types';
import { casToNumber } from './couchbase-types';

import type { DataEngine, EntityCollection } from '../../interfaces/data-engine';
import {
  DocumentNotFoundError,
  ConcurrencyError,
  TenantNotProvisionedError,
  DocumentTooLargeError,
} from '../../interfaces/data-engine';
import type {
  DataEngineConfig,
  DocResult,
  IsolationTier,
  JsonObject,
  JsonValue,
  Page,
  ProviderCapabilities,
  TenantDataPlane,
  WriteOpts,
  DocumentStatus,
} from '../../interfaces/types';
import type {
  EntityAggregation,
  EntityQuery,
  Filter,
  FieldFilter,
  LogicalFilter,
  IndexDef,
  QueryExplainResult,
  SortClause,
} from '../../interfaces/query';
import { SHARED_NAMESPACE, SHARED_RECORDS_COLLECTION, dedicatedScopeName } from '../../tenancy/names';

export class NoSqlDataEngine implements DataEngine {
  private cluster: Cluster | null = null;
  private readonly bucketName: string;

  constructor(private readonly config: DataEngineConfig) {
    this.bucketName = config.container || 'basefyio-apps';
  }

  private async getCluster(): Promise<Cluster> {
    if (this.cluster) return this.cluster;

    // Dynamic require — the couchbase package is only available in production (Linux)
    const couchbase = require('couchbase');
    this.cluster = await couchbase.connect(this.config.connectionString, {
      username: this.config.username,
      password: this.config.password,
    }) as Cluster;
    return this.cluster;
  }

  private async getScope(tier: IsolationTier, projectId?: string): Promise<Scope> {
    const cluster = await this.getCluster();
    const bucket = cluster.bucket(this.bucketName);
    const scopeName = tier === 'dedicated-scope' && projectId
      ? dedicatedScopeName(projectId)
      : SHARED_NAMESPACE;
    return bucket.scope(scopeName);
  }

  async provisionTenant(
    projectId: string,
    tier?: IsolationTier,
  ): Promise<TenantDataPlane> {
    const actualTier = tier ?? 'shared';
    const cluster = await this.getCluster();
    const bucket = cluster.bucket(this.bucketName);

    if (actualTier === 'dedicated-scope') {
      const scopeName = dedicatedScopeName(projectId);
      try {
        await bucket.collections().createScope(scopeName);
      } catch (e: any) {
        // Scope already exists — idempotent
        if (!e.message?.includes('already exists')) throw e;
      }
      // Create records collection in dedicated scope
      try {
        await bucket.collections().createCollection({
          name: SHARED_RECORDS_COLLECTION,
          scopeName,
        });
      } catch (e: any) {
        if (!e.message?.includes('already exists')) throw e;
      }
    }

    // Ensure baseline index on _projectId in the shared scope
    const scope = await this.getScope(actualTier, projectId);
    const indexScope = actualTier === 'dedicated-scope'
      ? dedicatedScopeName(projectId)
      : SHARED_NAMESPACE;

    try {
      await cluster.query(
        `CREATE INDEX IF NOT EXISTS \`idx_projectId\` ON \`${this.bucketName}\`.\`${indexScope}\`.\`${SHARED_RECORDS_COLLECTION}\`(_projectId)`,
      );
      await cluster.query(
        `CREATE INDEX IF NOT EXISTS \`idx_entity_projectId\` ON \`${this.bucketName}\`.\`${indexScope}\`.\`${SHARED_RECORDS_COLLECTION}\`(_entity, _projectId)`,
      );
    } catch {
      // Index creation failures are non-fatal for provisioning
    }

    return {
      projectId,
      tier: actualTier,
      namespace: indexScope,
      provisionedAt: new Date().toISOString(),
    };
  }

  async deprovisionTenant(projectId: string): Promise<void> {
    const cluster = await this.getCluster();
    // Soft-delete all documents for this project across all collections
    try {
      await cluster.query(
        `UPDATE \`${this.bucketName}\`.\`${SHARED_NAMESPACE}\`.\`${SHARED_RECORDS_COLLECTION}\`
         SET _status = 'deleted', _deletedAt = NOW_STR()
         WHERE _projectId = $1 AND _status != 'deleted'`,
        { parameters: [projectId] },
      );
    } catch {
      // Best-effort soft delete
    }
  }

  collection(projectId: string, entity: string): EntityCollection {
    return new CbEntityCollection(this, projectId, entity, this.config, this.bucketName);
  }

  capabilities(): ProviderCapabilities {
    return {
      transactions: true,
      fullTextSearch: true,
      vectorSearch: false,
      ttl: true,
      aggregationPipeline: false,
    };
  }

  async ping(): Promise<boolean> {
    try {
      const cluster = await this.getCluster();
      await cluster.ping();
      return true;
    } catch {
      return false;
    }
  }

  async aggregate(
    projectId: string,
    aggregation: EntityAggregation,
  ): Promise<Page<JsonObject>> {
    // Phase 4: Full aggregation pipeline compilation to N1QL
    return { data: [], total: 0, hasMore: false };
  }

  async explain(
    projectId: string,
    query: EntityQuery | EntityAggregation,
  ): Promise<QueryExplainResult> {
    return {
      mode: 'pipeline' in query ? 'aggregation' : 'sql',
      entity: 'entity' in query ? (query as EntityQuery).entity : (query as EntityAggregation).entity,
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

  /** @internal */
  async _getScope(tier: IsolationTier, projectId?: string): Promise<Scope> {
    return this.getScope(tier, projectId);
  }

  /** @internal */
  async _getCluster(): Promise<Cluster> {
    return this.getCluster();
  }

  get _bucketName(): string {
    return this.bucketName;
  }
}

// ── Couchbase Entity Collection ────────────────────────────

class CbEntityCollection implements EntityCollection {
  constructor(
    private readonly engine: NoSqlDataEngine,
    private readonly projectId: string,
    private readonly entity: string,
    private readonly config: DataEngineConfig,
    private readonly bucketName: string,
  ) {}

  private async scope(): Promise<Scope> {
    return this.engine._getScope('shared');
  }

  private collectionName(): string {
    // For now, all entities use the shared records collection.
    // Promoted entities will resolve to their own collection via metadata lookup.
    return SHARED_RECORDS_COLLECTION;
  }

  private async getCollection(): Promise<Collection> {
    const s = await this.scope();
    return s.collection(this.collectionName());
  }

  private buildEnvelope(
    id: string,
    doc: JsonObject,
    cas: CasValue,
    opts?: WriteOpts,
  ): JsonObject {
    const now = new Date().toISOString();
    return {
      _id: id,
      _entity: this.entity,
      _projectId: this.projectId,
      _schemaVersion: 1,
      _version: casToNumber(cas),
      _lastEventId: null,
      _eventSequence: 1,
      _status: opts?.status ?? 'active',
      _createdAt: now,
      _updatedAt: now,
      _createdBy: opts?.userId ?? '',
      _deletedAt: null,
      ...doc,
    };
  }

  private docToResult(raw: JsonObject): DocResult {
    return raw as unknown as DocResult;
  }

  async insert(doc: JsonObject, opts?: WriteOpts): Promise<DocResult> {
    this.checkDocSize(doc);
    const col = await this.getCollection();
    const id = `${this.entity}::${uuid()}`;
    const envelope = this.buildEnvelope(id, doc, 0, opts);

    const result = await col.insert(id, envelope);
    envelope._version = casToNumber(result.cas);
    return this.docToResult(envelope);
  }

  async get(id: string): Promise<DocResult | null> {
    const col = await this.getCollection();
    try {
      const result = await col.get(id);
      const content = result.content as JsonObject;
      // Verify project isolation
      if (content._projectId !== this.projectId) return null;
      if (content._entity !== this.entity) return null;
      if (content._status === 'deleted') return null;
      content._version = casToNumber(result.cas);
      return this.docToResult(content);
    } catch (e: any) {
      if (e.name === 'DocumentNotFoundError' || e.code === 13) return null;
      throw e;
    }
  }

  async update(id: string, patch: JsonObject, opts?: WriteOpts): Promise<DocResult> {
    this.checkDocSize(patch);
    const col = await this.getCollection();

    // Read current
    let current;
    try {
      current = await col.get(id);
    } catch {
      throw new DocumentNotFoundError(this.entity, id);
    }

    const content = current.content as JsonObject;
    if (content._projectId !== this.projectId) throw new DocumentNotFoundError(this.entity, id);
    if (content._status === 'deleted') throw new DocumentNotFoundError(this.entity, id);

    // CAS check
    if (opts?.ifMatch !== undefined) {
      const currentVersion = casToNumber(current.cas);
      if (currentVersion !== opts.ifMatch) {
        throw new ConcurrencyError(this.entity, id, opts.ifMatch, currentVersion);
      }
    }

    // Merge patch
    const updated: JsonObject = {
      ...content,
      ...patch,
      _updatedAt: new Date().toISOString(),
      _eventSequence: ((content._eventSequence as number) ?? 0) + 1,
    };

    try {
      const result = await col.replace(id, updated, { cas: current.cas });
      updated._version = casToNumber(result.cas);
      return this.docToResult(updated);
    } catch (e: any) {
      if (e.name === 'CasMismatchError' || e.code === 12) {
        throw new ConcurrencyError(this.entity, id, opts?.ifMatch ?? 0, 0);
      }
      throw e;
    }
  }

  async replace(id: string, doc: JsonObject, opts?: WriteOpts): Promise<DocResult> {
    this.checkDocSize(doc);
    const col = await this.getCollection();

    let current;
    try {
      current = await col.get(id);
    } catch {
      throw new DocumentNotFoundError(this.entity, id);
    }

    const content = current.content as JsonObject;
    if (content._projectId !== this.projectId) throw new DocumentNotFoundError(this.entity, id);

    if (opts?.ifMatch !== undefined) {
      const currentVersion = casToNumber(current.cas);
      if (currentVersion !== opts.ifMatch) {
        throw new ConcurrencyError(this.entity, id, opts.ifMatch, currentVersion);
      }
    }

    const replaced: JsonObject = {
      _id: content._id as string,
      _entity: this.entity,
      _projectId: this.projectId,
      _schemaVersion: content._schemaVersion as number,
      _version: 0,
      _lastEventId: content._lastEventId as string | null,
      _eventSequence: ((content._eventSequence as number) ?? 0) + 1,
      _status: content._status as string,
      _createdAt: content._createdAt as string,
      _updatedAt: new Date().toISOString(),
      _createdBy: content._createdBy as string,
      _deletedAt: null,
      ...doc,
    };

    try {
      const result = await col.replace(id, replaced, { cas: current.cas });
      replaced._version = casToNumber(result.cas);
      return this.docToResult(replaced);
    } catch (e: any) {
      if (e.name === 'CasMismatchError' || e.code === 12) {
        throw new ConcurrencyError(this.entity, id, opts?.ifMatch ?? 0, 0);
      }
      throw e;
    }
  }

  async delete(id: string, opts?: WriteOpts): Promise<void> {
    const col = await this.getCollection();

    let current;
    try {
      current = await col.get(id);
    } catch {
      throw new DocumentNotFoundError(this.entity, id);
    }

    const content = current.content as JsonObject;
    if (content._projectId !== this.projectId) throw new DocumentNotFoundError(this.entity, id);

    // Soft delete
    content._status = 'deleted';
    content._deletedAt = new Date().toISOString();
    content._updatedAt = new Date().toISOString();
    content._eventSequence = ((content._eventSequence as number) ?? 0) + 1;

    await col.replace(id, content, { cas: current.cas });
  }

  async query(q: EntityQuery): Promise<Page<DocResult>> {
    const cluster = await this.engine._getCluster();
    const scopeName = SHARED_NAMESPACE;
    const colName = this.collectionName();
    const fqn = `\`${this.bucketName}\`.\`${scopeName}\`.\`${colName}\``;

    const params: unknown[] = [this.projectId, this.entity];
    let where = `_projectId = $1 AND _entity = $2`;

    if (!q.includeSoftDeleted) {
      where += ` AND _status != 'deleted'`;
    }

    if (q.filter) {
      const { clause, filterParams } = this.compileFilter(q.filter, 3);
      where += ` AND (${clause})`;
      params.push(...filterParams);
    }

    let orderBy = 'ORDER BY _createdAt DESC';
    if (q.sort && q.sort.length > 0) {
      const clauses = q.sort.map((s) => {
        const field = s.path.path;
        return `\`${field}\` ${s.direction === 'desc' ? 'DESC' : 'ASC'}`;
      });
      orderBy = `ORDER BY ${clauses.join(', ')}`;
    }

    const limit = Math.min(Math.max(q.limit ?? 50, 1), 1000);
    const offset = Math.max(q.offset ?? 0, 0);

    const dataQuery = `SELECT META().id AS __docId, ${fqn}.* FROM ${fqn} WHERE ${where} ${orderBy} LIMIT ${limit} OFFSET ${offset}`;
    const countQuery = `SELECT COUNT(*) AS total FROM ${fqn} WHERE ${where}`;

    const [dataResult, countResult] = await Promise.all([
      cluster.query(dataQuery, { parameters: params }),
      cluster.query(countQuery, { parameters: params }),
    ]);

    const total = (countResult.rows[0] as JsonObject)?.total as number ?? 0;
    const data = dataResult.rows.map((row) => {
      const r = row as JsonObject;
      if (r.__docId) {
        r._id = r.__docId;
        delete r.__docId;
      }
      return this.docToResult(r);
    });

    return {
      data,
      total,
      hasMore: offset + limit < total,
      nextCursor: offset + limit < total ? String(offset + limit) : undefined,
    };
  }

  async count(filter?: Filter): Promise<number> {
    const cluster = await this.engine._getCluster();
    const fqn = `\`${this.bucketName}\`.\`${SHARED_NAMESPACE}\`.\`${this.collectionName()}\``;
    const params: unknown[] = [this.projectId, this.entity];
    let where = `_projectId = $1 AND _entity = $2 AND _status != 'deleted'`;

    if (filter) {
      const { clause, filterParams } = this.compileFilter(filter, 3);
      where += ` AND (${clause})`;
      params.push(...filterParams);
    }

    const result = await cluster.query(
      `SELECT COUNT(*) AS total FROM ${fqn} WHERE ${where}`,
      { parameters: params },
    );
    return (result.rows[0] as JsonObject)?.total as number ?? 0;
  }

  async ensureIndexes(defs: IndexDef[]): Promise<void> {
    const cluster = await this.engine._getCluster();
    const fqn = `\`${this.bucketName}\`.\`${SHARED_NAMESPACE}\`.\`${this.collectionName()}\``;

    for (const def of defs) {
      const fields = def.fields.map((f) => `\`${f.path}\``).join(', ');
      try {
        await cluster.query(
          `CREATE INDEX IF NOT EXISTS \`${def.name}\` ON ${fqn}(${fields})`,
        );
      } catch {
        // Best effort
      }
    }
  }

  // ── N1QL Filter Compiler ──────────────────────────────

  private compileFilter(
    filter: Filter,
    startIdx: number,
  ): { clause: string; filterParams: unknown[] } {
    const params: unknown[] = [];
    const clause = this.filterToN1ql(filter, startIdx, params);
    return { clause, filterParams: params };
  }

  private filterToN1ql(filter: Filter, idx: number, params: unknown[]): string {
    switch (filter.type) {
      case 'field': {
        const f = filter as FieldFilter;
        const path = `\`${f.path.path}\``;
        const currentIdx = idx + params.length;

        switch (f.operator) {
          case 'eq':
            params.push(f.value);
            return `${path} = $${currentIdx + 1}`;
          case 'neq':
            params.push(f.value);
            return `${path} != $${currentIdx + 1}`;
          case 'gt':
            params.push(f.value);
            return `${path} > $${currentIdx + 1}`;
          case 'gte':
            params.push(f.value);
            return `${path} >= $${currentIdx + 1}`;
          case 'lt':
            params.push(f.value);
            return `${path} < $${currentIdx + 1}`;
          case 'lte':
            params.push(f.value);
            return `${path} <= $${currentIdx + 1}`;
          case 'contains':
            params.push(f.value);
            return `$${currentIdx + 1} IN ${path}`;
          case 'exists':
            return f.value ? `${path} IS NOT MISSING` : `${path} IS MISSING`;
          case 'in': {
            const arr = f.value as unknown[];
            const placeholders = arr.map((v, i) => {
              params.push(v);
              return `$${currentIdx + 1 + i}`;
            });
            return `${path} IN [${placeholders.join(', ')}]`;
          }
          default:
            params.push(f.value);
            return `${path} = $${currentIdx + 1}`;
        }
      }
      case 'and': {
        const clauses = (filter as LogicalFilter).conditions.map((c) =>
          this.filterToN1ql(c, idx + params.length, params),
        );
        return `(${clauses.join(' AND ')})`;
      }
      case 'or': {
        const clauses = (filter as LogicalFilter).conditions.map((c) =>
          this.filterToN1ql(c, idx + params.length, params),
        );
        return `(${clauses.join(' OR ')})`;
      }
      case 'not': {
        const inner = this.filterToN1ql(
          (filter as { type: 'not'; condition: Filter }).condition,
          idx + params.length,
          params,
        );
        return `NOT (${inner})`;
      }
      default:
        return 'TRUE';
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
