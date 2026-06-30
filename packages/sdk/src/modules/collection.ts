import type { BasefyioFetchClient } from '../lib/fetch.js';
import type { BasefyioResponse, BasefyioError } from '../lib/types.js';

/* ─────────────── Types ─────────────── */

export interface CollectionInfo {
  name: string;
  documentCount: number;
}

export interface Document<T = Record<string, unknown>> {
  id: string;
  data: T;
  created_at: string;
  updated_at: string;
}

export interface DocumentListResult<T = Record<string, unknown>> {
  data: Document<T>[];
  total: number;
  limit: number;
  offset: number;
}

export interface NoSqlFilter {
  [key: string]:
    | unknown
    | { $eq?: unknown }
    | { $ne?: unknown }
    | { $gt?: number }
    | { $gte?: number }
    | { $lt?: number }
    | { $lte?: number }
    | { $in?: unknown[] }
    | { $nin?: unknown[] }
    | { $contains?: unknown }
    | { $exists?: boolean }
    | { $regex?: string }
    | { $iregex?: string };
}

/* ─────────────── DocumentQuery (chainable) ─────────────── */

export class DocumentQuery<T = Record<string, unknown>> implements PromiseLike<BasefyioResponse<DocumentListResult<T>>> {
  private _filter?: NoSqlFilter;
  private _sort?: Record<string, number>;
  private _project?: Record<string, 0 | 1>;
  private _limit?: number;
  private _offset?: number;

  constructor(
    private readonly http: BasefyioFetchClient,
    private readonly basePath: string,
    filter?: NoSqlFilter,
  ) {
    this._filter = filter;
  }

  filter(criteria: NoSqlFilter): this {
    this._filter = { ...this._filter, ...criteria };
    return this;
  }

  sort(field: string, direction: 'asc' | 'desc' = 'asc'): this {
    this._sort = { ...this._sort, [field]: direction === 'desc' ? -1 : 1 };
    return this;
  }

  limit(n: number): this {
    this._limit = n;
    return this;
  }

  skip(n: number): this {
    this._offset = n;
    return this;
  }

  project(fields: Record<string, 0 | 1>): this {
    this._project = fields;
    return this;
  }

  /** Execute the query and return the result. */
  async execute(): Promise<BasefyioResponse<DocumentListResult<T>>> {
    try {
      const params = new URLSearchParams();
      if (this._filter && Object.keys(this._filter).length > 0) {
        params.set('filter', JSON.stringify(this._filter));
      }
      if (this._sort && Object.keys(this._sort).length > 0) {
        params.set('sort', JSON.stringify(this._sort));
      }
      if (this._project && Object.keys(this._project).length > 0) {
        params.set('project', JSON.stringify(this._project));
      }
      if (this._limit !== undefined) {
        params.set('limit', String(this._limit));
      }
      if (this._offset !== undefined) {
        params.set('offset', String(this._offset));
      }

      const qs = params.toString();
      const path = qs ? `${this.basePath}?${qs}` : this.basePath;
      const data = await this.http.json<DocumentListResult<T>>(path);
      return { data, error: null };
    } catch (err: unknown) {
      const error = err as BasefyioError;
      return { data: null, error };
    }
  }

