import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  BadGatewayException,
  ConflictException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as crypto from 'crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TENANT_EMBEDDING_QUEUE } from '../queue/queue.module';
import {
  EmbeddingProviderService,
  type EmbedOutcome,
  type ProviderDescription,
  type ResolvedProvider,
} from '../embedding/providers/embedding-provider.service';
import {
  EMBEDDING_PROVIDER_IDS,
  EmbeddingProviderError,
  isEmbeddingProviderId,
  type EmbedIntent,
} from '../embedding/providers/embedding-provider';
import {
  PROVIDER_CATALOGUE,
  isPrivateHost,
} from '../embedding/providers/provider-registry';
import {
  buildDisclosure,
  regionFromCode,
  type DataRegion,
  type ProviderDisclosure,
} from '../embedding/providers/disclosure';
import type { SetEmbeddingProviderDto } from './dto/set-embedding-provider.dto';

/** Inputs per provider request (the APIs allow more; keep bodies small). */
const EMBED_BATCH = 100;
const MAX_SEARCH_LIMIT = 100;
/** Width of `kb_embeddings_store.embedding` as the bootstrap SQL creates it. */
const DEFAULT_STORE_DIMENSIONS = 1536;
const STORE_DIMENSIONS_TTL_MS = 10 * 60 * 1000;
/** Rows per page while re-embedding a project's store. */
const REEMBED_PAGE = 100;
/** A RUNNING state older than this belongs to a worker that died; a new run may start. */
const REEMBED_STALE_MS = 10 * 60 * 1000;
/** BullMQ job name on TENANT_EMBEDDING_QUEUE. */
export const REEMBED_JOB = 'reembed';

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

/** Progress of the last in-place re-embed, persisted on Project.embeddingReembedState. */
export interface ReembedState {
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  done: number;
  total: number;
  /** modelTag the vectors are (being) rewritten with. */
  model: string;
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface TenantEmbeddingStatus {
  pgvectorEnabled: boolean;
  pgvectorEnabledAt: Date | null;
  hasApiKey: boolean;
  embeddingCount: number | null;
  provider: string;
  providerName: string;
  model: string;
  modelTag: string;
  configSource: 'project' | 'platform';
  keySource: 'project' | 'platform' | 'none';
  requiresApiKey: boolean;
  /** The project's custom endpoint, when one is set (never carries credentials). */
  baseUrl: string | null;
  dimensions: number | null;
  storedDimensions: number | null;
  padded: boolean;
  dataRegion: DataRegion;
  reembed: ReembedState | null;
}

export interface SetProviderResult {
  provider: string;
  model: string;
  dimensions: number;
  storedDimensions: number | null;
  padded: boolean;
  reembed: { queued: boolean; total: number };
}

type ProjectRow = {
  id: string;
  dbHost: string;
  dbPort: number;
  dbUser: string;
  dbPassword: string;
  dbName: string;
  pgvectorEnabled: boolean;
  pgvectorEnabledAt: Date | null;
  embeddingApiKey: string | null;
  embeddingProvider: string | null;
  embeddingModel: string | null;
  embeddingBaseUrl: string | null;
  embeddingReembedState: unknown;
  teamId: string;
};

@Injectable()
export class TenantEmbeddingService {
  private readonly logger = new Logger(TenantEmbeddingService.name);
  private bootstrapSqlCache: string | null = null;
  private readonly storeDimensionsCache = new Map<string, { dims: number; at: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly providers: EmbeddingProviderService,
    @InjectQueue(TENANT_EMBEDDING_QUEUE) private readonly queue: Queue,
  ) {}

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

  /** Set a per-project provider API key (or clear it to fall back to the platform key). */
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

    const { project, resolved } = await this.getProjectWithEmbedding(projectId);
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

