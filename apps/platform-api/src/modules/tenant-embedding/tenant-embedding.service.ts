import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  BadGatewayException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as crypto from 'crypto';
import OpenAI from 'openai';
import { PrismaService } from '../../prisma/prisma.service';

/** Inputs per OpenAI embeddings request (the API allows 2048; keep bodies small). */
const EMBED_BATCH = 100;
const MAX_SEARCH_LIMIT = 100;

/** Serialize a JS number[] to the `[x,y,...]` literal PostgreSQL vector cast expects. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

export interface TenantEmbeddingRecord {
  id: string;
  contentHash: string;
  namespace: string;
  content: string;
  metadata: Record<string, unknown> | null;
  tokenCount: number | null;
  createdAt: string;
}

export interface TenantSimilarityResult {
  id: string;
  namespace: string;
  content: string;
  metadata: Record<string, unknown> | null;
  distance: number;
  score: number;
}

export interface StoreEmbeddingDto {
  content: string;
  namespace?: string;
  metadata?: Record<string, unknown>;
}

export interface SearchEmbeddingDto {
  query: string;
  namespace?: string;
  threshold?: number;
  limit?: number;
  filter?: Record<string, unknown>;
}

@Injectable()
export class TenantEmbeddingService {
  private readonly logger = new Logger(TenantEmbeddingService.name);
  private bootstrapSqlCache: string | null = null;
  private readonly globalOpenaiKey: string;
  private readonly embeddingModel: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.globalOpenaiKey = config.get<string>('openai.apiKey') || '';
    this.embeddingModel =
      config.get<string>('embedding.model') || 'text-embedding-3-small';
  }

  /* ──────────────── pgvector enable / disable ──────────────── */

  /**
   * Enable pgvector on a project's database: runs the bootstrap SQL that
   * creates the vector extension, embedding tables, indexes, and grants.
   *
   * CREATE EXTENSION requires superuser privileges, so we connect with the
   * platform admin credentials (same approach as RLS bootstrap).
   */
  async enablePgvector(projectId: string): Promise<void> {
    const project = await this.getProject(projectId);

    if (project.pgvectorEnabled) {
      this.logger.log(`pgvector already enabled for project ${projectId}`);
      return;
    }

    const adminPool = this.adminPoolForProjectDb(project.dbName);
    try {
      const sql = this.loadBootstrapSql();
      await adminPool.query(sql);

      await this.prisma.project.update({
        where: { id: projectId },
        data: { pgvectorEnabled: true, pgvectorEnabledAt: new Date() },
      });

      this.logger.log(`pgvector enabled for project ${projectId}`);
    } catch (err: any) {
      this.logger.error(
        `Failed to enable pgvector for project ${projectId}: ${err.message}`,
        err.stack,
      );
      throw new InternalServerErrorException(
        `Failed to enable pgvector: ${err.message}`,
      );
    } finally {
      await adminPool.end();
    }
  }

  /**
   * Mark pgvector as disabled on a project. Does NOT drop tables — data is preserved
   * in case the user re-enables later. API calls will be rejected while disabled.
   */
  async disablePgvector(projectId: string): Promise<void> {
    await this.prisma.project.update({
      where: { id: projectId },
      data: { pgvectorEnabled: false },
    });
    this.logger.log(`pgvector disabled for project ${projectId}`);
  }

  /** Set a per-project OpenAI API key (or clear it to fall back to platform key). */
  async setEmbeddingApiKey(
    projectId: string,
    apiKey: string | null,
  ): Promise<void> {
    await this.prisma.project.update({
      where: { id: projectId },
      data: { embeddingApiKey: apiKey },
    });
  }

  /* ──────────────── store embeddings ──────────────── */

  async store(
    projectId: string,
    dto: StoreEmbeddingDto,
  ): Promise<TenantEmbeddingRecord> {
    const [record] = await this.storeBatch(projectId, [dto]);
    return record;
  }

  /**
   * Store many chunks over one connection pool. Existing (content, namespace)
   * pairs are returned as-is; the rest are embedded EMBED_BATCH at a time and
   * written one transaction per item, so a failed vector insert can never
   * leave a metadata row behind that dedup would later return without a vector.
   * Results are in input order.
   */
  async storeBatch(
    projectId: string,
    items: StoreEmbeddingDto[],
  ): Promise<TenantEmbeddingRecord[]> {
    if (!Array.isArray(items)) {
      throw new BadRequestException('Body must be { items: [{ content, namespace?, metadata? }] }');
    }
    items.forEach((item, i) => {
      if (typeof item?.content !== 'string' || item.content.trim() === '') {
        throw new BadRequestException(`items[${i}].content must be a non-empty string`);
      }
    });
    if (items.length === 0) return [];

    const project = await this.getProjectWithEmbedding(projectId);
    const prepared = items.map((item) => {
      const namespace = item.namespace || 'default';
      return { ...item, namespace, hash: this.sha256(item.content + '::' + namespace) };
    });

    const pool = this.projectPool(project);
    try {
      const existing = await pool.query<any>(
        `SELECT e.id, e.content_hash, e.namespace, e.content, e.metadata, e.token_count, e.created_at
         FROM kb_embeddings e
         JOIN kb_embeddings_store es ON es.id = e.id
         WHERE (e.content_hash, e.namespace) IN (
           SELECT * FROM unnest($1::varchar[], $2::varchar[])
         )`,
        [prepared.map((p) => p.hash), prepared.map((p) => p.namespace)],
      );
      const byKey = new Map<string, TenantEmbeddingRecord>(
        existing.rows.map((r) => [`${r.content_hash}::${r.namespace}`, this.mapRow(r)]),
      );

      // Same text twice in one request: embed it once.
      const missing = [
        ...new Map(
          prepared
            .filter((p) => !byKey.has(`${p.hash}::${p.namespace}`))
            .map((p) => [`${p.hash}::${p.namespace}`, p]),
        ).values(),
      ];

      const openai = this.getOpenAI(project.embeddingApiKey);
      for (let i = 0; i < missing.length; i += EMBED_BATCH) {
        const slice = missing.slice(i, i + EMBED_BATCH);
        const embeddings = await this.generateEmbeddings(
          openai,
          slice.map((p) => p.content),
        );

        for (let j = 0; j < slice.length; j++) {
          const item = slice[j];
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            // A metadata row without a vector (left by an older, non-transactional
            // write) is replaced rather than returned as a hit.
            const insert = await client.query<any>(
              `INSERT INTO kb_embeddings (content_hash, namespace, content, metadata, token_count)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (content_hash, namespace) DO UPDATE
                 SET content = EXCLUDED.content,
                     metadata = EXCLUDED.metadata,
                     token_count = EXCLUDED.token_count,
                     updated_at = NOW()
               RETURNING id, content_hash, namespace, content, metadata, token_count, created_at`,
              [
                item.hash,
                item.namespace,
                item.content,
                item.metadata ? JSON.stringify(item.metadata) : null,
                embeddings[j].tokenCount,
              ],
            );
            const record = insert.rows[0];
            await client.query(
              `INSERT INTO kb_embeddings_store (id, embedding)
               VALUES ($1, $2::vector)
               ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding`,
              [record.id, toVectorLiteral(embeddings[j].vector)],
            );
            await client.query('COMMIT');
            byKey.set(`${item.hash}::${item.namespace}`, this.mapRow(record));
          } catch (err) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw err;
          } finally {
            client.release();
          }
        }
      }

      return prepared.map((p) => byKey.get(`${p.hash}::${p.namespace}`)!);
    } finally {
      await pool.end();
    }
  }

  /* ──────────────── search embeddings ──────────────── */

  async search(
    projectId: string,
    dto: SearchEmbeddingDto,
  ): Promise<TenantSimilarityResult[]> {
    const { query, namespace, threshold = 0.5, filter } = dto;
    if (typeof query !== 'string' || query.trim() === '') {
      throw new BadRequestException('query must be a non-empty string');
    }
    const limit = Math.min(Math.max(Math.trunc(Number(dto.limit ?? 10)) || 10, 1), MAX_SEARCH_LIMIT);

    const project = await this.getProjectWithEmbedding(projectId);
    const openai = this.getOpenAI(project.embeddingApiKey);
    const [embedding] = await this.generateEmbeddings(openai, [query]);

    const pool = this.projectPool(project);
    try {
      const conditions: string[] = [
        `(es.embedding <=> $1::vector) < $2`,
      ];
      const params: unknown[] = [toVectorLiteral(embedding.vector), threshold];

      if (namespace) {
        params.push(namespace);
        conditions.push(`e.namespace = $${params.length}`);
      }

      if (filter) {
        for (const [key, value] of Object.entries(filter)) {
          params.push(JSON.stringify(value));
          conditions.push(
            `e.metadata @> jsonb_build_object($${params.length}::text, $${params.length}::jsonb)`,
          );
        }
      }

      params.push(limit);
      const limitPlaceholder = `$${params.length}`;

      const sql = `
        SELECT
          e.id,
          e.namespace,
          e.content,
          e.metadata,
          (es.embedding <=> $1::vector) AS distance
        FROM kb_embeddings_store es
        JOIN kb_embeddings e ON e.id = es.id
        WHERE ${conditions.join(' AND ')}
        ORDER BY es.embedding <=> $1::vector
        LIMIT ${limitPlaceholder}
      `;

      const result = await pool.query<{
        id: string;
        namespace: string;
        content: string;
        metadata: Record<string, unknown> | null;
        distance: number;
      }>(sql, params);

      return result.rows.map((r) => ({
        id: r.id,
        namespace: r.namespace,
        content: r.content,
        metadata: r.metadata,
        distance: Number(r.distance),
        score: 1 - Number(r.distance),
      }));
    } finally {
      await pool.end();
    }
  }

  /* ──────────────── delete embeddings ──────────────── */

  async deleteByIds(projectId: string, ids: string[]): Promise<number> {
    const project = await this.getProjectWithEmbedding(projectId);
    const pool = this.projectPool(project);
    try {
      const result = await pool.query(
        `DELETE FROM kb_embeddings WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      return result.rowCount ?? 0;
    } finally {
      await pool.end();
    }
  }

  async deleteByNamespace(
    projectId: string,
    namespace: string,
  ): Promise<number> {
    const project = await this.getProjectWithEmbedding(projectId);
    const pool = this.projectPool(project);
    try {
      const result = await pool.query(
        `DELETE FROM kb_embeddings WHERE namespace = $1`,
        [namespace],
      );
      return result.rowCount ?? 0;
    } finally {
      await pool.end();
    }
  }

  /* ──────────────── status / info ──────────────── */

  async getStatus(projectId: string): Promise<{
    pgvectorEnabled: boolean;
    pgvectorEnabledAt: Date | null;
    hasApiKey: boolean;
    embeddingCount: number | null;
  }> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
      select: {
        pgvectorEnabled: true,
        pgvectorEnabledAt: true,
        embeddingApiKey: true,
        dbHost: true,
        dbPort: true,
        dbUser: true,
        dbPassword: true,
        dbName: true,
      },
    });
    if (!project) throw new NotFoundException('Project not found');

    let embeddingCount: number | null = null;
    if (project.pgvectorEnabled) {
      const pool = this.projectPool(project);
      try {
        const result = await pool.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM kb_embeddings`,
        );
        embeddingCount = parseInt(result.rows[0].count, 10);
      } catch {
        // Tables might not exist yet if pgvector was marked but bootstrap failed
        embeddingCount = null;
      } finally {
        await pool.end();
      }
    }

    return {
      pgvectorEnabled: project.pgvectorEnabled,
      pgvectorEnabledAt: project.pgvectorEnabledAt,
      hasApiKey: !!(project.embeddingApiKey || this.globalOpenaiKey),
      embeddingCount,
    };
  }

  /* ──────────────── private helpers ──────────────── */

  private async getProject(projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
      select: {
        id: true,
        dbHost: true,
        dbPort: true,
        dbUser: true,
        dbPassword: true,
        dbName: true,
        pgvectorEnabled: true,
        embeddingApiKey: true,
        teamId: true,
      },
    });
    if (!project) throw new NotFoundException('Project not found');
    return project;
  }

  private async getProjectWithEmbedding(projectId: string) {
    const project = await this.getProject(projectId);
    if (!project.pgvectorEnabled) {
      throw new BadRequestException(
        'pgvector is not enabled for this project. Enable it first via the admin API.',
      );
    }
    const apiKey = project.embeddingApiKey || this.globalOpenaiKey;
    if (!apiKey) {
      throw new BadRequestException(
        'No OpenAI API key configured. Set a per-project key or the platform OPENAI_API_KEY.',
      );
    }
    return project;
  }

  /**
   * Connect to a project's database as the platform admin (superuser).
   * Required for CREATE EXTENSION and GRANTing to RLS roles.
   */
  private adminPoolForProjectDb(dbName: string): Pool {
    return new Pool({
      host: this.config.get<string>('database.host'),
      port: this.config.get<number>('database.port'),
      user: this.config.get<string>('database.user'),
      password: this.config.get<string>('database.password'),
      database: dbName,
      statement_timeout: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }

  private projectPool(project: {
    dbHost: string;
    dbPort: number;
    dbUser: string;
    dbPassword: string;
    dbName: string;
  }): Pool {
    return new Pool({
      host: project.dbHost,
      port: project.dbPort,
      user: project.dbUser,
      password: project.dbPassword,
      database: project.dbName,
      statement_timeout: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }

  private getOpenAI(projectApiKey: string | null): OpenAI {
    const apiKey = projectApiKey || this.globalOpenaiKey;
    if (!apiKey) {
      throw new BadRequestException('No OpenAI API key available');
    }
    return new OpenAI({ apiKey });
  }

  /**
   * Embed several texts in one request. Provider failures are mapped to
   * HTTP errors that say what went wrong — unmapped, an OpenAI 401 or quota
   * error surfaced to callers as a bare 500 "Internal server error".
   */
  private async generateEmbeddings(
    openai: OpenAI,
    texts: string[],
  ): Promise<Array<{ vector: number[]; tokenCount: number }>> {
    let response: OpenAI.Embeddings.CreateEmbeddingResponse;
    try {
      response = await openai.embeddings.create({
        model: this.embeddingModel,
        input: texts.map((t) => t.slice(0, 8000)),
      });
    } catch (err) {
      throw this.providerError(err);
    }

    // Token usage is reported per request; attribute it evenly.
    const perItem = Math.round((response.usage?.total_tokens ?? 0) / texts.length);
    return [...response.data]
      .sort((a, b) => a.index - b.index)
      .map((d) => ({ vector: d.embedding, tokenCount: perItem }));
  }

  private providerError(err: unknown): HttpException {
    const status = err instanceof OpenAI.APIError ? err.status : undefined;
    const detail = err instanceof Error ? err.message : String(err);
    this.logger.error(`Embedding provider error (status ${status ?? 'n/a'}): ${detail}`);

    if (status === 401 || status === 403) {
      return new BadGatewayException(
        'Embedding provider rejected the API key. Check the project or platform OpenAI key.',
      );
    }
    if (status === 429) {
      return new HttpException(
        'Embedding provider rate limit or quota exceeded. Retry later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (status === 400) {
      return new BadRequestException(`Embedding provider rejected the input: ${detail}`);
    }
    return new BadGatewayException(
      status
        ? `Embedding provider error (HTTP ${status}).`
        : 'Could not reach the embedding provider.',
    );
  }

  private sha256(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex');
  }

  private loadBootstrapSql(): string {
    if (this.bootstrapSqlCache) return this.bootstrapSqlCache;
    const candidate = join(__dirname, 'sql', 'tenant-pgvector-bootstrap.sql');
    const sql = readFileSync(candidate, 'utf8');
    this.bootstrapSqlCache = sql;
    return sql;
  }

  private mapRow(row: any): TenantEmbeddingRecord {
    return {
      id: row.id,
      contentHash: row.content_hash,
      namespace: row.namespace,
      content: row.content,
      metadata: row.metadata,
      tokenCount: row.token_count,
      createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    };
  }
}
