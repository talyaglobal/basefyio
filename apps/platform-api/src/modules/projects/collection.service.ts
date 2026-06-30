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
    if (!VALID_COLLECTION_RE.test(name)) {
      throw new BadRequestException(
        `Invalid collection name: "${name}". Must start with a letter or underscore and contain only alphanumeric characters.`,
      );
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
    this.validateCollectionName(collectionName);

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

  async dropCollection(
    projectId: string,
    collectionName: string,
    userId?: string,
  ): Promise<{ message: string }> {
    this.validateCollectionName(collectionName);

    const { pool } = await this.getProjectPool(projectId, userId);
    const client = await pool.connect();

    try {
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
      const result = await client.query(
        `
        SELECT
          t.tablename AS name,
          COALESCE(s.n_live_tup, 0)::int AS "documentCount"
        FROM pg_catalog.pg_tables t
        LEFT JOIN pg_stat_user_tables s
          ON s.relname = t.tablename AND s.schemaname = t.schemaname
        WHERE t.schemaname = $1
        ORDER BY t.tablename
        `,
        [NOSQL_SCHEMA],
      );

      return result.rows;
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
      const orderBy = buildNoSqlSort(options.sort);
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
          `SELECT ${selectExpr} FROM ${qualified} ${whereClause} ${orderBy ? `ORDER BY ${orderBy}` : ''} LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
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

  async createIndex(
    projectId: string,
    collectionName: string,
    fieldPath: string,
    userId?: string,
  ): Promise<{ message: string }> {
    this.validateCollectionName(collectionName);
    if (!VALID_COLLECTION_RE.test(fieldPath)) {
      throw new BadRequestException(`Invalid field path: "${fieldPath}"`);
    }

    const { pool } = await this.getProjectPool(projectId, userId);
    const client = await pool.connect();

    try {
      const qualified = this.qualifiedName(collectionName);
      const indexName = `idx_${collectionName}_${fieldPath.replace(/\./g, '_')}`;

      await client.query(
        `CREATE INDEX IF NOT EXISTS "${indexName}" ON ${qualified} ((data->>'${fieldPath}'))`,
      );

      return { message: `Index created on "${collectionName}.${fieldPath}"` };
    } catch (err: any) {
      throw new BadRequestException(
        `Failed to create index: ${err.message}`,
      );
    } finally {
      client.release();
      await pool.end();
    }
  }
}
