import * as crypto from 'crypto';
import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type { EntityCollection, VectorSourceRow } from '@basefyio/data-engine';
import { DATA_VECTOR_QUEUE } from '../queue/queue.module';
import {
  ProjectEmbeddingService,
  type ProjectEmbeddingTarget,
} from '../embedding/project-embedding.service';
import type { ResolvedProvider } from '../embedding/providers/embedding-provider.service';
import {
  DataEngineService,
  parseVectorConfig,
  reembedActive,
  type PlatformVectorConfig,
  type VectorReembedState,
} from './data-engine.service';
import { buildSourceText, sourceHash } from './vector-source';
import { MAX_VECTOR_DIMENSIONS } from './dto/vector.dto';

/** BullMQ job names on DATA_VECTOR_QUEUE. */
export const EMBED_RECORD_JOB = 'embed-record';
export const REEMBED_ENTITY_JOB = 'reembed-entity';

export interface EmbedRecordJob {
  projectId: string;
  entity: string;
  id: string;
}

export interface ReembedEntityJob {
  projectId: string;
  entity: string;
}

/** Records per page of a re-embed (one provider call per page). */
export const REEMBED_PAGE = 100;
/** A re-embed stops after this many pages in a row where every embedding failed. */
const MAX_FAILED_PAGES = 3;
/** Wait before an embed-record job runs, so a burst of writes to one record collapses into one job. */
const EMBED_RECORD_DELAY_MS = 1_000;
/** Attempts at reading a record that keeps changing while it is embedded. */
const MAX_RECORD_ATTEMPTS = 3;
/** Longest error kept in progress state. */
const MAX_ERROR_LENGTH = 300;
/** A queue add slower than this is reported as failed (Redis outage). */
const QUEUE_ADD_TIMEOUT_MS = 5_000;

/**
 * Refusals that are about the project, not the record: the plan does not
 * include platform-key embeddings, today's budget is used up, or AI is off.
 * No record is marked failed for them; a re-embed stops at once.
 */
const PROJECT_REFUSALS = new Set(['EMBEDDING_PLAN_REQUIRED', 'EMBEDDING_DAILY_LIMIT', 'AI_DISABLED']);

function refusalCode(err: unknown): string | null {
  if (!(err instanceof HttpException)) return null;
  const code = (err.getResponse() as any)?.code;
  return typeof code === 'string' && PROJECT_REFUSALS.has(code) ? code : null;
}

export type RecordOutcome = 'embedded' | 'unchanged' | 'empty' | 'missing' | 'skipped' | 'failed' | 'changed';

/** Strip anything that looks like a credential, and bound the length. */
export function safeError(err: unknown): string {
  const body = err instanceof HttpException ? (err.getResponse() as any) : null;
  const message =
    body && typeof body === 'object'
      ? String(body.message ?? (err as Error).message)
      : err instanceof Error
        ? err.message
        : String(err);
  const raw = body && typeof body === 'object' && typeof body.code === 'string' ? `${body.code}: ${message}` : message;
  return raw
    // Provider key shapes (sk-..., pk_...), bearer tokens, and long opaque strings.
    .replace(/\b(?:sk|pk|rk)[-_][A-Za-z0-9_\-*.]{6,}/gi, '[redacted]')
    .replace(/\bbearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[A-Za-z0-9_\-]{32,}/g, '[redacted]')
    .slice(0, MAX_ERROR_LENGTH);
}

/** Job ids may not contain ":"; a digest keeps them short and unambiguous. */
function digest(...parts: string[]): string {
  return crypto.createHash('sha1').update(parts.join('\u0000')).digest('hex');
}

export function embedRecordJobId(projectId: string, entity: string, id: string): string {
  return `rec-${digest(projectId, entity, id)}`;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`queue did not answer within ${ms} ms`)), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

type PlatformCollection = EntityCollection &
  Required<Pick<EntityCollection, 'setVector' | 'vectorSources' | 'setVectorMarker' | 'vectorStats'>>;

