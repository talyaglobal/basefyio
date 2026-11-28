/**
 * Basefyio SDK — Data Engine Client
 *
 * Typed client for the Data Engine REST API.
 * Usage:
 *   const bf = createClient({ ... });
 *   const patients = bf.data.collection('patients');
 *   await patients.insert({ firstName: 'John' });
 *   const { data } = await patients.find({ 'address.city': 'New York' }).limit(10);
 *   const feed = await bf.data.view('mobileFeedCard');
 */

import type { BasefyioFetchClient } from '../lib/fetch.js';
import type { BasefyioResponse, BasefyioError } from '../lib/types.js';

// ── Types ──────────────────────────────────────────────────

export interface DataEngineDocument<T = Record<string, unknown>> {
  _id: string;
  _entity: string;
  _projectId: string;
  _schemaVersion: number;
  _version: number;
  _eventSequence: number;
  _status: string;
  _createdAt: string;
  _updatedAt: string;
  _createdBy: string;
  _deletedAt: string | null;
  [key: string]: unknown;
}

export interface DataEnginePage<T = Record<string, unknown>> {
  data: DataEngineDocument<T>[];
  total: number;
  hasMore: boolean;
  nextCursor?: string;
}

export interface EntityInfo {
  id: string;
  logicalName: string;
  displayName: string;
  storageStrategy: string;
  schemaVersion: number;
  fields: unknown[];
  generatedByAI: boolean;
  description?: string;
}

export interface DataEngineFilter {
  [key: string]: unknown;
}

export interface DataEngineSort {
  path: string;
  direction: 'asc' | 'desc';
}

// ── Vectors ────────────────────────────────────────────────

/** Vector setup of an entity: the caller's own vectors, or vectors the platform computes from text. */
export type VectorConfig =
  | { mode: 'client'; dimensions: number; updatedAt: string }
  | { mode: 'platform'; dimensions: number; sourcePaths: string[]; modelTag: string; updatedAt: string };

/** Body of `vectorConfig(entity).set()`. */
export type VectorConfigInput =
  | { mode: 'client'; dimensions: number }
  | { mode: 'platform'; sourcePaths: string[] };

export interface VectorReembedState {
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  done: number;
  total: number;
  failed: number;
  model: string;
  dimensions: number | null;
  lastError: string | null;
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface VectorStatus {
  mode: 'client' | 'platform' | null;
  dimensions: number | null;
  embedded: number;
  total: number;
  maxScan: number | null;
  strategy: 'exact' | 'ann' | null;
  /** Platform mode: the model the stored vectors were made with. */
  modelTag: string | null;
  sourcePaths: string[] | null;
  /** Platform mode: the model the project embeds with now. */
  currentModelTag: string | null;
  /** The project switched models: search with `query` answers 409 until a re-embed finishes. */
  mismatch: boolean;
  /** Platform mode: records still waiting for a vector of the current model. */
  pending: number | null;
  /** Platform mode: records whose last embedding failed. */
  failed: number | null;
  reembed: VectorReembedState | null;
  /** Whether the project may compute embeddings with the platform's key (Pro plan and above, or its own key). */
  platformKeyAllowed: boolean | null;
  /** Daily platform-key token limit, today's use and its reset; null on the project's own key. */
  dailyTokens: { limit: number | null; used: number | null; resetsAt: string | null } | null;
}

export interface VectorInfo {
  id: string;
  dims: number;
  model: string;
  source: string;
  hash: string | null;
  updatedAt: string;
  vector: number[];
}

export interface VectorSearchOptions {
  /** Query vector, as wide as the entity's vectors. Exactly one of `vector` or `query`. */
  vector?: number[];
  /** Text to search for (platform-mode entities); embedded with the entity's model. */
  query?: string;
  /** Same grammar as `find()` filters. */
  filter?: DataEngineFilter;
  /** 1..100, default 10. */
  limit?: number;
  /** Maximum cosine distance, 0..2, default 0.5. */
  threshold?: number;
}

export type VectorSearchHit<T = Record<string, unknown>> = DataEngineDocument<T> & {
  _distance: number;
  _score: number;
};

export interface VectorSearchResult<T = Record<string, unknown>> {
  data: VectorSearchHit<T>[];
  scanned: number;
  strategy: 'exact' | 'ann';
}

async function call<R>(fn: () => Promise<R>): Promise<BasefyioResponse<R>> {
  try {
    return { data: await fn(), error: null };
  } catch (err: unknown) {
    return { data: null, error: err as BasefyioError };
  }
}

/** `bf.data.vectorConfig(entity)`: read, set or remove an entity's vector setup. */
export class VectorConfigClient {
  constructor(
    private readonly http: BasefyioFetchClient,
    private readonly path: string,
  ) {}

