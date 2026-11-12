import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeDataService } from '../realtime-data/realtime-data.service';
import {
  buildNoSqlFilter,
  buildNoSqlSort,
  buildNoSqlProjection,
} from './nosql-filter.util';

export interface CollectionInfo {
  name: string;
  documentCount: number;
}

export interface DocumentResult {
  id: string;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

const NOSQL_SCHEMA = 'nosql';
const VALID_COLLECTION_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
/** PostgreSQL identifiers are cut at 63 bytes; longer names would silently collide. */
const MAX_COLLECTION_NAME_LENGTH = 63;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Dotted JSON path for an index: "status" or "address.city". */
const INDEX_PATH_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*){0,7}$/;
const MAX_DOCUMENT_SIZE_BYTES = 16 * 1024 * 1024; // 16 MB

@Injectable()
export class CollectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly realtimeData: RealtimeDataService,
  ) {}

  /* ─────────────── Pool helper (same pattern as ProjectDataService) ─────────────── */

  private async getProjectPool(
    projectId: string,
    userId?: string,
    opts?: { statementTimeoutMs?: number },
  ): Promise<{ pool: Pool; project: any }> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
    });
    if (!project) throw new NotFoundException('Project not found');

    if (userId) {
      const membership = await this.prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: project.teamId, userId } },
      });
      if (!membership) throw new NotFoundException('Project not found');
    }

    const statementTimeoutMs =
      opts?.statementTimeoutMs !== undefined ? opts.statementTimeoutMs : 15_000;

    const pool = new Pool({
      host: project.dbHost,
      port: project.dbPort,
      user: project.dbUser,
      password: project.dbPassword,
      database: project.dbName,
      ...(statementTimeoutMs > 0
        ? { statement_timeout: statementTimeoutMs }
        : {}),
    });

    return { pool, project };
  }

  /* ─────────────── Schema bootstrap ─────────────── */

  private async ensureNosqlSchema(client: PoolClient): Promise<void> {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${NOSQL_SCHEMA}`);
    // Grant permissions so RLS roles can access collections
    await client.query(`GRANT USAGE ON SCHEMA ${NOSQL_SCHEMA} TO PUBLIC`);
  }

  /* ─────────────── Validation ─────────────── */

  private validateCollectionName(name: string): void {
    if (typeof name !== 'string' || !VALID_COLLECTION_RE.test(name)) {
      throw new BadRequestException(
        `Invalid collection name: "${name}". Must start with a letter or underscore and contain only letters, digits and underscores.`,
      );
    }
  }

  /**
   * Only enforced when creating: PostgreSQL silently truncates longer names, so
   * a collection created with one would answer to a different name. Existing
   * callers that address a collection by a longer (truncated) name keep working.
   */
  private validateNewCollectionName(name: string): void {
    this.validateCollectionName(name);
    if (name.length > MAX_COLLECTION_NAME_LENGTH) {
      throw new BadRequestException(
        `Invalid collection name: "${name}" is ${name.length} characters long; the maximum is ${MAX_COLLECTION_NAME_LENGTH}.`,
      );
    }
  }

  /** Document ids are UUIDs; anything else is a client error, not a database error. */
  private validateDocId(docId: string): void {
    if (!UUID_RE.test(docId)) {
      throw new BadRequestException(`Invalid document id "${docId}": document ids are UUIDs`);
    }
  }

  private qualifiedName(collection: string): string {
    return `"${NOSQL_SCHEMA}"."${collection}"`;
  }

  /* ─────────────── Collection management ─────────────── */

  async createCollection(
    projectId: string,
    collectionName: string,
    userId?: string,
  ): Promise<{ message: string }> {
    this.validateNewCollectionName(collectionName);

    const { pool } = await this.getProjectPool(projectId, userId);
    const client = await pool.connect();

    try {
      await this.ensureNosqlSchema(client);

      const qualified = this.qualifiedName(collectionName);

      await client.query(`
        CREATE TABLE ${qualified} (
          id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
          data JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);

      // GIN index for fast JSONB queries
      await client.query(
        `CREATE INDEX "idx_${collectionName}_data_gin" ON ${qualified} USING GIN (data)`,
      );

      // Serves the default document order (creation order, id as the tiebreaker).
      // The "-" keeps the name clear of the idx_<collection>_<field> field indexes.
      await client.query(
        `CREATE INDEX "${`idx_${collectionName}-order`.slice(0, MAX_COLLECTION_NAME_LENGTH)}" ON ${qualified} (created_at, id)`,
      );

      // Grant table permissions for RLS roles
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${qualified} TO anon, authenticated, service_role`,
      );

      // Enable RLS
      await client.query(`ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY`);

      // Default policy: service_role has full access
      await client.query(
        `CREATE POLICY "service_role_all" ON ${qualified} FOR ALL TO service_role USING (true) WITH CHECK (true)`,
      );

      return { message: `Collection "${collectionName}" created` };
    } catch (err: any) {
      if (err.code === '42P07') {
        throw new BadRequestException(
          `Collection "${collectionName}" already exists`,
        );
      }
      throw new BadRequestException(
        `Failed to create collection: ${err.message}`,
      );
    } finally {
      client.release();
      await pool.end();
    }
  }

  /**
   * Create a relational table in the project's `public` schema from a typed
   * column spec (used by Blueprint generation). Mirrors createCollection's
   * grants + RLS. Returns {created:false} if the table already exists.
   */
  async createRelationalTable(
    projectId: string,
    tableName: string,
    columns: Array<{ name: string; type: string; nullable: boolean }>,
    userId?: string,
  ): Promise<{ created: boolean; reason?: string }> {
    this.validateCollectionName(tableName);
    for (const c of columns) this.validateCollectionName(c.name);

    const { pool } = await this.getProjectPool(projectId, userId);
    const client = await pool.connect();
    try {
      const qualified = `"public"."${tableName}"`;
      const colDefs = columns
        .map((c) => `"${c.name}" ${c.type}${c.nullable ? '' : ' NOT NULL'}`)
        .join(',\n          ');
      await client.query(`
        CREATE TABLE ${qualified} (
          id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
          ${colDefs ? colDefs + ',' : ''}
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${qualified} TO anon, authenticated, service_role`,
      );
      await client.query(`ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY`);
      await client.query(
        `CREATE POLICY "service_role_all" ON ${qualified} FOR ALL TO service_role USING (true) WITH CHECK (true)`,
      );
      return { created: true };
    } catch (err: any) {
      if (err.code === '42P07') return { created: false, reason: 'exists' };
      throw new BadRequestException(
        `Failed to create table "${tableName}": ${err.message}`,
      );
    } finally {
      client.release();
      await pool.end();
    }
  }

  /**
   * Run a list of DDL statements against the project DB inside a single
   * transaction (used to apply schema migrations). Statements are generated by
   * our own diff engine, never raw user input. Returns the count applied.
   */
  async runStatements(
    projectId: string,
    statements: string[],
    userId?: string,
  ): Promise<{ applied: number }> {
    if (statements.length === 0) return { applied: 0 };
    const { pool } = await this.getProjectPool(projectId, userId, {
      statementTimeoutMs: 60_000,
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let applied = 0;
      for (const sql of statements) {
        await client.query(sql);
        applied++;
      }
      await client.query('COMMIT');
      return { applied };
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new BadRequestException(`Migration failed: ${err.message}`);
    } finally {
      client.release();
      await pool.end();
    }
  }

  async dropCollection(
    projectId: string,
    collectionName: string,
    userId?: string,
  ): Promise<{ message: string }> {
    this.validateCollectionName(collectionName);

    const { pool } = await this.getProjectPool(projectId, userId);
    const client = await pool.connect();

    try {
      const exists = await client.query(
        `SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname = $1 AND tablename = $2`,
        [NOSQL_SCHEMA, collectionName],
      );
      if (exists.rowCount === 0) {
        throw new NotFoundException(`Collection "${collectionName}" not found`);
      }
      await client.query(
        `DROP TABLE IF EXISTS ${this.qualifiedName(collectionName)} CASCADE`,
      );
      return { message: `Collection "${collectionName}" dropped` };
    } finally {
      client.release();
      await pool.end();
    }
  }

  async listCollections(
    projectId: string,
    userId?: string,
  ): Promise<CollectionInfo[]> {
    const { pool } = await this.getProjectPool(projectId, userId);
    const client = await pool.connect();

    try {
      const tables = await client.query(
        `SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname = $1 ORDER BY tablename`,
        [NOSQL_SCHEMA],
      );
      // Use a real COUNT per collection: pg_stat.n_live_tup is only an estimate
      // and reads 0 for freshly-populated collections (no ANALYZE yet), which
      // made the sidebar badge show 0 documents.
      const rows: CollectionInfo[] = [];
      for (const t of tables.rows as { name: string }[]) {
        const c = await client.query(
          `SELECT COUNT(*)::int AS n FROM ${this.qualifiedName(t.name)}`,
        );
        rows.push({ name: t.name, documentCount: c.rows[0]?.n ?? 0 });
      }
      return rows;
    } finally {
      client.release();
      await pool.end();
    }
  }

  /* ─────────────── Document CRUD ─────────────── */

  async insertDocument(
    projectId: string,
    collectionName: string,
    doc: Record<string, unknown> | Record<string, unknown>[],
    userId?: string,
  ): Promise<DocumentResult[]> {
    this.validateCollectionName(collectionName);
    const docs = Array.isArray(doc) ? doc : [doc];
    if (!docs.length) throw new BadRequestException('No documents provided');

    // Validate document sizes
    for (const d of docs) {
      const size = Buffer.byteLength(JSON.stringify(d), 'utf8');
      if (size > MAX_DOCUMENT_SIZE_BYTES) {
        throw new BadRequestException(
          `Document exceeds maximum size of ${MAX_DOCUMENT_SIZE_BYTES / (1024 * 1024)}MB`,
        );
      }
    }

    const { pool } = await this.getProjectPool(projectId, userId);
    const client = await pool.connect();

    try {
      const qualified = this.qualifiedName(collectionName);
      const params: unknown[] = [];
      const valueGroups: string[] = [];

      for (const d of docs) {
        params.push(JSON.stringify(d));
        valueGroups.push(`($${params.length}::jsonb)`);
      }

      const result = await client.query(
        `INSERT INTO ${qualified} (data) VALUES ${valueGroups.join(', ')} RETURNING *`,
        params,
      );

      for (const row of result.rows) {
        this.realtimeData.publishChange(projectId, {
          type: 'INSERT', kind: 'collection', entity: collectionName, new: row,
        });
      }
      return result.rows;
    } catch (err: any) {
      if (err.code === '42P01') {
        throw new NotFoundException(
          `Collection "${collectionName}" not found`,
        );
      }
      throw new BadRequestException(`Insert failed: ${err.message}`);
    } finally {
      client.release();
      await pool.end();
    }
  }

  async findDocuments(
    projectId: string,
    collectionName: string,
    options: {
      filter?: Record<string, unknown>;
      sort?: Record<string, number>;
      project?: Record<string, 0 | 1>;
      limit?: number;
      offset?: number;
    } = {},
    userId?: string,
  ): Promise<{
    data: DocumentResult[];
    total: number;
    limit: number;
    offset: number;
  }> {
    this.validateCollectionName(collectionName);

    const { pool } = await this.getProjectPool(projectId, userId);
    const client = await pool.connect();

    try {
      const qualified = this.qualifiedName(collectionName);
      const { where, params } = buildNoSqlFilter(options.filter);
      // id is the final tiebreaker so pages never skip or repeat documents;
      // without a sort, documents come in creation order.
      const sortSql = buildNoSqlSort(options.sort);
      const orderBy = sortSql ? `${sortSql}, id ASC` : 'created_at ASC, id ASC';
      const projection = buildNoSqlProjection(options.project);

      const selectExpr = projection
        ? `id, ${projection} AS data, created_at, updated_at`
        : '*';

      const whereClause = where ? `WHERE ${where}` : '';

      const limit = Math.min(Math.max(options.limit ?? 50, 1), 1000);
      const offset = Math.max(options.offset ?? 0, 0);

      const limitIdx = params.length + 1;
      const offsetIdx = params.length + 2;

      const [dataResult, countResult] = await Promise.all([
        client.query(
          `SELECT ${selectExpr} FROM ${qualified} ${whereClause} ORDER BY ${orderBy} LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
          [...params, limit, offset],
        ),
        client.query(
          `SELECT COUNT(*)::int AS total FROM ${qualified} ${whereClause}`,
          params,
        ),
      ]);

      return {
        data: dataResult.rows,
        total: countResult.rows[0]?.total ?? 0,
        limit,
        offset,
      };
    } catch (err: any) {
      if (err.code === '42P01') {
        throw new NotFoundException(
          `Collection "${collectionName}" not found`,
        );
      }
      throw new BadRequestException(`Query failed: ${err.message}`);
    } finally {
      client.release();
      await pool.end();
    }
  }

  async findDocumentById(
    projectId: string,
    collectionName: string,
    docId: string,
    userId?: string,
  ): Promise<DocumentResult> {
    this.validateCollectionName(collectionName);
    this.validateDocId(docId);

    const { pool } = await this.getProjectPool(projectId, userId);
    const client = await pool.connect();

    try {
      const result = await client.query(
        `SELECT * FROM ${this.qualifiedName(collectionName)} WHERE id = $1`,
        [docId],
      );

      if (result.rowCount === 0) {
        throw new NotFoundException(`Document "${docId}" not found`);
      }

      return result.rows[0];
    } catch (err: any) {
      if (err instanceof NotFoundException) throw err;
      if (err.code === '42P01') {
        throw new NotFoundException(
          `Collection "${collectionName}" not found`,
        );
      }
      throw new BadRequestException(`Query failed: ${err.message}`);
    } finally {
      client.release();
      await pool.end();
    }
  }

  async updateDocument(
    projectId: string,
    collectionName: string,
    docId: string,
    update: Record<string, unknown>,
    userId?: string,
  ): Promise<DocumentResult> {
    this.validateCollectionName(collectionName);
    this.validateDocId(docId);

    const { pool } = await this.getProjectPool(projectId, userId);
    const client = await pool.connect();

    try {
      // Merge update into existing data using || operator
      const result = await client.query(
        `UPDATE ${this.qualifiedName(collectionName)}
         SET data = data || $1::jsonb, updated_at = now()
         WHERE id = $2
         RETURNING *`,
        [JSON.stringify(update), docId],
      );

      if (result.rowCount === 0) {
        throw new NotFoundException(`Document "${docId}" not found`);
      }

      this.realtimeData.publishChange(projectId, {
        type: 'UPDATE', kind: 'collection', entity: collectionName,
        new: result.rows[0], old: { id: docId },
      });
      return result.rows[0];
    } catch (err: any) {
      if (err instanceof NotFoundException) throw err;
      if (err.code === '42P01') {
        throw new NotFoundException(
          `Collection "${collectionName}" not found`,
        );
      }
      throw new BadRequestException(`Update failed: ${err.message}`);
    } finally {
      client.release();
      await pool.end();
    }
  }

  async replaceDocument(
    projectId: string,
    collectionName: string,
    docId: string,
    newDoc: Record<string, unknown>,
    userId?: string,
  ): Promise<DocumentResult> {
    this.validateCollectionName(collectionName);
    this.validateDocId(docId);

    const size = Buffer.byteLength(JSON.stringify(newDoc), 'utf8');
    if (size > MAX_DOCUMENT_SIZE_BYTES) {
      throw new BadRequestException(
        `Document exceeds maximum size of ${MAX_DOCUMENT_SIZE_BYTES / (1024 * 1024)}MB`,
      );
    }

    const { pool } = await this.getProjectPool(projectId, userId);
    const client = await pool.connect();

    try {
      const result = await client.query(
        `UPDATE ${this.qualifiedName(collectionName)}
         SET data = $1::jsonb, updated_at = now()
         WHERE id = $2
         RETURNING *`,
        [JSON.stringify(newDoc), docId],
      );

      if (result.rowCount === 0) {
        throw new NotFoundException(`Document "${docId}" not found`);
      }

      this.realtimeData.publishChange(projectId, {
        type: 'UPDATE', kind: 'collection', entity: collectionName,
        new: result.rows[0], old: { id: docId },
      });
      return result.rows[0];
    } catch (err: any) {
      if (err instanceof NotFoundException) throw err;
      if (err.code === '42P01') {
        throw new NotFoundException(
          `Collection "${collectionName}" not found`,
        );
      }
      throw new BadRequestException(`Replace failed: ${err.message}`);
    } finally {
      client.release();
      await pool.end();
    }
  }

  async deleteDocument(
    projectId: string,
    collectionName: string,
    docId: string,
    userId?: string,
  ): Promise<{ message: string }> {
    this.validateCollectionName(collectionName);
    this.validateDocId(docId);

    const { pool } = await this.getProjectPool(projectId, userId);
    const client = await pool.connect();

    try {
      const result = await client.query(
        `DELETE FROM ${this.qualifiedName(collectionName)} WHERE id = $1`,
        [docId],
      );

      if (result.rowCount === 0) {
        throw new NotFoundException(`Document "${docId}" not found`);
      }

      this.realtimeData.publishChange(projectId, {
        type: 'DELETE', kind: 'collection', entity: collectionName, old: { id: docId },
      });
      return { message: 'Document deleted' };
    } catch (err: any) {
      if (err instanceof NotFoundException) throw err;
      if (err.code === '42P01') {
        throw new NotFoundException(`Collection "${collectionName}" not found`);
      }
      throw new BadRequestException(`Delete failed: ${err.message}`);
    } finally {
      client.release();
      await pool.end();
    }
  }

  async deleteDocuments(
    projectId: string,
    collectionName: string,
    filter: Record<string, unknown>,
    userId?: string,
  ): Promise<{ deleted: number }> {
    this.validateCollectionName(collectionName);

    if (!filter || Object.keys(filter).length === 0) {
      throw new BadRequestException(
        'A filter is required for bulk delete to prevent accidental data loss',
      );
    }

    const { pool } = await this.getProjectPool(projectId, userId);
    const client = await pool.connect();

    try {
      const { where, params } = buildNoSqlFilter(filter);
      const result = await client.query(
        `DELETE FROM ${this.qualifiedName(collectionName)} WHERE ${where}`,
        params,
      );

      return { deleted: result.rowCount ?? 0 };
    } catch (err: any) {
      if (err.code === '42P01') {
        throw new NotFoundException(
          `Collection "${collectionName}" not found`,
        );
      }
      throw new BadRequestException(`Bulk delete failed: ${err.message}`);
    } finally {
      client.release();
      await pool.end();
    }
  }

  async countDocuments(
    projectId: string,
    collectionName: string,
    filter?: Record<string, unknown>,
    userId?: string,
  ): Promise<{ count: number }> {
    this.validateCollectionName(collectionName);

    const { pool } = await this.getProjectPool(projectId, userId);
    const client = await pool.connect();

    try {
      const { where, params } = buildNoSqlFilter(filter);
      const whereClause = where ? `WHERE ${where}` : '';
      const result = await client.query(
        `SELECT COUNT(*)::int AS count FROM ${this.qualifiedName(collectionName)} ${whereClause}`,
        params,
      );

      return { count: result.rows[0]?.count ?? 0 };
    } catch (err: any) {
      if (err.code === '42P01') {
        throw new NotFoundException(
          `Collection "${collectionName}" not found`,
        );
      }
      throw new BadRequestException(`Count failed: ${err.message}`);
    } finally {
      client.release();
      await pool.end();
    }
  }

  /** Index expression for a (possibly dotted) field path — the same expression the filters use. */
  private indexExpression(fieldPath: string): string {
    const parts = fieldPath.split('.');
    return parts.length === 1
      ? `(data->>'${parts[0]}')`
      : `(data #>> '{${parts.join(',')}}')`;
  }

  async createIndex(
    projectId: string,
    collectionName: string,
    fieldPath: string,
    userId?: string,
  ): Promise<{ message: string; name: string }> {
    this.validateCollectionName(collectionName);
    if (typeof fieldPath !== 'string' || fieldPath.trim() === '') {
      throw new BadRequestException(
        'fieldPath is required, e.g. { "fieldPath": "status" } or { "fieldPath": "address.city" }',
      );
    }
    if (!INDEX_PATH_RE.test(fieldPath)) {
      throw new BadRequestException(
        `Invalid field path: "${fieldPath}". Use a field name or a dotted path such as "address.city" (letters, digits, underscores).`,
      );
    }

    const { pool } = await this.getProjectPool(projectId, userId);
    const client = await pool.connect();

    try {
      const qualified = this.qualifiedName(collectionName);
      const indexName = `idx_${collectionName}_${fieldPath.replace(/\./g, '_')}`.slice(
        0,
        MAX_COLLECTION_NAME_LENGTH,
      );

      await client.query(
        `CREATE INDEX IF NOT EXISTS "${indexName}" ON ${qualified} (${this.indexExpression(fieldPath)})`,
      );

      return { message: `Index created on "${collectionName}.${fieldPath}"`, name: indexName };
    } catch (err: any) {
      if (err.code === '42P01') {
        throw new NotFoundException(`Collection "${collectionName}" not found`);
      }
      throw new BadRequestException(
        `Failed to create index: ${err.message}`,
      );
    } finally {
      client.release();
      await pool.end();
    }
  }

  /**
   * The collection's indexes. `system` marks the two created with the
   * collection (the primary key and the GIN index behind every filter) —
   * those cannot be dropped.
   */
  async listIndexes(
    projectId: string,
    collectionName: string,
    userId?: string,
  ): Promise<Array<{ name: string; fieldPath: string | null; definition: string; system: boolean }>> {
    this.validateCollectionName(collectionName);
    const { pool } = await this.getProjectPool(projectId, userId);
    const client = await pool.connect();
    try {
      const exists = await client.query(
        `SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname = $1 AND tablename = $2`,
        [NOSQL_SCHEMA, collectionName],
      );
      if (exists.rowCount === 0) {
        throw new NotFoundException(`Collection "${collectionName}" not found`);
      }
      const result = await client.query(
        `SELECT indexname, indexdef FROM pg_catalog.pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname`,
        [NOSQL_SCHEMA, collectionName],
      );
      return (result.rows as { indexname: string; indexdef: string }[]).map((row) =>
        describeIndex(row.indexname, row.indexdef),
      );
    } finally {
      client.release();
      await pool.end();
    }
  }

  async dropIndex(
    projectId: string,
    collectionName: string,
    indexName: string,
    userId?: string,
  ): Promise<{ message: string }> {
    this.validateCollectionName(collectionName);
    const indexes = await this.listIndexes(projectId, collectionName, userId);
    const index = indexes.find((i) => i.name === indexName);
    if (!index) {
      throw new NotFoundException(
        `Index "${indexName}" not found on collection "${collectionName}"`,
      );
    }
    if (index.system) {
      throw new BadRequestException(
        `Index "${indexName}" is created with the collection and cannot be dropped`,
      );
    }
    const { pool } = await this.getProjectPool(projectId, userId);
    const client = await pool.connect();
    try {
      // The name was matched against pg_indexes above, so it names a real index.
      await client.query(
        `DROP INDEX IF EXISTS "${NOSQL_SCHEMA}"."${indexName.replace(/"/g, '""')}"`,
      );
      return { message: `Index "${indexName}" dropped` };
    } finally {
      client.release();
      await pool.end();
    }
  }
}

/**
 * Describe a pg_indexes row: which document field it covers (null for
 * other expressions) and whether it is one of the indexes every collection
 * is created with.
 */
export function describeIndex(
  name: string,
  definition: string,
): { name: string; fieldPath: string | null; definition: string; system: boolean } {
  const single = /\(data ->> '([^']+)'::text\)/.exec(definition);
  const nested = /\(data #>> '\{([^}]+)\}'::text\[\]\)/.exec(definition);
  const fieldPath = single ? single[1] : nested ? nested[1].split(',').join('.') : null;
  const system =
    name.endsWith('_pkey') ||
    /USING gin \(data\)/i.test(definition) ||
    /\(created_at, id\)/.test(definition);
  return { name, fieldPath, definition, system };
}