/** Who embeds a batch: the project, its provider, the model tag and width the vectors must have. */
interface EmbedContext {
  project: ProjectEmbeddingTarget;
  resolved: ResolvedProvider;
  tag: string;
  dimensions: number;
  paths: string[];
}

interface BatchResult {
  embedded: number;
  unchanged: number;
  empty: number;
  failed: number;
  changed: number;
  lastError: string | null;
  /** The provider or the budget refused in a way every further page would repeat. */
  fatal: boolean;
  /** The plan, the daily budget or the AI switch refused (no record was marked). */
  refused?: boolean;
}

/**
 * Data Engine platform vectors: the platform computes a record's vector from
 * the text at the entity's source paths.
 *
 * Writes only enqueue (enqueueRecord); embedding runs in the data-vector
 * worker, never inside a write request. Every read and write goes through the
 * entity collection of the job's project and entity, so the engine's scope
 * (project + entity + not deleted) bounds what a job can touch: an id from
 * another project or entity simply matches nothing.
 */
@Injectable()
export class DataVectorEmbedderService {
  private readonly logger = new Logger(DataVectorEmbedderService.name);

  constructor(
    private readonly dataEngine: DataEngineService,
    private readonly projectEmbedding: ProjectEmbeddingService,
    @InjectQueue(DATA_VECTOR_QUEUE) private readonly queue: Queue,
  ) {}

  // ── Producers ──────────────────────────────────────────

