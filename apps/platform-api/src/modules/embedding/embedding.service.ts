import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as crypto from 'crypto';
import OpenAI from 'openai';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { VectorStoreService } from './vector-store.service';
import { EMBEDDING_QUEUE } from '../queue/queue.module';
import type { EmbedJob, EmbeddingJobPayload, EntityType } from './types';

const CACHE_TTL_SECONDS = 86_400; // 24 hours
const CACHE_KEY_PREFIX = 'emb:v1:';

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private openai: OpenAI | null = null;
  private readonly model: string;
  private readonly enabled: boolean;
  private readonly maxDailyTokens: number;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly vectorStore: VectorStoreService,
    @InjectQueue(EMBEDDING_QUEUE) private readonly queue: Queue,
  ) {
    const apiKey = config.get<string>('openai.apiKey');
    this.enabled = config.get<boolean>('embedding.enabled') ?? true;
    this.model = config.get<string>('embedding.model') ?? 'text-embedding-3-small';
    this.maxDailyTokens = config.get<number>('embedding.maxDailyTokens') ?? 1_000_000;

    if (apiKey) {
      this.openai = new OpenAI({ apiKey });
    } else {
      this.logger.warn('OPENAI_API_KEY not set — embedding features disabled');
    }
  }

  /**
   * Embed a single piece of content. Returns the embedding_records.id.
   * Uses SHA-256 dedup: if the same content was embedded before, returns the
   * cached record id without calling OpenAI.
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
    if (!this.enabled || !this.openai) return null;

    const hash = this.sha256(content);

    if (!opts?.force) {
      const existing = await this.prisma.embeddingRecord.findUnique({
        where: { contentHash: hash },
        select: { id: true },
      });
      if (existing) return existing.id;
    }

    const embedding = await this.generateEmbedding(content);
    if (!embedding) return null;

    return this.persistEmbedding(
      hash,
      embedding,
      content,
      entityType,
      entityId,
      opts,
    );
  }

  /**
   * Embed a batch of jobs. Returns a map of entityId → embeddingRecordId.
   * Deduplication happens per-item before calling OpenAI.
   */
  async embedBatch(
    jobs: EmbedJob[],
    batchSize = 20,
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    if (!this.enabled || !this.openai || jobs.length === 0) return results;

    // Check dedup for all items first
    const hashes = jobs.map((j) => this.sha256(j.content));
    const existing = await this.prisma.embeddingRecord.findMany({
      where: { contentHash: { in: hashes } },
      select: { id: true, contentHash: true, entityId: true },
    });
    const existingByHash = new Map(existing.map((r) => [r.contentHash, r]));

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

      const embeddings = await this.generateEmbeddingBatch(texts);
      if (!embeddings) continue;

      for (let j = 0; j < chunk.length; j++) {
        const { job, hash } = chunk[j];
        const id = await this.persistEmbedding(
          hash,
          embeddings[j],
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
      .add('embed', payload, { priority, delay: delayMs })
      .catch((err) =>
        this.logger.warn('Failed to enqueue embedding job', err?.message),
      );
  }

  /**
   * Generate a single embedding vector. Returns null on failure.
   * Checks Redis cache first (key: emb:v1:{sha256}).
   */
  async generateEmbedding(text: string): Promise<number[] | null> {
    if (!this.openai) return null;

    const hash = this.sha256(text);
    const cacheKey = `${CACHE_KEY_PREFIX}${hash}`;

    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as number[];
    } catch {
      // Redis miss or error — proceed to OpenAI
    }

    if (!(await this.checkTokenBudget())) {
      this.logger.warn('Daily token budget exceeded — skipping embedding');
      return null;
    }

    try {
      const response = await this.openai.embeddings.create({
        model: this.model,
        input: text,
      });
      const embedding = response.data[0].embedding;
      const tokens = response.usage?.total_tokens ?? 0;
      await this.trackTokenUsage(tokens);

      try {
        await this.redis.set(cacheKey, JSON.stringify(embedding), CACHE_TTL_SECONDS);
      } catch {
        // Cache write failure is non-fatal
      }

      return embedding;
    } catch (err: any) {
      this.logger.error('OpenAI embedding error', err?.message);
      return null;
    }
  }

  private async generateEmbeddingBatch(texts: string[]): Promise<number[][] | null> {
    if (!this.openai || texts.length === 0) return null;

    if (!(await this.checkTokenBudget())) {
      this.logger.warn('Daily token budget exceeded — skipping batch embedding');
      return null;
    }

    try {
      const response = await this.openai.embeddings.create({
        model: this.model,
        input: texts,
      });
      const tokens = response.usage?.total_tokens ?? 0;
      await this.trackTokenUsage(tokens);

      // Cache each embedding individually
      const embeddings = response.data.map((d) => d.embedding);
      await Promise.allSettled(
        texts.map((text, i) => {
          const hash = this.sha256(text);
          return this.redis
            .set(`${CACHE_KEY_PREFIX}${hash}`, JSON.stringify(embeddings[i]), CACHE_TTL_SECONDS)
            .catch(() => {});
        }),
      );

      return embeddings;
    } catch (err: any) {
      this.logger.error('OpenAI batch embedding error', err?.message);
      return null;
    }
  }

  private async persistEmbedding(
    hash: string,
    embedding: number[],
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
          embeddingModel: this.model,
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
