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
  DocumentNotDeletedError,
  DocumentNotFoundError,
  ConcurrencyError,
  DocumentTooLargeError,
  QueryValidationError,
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
  ReadOpts,
  DocumentStatus,
} from '../../interfaces/types';
import type {
  EntityAggregation,
  EntityQuery,
  Filter,
  FieldFilter,
  IndexDef,
  QueryExplainResult,
} from '../../interfaces/query';

const SCHEMA = 'data_engine';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

/** Public envelope paths → real columns of data_engine.records. */
const ENVELOPE_COLUMNS: Record<string, string> = {
  _id: 'id',
  _entity: 'entity',
  _projectId: 'project_id',
  _schemaVersion: 'schema_version',
  _version: 'version',
  _lastEventId: 'last_event_id',
  _eventSequence: 'event_sequence',
  _status: 'status',
  _createdAt: 'created_at',
  _updatedAt: 'updated_at',
  _createdBy: 'created_by',
  _deletedAt: 'deleted_at',
};

const TIMESTAMP_COLUMNS = new Set(['created_at', 'updated_at', 'deleted_at']);

/** Path segments for a validated AST path ("a.b[].c" → ["a","b","c"]). */
function pathSegments(path: string): string[] {
  return path.replace(/\[\]/g, '').split('.');
}

/**
 * Compiles the Filter AST to a parameterised WHERE fragment. Every value and
 * every path goes through a bind parameter; nothing user-supplied is spliced
 * into the SQL text. Semantics follow the document-store providers: equality
 * on an array field matches when any element is equal, comparisons only match
 * values of the same JSON type, and a missing field never equals anything.
 */
/** @internal — exported for unit tests. */
export class PgFilterCompiler {
  constructor(private readonly params: unknown[]) {}

  private bind(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  /** jsonb expression for a path (envelope fields map to their columns). */
  private jsonbExpr(path: string): string {
    const column = ENVELOPE_COLUMNS[path];
    if (column) {
      if (TIMESTAMP_COLUMNS.has(column)) {
        return `to_jsonb(to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`;
      }
      return `to_jsonb(${column})`;
    }
    return `(data #> ${this.bind(pathSegments(path))}::text[])`;
  }

  private textExpr(path: string): string {
    return `(${this.jsonbExpr(path)} #>> '{}')`;
  }

  compile(filter: Filter): string {
    switch (filter.type) {
      case 'field':
        return this.field(filter);
      case 'and':
      case 'or': {
        if (filter.conditions.length === 0) return filter.type === 'and' ? 'TRUE' : 'FALSE';
        const op = filter.type === 'and' ? ' AND ' : ' OR ';
        return `(${filter.conditions.map((c) => this.compile(c)).join(op)})`;
      }
      case 'not':
        return `NOT COALESCE((${this.compile(filter.condition)}), FALSE)`;
      default:
        return 'FALSE';
    }
  }

  private eq(path: string, value: JsonValue): string {
    const expr = this.jsonbExpr(path);
    const v = this.bind(JSON.stringify(value));
    return `(${expr} = ${v}::jsonb OR (jsonb_typeof(${expr}) = 'array' AND ${expr} @> jsonb_build_array(${v}::jsonb)))`;
  }

  private anyOf(path: string, values: JsonValue[]): string {
    if (values.length === 0) return 'FALSE';
    const expr = this.jsonbExpr(path);
    const list = this.bind(values.map((v) => JSON.stringify(v)));
    return `(${expr} = ANY(${list}::jsonb[]) OR (jsonb_typeof(${expr}) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(${expr}) AS el(v) WHERE el.v = ANY(${list}::jsonb[]))))`;
  }

  private field(f: FieldFilter): string {
    const path = f.path.path;
    const value = f.value;
    switch (f.operator) {
      case 'eq':
        return value === null ? `(${this.jsonbExpr(path)} IS NULL OR ${this.jsonbExpr(path)} = 'null'::jsonb)` : this.eq(path, value);
      case 'neq':
        return value === null
          ? `(${this.jsonbExpr(path)} IS NOT NULL AND ${this.jsonbExpr(path)} <> 'null'::jsonb)`
          : `NOT COALESCE(${this.eq(path, value)}, FALSE)`;
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        const op = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[f.operator];
        const expr = this.jsonbExpr(path);
        const v = this.bind(JSON.stringify(value));
        return `(jsonb_typeof(${expr}) = jsonb_typeof(${v}::jsonb) AND ${expr} ${op} ${v}::jsonb)`;
      }
      case 'in':
      case 'containsAny':
        return this.anyOf(path, Array.isArray(value) ? value : [value]);
      case 'nin':
        return `NOT COALESCE(${this.anyOf(path, Array.isArray(value) ? value : [value])}, FALSE)`;
      case 'contains': {
        const expr = this.jsonbExpr(path);
        const v = this.bind(JSON.stringify(value));
        return `(${expr} @> jsonb_build_array(${v}::jsonb) OR ${expr} = ${v}::jsonb)`;
      }
      case 'exists':
        return value === false ? `${this.jsonbExpr(path)} IS NULL` : `${this.jsonbExpr(path)} IS NOT NULL`;
      case 'regex':
        return `${this.textExpr(path)} ~ ${this.bind(String(value))}`;
      case 'iregex':
        return `${this.textExpr(path)} ~* ${this.bind(String(value))}`;
      case 'like':
        return `${this.textExpr(path)} LIKE ${this.bind(String(value))}`;
      case 'ilike':
        return `${this.textExpr(path)} ILIKE ${this.bind(String(value))}`;
      default:
        throw new QueryValidationError(`Unsupported filter operator "${String(f.operator)}"`);
    }
  }
}

