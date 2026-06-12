/**
 * PostgreSQL Data Engine Provider (JSONB-based)
 *
 * Proves the DataEngine abstraction is real. Documents stored in JSONB.
 * Selected by DATA_ENGINE_PROVIDER=postgres.
 *
 * Table layout per project DB:
 *   data_engine.records (id UUID PK, entity TEXT, project_id TEXT, version INT,
 *                        data JSONB, envelope JSONB, created_at, updated_at, deleted_at)
 *
 * Dedicated-collection entities get their own table: data_engine."<entity>"
 */

import { v4 as uuid } from 'uuid';
import type { Pool, PoolClient } from 'pg';
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
  NotFilter,
  IndexDef,
  QueryExplainResult,
  SortClause,
} from '../../interfaces/query';

const SCHEMA = 'data_engine';
const RECORDS_TABLE = 'records';

export class PostgresDataEngine implements DataEngine {
  private pools = new Map<string, Pool>();

  constructor(private readonly config: DataEngineConfig) {}

  private getPoolFactory(): typeof import('pg').Pool {
    // Dynamic import to honor peerDependency
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pg = require('pg');
    return pg.Pool;
  }

  /**
   * For the Postgres provider, each project uses its OWN project database
   * (the existing per-project PostgreSQL database). The connection string
   * in config is the platform DB; individual project DBs are resolved from
   * Prisma metadata in the NestJS layer and passed via provisionTenant.
   *
   * For standalone/test usage, we use a single pool from config.connectionString.
   */
  private async getPool(projectId: string): Promise<Pool> {
    let pool = this.pools.get(projectId);
    if (pool) return pool;

    const PoolCtor = this.getPoolFactory();
    pool = new PoolCtor({
      connectionString: this.config.connectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
    });
    this.pools.set(projectId, pool);
    return pool;
  }