      const targetDimensions =
        missing.length > 0 ? await this.storeDimensions(project, pool) : null;
      for (let i = 0; i < missing.length; i += EMBED_BATCH) {
        const slice = missing.slice(i, i + EMBED_BATCH);
        const embeddings = await this.generateEmbeddings(
          resolved,
          slice.map((p) => p.content),
          'document',
          targetDimensions,
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

    const { project, resolved } = await this.getProjectWithEmbedding(projectId);

    const pool = this.projectPool(project);
    try {
      const targetDimensions = await this.storeDimensions(project, pool);
      const [embedding] = await this.generateEmbeddings(resolved, [query], 'query', targetDimensions);

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
    const { project } = await this.getProjectWithEmbedding(projectId);
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
    const { project } = await this.getProjectWithEmbedding(projectId);
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

  async getStatus(projectId: string): Promise<TenantEmbeddingStatus> {
    const project = await this.getProject(projectId);

    let embeddingCount: number | null = null;
    let storedDimensions: number | null = null;
    if (project.pgvectorEnabled) {
      const pool = this.projectPool(project);
      try {
        const result = await pool.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM kb_embeddings`,
        );
        embeddingCount = parseInt(result.rows[0].count, 10);
        storedDimensions = await this.storeDimensions(project, pool);
      } catch {
        // Tables might not exist yet if pgvector was marked but bootstrap failed
        embeddingCount = null;
      } finally {
        await pool.end();
      }
    }

    const measured = await this.describeAndMeasure(project, storedDimensions);
    const disclosure = this.disclosureFor(project, measured);

    return {
      pgvectorEnabled: project.pgvectorEnabled,
      pgvectorEnabledAt: project.pgvectorEnabledAt,
      hasApiKey: measured.hasApiKey,
      embeddingCount,
      provider: measured.desc.config.provider,
      providerName: measured.entry.name,
      model: disclosure.provider.model,
      modelTag: measured.desc.tag,
      configSource: measured.desc.source,
      keySource: measured.desc.keySource,
      requiresApiKey: measured.entry.requiresApiKey,
      baseUrl: project.embeddingProvider ? project.embeddingBaseUrl : null,
      dimensions: measured.dimensions,
      storedDimensions,
      padded: disclosure.provider.padded,
      dataRegion: disclosure.dataRegion,
      reembed: this.reembedState(project),
    };
  }

  /**
   * Which provider, model and country this project's text goes to, with the
   * retention statement for that provider. Safe for anon-key callers: it
   * carries no key and no URL beyond the endpoint host.
   */
  async getDisclosure(projectId: string): Promise<ProviderDisclosure> {
    const project = await this.getProject(projectId);
    const storedDimensions = project.pgvectorEnabled
      ? await this.storeDimensions(project).catch(() => null)
      : null;
    const measured = await this.describeAndMeasure(project, storedDimensions);
    return this.disclosureFor(project, measured);
  }

  /** Providers the dashboard can offer, with which platform keys exist (never the keys). */
  getProviderCatalogue() {
    const settings = this.providers.settings();
    const hostRegion = regionFromCode(settings.hostRegion);
    return {
      platformProvider: settings.primary.provider,
      platformModel:
        settings.primary.model || PROVIDER_CATALOGUE[settings.primary.provider].defaultModel,
      hostRegion,
      allowPrivateBaseUrl: settings.allowPrivateBaseUrl,
      reembedMaxRows: settings.reembedMaxRows,
      providers: EMBEDDING_PROVIDER_IDS.map((id) => {
        const entry = PROVIDER_CATALOGUE[id];
        return {
          id,
          name: entry.name,
          defaultModel: entry.defaultModel,
          requiresApiKey: entry.requiresApiKey,
          keyEnvVar: entry.keyEnvVar,
          supportsBaseUrl: entry.supportsBaseUrl,
          platformKeyAvailable: !!settings.keys[id],
          selfHosted: entry.disclosure.selfHosted,
          dataRegion: entry.disclosure.selfHosted ? hostRegion : entry.disclosure.dataRegion,
        };
      }),
    };
  }

  /* ──────────────── provider selection ──────────────── */

  /**
   * Switch the project's embedding provider / model / endpoint.
   *
   * The candidate is probed first (one tiny request proves the key, the host
   * and the model and tells us the vector width). Then the dimension rules:
   * wider than the store → refused; narrower → stored zero-padded; a model
   * change while vectors exist → refused unless the caller confirms the
   * in-place re-embed (`reembed: true`), which is queued after the switch.
   */
  async setProvider(projectId: string, dto: SetEmbeddingProviderDto): Promise<SetProviderResult> {
    const project = await this.getProject(projectId);
    const settings = this.providers.settings();

    const providerId = dto.provider ?? null;
    if (providerId !== null && !isEmbeddingProviderId(providerId)) {
      throw new BadRequestException(
        `provider must be one of ${EMBEDDING_PROVIDER_IDS.join(', ')} or null`,
      );
    }
    const model = dto.model?.trim() || null;
    if (model && !/^[\w.:@/-]{1,120}$/.test(model)) {
      throw new BadRequestException('model may only contain letters, digits, ".", ":", "@", "/", "-" and "_"');
    }
    const baseUrl = dto.baseUrl?.trim() || null;
    if (baseUrl) this.validateProjectBaseUrl(baseUrl, settings.allowPrivateBaseUrl);
    if (providerId === null && (model || baseUrl)) {
      throw new BadRequestException('model and baseUrl need a provider; omit them to use the platform default');
    }

    const candidateFields = {
      ...project,
      embeddingProvider: providerId,
      embeddingModel: providerId ? model : null,
      embeddingBaseUrl: providerId ? baseUrl : null,
    };
    const candidate = this.providers.forProject(candidateFields);
    let probed: { dimensions: number; model: string };
    try {
      probed = await this.providers.probe(candidate);
    } catch (err) {
      if (err instanceof EmbeddingProviderError) {
        throw new BadRequestException(
          `${PROVIDER_CATALOGUE[err.provider].name} did not accept this configuration: ${err.message}`,
        );
      }
      throw err;
    }

    let storedDimensions: number | null = null;
    let existingVectors = 0;
    let estimatedTokens = 0;
    if (project.pgvectorEnabled) {
      const pool = this.projectPool(project);
      try {
        storedDimensions = await this.storeDimensions(project, pool);
        const counts = await pool.query<{ n: string; tokens: string }>(
          `SELECT (SELECT COUNT(*) FROM kb_embeddings_store) AS n,
                  (SELECT COALESCE(SUM(token_count), 0) FROM kb_embeddings) AS tokens`,
        );
        existingVectors = parseInt(counts.rows[0]?.n ?? '0', 10) || 0;
        estimatedTokens = parseInt(counts.rows[0]?.tokens ?? '0', 10) || 0;
      } catch {
        // Store not provisioned yet — nothing to protect.
      } finally {
        await pool.end();
      }
    }

    if (storedDimensions && probed.dimensions > storedDimensions) {
      throw new ConflictException({
        code: 'EMBEDDING_DIMENSION_TOO_LARGE',
        message: `${candidate.tag} produces ${probed.dimensions}-dimensional vectors but this project's vector store holds ${storedDimensions}. Choose a model with at most ${storedDimensions} dimensions.`,
      });
    }

    const currentTag = this.providers.describeProject(project).tag;
    const modelChanges = currentTag !== candidate.tag;
    const needsReembed = project.pgvectorEnabled && existingVectors > 0 && modelChanges;
    if (needsReembed && !dto.reembed) {
      throw new ConflictException({
        code: 'EMBEDDING_MODEL_CHANGE_REQUIRES_REEMBED',
        message: `This project holds ${existingVectors.toLocaleString('en-US')} vector(s) made with ${currentTag}. Switching to ${candidate.tag} re-embeds all of them (about ${estimatedTokens.toLocaleString('en-US')} tokens) and search relevance is reduced until that finishes. Confirm the re-embed, or delete the existing embeddings first.`,
      });
    }
    if (needsReembed && existingVectors > settings.reembedMaxRows) {
      throw new ConflictException({
        code: 'EMBEDDING_REEMBED_TOO_LARGE',
        message: `This project holds ${existingVectors.toLocaleString('en-US')} vectors, above the re-embed limit of ${settings.reembedMaxRows.toLocaleString('en-US')} (EMBEDDING_REEMBED_MAX_ROWS). Delete embeddings by namespace first, or raise the limit on the server.`,
      });
    }

    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        embeddingProvider: candidateFields.embeddingProvider,
        embeddingModel: candidateFields.embeddingModel,
        embeddingBaseUrl: candidateFields.embeddingBaseUrl,
      },
    });
    this.logger.log(
      `Project ${projectId} embedding provider set to ${candidate.tag}` +
        (needsReembed ? ` (re-embedding ${existingVectors} vectors)` : ''),
    );