  /**
   * After a create / update / replace / restore: queue the record's embedding
   * when the entity is in platform mode. Fire and forget — never awaited by
   * the write, never fails it. `vectorConfig` is the entity definition's raw
   * value when the caller already loaded it.
   */
  afterWrite(projectId: string, entity: string, id: string | undefined, vectorConfig?: unknown): void {
    if (!id) return;
    void (async () => {
      const config =
        vectorConfig !== undefined
          ? parseVectorConfig(vectorConfig)
          : await this.dataEngine.getVectorConfig(projectId, entity);
      if (config?.mode !== 'platform') return;
      await this.queue.add(
        EMBED_RECORD_JOB,
        { projectId, entity, id } satisfies EmbedRecordJob,
        {
          // One waiting job per record: a burst of writes collapses into one embedding.
          jobId: embedRecordJobId(projectId, entity, id),
          delay: EMBED_RECORD_DELAY_MS,
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    })().catch((err) => {
      this.logger.warn(`Could not queue the vector of ${entity}/${id} (project ${projectId}): ${safeError(err)}`);
    });
  }

  /** Queue a re-embed of the whole entity. 409 when one is running; 403/400 when the project cannot embed. */
  async startReembed(projectId: string, entity: string): Promise<{ queued: boolean; total: number; state: VectorReembedState }> {
    const { config, reembed } = await this.dataEngine.getVectorSetup(projectId, entity);
    if (config?.mode !== 'platform') {
      throw new ConflictException({
        statusCode: 409,
        code: 'VECTOR_MODE_NOT_PLATFORM',
        message: `Entity "${entity}" is not in platform mode; only platform vectors are re-embedded.`,
      });
    }
    if (reembedActive(reembed)) {
      throw new ConflictException({
        statusCode: 409,
        code: 'VECTOR_REEMBED_RUNNING',
        message: `A re-embed of "${entity}" is already in progress (${reembed!.done}/${reembed!.total}).`,
      });
    }
    // Fail early when the project cannot embed at all (AI switched off, no key).
    const project = await this.projectEmbedding.loadProject(projectId);
    const resolved = this.projectEmbedding.resolve(project);
    await this.projectEmbedding.assertPlatformKeyAllowed(project, resolved);

    const col = await this.platformCollection(projectId, entity);
    const { total } = await col.vectorStats();
    const now = new Date().toISOString();
    const queued: VectorReembedState = {
      status: 'QUEUED',
      done: 0,
      total,
      failed: 0,
      model: resolved.tag,
      dimensions: null,
      lastError: null,
      updatedAt: now,
    };
    await this.dataEngine.setVectorReembedState(projectId, entity, queued);
    try {
      await withTimeout(
        this.queue.add(
          REEMBED_ENTITY_JOB,
          { projectId, entity } satisfies ReembedEntityJob,
          {
            jobId: `reembed-${digest(projectId, entity)}-${Date.now()}`,
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: true,
          },
        ),
        QUEUE_ADD_TIMEOUT_MS,
      );
    } catch (err) {
      const failed: VectorReembedState = {
        ...queued,
        status: 'FAILED',
        lastError: `Could not queue the re-embed job: ${safeError(err)}`,
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };
      await this.dataEngine.setVectorReembedState(projectId, entity, failed).catch(() => undefined);
      throw new ServiceUnavailableException('Could not queue the re-embed job. Try again shortly.');
    }
    return { queued: true, total, state: queued };
  }

  // ── Worker: one record ─────────────────────────────────

  /** Embed one record when its source text or the model changed. Never throws. */
  async embedRecord(job: EmbedRecordJob): Promise<RecordOutcome> {
    const { projectId, entity, id } = job;
    try {
      const { config, reembed } = await this.dataEngine.getVectorSetup(projectId, entity);
      if (config?.mode !== 'platform') return 'skipped';
      const col = await this.platformCollection(projectId, entity);

      const project = await this.projectEmbedding.loadProject(projectId);
      const resolved = this.projectEmbedding.resolve(project);
      const dimensions = this.recordDimensions(config, reembed, resolved.tag);
      // The project switched models and no re-embed runs: leave the record pending.
      if (dimensions === null) return 'skipped';
      const ctx: EmbedContext = { project, resolved, tag: resolved.tag, dimensions, paths: config.sourcePaths };

      for (let attempt = 0; attempt < MAX_RECORD_ATTEMPTS; attempt++) {
        const [row] = await col.vectorSources({ paths: ctx.paths, ids: [id], limit: 1 });
        if (!row || row.id !== id) return 'missing';
        const r = await this.processBatch(col, [row], ctx);
        if (r.refused) {
          this.logger.warn(`Vector of ${entity}/${id} (project ${projectId}) not computed: ${r.lastError}`);
          return 'skipped';
        }
        if (r.changed === 0) {
          if (r.embedded) return 'embedded';
          if (r.empty) return 'empty';
          if (r.unchanged) return 'unchanged';
          if (r.failed) return 'failed';
          return 'missing';
        }
        // The record changed while it was embedded: read it again.
      }
      return 'changed';
    } catch (err) {
      this.logger.warn(`Vector of ${entity}/${id} (project ${projectId}) not computed: ${safeError(err)}`);
      return 'failed';
    }
  }

  /**
   * Width a single-record job writes with: the entity's model, or the model a
   * running re-embed moves the entity to. Null when the project's model is
   * neither (the record waits for a re-embed).
   */
  private recordDimensions(
    config: PlatformVectorConfig,
    reembed: VectorReembedState | null,
    tag: string,
  ): number | null {
    if (tag === config.modelTag) return config.dimensions;
    if (reembedActive(reembed) && reembed!.model === tag && reembed!.dimensions) return reembed!.dimensions;
    return null;
  }

  // ── Worker: whole entity ───────────────────────────────

  /**
   * Re-embed every live record of the entity with the project's current
   * model, 100 at a time, skipping records whose text and model are
   * unchanged. Progress lands on EntityDefinition.vectorReembedState. A
   * failed record is counted and the run goes on; a provider or budget
   * failure that every further page would repeat ends the run as FAILED.
   * Never throws (the job has one attempt; nothing retries a failure storm).
   */
  async reembedEntity(job: ReembedEntityJob): Promise<VectorReembedState> {
    const { projectId, entity } = job;
    const startedAt = new Date().toISOString();
    let state: VectorReembedState = {
      status: 'RUNNING',
      done: 0,
      total: 0,
      failed: 0,
      model: '',
      dimensions: null,
      lastError: null,
      startedAt,
      updatedAt: startedAt,
    };
    const write = async (patch: Partial<VectorReembedState>) => {
      state = { ...state, ...patch, updatedAt: new Date().toISOString() };
      await this.dataEngine.setVectorReembedState(projectId, entity, state);
      return state;
    };
    const fail = async (message: string) => {
      const finishedAt = new Date().toISOString();
      state = { ...state, status: 'FAILED', lastError: message.slice(0, MAX_ERROR_LENGTH), updatedAt: finishedAt, finishedAt };
      await this.dataEngine.setVectorReembedState(projectId, entity, state).catch(() => undefined);
      this.logger.warn(`Re-embed of ${entity} (project ${projectId}) failed after ${state.done}: ${state.lastError}`);
      return state;
    };

    try {
      const { config } = await this.dataEngine.getVectorSetup(projectId, entity);
      if (config?.mode !== 'platform') return await fail('The entity is not in platform mode.');
      const col = await this.platformCollection(projectId, entity);
      const project = await this.projectEmbedding.loadProject(projectId);
      const resolved = this.projectEmbedding.resolve(project);
      // Free plan on the platform key: refuse before any page is read.
      await this.projectEmbedding.assertPlatformKeyAllowed(project, resolved);
      const tag = resolved.tag;
      const dimensions =
        tag === config.modelTag ? config.dimensions : await this.projectEmbedding.dimensions(resolved);
      if (dimensions > MAX_VECTOR_DIMENSIONS) {
        return await fail(`${tag} produces ${dimensions}-dimensional vectors; at most ${MAX_VECTOR_DIMENSIONS} are stored.`);
      }
      const { total } = await col.vectorStats();
      await write({ status: 'RUNNING', model: tag, dimensions, total });

      const ctx: EmbedContext = { project, resolved, tag, dimensions, paths: config.sourcePaths };
      let after: string | undefined;
      let failedPages = 0;
      for (;;) {
        const rows = await col.vectorSources({ paths: ctx.paths, after, limit: REEMBED_PAGE });
        if (rows.length === 0) break;
        const r = await this.processBatch(col, rows, ctx);
        after = rows[rows.length - 1].id;
        failedPages = r.failed > 0 && r.embedded === 0 ? failedPages + 1 : 0;
        await write({
          done: state.done + rows.length,
          total: Math.max(state.total, state.done + rows.length),
          failed: state.failed + r.failed,
          lastError: r.lastError ?? state.lastError,
        });
        if (r.fatal) return await fail(r.lastError ?? 'The embedding provider refused the request.');
        if (failedPages >= MAX_FAILED_PAGES) {
          return await fail(`Stopped after ${MAX_FAILED_PAGES} pages in a row failed: ${r.lastError ?? 'provider error'}`);
        }
        // The setup changed under the run (mode, paths, or removed): stop rather than mix.
        const now = (await this.dataEngine.getVectorSetup(projectId, entity)).config;
        if (now?.mode !== 'platform' || now.sourcePaths.join('\n') !== config.sourcePaths.join('\n')) {
          return await fail('The vector config changed during the re-embed. Start it again.');
        }
      }

      // The entity now holds this model's vectors: search embeds queries with it.
      if (tag !== config.modelTag || dimensions !== config.dimensions) {
        await this.dataEngine.setVectorConfig(projectId, entity, {
          ...config,
          modelTag: tag,
          dimensions,
          updatedAt: new Date().toISOString(),
        });
      }
      const finishedAt = new Date().toISOString();
      state = { ...state, status: 'COMPLETED', updatedAt: finishedAt, finishedAt };
      await this.dataEngine.setVectorReembedState(projectId, entity, state);
      this.logger.log(
        `Re-embedded ${entity} (project ${projectId}) with ${tag}: ${state.done} records, ${state.failed} failed`,
      );
      return state;
    } catch (err) {
      return fail(safeError(err));
    }
  }

  // ── Shared ─────────────────────────────────────────────

  /**
   * Embed the rows whose text or model changed, in one provider call, and
   * write each vector only while the record is at the version it was read at.
   */
  private async processBatch(col: PlatformCollection, rows: VectorSourceRow[], ctx: EmbedContext): Promise<BatchResult> {
    const out: BatchResult = { embedded: 0, unchanged: 0, empty: 0, failed: 0, changed: 0, lastError: null, fatal: false };
    const todo: Array<{ row: VectorSourceRow; text: string; hash: string }> = [];

    for (const row of rows) {
      const text = buildSourceText(row.data, ctx.paths);
      if (text === '') {
        if (!row.vector && row.marker?.kind === 'empty' && row.marker.model === ctx.tag) {
          out.unchanged++;
          continue;
        }
        // Nothing to embed: the record leaves vector search.
        const ok = await col.setVectorMarker(row.id, { kind: 'empty', model: ctx.tag, hash: null }, { ifVersion: row.version });
        if (ok) out.empty++;
        else out.changed++;
        continue;
      }
      const hash = sourceHash(text);
      const v = row.vector;
      if (v && v.source === 'platform' && v.model === ctx.tag && v.hash === hash && v.dims === ctx.dimensions) {
        out.unchanged++;
        continue;
      }
      todo.push({ row, text, hash });
    }
    if (todo.length === 0) return out;

    let vectors: number[][] | null = null;
    let tag = ctx.tag;
    try {
      const res = await this.projectEmbedding.embedForProject(ctx.project, todo.map((t) => t.text), {
        intent: 'document',
        targetDimensions: ctx.dimensions,
        resolved: ctx.resolved,
      });
      vectors = res.vectors;
      tag = res.tag;
    } catch (err) {
      const status = err instanceof HttpException ? err.getStatus() : 0;
      if (refusalCode(err)) {
        // About the project, not these records: they stay pending, nothing is retried.
        out.lastError = safeError(err);
        out.fatal = true;
        out.refused = true;
        return out;
      }
      // A rejected input in a batch: find the one record that caused it.
      if (status === 400 && todo.length > 1) {
        for (const t of todo) {
          const one = await this.processBatch(col, [t.row], ctx);
          out.embedded += one.embedded;
          out.failed += one.failed;
          out.changed += one.changed;
          out.unchanged += one.unchanged;
          out.empty += one.empty;
          out.lastError = one.lastError ?? out.lastError;
          if (one.fatal) {
            out.fatal = true;
            out.refused = one.refused;
            break;
          }
        }
        return out;
      }
      out.lastError = safeError(err);
      // Budget or quota used up, AI switched off, key rejected or provider unreachable:
      // every further page would fail the same way, so a re-embed stops here.
      // (A rejected input, 400, is about this record only.)
      out.fatal = status === 429 || status === 403 || status === 502;
      for (const t of todo) {
        await col
          .setVectorMarker(t.row.id, { kind: 'failed', model: ctx.tag, hash: t.hash, error: out.lastError }, { ifVersion: t.row.version })
          .catch(() => false);
        out.failed++;
      }
      return out;
    }

    for (let i = 0; i < todo.length; i++) {
      const t = todo[i];
      try {
        await col.setVector(t.row.id, vectors[i], {
          dimensions: ctx.dimensions,
          model: tag,
          source: 'platform',
          hash: t.hash,
          ifVersion: t.row.version,
        });
        out.embedded++;
      } catch (err: any) {
        if (err?.code === 'CONCURRENCY_CONFLICT') {
          out.changed++;
        } else if (err?.code === 'DOCUMENT_NOT_FOUND') {
          // Deleted meanwhile: it left search with its record.
        } else {
          out.lastError = safeError(err);
          await col
            .setVectorMarker(t.row.id, { kind: 'failed', model: ctx.tag, hash: t.hash, error: out.lastError }, { ifVersion: t.row.version })
            .catch(() => false);
          out.failed++;
        }
      }
    }
    return out;
  }

  /** The entity's collection, with the methods platform vectors need. */
  private async platformCollection(projectId: string, entity: string): Promise<PlatformCollection> {
    const col = await this.dataEngine.getEntityCollection(projectId, entity);
    if (
      typeof col.setVector !== 'function' ||
      typeof col.vectorSources !== 'function' ||
      typeof col.setVectorMarker !== 'function' ||
      typeof col.vectorStats !== 'function'
    ) {
      throw new Error('This data engine provider does not store vectors');
    }
    return col as PlatformCollection;
  }
}