/** ORDER BY expression for a sort path. Paths are validated (safe charset) upstream. */
/** @internal — exported for unit tests. */
export function sortExpr(path: string): string {
  const column = ENVELOPE_COLUMNS[path];
  if (column) return column;
  const segments = pathSegments(path);
  if (!segments.every((s) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s))) {
    throw new QueryValidationError(`invalid sort path "${path}"`);
  }
  return `(data #> '{${segments.join(',')}}')`;
}

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
    const [created] = await this.insertMany([doc], opts);
    return created;
  }

  async insertMany(docs: JsonObject[], opts?: WriteOpts): Promise<DocResult[]> {
    if (docs.length === 0) return [];
    for (const doc of docs) this.checkDocSize(doc);
    const pool = await this.pool();
    const status = opts?.status ?? 'active';
    const userId = opts?.userId ?? '';

    const params: unknown[] = [this.entity, this.projectId, status, userId];
    const rows = docs.map((doc) => {
      params.push(uuid(), JSON.stringify(doc));
      const idIdx = params.length - 1;
      return `($${idIdx}, $1, $2, 1, 1, 1, $3, $${idIdx + 1}::jsonb, $4)`;
    });
    const result = await pool.query(
      `INSERT INTO ${SCHEMA}.${RECORDS_TABLE}
       (id, entity, project_id, version, event_sequence, schema_version, status, data, created_by)
       VALUES ${rows.join(', ')}
       RETURNING *`,
      params,
    );
    // RETURNING order follows VALUES order for a single INSERT.
    return result.rows.map((r: Record<string, unknown>) => this.toDocResult(r));
  }

  async get(id: string, opts?: ReadOpts): Promise<DocResult | null> {
    if (!UUID_RE.test(id)) return null;
    const pool = await this.pool();
    const result = await pool.query(
      `SELECT * FROM ${SCHEMA}.${RECORDS_TABLE}
       WHERE id = $1 AND project_id = $2 AND entity = $3
       ${opts?.includeSoftDeleted ? '' : `AND status != 'deleted'`}`,
      [id, this.projectId, this.entity],
    );
    if (result.rowCount === 0) return null;
    return this.toDocResult(result.rows[0]);
  }

  /**
   * One atomic conditional UPDATE: the expected version (If-Match) is part of
   * the WHERE clause. When no row matched, a second read tells "not found"
   * apart from "version conflict" / "not deleted".
   */
  private async writeOne(
    id: string,
    setSql: string,
    setParams: unknown[],
    opts: WriteOpts | undefined,
    match: { deleted: boolean } = { deleted: false },
  ): Promise<DocResult> {
    if (!UUID_RE.test(id)) throw new DocumentNotFoundError(this.entity, id);
    const pool = await this.pool();
    const params: unknown[] = [id, this.projectId, this.entity, ...setParams];
    let where = `id = $1 AND project_id = $2 AND entity = $3 AND status ${match.deleted ? `= 'deleted'` : `!= 'deleted'`}`;
    if (opts?.ifMatch !== undefined) {
      params.push(opts.ifMatch);
      where += ` AND version = $${params.length}`;
    }
    const result = await pool.query(
      `UPDATE ${SCHEMA}.${RECORDS_TABLE}
       SET ${setSql},
           version = version + 1,
           event_sequence = event_sequence + 1,
           updated_at = now()
       WHERE ${where}
       RETURNING *`,
      params,
    );
    if (result.rowCount && result.rowCount > 0) return this.toDocResult(result.rows[0]);

    const current = await pool.query(
      `SELECT version, status FROM ${SCHEMA}.${RECORDS_TABLE} WHERE id = $1 AND project_id = $2 AND entity = $3`,
      [id, this.projectId, this.entity],
    );
    if (current.rowCount === 0) throw new DocumentNotFoundError(this.entity, id);
    const row = current.rows[0] as { version: number; status: string };
    const isDeleted = row.status === 'deleted';
    if (match.deleted && !isDeleted) throw new DocumentNotDeletedError(this.entity, id);
    if (!match.deleted && isDeleted) throw new DocumentNotFoundError(this.entity, id);
    if (opts?.ifMatch !== undefined && row.version !== opts.ifMatch) {
      throw new ConcurrencyError(this.entity, id, opts.ifMatch, row.version);
    }
    throw new DocumentNotFoundError(this.entity, id);
  }

  async update(id: string, patch: JsonObject, opts?: WriteOpts): Promise<DocResult> {
    this.checkDocSize(patch);
    return this.writeOne(id, `data = data || $4::jsonb`, [JSON.stringify(patch)], opts);
  }

  async replace(id: string, doc: JsonObject, opts?: WriteOpts): Promise<DocResult> {
    this.checkDocSize(doc);
    return this.writeOne(id, `data = $4::jsonb`, [JSON.stringify(doc)], opts);
  }

  async delete(id: string, opts?: WriteOpts): Promise<void> {
    await this.writeOne(id, `status = 'deleted', deleted_at = now()`, [], opts);
  }

  async restore(id: string, opts?: WriteOpts): Promise<DocResult> {
    return this.writeOne(id, `status = 'active', deleted_at = NULL`, [], opts, { deleted: true });
  }

  async purge(): Promise<number> {
    const pool = await this.pool();
    const result = await pool.query(
      `DELETE FROM ${SCHEMA}.${RECORDS_TABLE} WHERE project_id = $1 AND entity = $2`,
      [this.projectId, this.entity],
    );
    return result.rowCount ?? 0;
  }

  private whereClause(filter: Filter | undefined, includeSoftDeleted: boolean, params: unknown[]): string {
    params.push(this.projectId, this.entity);
    let where = `project_id = $${params.length - 1} AND entity = $${params.length}`;
    if (!includeSoftDeleted) where += ` AND status != 'deleted'`;
    if (filter) where += ` AND (${new PgFilterCompiler(params).compile(filter)})`;
    return where;
  }

  async query(q: EntityQuery): Promise<Page<DocResult>> {
    const pool = await this.pool();
    const params: unknown[] = [];
    const where = this.whereClause(q.filter, q.includeSoftDeleted === true, params);

    // id is the final tiebreaker so equal sort keys still page deterministically.
    const order = q.sort && q.sort.length > 0
      ? q.sort.map((s) => `${sortExpr(s.path.path)} ${s.direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`)
      : ['created_at DESC'];
    order.push('id ASC');

    const limit = Math.min(Math.max(q.limit ?? 50, 1), 1000);
    const offset = Math.max(q.offset ?? 0, 0);
    const countParams = params.slice();
    params.push(limit, offset);

    const [dataResult, countResult] = await Promise.all([
      pool.query(
        `SELECT * FROM ${SCHEMA}.${RECORDS_TABLE} WHERE ${where} ORDER BY ${order.join(', ')} LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total FROM ${SCHEMA}.${RECORDS_TABLE} WHERE ${where}`,
        countParams,
      ),
    ]);

    const total = countResult.rows[0]?.total ?? 0;
    const returned = dataResult.rows.length;

    return {
      data: dataResult.rows.map((r: Record<string, unknown>) => this.toDocResult(r)),
      total,
      hasMore: offset + returned < total,
      nextCursor: offset + returned < total ? String(offset + returned) : undefined,
    };
  }

  async count(filter?: Filter, opts?: ReadOpts): Promise<number> {
    const pool = await this.pool();
    const params: unknown[] = [];
    const where = this.whereClause(filter, opts?.includeSoftDeleted === true, params);
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