    const reembed = needsReembed
      ? await this.startReembed(projectId)
      : { queued: false, total: existingVectors };

    return {
      provider: candidate.config.provider,
      model: candidate.provider.model,
      dimensions: probed.dimensions,
      storedDimensions,
      padded: storedDimensions != null && probed.dimensions < storedDimensions,
      reembed,
    };
  }

  /* ──────────────── re-embed ──────────────── */

  /** Queue an in-place re-embed of every vector in the project's store. */
  async startReembed(projectId: string): Promise<{ queued: boolean; total: number }> {
    const { project, resolved } = await this.getProjectWithEmbedding(projectId);
    const state = this.reembedState(project);
    if (
      state &&
      (state.status === 'RUNNING' || state.status === 'QUEUED') &&
      Date.now() - Date.parse(state.updatedAt) < REEMBED_STALE_MS
    ) {
      throw new ConflictException({
        code: 'EMBEDDING_REEMBED_RUNNING',
        message: `A re-embed is already in progress (${state.done}/${state.total}).`,
      });
    }

    const pool = this.projectPool(project);
    let total = 0;
    try {
      total = await this.countVectors(pool);
    } finally {
      await pool.end();
    }

    const max = this.providers.settings().reembedMaxRows;
    if (total > max) {
      throw new ConflictException({
        code: 'EMBEDDING_REEMBED_TOO_LARGE',
        message: `This project holds ${total.toLocaleString('en-US')} vectors, above the re-embed limit of ${max.toLocaleString('en-US')} (EMBEDDING_REEMBED_MAX_ROWS). Delete embeddings by namespace first, or raise the limit on the server.`,
      });
    }

    const now = new Date().toISOString();
    if (total === 0) {
      await this.writeReembedState(projectId, {
        status: 'COMPLETED',
        done: 0,
        total: 0,
        model: resolved.tag,
        startedAt: now,
        updatedAt: now,
        finishedAt: now,
      });
      return { queued: false, total: 0 };
    }

    await this.writeReembedState(projectId, {
      status: 'QUEUED',
      done: 0,
      total,
      model: resolved.tag,
      updatedAt: now,
    });
    try {
      await this.queue.add(
        REEMBED_JOB,
        { projectId },
        {
          jobId: `reembed-${projectId}`,
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    } catch (err: any) {
      await this.writeReembedState(projectId, {
        status: 'FAILED',
        done: 0,
        total,
        model: resolved.tag,
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        error: `Could not queue the re-embed job: ${err?.message ?? err}`,
      });
      throw new InternalServerErrorException('Could not queue the re-embed job. Try again later.');
    }
    return { queued: true, total };
  }

  /**
   * Worker body: rewrite every vector in `kb_embeddings_store` with the
   * project's current provider, page by page, recording progress on the
   * project. Never throws — the outcome lands in the persisted state so a
   * costly job is never retried blindly.
   */
  async reembedProject(projectId: string): Promise<ReembedState> {
    let project: ProjectRow;
    let resolved: ResolvedProvider;
    try {
      ({ project, resolved } = await this.getProjectWithEmbedding(projectId));
    } catch (err: any) {
      const message = err?.message ?? String(err);
      this.logger.error(`Re-embed for project ${projectId} could not start: ${message}`);
      const now = new Date().toISOString();
      return this.writeReembedState(projectId, {
        status: 'FAILED',
        done: 0,
        total: 0,
        model: '',
        updatedAt: now,
        finishedAt: now,
        error: message,
      }).catch(() => ({
        status: 'FAILED' as const,
        done: 0,
        total: 0,
        model: '',
        updatedAt: now,
        finishedAt: now,
        error: message,
      }));
    }

    const startedAt = new Date().toISOString();
    const pool = this.projectPool(project);
    let done = 0;
    let total = 0;
    try {
      const targetDimensions = await this.storeDimensions(project, pool);
      total = await this.countVectors(pool);
      await this.writeReembedState(projectId, {
        status: 'RUNNING',
        done,
        total,
        model: resolved.tag,
        startedAt,
        updatedAt: new Date().toISOString(),
      });

      let cursor: string | null = null;
      for (;;) {
        const page: { rows: Array<{ id: string; content: string }> } = cursor
          ? await pool.query<{ id: string; content: string }>(
              `SELECT e.id, e.content
                 FROM kb_embeddings e
                 JOIN kb_embeddings_store es ON es.id = e.id
                WHERE e.id > $1
                ORDER BY e.id
                LIMIT $2`,
              [cursor, REEMBED_PAGE],
            )
          : await pool.query<{ id: string; content: string }>(
              `SELECT e.id, e.content
                 FROM kb_embeddings e
                 JOIN kb_embeddings_store es ON es.id = e.id
                ORDER BY e.id
                LIMIT $1`,
              [REEMBED_PAGE],
            );
        if (page.rows.length === 0) break;

        const out: EmbedOutcome = await this.providers.embed(
          resolved,
          page.rows.map((r) => r.content),
          { intent: 'document', targetDimensions },
        );
        const perItem =
          out.tokenCount != null ? Math.round(out.tokenCount / page.rows.length) : null;

        for (let i = 0; i < page.rows.length; i++) {
          const row = page.rows[i];
          await pool.query(
            `UPDATE kb_embeddings_store SET embedding = $2::vector WHERE id = $1`,
            [row.id, toVectorLiteral(out.vectors[i])],
          );
          if (perItem != null) {
            await pool.query(
              `UPDATE kb_embeddings SET token_count = $2, updated_at = NOW() WHERE id = $1`,
              [row.id, perItem],
            );
          }
        }

        done += page.rows.length;
        cursor = page.rows[page.rows.length - 1].id;
        await this.writeReembedState(projectId, {
          status: 'RUNNING',
          done,
          total: Math.max(total, done),
          model: resolved.tag,
          startedAt,
          updatedAt: new Date().toISOString(),
        });
      }

      const finishedAt = new Date().toISOString();
      this.logger.log(`Re-embedded ${done} vector(s) for project ${projectId} with ${resolved.tag}`);
      return await this.writeReembedState(projectId, {
        status: 'COMPLETED',
        done,
        total: Math.max(total, done),
        model: resolved.tag,
        startedAt,
        updatedAt: finishedAt,
        finishedAt,
      });
    } catch (err: any) {
      const message = String(err?.message ?? err).slice(0, 2000);
      this.logger.error(`Re-embed failed for project ${projectId} after ${done} row(s): ${message}`);
      const finishedAt = new Date().toISOString();
      return await this.writeReembedState(projectId, {
        status: 'FAILED',
        done,
        total: Math.max(total, done),
        model: resolved.tag,
        startedAt,
        updatedAt: finishedAt,
        finishedAt,
        error: message,
      }).catch(() => ({
        status: 'FAILED' as const,
        done,
        total,
        model: resolved.tag,
        startedAt,
        updatedAt: finishedAt,
        finishedAt,
        error: message,
      }));
    } finally {
      await pool.end();
    }
  }

  /* ──────────────── private helpers ──────────────── */

  private async getProject(projectId: string): Promise<ProjectRow> {
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
        pgvectorEnabledAt: true,
        embeddingApiKey: true,
        embeddingProvider: true,
        embeddingModel: true,
        embeddingBaseUrl: true,
        embeddingReembedState: true,
        teamId: true,
      },
    });
    if (!project) throw new NotFoundException('Project not found');
    return project as ProjectRow;
  }

  /**
   * The project with pgvector enabled and a usable provider. A missing key
   * surfaces as 400 with the provider's env var named, as before.
   */
  private async getProjectWithEmbedding(
    projectId: string,
  ): Promise<{ project: ProjectRow; resolved: ResolvedProvider }> {
    const project = await this.getProject(projectId);
    if (!project.pgvectorEnabled) {
      throw new BadRequestException(
        'pgvector is not enabled for this project. Enable it first via the admin API.',
      );
    }
    const resolved = this.providers.forProject(project);
    return { project, resolved };
  }

  private async describeAndMeasure(project: ProjectRow, storedDimensions: number | null) {
    const desc: ProviderDescription = this.providers.describeProject(project);
    const entry = PROVIDER_CATALOGUE[desc.config.provider];
    const hasApiKey = desc.keySource !== 'none' || !entry.requiresApiKey;

    let dimensions: number | null = null;
    if (hasApiKey) {
      try {
        dimensions = await this.providers.dimensionsFor(this.providers.forProject(project));
      } catch {
        dimensions = null;
      }
    }
    return { desc, entry, hasApiKey, dimensions, storedDimensions };
  }

  private disclosureFor(
    project: ProjectRow,
    m: Awaited<ReturnType<TenantEmbeddingService['describeAndMeasure']>>,
  ): ProviderDisclosure {
    const settings = this.providers.settings();
    const noKey = m.entry.requiresApiKey && m.desc.keySource === 'none';
    return buildDisclosure({
      scope: 'project',
      configSource: m.desc.source,
      config: m.desc.config,
      keySource: m.desc.keySource,
      fallback: m.desc.fallback,
      dimensions: m.dimensions,
      storedDimensions: m.storedDimensions,
      hostRegion: settings.hostRegion,
      endpointIsPlatformHost: m.desc.endpointIsPlatformHost,
      status: noKey ? 'no_api_key' : 'ok',
      statusMessage: noKey
        ? `No ${m.entry.name} API key configured. Set a per-project key or the platform ${m.entry.keyEnvVar}.`
        : null,
    });
  }

  /**
   * Per-project `baseUrl`: public https only, unless the operator allows
   * private hosts (self-hosters with a LAN Ollama). Credentials in the URL are
   * refused outright — the key field is where a key belongs.
   */
  private validateProjectBaseUrl(baseUrl: string, allowPrivate: boolean): void {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new BadRequestException('baseUrl must be an absolute http(s) URL');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new BadRequestException('baseUrl must be an absolute http(s) URL');
    }
    if (url.username || url.password) {
      throw new BadRequestException('baseUrl must not carry credentials; use the API key field');
    }
    if (!allowPrivate && (url.protocol !== 'https:' || isPrivateHost(baseUrl))) {
      throw new BadRequestException(
        'Project endpoints must be public https URLs. Set EMBEDDING_ALLOW_PRIVATE_BASE_URL=true on the server to allow private or plain-http hosts.',
      );
    }
  }

  /** Width of this project's vector column (from the catalog), cached for a few minutes. */
  private async storeDimensions(project: ProjectRow, pool?: Pool): Promise<number> {
    const cached = this.storeDimensionsCache.get(project.id);
    if (cached && Date.now() - cached.at < STORE_DIMENSIONS_TTL_MS) return cached.dims;

    const ownPool = !pool;
    const p = pool ?? this.projectPool(project);
    try {
      const result = await p.query<{ type: string }>(
        `SELECT format_type(atttypid, atttypmod) AS type
           FROM pg_attribute
          WHERE attrelid = 'kb_embeddings_store'::regclass AND attname = 'embedding'`,
      );
      const match = /vector\((\d+)\)/.exec(result.rows?.[0]?.type ?? '');
      const dims = match ? Number(match[1]) : DEFAULT_STORE_DIMENSIONS;
      this.storeDimensionsCache.set(project.id, { dims, at: Date.now() });
      return dims;
    } catch {
      return DEFAULT_STORE_DIMENSIONS;
    } finally {
      if (ownPool) await p.end();
    }
  }

  private async countVectors(pool: Pool): Promise<number> {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM kb_embeddings_store`,
    );
    return parseInt(result.rows[0]?.count ?? '0', 10) || 0;
  }

  private reembedState(project: ProjectRow): ReembedState | null {
    const raw = project.embeddingReembedState;
    if (!raw || typeof raw !== 'object') return null;
    const s = raw as Partial<ReembedState>;
    if (typeof s.status !== 'string') return null;
    return s as ReembedState;
  }

  private async writeReembedState(projectId: string, state: ReembedState): Promise<ReembedState> {
    await this.prisma.project.update({
      where: { id: projectId },
      data: { embeddingReembedState: state as unknown as Prisma.InputJsonValue },
    });
    return state;
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

  /**
   * Embed several texts in one request through the project's provider.
   * Provider failures are mapped to HTTP errors that say what went wrong —
   * unmapped, a 401 or quota error would surface as a bare 500.
   */
  private async generateEmbeddings(
    resolved: ResolvedProvider,
    texts: string[],
    intent: EmbedIntent,
    targetDimensions: number | null,
  ): Promise<Array<{ vector: number[]; tokenCount: number }>> {
    let out: EmbedOutcome;
    try {
      out = await this.providers.embed(resolved, texts, { intent, targetDimensions });
    } catch (err) {
      throw this.providerError(err);
    }

    // Token usage is reported per request; attribute it evenly.
    const perItem = Math.round((out.tokenCount ?? 0) / texts.length);
    return out.vectors.map((vector) => ({ vector, tokenCount: perItem }));
  }

  private providerError(err: unknown): HttpException {
    if (err instanceof HttpException) return err;
    const pe = err instanceof EmbeddingProviderError ? err : null;
    const status = pe?.status;
    const detail = err instanceof Error ? err.message : String(err);
    const name = pe ? PROVIDER_CATALOGUE[pe.provider].name : 'the embedding provider';
    this.logger.error(`Embedding provider error (status ${status ?? 'n/a'}): ${detail}`);

    if (pe?.kind === 'auth') {
      return new BadGatewayException(
        `Embedding provider rejected the API key. Check the project or platform ${name} key.`,
      );
    }
    if (pe?.kind === 'quota') {
      return new HttpException(
        'Embedding provider rate limit or quota exceeded. Retry later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (pe?.kind === 'input') {
      return new BadRequestException(`Embedding provider rejected the input: ${detail}`);
    }
    if (pe?.kind === 'unavailable' || !status) {
      return new BadGatewayException(`Could not reach the embedding provider (${name}).`);
    }
    return new BadGatewayException(`Embedding provider error (HTTP ${status}).`);
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
