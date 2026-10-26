import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { VectorStoreService } from './vector-store.service';
import { EMBEDDING_QUEUE } from '../queue/queue.module';
import {
  EmbeddingProviderService,
  type EmbedOutcome,
  type ResolvedProvider,
} from './providers/embedding-provider.service';
import { PROVIDER_CATALOGUE } from './providers/provider-registry';
import { EmbeddingProviderError, type EmbedIntent } from './providers/embedding-provider';
import type { EmbedJob, EmbeddingJobPayload, EntityType } from './types';

const CACHE_TTL_SECONDS = 86_400; // 24 hours
/**
 * v2 keys carry provider/model and intent, so changing the model can never
 * serve a vector from another model's space out of the cache.
 */
const CACHE_KEY_PREFIX = 'emb:v2:';
/** Width of `embeddings_store.embedding` as the migration created it; re-read from the catalog on first use. */
const DEFAULT_STORE_DIMENSIONS = 1536;

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly resolved: ResolvedProvider | null;
  private readonly enabled: boolean;
  private readonly maxDailyTokens: number;
  private storeDimensionsCache: number | null = null;
  private misconfigurationLogged = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly vectorStore: VectorStoreService,
    @InjectQueue(EMBEDDING_QUEUE) private readonly queue: Queue,
    private readonly providers: EmbeddingProviderService,
  ) {
    this.enabled = config.get<boolean>('embedding.enabled') ?? true;
    this.maxDailyTokens = config.get<number>('embedding.maxDailyTokens') ?? 1_000_000;

    this.resolved = this.enabled ? providers.platform() : null;
    if (this.enabled && !this.resolved) {
      const desc = providers.describePlatform();
      const entry = PROVIDER_CATALOGUE[desc.config.provider];
      this.logger.warn(
        `${entry.keyEnvVar ?? entry.name} not set — embedding features disabled`,
      );
    }
  }

  /** `embedding_records.embedding_model` value for the configured provider. */
  private get tag(): string {
    return this.resolved?.tag ?? this.providers.describePlatform().tag;
  }

  /**
   * Embed a single piece of content. Returns the embedding_records.id.
   * Uses SHA-256 dedup: if the same content was embedded before *with the
   * current model*, returns the cached record id without calling the provider.
   * A record left by another model is re-embedded and overwritten in place.
   */
  async embedContent(
    content: string,
    entityType: EntityType,
    entityId: string,
    opts?: {
      projectId?: string;
      teamId?: string;
      extraMeta?: Record<string, unknown>;
      force?: boolean;
    },
  ): Promise<string | null> {
    if (!this.enabled || !this.resolved) return null;

    const hash = this.sha256(content);

    if (!opts?.force) {
      const existing = await this.prisma.embeddingRecord.findUnique({
        where: { contentHash: hash },
        select: { id: true, embeddingModel: true },
      });
      if (existing && existing.embeddingModel === this.tag) return existing.id;
    }

    const embedded = await this.embedOne(content, 'document');
    if (!embedded) return null;

    return this.persistEmbedding(
      hash,
      embedded.vector,
      embedded.tag,
      content,
      entityType,
      entityId,
      opts,
    );
  }

  /**
   * Embed a batch of jobs. Returns a map of entityId → embeddingRecordId.
   * Deduplication happens per-item before calling the provider; only records
   * made with the current model count as hits.
   */
  async embedBatch(
    jobs: EmbedJob[],
    batchSize = 20,
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    if (!this.enabled || !this.resolved || jobs.length === 0) return results;

    // Check dedup for all items first
    const hashes = jobs.map((j) => this.sha256(j.content));
    const existing = await this.prisma.embeddingRecord.findMany({
      where: { contentHash: { in: hashes } },
      select: { id: true, contentHash: true, entityId: true, embeddingModel: true },
    });
    const existingByHash = new Map(
      existing.filter((r) => r.embeddingModel === this.tag).map((r) => [r.contentHash, r]),
    );

    const toEmbed: Array<{ job: EmbedJob; hash: string; idx: number }> = [];
    jobs.forEach((job, idx) => {
      const hash = hashes[idx];
      const cached = existingByHash.get(hash);
      if (cached) {
        results.set(job.entityId, cached.id);
      } else {
        toEmbed.push({ job, hash, idx });
      }
    });

    // Process in batches
    for (let i = 0; i < toEmbed.length; i += batchSize) {
      const chunk = toEmbed.slice(i, i + batchSize);
      const texts = chunk.map((c) => c.job.content);

      const embedded = await this.generateEmbeddingBatch(texts);
      if (!embedded) continue;

      for (let j = 0; j < chunk.length; j++) {
        const { job, hash } = chunk[j];
        const id = await this.persistEmbedding(
          hash,
          embedded.vectors[j],
          embedded.tag,
          job.content,
          job.entityType,
          job.entityId,
          { projectId: job.projectId, teamId: job.teamId, extraMeta: job.extraMeta },
        );
        if (id) results.set(job.entityId, id);
      }
    }

    return results;
  }

  /**
   * Enqueue an embedding job for async background processing.
   * Fire-and-forget — never throws.
   */
  enqueueJob(jobs: EmbedJob[], priority = 10, delayMs = 0): void {
    const payload: EmbeddingJobPayload = { jobs };
    this.queue
      // Finished jobs are trimmed: without this every executed statement left
      // a completed job behind in Redis for the life of the instance.
      .add('embed', payload, {
        priority,
        delay: delayMs,
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86_400 },
      })
      .catch((err) =>
        this.logger.warn('Failed to enqueue embedding job', err?.message),
      );
  }

  /**
   * Generate a single embedding vector. Returns null on failure.
   * Checks Redis cache first (key: emb:v2:{provider/model}/{intent}:{sha256}).
   * Callers embedding a search query keep the default intent; stored content
   * passes 'document' (some providers embed the two differently).
   */
  async generateEmbedding(text: string, intent: EmbedIntent = 'query'): Promise<number[] | null> {
    const out = await this.embedOne(text, intent);
    return out?.vector ?? null;
  }

  private async embedOne(
    text: string,
    intent: EmbedIntent,
  ): Promise<{ vector: number[]; tag: string } | null> {
    if (!this.resolved) return null;

    const hash = this.sha256(text);
    const cacheKey = this.cacheKey(hash, intent);

    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) return { vector: JSON.parse(cached) as number[], tag: this.tag };
    } catch {
      // Redis miss or error — proceed to the provider
    }

    if (!(await this.checkTokenBudget())) {
      this.logger.warn('Daily token budget exceeded — skipping embedding');
      return null;
    }

    const out = await this.embedTexts([text], intent);
    if (!out) return null;
    const vector = out.vectors[0];

    // A fallback's vectors live in another space; never let them answer for the primary.
    if (!out.usedFallback) {
      try {
        await this.redis.set(cacheKey, JSON.stringify(vector), CACHE_TTL_SECONDS);
      } catch {
        // Cache write failure is non-fatal
      }
    }

    return { vector, tag: out.tag };
  }

  private async generateEmbeddingBatch(
    texts: string[],
  ): Promise<{ vectors: number[][]; tag: string } | null> {
    if (!this.resolved || texts.length === 0) return null;

    if (!(await this.checkTokenBudget())) {
      this.logger.warn('Daily token budget exceeded — skipping batch embedding');
      return null;
    }

    const out = await this.embedTexts(texts, 'document');
    if (!out) return null;

    if (!out.usedFallback) {
      // Cache each embedding individually
      await Promise.allSettled(
        texts.map((text, i) =>
          this.redis
            .set(
              this.cacheKey(this.sha256(text), 'document'),
              JSON.stringify(out.vectors[i]),
              CACHE_TTL_SECONDS,
            )
            .catch(() => {}),
        ),
      );
    }

    return { vectors: out.vectors, tag: out.tag };
  }

  /**
   * One provider round-trip with failover and width fitting. Returns null on
   * any failure — every caller treats a missing vector as "degrade quietly".
   */
  private async embedTexts(texts: string[], intent: EmbedIntent): Promise<EmbedOutcome | null> {
    if (!this.resolved) return null;
    try {
      const out = await this.providers.embed(this.resolved, texts, {
        intent,
        targetDimensions: await this.storeDimensions(),
      });
      const tokens =
        out.tokenCount ?? Math.ceil(texts.reduce((n, t) => n + t.length, 0) / 4);
      await this.trackTokenUsage(tokens);
      return out;
    } catch (err: any) {
      const misconfigured =
        err instanceof EmbeddingProviderError &&
        err.kind === 'input' &&
        /vector store holds/.test(err.message);
      if (misconfigured) {
        if (!this.misconfigurationLogged) {
          this.misconfigurationLogged = true;
          this.logger.error(`Embedding provider misconfigured: ${err.message} Embeddings are disabled until this is fixed.`);
        }
      } else {
        this.logger.error(`Embedding error (${this.tag})`, err?.message);
      }
      return null;
    }
  }

  /** Width of the platform vector column, read once from the catalog. */
  private async storeDimensions(): Promise<number> {
    if (this.storeDimensionsCache) return this.storeDimensionsCache;
    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ type: string }>>(
        `SELECT format_type(atttypid, atttypmod) AS type
           FROM pg_attribute
          WHERE attrelid = 'embeddings_store'::regclass AND attname = 'embedding'`,
      );
      const match = /vector\((\d+)\)/.exec(rows[0]?.type ?? '');
      this.storeDimensionsCache = match ? Number(match[1]) : DEFAULT_STORE_DIMENSIONS;
    } catch (err: any) {
      this.logger.warn(
        `Could not read embeddings_store dimensions (${err?.message ?? err}); assuming ${DEFAULT_STORE_DIMENSIONS}`,
      );
      this.storeDimensionsCache = DEFAULT_STORE_DIMENSIONS;
    }
    return this.storeDimensionsCache;
  }

  private cacheKey(hash: string, intent: EmbedIntent): string {
    return `${CACHE_KEY_PREFIX}${this.tag}/${intent}:${hash}`;
  }

  private async persistEmbedding(
    hash: string,
    embedding: number[],
    tag: string,
    content: string,
    entityType: EntityType,
    entityId: string,
    opts?: {
      projectId?: string;
      teamId?: string;
      extraMeta?: Record<string, unknown>;
    },
  ): Promise<string | null> {
    try {
      // Upsert the metadata record
      const record = await this.prisma.embeddingRecord.upsert({
        where: { contentHash: hash },
        create: {
          contentHash: hash,
          entityType,
          entityId,
          projectId: opts?.projectId ?? null,
          teamId: opts?.teamId ?? null,
          embeddingModel: tag,
          tokenCount: Math.ceil(content.length / 4), // rough estimate
          metadata: {
            text: content.slice(0, 2000),
            ...(opts?.extraMeta ?? {}),
          },
        },
        update: {
          entityType,
          entityId,
          projectId: opts?.projectId ?? null,
          teamId: opts?.teamId ?? null,
          embeddingModel: tag,
          metadata: {
            text: content.slice(0, 2000),
            ...(opts?.extraMeta ?? {}),
          },
          updatedAt: new Date(),
        },
        select: { id: true },
      });

      // Upsert the vector (raw SQL — Prisma can't handle vector type)
      await this.vectorStore.upsertVector(record.id, embedding);

      return record.id;
    } catch (err: any) {
      this.logger.error('Failed to persist embedding', err?.message);
      return null;
    }
  }

  private sha256(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex');
  }

  private async checkTokenBudget(): Promise<boolean> {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const key = `emb:usage:tokens:${today}`;
      const used = parseInt((await this.redis.get(key)) ?? '0', 10);
      return used < this.maxDailyTokens;
    } catch {
      return true; // On Redis error, allow the call
    }
  }

  private async trackTokenUsage(tokens: number): Promise<void> {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const key = `emb:usage:tokens:${today}`;
      await this.redis.incrby(key, tokens);
      // Keep for 48h so yesterday's budget is still visible in logs
      await this.redis.expire(key, 172_800);
    } catch {
      // Non-fatal
    }
  }
}