  async provisionTenant(
    projectId: string,
    tier?: IsolationTier,
  ): Promise<TenantDataPlane> {
    const pool = await this.getPool(projectId);
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${SCHEMA}.${RECORDS_TABLE} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          entity TEXT NOT NULL,
          project_id TEXT NOT NULL,
          version INT NOT NULL DEFAULT 1,
          event_sequence INT NOT NULL DEFAULT 1,
          last_event_id TEXT,
          schema_version INT NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'active',
          data JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_by TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          deleted_at TIMESTAMPTZ
        )
      `);
      // Baseline indexes
      await client.query(`CREATE INDEX IF NOT EXISTS idx_de_records_project_entity ON ${SCHEMA}.${RECORDS_TABLE} (project_id, entity)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_de_records_project_entity_status ON ${SCHEMA}.${RECORDS_TABLE} (project_id, entity, status)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_de_records_data_gin ON ${SCHEMA}.${RECORDS_TABLE} USING GIN (data)`);

      return {
        projectId,
        tier: tier ?? 'shared',
        namespace: SCHEMA,
        provisionedAt: new Date().toISOString(),
      };
    } finally {
      client.release();
    }
  }

  async deprovisionTenant(projectId: string): Promise<void> {
    const pool = await this.getPool(projectId);
    await pool.query(
      `UPDATE ${SCHEMA}.${RECORDS_TABLE} SET status = 'deleted', deleted_at = now() WHERE project_id = $1 AND status != 'deleted'`,
      [projectId],
    );
  }

  collection(projectId: string, entity: string): EntityCollection {
    return new PgEntityCollection(this, projectId, entity, this.config);
  }

  capabilities(): ProviderCapabilities {
    return {
      transactions: true,
      fullTextSearch: false,
      vectorSearch: false,
      ttl: false,
      aggregationPipeline: false,
    };
  }

  async ping(): Promise<boolean> {
    try {
      const pool = await this.getPool('__ping__');
      const result = await pool.query('SELECT 1');
      return result.rowCount === 1;
    } catch {
      return false;
    }
  }

  async aggregate(
    projectId: string,
    aggregation: EntityAggregation,
  ): Promise<Page<JsonObject>> {
    // Basic aggregation support — Phase 4 will add full pipeline compilation
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

  /** @internal — exposed for PgEntityCollection */
  async _getPool(projectId: string): Promise<Pool> {
    return this.getPool(projectId);
  }
}

// ── PostgreSQL Entity Collection ───────────────────────────

class PgEntityCollection implements EntityCollection {
  constructor(
    private readonly engine: PostgresDataEngine,
    private readonly projectId: string,
    private readonly entity: string,
    private readonly config: DataEngineConfig,
  ) {}

  private async pool(): Promise<Pool> {
    return this.engine._getPool(this.projectId);
  }

  private toDocResult(row: Record<string, unknown>): DocResult {
    const data = (row.data ?? {}) as JsonObject;
    return {
      ...data,
      _id: row.id as string,
      _entity: row.entity as string,
      _projectId: row.project_id as string,
      _schemaVersion: row.schema_version as number,
      _version: row.version as number,
      _lastEventId: (row.last_event_id as string) ?? null,
      _eventSequence: row.event_sequence as number,
      _status: row.status as DocumentStatus,
      _createdAt: (row.created_at as Date).toISOString(),
      _updatedAt: (row.updated_at as Date).toISOString(),
      _createdBy: (row.created_by as string) ?? '',
      _deletedAt: row.deleted_at ? (row.deleted_at as Date).toISOString() : null,
    };
  }

  async insert(doc: JsonObject, opts?: WriteOpts): Promise<DocResult> {
    this.checkDocSize(doc);
    const pool = await this.pool();
    const id = uuid();
    const status = opts?.status ?? 'active';
    const userId = opts?.userId ?? '';

    const result = await pool.query(
      `INSERT INTO ${SCHEMA}.${RECORDS_TABLE}
       (id, entity, project_id, version, event_sequence, schema_version, status, data, created_by)
       VALUES ($1, $2, $3, 1, 1, 1, $4, $5::jsonb, $6)
       RETURNING *`,
      [id, this.entity, this.projectId, status, JSON.stringify(doc), userId],
    );
    return this.toDocResult(result.rows[0]);
  }

  async get(id: string): Promise<DocResult | null> {
    const pool = await this.pool();
    const result = await pool.query(
      `SELECT * FROM ${SCHEMA}.${RECORDS_TABLE}
       WHERE id = $1 AND project_id = $2 AND entity = $3 AND status != 'deleted'`,
      [id, this.projectId, this.entity],
    );
    if (result.rowCount === 0) return null;
    return this.toDocResult(result.rows[0]);
  }

  async update(id: string, patch: JsonObject, opts?: WriteOpts): Promise<DocResult> {
    this.checkDocSize(patch);
    const pool = await this.pool();

    if (opts?.ifMatch !== undefined) {
      const current = await pool.query(
        `SELECT version FROM ${SCHEMA}.${RECORDS_TABLE} WHERE id = $1 AND project_id = $2 AND entity = $3`,
        [id, this.projectId, this.entity],
      );
      if (current.rowCount === 0) throw new DocumentNotFoundError(this.entity, id);
      const actualVersion = current.rows[0].version as number;
      if (actualVersion !== opts.ifMatch) {
        throw new ConcurrencyError(this.entity, id, opts.ifMatch, actualVersion);
      }
    }

    const result = await pool.query(
      `UPDATE ${SCHEMA}.${RECORDS_TABLE}
       SET data = data || $1::jsonb,
           version = version + 1,
           event_sequence = event_sequence + 1,
           updated_at = now()
       WHERE id = $2 AND project_id = $3 AND entity = $4 AND status != 'deleted'
       RETURNING *`,
      [JSON.stringify(patch), id, this.projectId, this.entity],
    );
    if (result.rowCount === 0) throw new DocumentNotFoundError(this.entity, id);
    return this.toDocResult(result.rows[0]);
  }

  async replace(id: string, doc: JsonObject, opts?: WriteOpts): Promise<DocResult> {
    this.checkDocSize(doc);
    const pool = await this.pool();

    if (opts?.ifMatch !== undefined) {
      const current = await pool.query(
        `SELECT version FROM ${SCHEMA}.${RECORDS_TABLE} WHERE id = $1 AND project_id = $2 AND entity = $3`,
        [id, this.projectId, this.entity],
      );
      if (current.rowCount === 0) throw new DocumentNotFoundError(this.entity, id);
      const actualVersion = current.rows[0].version as number;
      if (actualVersion !== opts.ifMatch) {
        throw new ConcurrencyError(this.entity, id, opts.ifMatch, actualVersion);
      }
    }

    const result = await pool.query(
      `UPDATE ${SCHEMA}.${RECORDS_TABLE}
       SET data = $1::jsonb,
           version = version + 1,
           event_sequence = event_sequence + 1,
           updated_at = now()
       WHERE id = $2 AND project_id = $3 AND entity = $4 AND status != 'deleted'
       RETURNING *`,
      [JSON.stringify(doc), id, this.projectId, this.entity],
    );
    if (result.rowCount === 0) throw new DocumentNotFoundError(this.entity, id);
    return this.toDocResult(result.rows[0]);
  }

  async delete(id: string, opts?: WriteOpts): Promise<void> {
    const pool = await this.pool();
    const result = await pool.query(
      `UPDATE ${SCHEMA}.${RECORDS_TABLE}
       SET status = 'deleted', deleted_at = now(), version = version + 1, event_sequence = event_sequence + 1, updated_at = now()
       WHERE id = $1 AND project_id = $2 AND entity = $3 AND status != 'deleted'`,
      [id, this.projectId, this.entity],
    );
    if (result.rowCount === 0) throw new DocumentNotFoundError(this.entity, id);
  }

  async query(q: EntityQuery): Promise<Page<DocResult>> {
    const pool = await this.pool();
    const params: unknown[] = [this.projectId, this.entity];
    let paramIdx = 3;

    // Base WHERE: mandatory _projectId + _entity
    let where = `project_id = $1 AND entity = $2`;

    // Soft-delete exclusion (default)
    if (!q.includeSoftDeleted) {
      where += ` AND status != 'deleted'`;
    }

    // User filters
    if (q.filter) {
      const { clause, filterParams } = this.compileFilter(q.filter, paramIdx);
      where += ` AND (${clause})`;
      params.push(...filterParams);
      paramIdx += filterParams.length;
    }

    // Sort
    let orderBy = 'ORDER BY created_at DESC';
    if (q.sort && q.sort.length > 0) {
      const sortClauses = q.sort.map((s) => {
        const col = this.sortPathToSql(s);
        return `${col} ${s.direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`;
      });
      orderBy = `ORDER BY ${sortClauses.join(', ')}`;
    }

    // Pagination
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 1000);
    const offset = Math.max(q.offset ?? 0, 0);

    // Snapshot filter-only params for the COUNT query BEFORE adding limit/offset
    const countParams = params.slice();

    params.push(limit, offset);
    const limitIdx = paramIdx;
    const offsetIdx = paramIdx + 1;

    const [dataResult, countResult] = await Promise.all([
      pool.query(
        `SELECT * FROM ${SCHEMA}.${RECORDS_TABLE} WHERE ${where} ${orderBy} LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        params,
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total FROM ${SCHEMA}.${RECORDS_TABLE} WHERE ${where}`,
        countParams,
      ),
    ]);

    const total = countResult.rows[0]?.total ?? 0;

    return {
      data: dataResult.rows.map((r: Record<string, unknown>) => this.toDocResult(r)),
      total,
      hasMore: offset + limit < total,
      nextCursor: offset + limit < total ? String(offset + limit) : undefined,
    };
  }

  async count(filter?: Filter): Promise<number> {
    const pool = await this.pool();
    const params: unknown[] = [this.projectId, this.entity];
    let where = `project_id = $1 AND entity = $2 AND status != 'deleted'`;

    if (filter) {
      const { clause, filterParams } = this.compileFilter(filter, 3);
      where += ` AND (${clause})`;
      params.push(...filterParams);
    }

    const result = await pool.query(
      `SELECT COUNT(*)::int AS total FROM ${SCHEMA}.${RECORDS_TABLE} WHERE ${where}`,
      params,
    );
    return result.rows[0]?.total ?? 0;
  }

  async ensureIndexes(defs: IndexDef[]): Promise<void> {
    const pool = await this.pool();
    for (const def of defs) {
      const safeName = def.name.replace(/[^a-zA-Z0-9_]/g, '');
      // Create expression index on JSONB path
      for (const field of def.fields) {
        const expr = `(data->>'${field.path.replace(/'/g, "''")}')`;
        try {
          await pool.query(
            `CREATE INDEX IF NOT EXISTS "de_${safeName}" ON ${SCHEMA}.${RECORDS_TABLE} (${expr})`,
          );
        } catch {
          // Index creation can fail for various reasons; best effort
        }
      }
    }
  }

  // ── Filter Compiler ──────────────────────────────────

  private compileFilter(
    filter: Filter,
    startIdx: number,
  ): { clause: string; filterParams: unknown[] } {
    const params: unknown[] = [];
    const clause = this.filterToSql(filter, startIdx, params);
    return { clause, filterParams: params };
  }

  private filterToSql(filter: Filter, idx: number, params: unknown[]): string {
    switch (filter.type) {
      case 'field':
        return this.fieldFilterToSql(filter, idx, params);
      case 'and':
        return this.logicalFilterToSql(filter, 'AND', idx, params);
      case 'or':
        return this.logicalFilterToSql(filter, 'OR', idx, params);
      case 'not': {
        const inner = this.filterToSql(filter.condition, idx, params);
        return `NOT (${inner})`;
      }
      default:
        return 'TRUE';
    }
  }

  private fieldFilterToSql(filter: FieldFilter, startIdx: number, params: unknown[]): string {
    const path = filter.path.path;
    // Map to JSONB operator
    const jsonPath = `data->>'${path.replace(/\./g, "'->'")}'`;
    const currentIdx = startIdx + params.length;

    switch (filter.operator) {
      case 'eq':
        params.push(String(filter.value));
        return `${jsonPath} = $${currentIdx + 1}`;
      case 'neq':
        params.push(String(filter.value));
        return `${jsonPath} != $${currentIdx + 1}`;
      case 'gt':
        params.push(filter.value);
        return `(${jsonPath})::numeric > $${currentIdx + 1}`;
      case 'gte':
        params.push(filter.value);
        return `(${jsonPath})::numeric >= $${currentIdx + 1}`;
      case 'lt':
        params.push(filter.value);
        return `(${jsonPath})::numeric < $${currentIdx + 1}`;
      case 'lte':
        params.push(filter.value);
        return `(${jsonPath})::numeric <= $${currentIdx + 1}`;
      case 'contains':
        params.push(JSON.stringify([filter.value]));
        return `data->'${path}' @> $${currentIdx + 1}::jsonb`;
      case 'exists':
        return filter.value ? `data ? '${path}'` : `NOT (data ? '${path}')`;
      case 'in': {
        const arr = filter.value as unknown[];
        const placeholders = arr.map((_, i) => {
          params.push(String(arr[i]));
          return `$${currentIdx + 1 + i}`;
        });
        return `${jsonPath} IN (${placeholders.join(', ')})`;
      }
      default:
        params.push(String(filter.value));
        return `${jsonPath} = $${currentIdx + 1}`;
    }
  }

  private logicalFilterToSql(
    filter: LogicalFilter,
    op: 'AND' | 'OR',
    startIdx: number,
    params: unknown[],
  ): string {
    const clauses = filter.conditions.map((c) =>
      this.filterToSql(c, startIdx + params.length, params),
    );
    return `(${clauses.join(` ${op} `)})`;
  }

  private sortPathToSql(sort: SortClause): string {
    const path = sort.path.path;
    if (path.startsWith('_')) {
      // Envelope fields are real columns
      const colMap: Record<string, string> = {
        _createdAt: 'created_at',
        _updatedAt: 'updated_at',
        _version: 'version',
        _status: 'status',
      };
      return colMap[path] ?? 'created_at';
    }
    return `data->>'${path}'`;
  }

  private checkDocSize(doc: JsonObject): void {
    const size = Buffer.byteLength(JSON.stringify(doc), 'utf8');
    const maxBytes = this.config.maxDocumentKb * 1024;
    if (size > maxBytes) {
      throw new DocumentTooLargeError(
        Math.ceil(size / 1024),
        this.config.maxDocumentKb,
      );
    }
  }
}