  get(): Promise<BasefyioResponse<VectorConfig>> {
    return call(() => this.http.json<VectorConfig>(this.path));
  }

  /**
   * Turn vectors on, or change the setup. Switching mode while vectors exist
   * needs `{ purge: true }` (they are deleted first).
   *
   * @example
   * await bf.data.vectorConfig('articles').set({ mode: 'platform', sourcePaths: ['title', 'body'] });
   */
  set(
    config: VectorConfigInput,
    opts?: { purge?: boolean },
  ): Promise<BasefyioResponse<VectorConfig & { reembed?: { queued: boolean; total: number } }>> {
    return call(() =>
      this.http.json<VectorConfig & { reembed?: { queued: boolean; total: number } }>(
        opts?.purge ? `${this.path}?purge=true` : this.path,
        { method: 'PUT', body: JSON.stringify(config) },
      ),
    );
  }

  /** Turn vectors off; `{ purge: true }` is required when vectors exist and deletes them. */
  delete(opts?: { purge?: boolean }): Promise<BasefyioResponse<{ deleted: true; cleared: number }>> {
    return call(() =>
      this.http.json<{ deleted: true; cleared: number }>(opts?.purge ? `${this.path}?purge=true` : this.path, {
        method: 'DELETE',
      }),
    );
  }
}

// ── DataEngineQuery (chainable) ────────────────────────────

export class DataEngineQuery<T = Record<string, unknown>>
  implements PromiseLike<BasefyioResponse<DataEnginePage<T>>>
{
  private _filter?: DataEngineFilter;
  private _sort?: DataEngineSort[];
  private _limit?: number;
  private _offset?: number;
  private _includeDeleted = false;

  constructor(
    private readonly http: BasefyioFetchClient,
    private readonly basePath: string,
    filter?: DataEngineFilter,
  ) {
    this._filter = filter;
  }

  filter(criteria: DataEngineFilter): this {
    this._filter = { ...this._filter, ...criteria };
    return this;
  }

  sort(path: string, direction: 'asc' | 'desc' = 'asc'): this {
    if (!this._sort) this._sort = [];
    this._sort.push({ path, direction });
    return this;
  }

  limit(n: number): this {
    this._limit = n;
    return this;
  }

  offset(n: number): this {
    this._offset = n;
    return this;
  }

  skip(n: number): this {
    return this.offset(n);
  }

  /** Also return soft-deleted documents (their `_status` is 'deleted'); see `restore()`. */
  includeDeleted(): this {
    this._includeDeleted = true;
    return this;
  }

  async execute(): Promise<BasefyioResponse<DataEnginePage<T>>> {
    try {
      const params = new URLSearchParams();
      if (this._filter && Object.keys(this._filter).length > 0) {
        params.set('filter', JSON.stringify(this._filter));
      }
      if (this._sort && this._sort.length > 0) {
        params.set('sort', JSON.stringify(this._sort));
      }
      if (this._limit !== undefined) params.set('limit', String(this._limit));
      if (this._offset !== undefined) params.set('offset', String(this._offset));
      if (this._includeDeleted) params.set('includeSoftDeleted', 'true');

      const qs = params.toString();
      const path = qs ? `${this.basePath}?${qs}` : this.basePath;
      const data = await this.http.json<DataEnginePage<T>>(path);
      return { data, error: null };
    } catch (err: unknown) {
      return { data: null, error: err as BasefyioError };
    }
  }

  then<TResult1 = BasefyioResponse<DataEnginePage<T>>, TResult2 = never>(
    onfulfilled?: ((value: BasefyioResponse<DataEnginePage<T>>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

// ── EntityClient (per-entity operations) ───────────────────

export class EntityClient<T = Record<string, unknown>> {
  constructor(
    private readonly http: BasefyioFetchClient,
    private readonly basePath: string,
  ) {}

  /**
   * Insert a new document.
   *
   * @example
   * const { data } = await bf.data.collection('patients').insert({ firstName: 'John' });
   */
  async insert(doc: Partial<T>): Promise<BasefyioResponse<DataEngineDocument<T>>> {
    try {
      const data = await this.http.json<DataEngineDocument<T>>(this.basePath, {
        method: 'POST',
        body: JSON.stringify(doc),
      });
      return { data, error: null };
    } catch (err: unknown) {
      return { data: null, error: err as BasefyioError };
    }
  }

  /**
   * Find documents with optional filter. Returns a chainable query.
   *
   * @example
   * const { data } = await bf.data.collection('patients')
   *   .find({ 'address.city': 'New York' })
   *   .sort('_createdAt', 'desc')
   *   .limit(20);
   */
  find(filter?: DataEngineFilter): DataEngineQuery<T> {
    return new DataEngineQuery<T>(this.http, this.basePath, filter);
  }

  /**
   * Get a document by ID.
   */
  async get(id: string): Promise<BasefyioResponse<DataEngineDocument<T>>> {
    try {
      const data = await this.http.json<DataEngineDocument<T>>(`${this.basePath}/${id}`);
      return { data, error: null };
    } catch (err: unknown) {
      return { data: null, error: err as BasefyioError };
    }
  }

  /**
   * Partial update — merge fields into existing document.
   *
   * @example
   * await bf.data.collection('patients').update(id, { age: 36 });
   */
  async update(
    id: string,
    patch: Partial<T>,
    opts?: { ifMatch?: number },
  ): Promise<BasefyioResponse<DataEngineDocument<T>>> {
    try {
      const data = await this.http.json<DataEngineDocument<T>>(`${this.basePath}/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
        ...ifMatchHeader(opts),
      });
      return { data, error: null };
    } catch (err: unknown) {
      return { data: null, error: err as BasefyioError };
    }
  }

  /**
   * Full document replacement. `ifMatch` as in {@link update}.
   */
  async replace(id: string, doc: T, opts?: { ifMatch?: number }): Promise<BasefyioResponse<DataEngineDocument<T>>> {
    try {
      const data = await this.http.json<DataEngineDocument<T>>(`${this.basePath}/${id}`, {
        method: 'PUT',
        body: JSON.stringify(doc),
        ...ifMatchHeader(opts),
      });
      return { data, error: null };
    } catch (err: unknown) {
      return { data: null, error: err as BasefyioError };
    }
  }

  /**
   * Delete a document (soft-delete).
   */
  async delete(id: string): Promise<BasefyioResponse<void>> {
    try {
      await this.http.json<void>(`${this.basePath}/${id}`, { method: 'DELETE' });
      return { data: null, error: null };
    } catch (err: unknown) {
      return { data: null, error: err as BasefyioError };
    }
  }

  /**
   * Nearest records by vector similarity: send your own `vector`, or a text
   * `query` on a platform-mode entity.
   *
   * @example
   * const { data } = await bf.data.collection('articles').search({ query: 'waterproof boots', limit: 5 });
   */
  search(opts: VectorSearchOptions): Promise<BasefyioResponse<VectorSearchResult<T>>> {
    return call(() =>
      this.http.json<VectorSearchResult<T>>(`${this.basePath}/search`, {
        method: 'POST',
        body: JSON.stringify(opts),
      }),
    );
  }

  /** Store your own vector on a record (client-mode entities). */
  setVector(
    id: string,
    vector: number[],
  ): Promise<BasefyioResponse<Omit<VectorInfo, 'vector' | 'hash'>>> {
    return call(() =>
      this.http.json<Omit<VectorInfo, 'vector' | 'hash'>>(`${this.basePath}/${encodeURIComponent(id)}/vector`, {
        method: 'PUT',
        body: JSON.stringify({ vector }),
      }),
    );
  }

  /** The record's stored (unit-length) vector. */
  getVector(id: string): Promise<BasefyioResponse<VectorInfo>> {
    return call(() => this.http.json<VectorInfo>(`${this.basePath}/${encodeURIComponent(id)}/vector`));
  }

  /** Remove the record's vector. */
  deleteVector(id: string): Promise<BasefyioResponse<void>> {
    return call(async () => {
      await this.http.json<void>(`${this.basePath}/${encodeURIComponent(id)}/vector`, { method: 'DELETE' });
      return null as unknown as void;
    });
  }

  /**
   * Bring back a soft-deleted document. Find deleted ones with
   * `.find().includeDeleted()` or `?includeSoftDeleted=true`.
   */
  async restore(id: string): Promise<BasefyioResponse<DataEngineDocument<T>>> {
    try {
      const data = await this.http.json<DataEngineDocument<T>>(`${this.basePath}/${id}/restore`, { method: 'POST' });
      return { data, error: null };
    } catch (err: unknown) {
      return { data: null, error: err as BasefyioError };
    }
  }
}

/**
 * `If-Match: "<version>"`: the write succeeds only while the document is still
 * at that `_version`; otherwise the server answers 409 and nothing changes.
 */
function ifMatchHeader(opts?: { ifMatch?: number }): { headers?: Record<string, string> } {
  return typeof opts?.ifMatch === 'number' ? { headers: { 'If-Match': `"${opts.ifMatch}"` } } : {};
}

// ── DataEngineClient (top-level) ───────────────────────────

export class DataEngineClient {
  private readonly basePath: string;

  constructor(
    private readonly http: BasefyioFetchClient,
    projectId: string,
  ) {
    this.basePath = `/v1/projects/${projectId}`;
  }

  /**
   * Get an entity client for document operations.
   *
   * @example
   * const patients = bf.data.collection<Patient>('patients');
   */
  collection<T = Record<string, unknown>>(entity: string): EntityClient<T> {
    return new EntityClient<T>(this.http, `${this.basePath}/data/${entity}`);
  }

  /**
   * The entity's vector setup (get / set / delete).
   *
   * @example
   * await bf.data.vectorConfig('articles').set({ mode: 'platform', sourcePaths: ['title', 'body'] });
   */
  vectorConfig(entity: string): VectorConfigClient {
    return new VectorConfigClient(this.http, `${this.basePath}/entities/${entity}/vector-config`);
  }

  /** How many records carry a vector; in platform mode also pending, failed and the re-embed progress. */
  vectorStatus(entity: string): Promise<BasefyioResponse<VectorStatus>> {
    return call(() => this.http.json<VectorStatus>(`${this.basePath}/entities/${entity}/vector-status`));
  }

  /** Re-embed a platform-mode entity with the project's current model (after a model change). */
  reembed(entity: string): Promise<BasefyioResponse<{ queued: boolean; total: number; reembed: VectorReembedState }>> {
    return call(() =>
      this.http.json<{ queued: boolean; total: number; reembed: VectorReembedState }>(
        `${this.basePath}/entities/${entity}/reembed`,
        { method: 'POST' },
      ),
    );
  }

  /**
   * Projections (read models) are not available on the server yet; this always
   * answers an error without a request. Query the entity with `collection()`.
   *
   * @deprecated Not served yet: there is no `/views` endpoint.
   */
  async view<T = Record<string, unknown>>(
    projectionName: string,
    _params?: { limit?: number; offset?: number; cursor?: string },
  ): Promise<BasefyioResponse<DataEnginePage<T>>> {
    return {
      data: null,
      error: {
        message: `Projections are not available yet ("${projectionName}"). Query the entity with bf.data.collection() instead.`,
        status: 501,
      } as BasefyioError,
    };
  }

  /**
   * List all entity definitions for this project.
   */
  async listEntities(): Promise<BasefyioResponse<EntityInfo[]>> {
    try {
      const data = await this.http.json<EntityInfo[]>(`${this.basePath}/entities`);
      return { data, error: null };
    } catch (err: unknown) {
      return { data: null, error: err as BasefyioError };
    }
  }

  /**
   * Create a new entity definition.
   */
  async createEntity(def: {
    logicalName: string;
    displayName: string;
    fields: unknown[];
    description?: string;
  }): Promise<BasefyioResponse<EntityInfo>> {
    try {
      const data = await this.http.json<EntityInfo>(`${this.basePath}/entities`, {
        method: 'POST',
        body: JSON.stringify(def),
      });
      return { data, error: null };
    } catch (err: unknown) {
      return { data: null, error: err as BasefyioError };
    }
  }

  /**
   * Data Engine health check.
   */
  async health(): Promise<BasefyioResponse<{ available: boolean; reachable: boolean }>> {
    try {
      const data = await this.http.json<{ available: boolean; reachable: boolean }>(
        `${this.basePath}/data-engine/health`,
      );
      return { data, error: null };
    } catch (err: unknown) {
      return { data: null, error: err as BasefyioError };
    }
  }
}
