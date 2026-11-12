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
import { toBasefyioError, toJson } from '../lib/errors.js';
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

export interface DataEngineWriteOptions {
  /**
   * Optimistic concurrency: the `_version` you read. The write fails with a
   * 409 if the document has changed since (sent as the If-Match header).
   */
  ifMatch?: number;
}

function ifMatchHeader(opts?: DataEngineWriteOptions): Record<string, string> | undefined {
  return opts?.ifMatch !== undefined ? { 'If-Match': `"${opts.ifMatch}"` } : undefined;
}

// ── DataEngineQuery (chainable) ────────────────────────────

export class DataEngineQuery<T = Record<string, unknown>>
  implements PromiseLike<BasefyioResponse<DataEnginePage<T>>>
{
  private _filter?: DataEngineFilter;
  private _sort?: DataEngineSort[];
  private _limit?: number;
  private _offset?: number;

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

  async execute(): Promise<BasefyioResponse<DataEnginePage<T>>> {
    try {
      const params = new URLSearchParams();
      if (this._filter && Object.keys(this._filter).length > 0) {
        params.set('filter', toJson(this._filter));
      }
      if (this._sort && this._sort.length > 0) {
        params.set('sort', toJson(this._sort));
      }
      if (this._limit !== undefined) params.set('limit', String(this._limit));
      if (this._offset !== undefined) params.set('offset', String(this._offset));

      const qs = params.toString();
      const path = qs ? `${this.basePath}?${qs}` : this.basePath;
      const data = await this.http.json<DataEnginePage<T>>(path);
      return { data, error: null };
    } catch (err: unknown) {
      return { data: null, error: toBasefyioError(err) };
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
        body: toJson(doc),
      });
      return { data, error: null };
    } catch (err: unknown) {
      return { data: null, error: toBasefyioError(err) };
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
      return { data: null, error: toBasefyioError(err) };
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
    opts?: DataEngineWriteOptions,
  ): Promise<BasefyioResponse<DataEngineDocument<T>>> {
    try {
      const data = await this.http.json<DataEngineDocument<T>>(`${this.basePath}/${id}`, {
        method: 'PATCH',
        body: toJson(patch),
        headers: ifMatchHeader(opts),
      });
      return { data, error: null };
    } catch (err: unknown) {
      return { data: null, error: toBasefyioError(err) };
    }
  }

  /**
   * Full document replacement.
   */
  async replace(
    id: string,
    doc: T,
    opts?: DataEngineWriteOptions,
  ): Promise<BasefyioResponse<DataEngineDocument<T>>> {
    try {
      const data = await this.http.json<DataEngineDocument<T>>(`${this.basePath}/${id}`, {
        method: 'PUT',
        body: toJson(doc),
        headers: ifMatchHeader(opts),
      });
      return { data, error: null };
    } catch (err: unknown) {
      return { data: null, error: toBasefyioError(err) };
    }
  }

  /**
   * Delete a document (soft-delete).
   */
  async delete(id: string, opts?: DataEngineWriteOptions): Promise<BasefyioResponse<void>> {
    try {
      await this.http.json<void>(`${this.basePath}/${id}`, {
        method: 'DELETE',
        headers: ifMatchHeader(opts),
      });
      return { data: null, error: null };
    } catch (err: unknown) {
      return { data: null, error: toBasefyioError(err) };
    }
  }

  /**
   * Undo a soft delete.
   *
   * @example
   * await bf.data.collection('patients').restore(id);
   */
  async restore(id: string): Promise<BasefyioResponse<DataEngineDocument<T>>> {
    try {
      const data = await this.http.json<DataEngineDocument<T>>(`${this.basePath}/${id}/restore`, {
        method: 'POST',
      });
      return { data, error: null };
    } catch (err: unknown) {
      return { data: null, error: toBasefyioError(err) };
    }
  }

  /**
   * Insert up to 1000 documents in one request. Every document is validated
   * before any is written.
   */
  async insertMany(docs: Partial<T>[]): Promise<BasefyioResponse<DataEngineDocument<T>[]>> {
    try {
      const data = await this.http.json<DataEngineDocument<T>[]>(this.basePath, {
        method: 'POST',
        body: toJson(docs),
      });
      return { data, error: null };
    } catch (err: unknown) {
      return { data: null, error: toBasefyioError(err) };
    }
  }

  /** Count the documents matching an optional filter. */
  async count(filter?: DataEngineFilter): Promise<BasefyioResponse<number>> {
    try {
      const qs = filter && Object.keys(filter).length > 0 ? `?filter=${encodeURIComponent(toJson(filter))}` : '';
      const data = await this.http.json<{ count: number }>(`${this.basePath}/count${qs}`);
      return { data: data.count, error: null };
    } catch (err: unknown) {
      return { data: null, error: toBasefyioError(err) };
    }
  }
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
   * Fetch a projection (mobile-ready read model).
   *
   * @example
   * const { data } = await bf.data.view('mobileFeedCard');
   */
  async view<T = Record<string, unknown>>(
    projectionName: string,
    params?: { limit?: number; offset?: number; cursor?: string },
  ): Promise<BasefyioResponse<DataEnginePage<T>>> {
    try {
      const qs = new URLSearchParams();
      if (params?.limit) qs.set('limit', String(params.limit));
      if (params?.offset) qs.set('offset', String(params.offset));
      if (params?.cursor) qs.set('cursor', params.cursor);
      const query = qs.toString();
      const path = `${this.basePath}/views/${projectionName}${query ? `?${query}` : ''}`;
      const data = await this.http.json<DataEnginePage<T>>(path);
      return { data, error: null };
    } catch (err: unknown) {
      return { data: null, error: toBasefyioError(err) };
    }
  }

  /**
   * List all entity definitions for this project.
   */
  async listEntities(): Promise<BasefyioResponse<EntityInfo[]>> {
    try {
      const data = await this.http.json<EntityInfo[]>(`${this.basePath}/entities`);
      return { data, error: null };
    } catch (err: unknown) {
      return { data: null, error: toBasefyioError(err) };
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
        body: toJson(def),
      });
      return { data, error: null };
    } catch (err: unknown) {
      return { data: null, error: toBasefyioError(err) };
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
      return { data: null, error: toBasefyioError(err) };
    }
  }
}
