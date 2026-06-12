import type { BasefyioFetchClient } from '../lib/fetch.js';
import type { Item, ItemsPage, ListItemsOptions } from '../lib/types.js';

/**
 * ItemsClient provides CRUD operations for content-layer items.
 * Each "entity" is a named collection within a project (e.g. "customers", "orders").
 */
export class ItemsClient {
  private http: BasefyioFetchClient;

  constructor(http: BasefyioFetchClient) {
    this.http = http;
  }

  /**
   * List items for an entity with optional filtering, sorting, and cursor pagination.
   */
  async list(
    projectId: string,
    entityName: string,
    opts: ListItemsOptions = {},
  ): Promise<ItemsPage> {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts.cursor) params.set('cursor', opts.cursor);
    if (opts.sort) params.set('sort', opts.sort);
    if (opts.order) params.set('order', opts.order);
    if (opts.filters) {
      for (const [k, v] of Object.entries(opts.filters)) {
        params.set(`filter[${k}]`, v);
      }
    }
    const qs = params.toString();
    return this.http.json<ItemsPage>(
      `/v1/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(entityName)}${qs ? `?${qs}` : ''}`,
    );
  }

  /** Get a single item by ID. */
  async get(projectId: string, entityName: string, id: string): Promise<Item> {
    return this.http.json<Item>(
      `/v1/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(entityName)}/${encodeURIComponent(id)}`,
    );
  }

  /** Create a new item. */
  async create(
    projectId: string,
    entityName: string,
    data: Record<string, unknown>,
  ): Promise<Item> {
    return this.http.json<Item>(
      `/v1/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(entityName)}`,
      { method: 'POST', body: JSON.stringify(data) },
    );
  }

  /** Update an item by ID. */
  async update(
    projectId: string,
    entityName: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<Item> {
    return this.http.json<Item>(
      `/v1/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(entityName)}/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(data) },
    );
  }

  /** Delete an item by ID. */
  async delete(
    projectId: string,
    entityName: string,
    id: string,
  ): Promise<{ deleted: boolean; id: string }> {
    return this.http.json<{ deleted: boolean; id: string }>(
      `/v1/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(entityName)}/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
  }
}

/**
 * Function-based factory — used in unit tests and for functional composition.
 * The returned object has the same surface as ItemsClient.
 */
export function createItemsModule(client: {
  get: (path: string) => Promise<any>;
  post: (path: string, data?: unknown) => Promise<any>;
  patch: (path: string, data?: unknown) => Promise<any>;
  delete: (path: string) => Promise<any>;
}) {
  return {
    async list(
      projectId: string,
      entityName: string,
      opts: ListItemsOptions = {},
    ): Promise<ItemsPage> {
      const params = new URLSearchParams();
      if (opts.limit !== undefined) params.set('limit', String(opts.limit));
      if (opts.cursor) params.set('cursor', opts.cursor);
      if (opts.sort) params.set('sort', opts.sort);
      if (opts.order) params.set('order', opts.order);
      if (opts.filters) {
        for (const [k, v] of Object.entries(opts.filters)) {
          params.set(`filter[${k}]`, v);
        }
      }
      const qs = params.toString();
      return client.get(
        `/v1/projects/${projectId}/items/${entityName}${qs ? `?${qs}` : ''}`,
      );
    },

    async get(projectId: string, entityName: string, id: string): Promise<Item> {
      return client.get(`/v1/projects/${projectId}/items/${entityName}/${id}`);
    },

    async create(
      projectId: string,
      entityName: string,
      data: Record<string, unknown>,
    ): Promise<Item> {
      return client.post(`/v1/projects/${projectId}/items/${entityName}`, data);
    },

    async update(
      projectId: string,
      entityName: string,
      id: string,
      data: Record<string, unknown>,
    ): Promise<Item> {
      return client.patch(
        `/v1/projects/${projectId}/items/${entityName}/${id}`,
        data,
      );
    },

    async delete(
      projectId: string,
      entityName: string,
      id: string,
    ): Promise<{ deleted: boolean; id: string }> {
      return client.delete(`/v1/projects/${projectId}/items/${entityName}/${id}`);
    },
  };
}

export type ItemsModule = ReturnType<typeof createItemsModule>;