  then<TResult1 = BasefyioResponse<DocumentListResult<T>>, TResult2 = never>(
    onfulfilled?: ((value: BasefyioResponse<DocumentListResult<T>>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

/* ─────────────── CollectionClient ─────────────── */

export class CollectionClient<T = Record<string, unknown>> {
  private readonly basePath: string;

  constructor(
    private readonly http: BasefyioFetchClient,
    collectionPath: string,
  ) {
    this.basePath = collectionPath;
  }

  /**
   * Insert one or more documents.
   *
   * @example
   * const { data } = await bf.collection('posts').insert({ title: 'Hello' })
   * const { data } = await bf.collection('posts').insert([{ title: 'A' }, { title: 'B' }])
   */
  async insert(doc: T | T[]): Promise<BasefyioResponse<Document<T>[]>> {
    try {
      const data = await this.http.json<Document<T>[]>(this.basePath, {
        method: 'POST',
        body: JSON.stringify(doc),
        headers: { 'Prefer': 'return=representation' },
      });
      return { data, error: null };
    } catch (err: unknown) {
      return { data: null, error: err as BasefyioError };
    }
  }

  /**
   * Find documents with optional filter, sort, limit, skip, and projection.
   * Returns a chainable DocumentQuery.
   *
   * @example
   * const { data } = await bf.collection('posts').find({ status: 'published' }).sort('views', 'desc').limit(10)
   */
  find(filter?: NoSqlFilter): DocumentQuery<T> {
    return new DocumentQuery<T>(this.http, this.basePath, filter);
  }

  /**
   * Get a single document by ID.
   */
  async findById(id: string): Promise<BasefyioResponse<Document<T>>> {
    try {
      const data = await this.http.json<Document<T>>(`${this.basePath}/${id}`);
      return { data, error: null };
    } catch (err: unknown) {
      return { data: null, error: err as BasefyioError };
    }
  }

  /**
   * Partial update — merges fields into existing document data.
   *
   * @example
   * await bf.collection('posts').updateById(id, { views: 42 })
   */
  async updateById(id: string, update: Partial<T>): Promise<BasefyioResponse<Document<T>>> {
    try {
      const data = await this.http.json<Document<T>>(`${this.basePath}/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(update),
        headers: { 'Prefer': 'return=representation' },
      });
      return { data, error: null };
    } catch (err: unknown) {
      return { data: null, error: err as BasefyioError };
    }
  }

  /**
   * Full document replacement.
   */
  async replaceById(id: string, doc: T): Promise<BasefyioResponse<Document<T>>> {
    try {
      const data = await this.http.json<Document<T>>(`${this.basePath}/${id}`, {
        method: 'PUT',
        body: JSON.stringify(doc),
        headers: { 'Prefer': 'return=representation' },
      });
      return { data, error: null };
    } catch (err: unknown) {
      return { data: null, error: err as BasefyioError };
    }
  }

  /**
   * Delete a document by ID.
   */
  async deleteById(id: string): Promise<BasefyioResponse<{ count: number }>> {
    try {
      const data = await this.http.json<{ count: number }>(`${this.basePath}/${id}`, {
        method: 'DELETE',
      });
      return { data, error: null };
    } catch (err: unknown) {
      return { data: null, error: err as BasefyioError };
    }
  }

  /**
   * Count documents with optional filter.
   */
  async count(filter?: NoSqlFilter): Promise<BasefyioResponse<number>> {
    try {
      const params = new URLSearchParams();
      if (filter && Object.keys(filter).length > 0) {
        params.set('filter', JSON.stringify(filter));
      }
      const qs = params.toString();
      // The count endpoint is on the admin API. For public API, use find with limit=0.
      // We'll use the find endpoint and just extract the count.
      params.set('limit', '0');
      const path = qs
        ? `${this.basePath}?${params.toString()}`
        : `${this.basePath}?limit=0`;
      const result = await this.http.json<{ data: unknown[]; count: number }>(path);
      return { data: result.count, error: null };
    } catch (err: unknown) {
      return { data: null, error: err as BasefyioError };
    }
  }
}

/* ─────────────── CollectionManager ─────────────── */

export class CollectionManager {
  private readonly adminBasePath: string;
  private readonly publicBasePath: string;

  constructor(
    private readonly http: BasefyioFetchClient,
    projectId: string,
  ) {
    this.adminBasePath = `/projects/${projectId}/collections`;
    this.publicBasePath = '/rest/v1/collections';
  }

  /**
   * Get a CollectionClient for performing document operations via the public API (with RLS).
   *
   * @example
   * const posts = bf.collection('posts')
   * const { data } = await posts.find({ status: 'published' }).limit(10)
   */
  get<T = Record<string, unknown>>(name: string): CollectionClient<T> {
    return new CollectionClient<T>(this.http, `${this.publicBasePath}/${name}`);
  }

  /**
   * List all collections in the project.
   */
  async list(): Promise<BasefyioResponse<CollectionInfo[]>> {
    try {
      const data = await this.http.json<CollectionInfo[]>(this.adminBasePath);
      return { data, error: null };
    } catch (err: unknown) {
      return { data: null, error: err as BasefyioError };
    }
  }

  /**
   * Create a new collection.
   *
   * @example
   * await bf.collections.create('posts')
   */
  async create(name: string): Promise<BasefyioResponse<{ message: string }>> {
    try {
      const data = await this.http.json<{ message: string }>(this.adminBasePath, {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      return { data, error: null };
    } catch (err: unknown) {
      return { data: null, error: err as BasefyioError };
    }
  }

  /**
   * Drop a collection and all its documents.
   */
  async drop(name: string): Promise<BasefyioResponse<{ message: string }>> {
    try {
      const data = await this.http.json<{ message: string }>(
        `${this.adminBasePath}/${name}`,
        { method: 'DELETE' },
      );
      return { data, error: null };
    } catch (err: unknown) {
      return { data: null, error: err as BasefyioError };
    }
  }
}
