import type { BasefyioFetchClient } from '../lib/fetch.js';
import type {
  StructureItem,
  StructureItemsPage,
  ListStructureItemsOptions,
} from '../lib/types.js';

export class ItemsClient {
  private http: BasefyioFetchClient;

  constructor(http: BasefyioFetchClient) {
    this.http = http;
  }

  async list(
    projectId: string,
    structureId: string,
    opts: ListStructureItemsOptions = {},
  ): Promise<StructureItemsPage> {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts.cursor) params.set('cursor', opts.cursor);
    const qs = params.toString();
    return this.http.json<StructureItemsPage>(
      `/v1/projects/${encodeURIComponent(projectId)}/structures/${encodeURIComponent(structureId)}/items${qs ? `?${qs}` : ''}`,
    );
  }

  async get(projectId: string, structureId: string, itemId: string): Promise<StructureItem> {
    return this.http.json<StructureItem>(
      `/v1/projects/${encodeURIComponent(projectId)}/structures/${encodeURIComponent(structureId)}/items/${encodeURIComponent(itemId)}`,
    );
  }

  async create(
    projectId: string,
    structureId: string,
    data: Record<string, unknown>,
  ): Promise<StructureItem> {
    return this.http.json<StructureItem>(
      `/v1/projects/${encodeURIComponent(projectId)}/structures/${encodeURIComponent(structureId)}/items`,
      { method: 'POST', body: JSON.stringify(data) },
    );
  }

  async update(
    projectId: string,
    structureId: string,
    itemId: string,
    data: Record<string, unknown>,
  ): Promise<StructureItem> {
    return this.http.json<StructureItem>(
      `/v1/projects/${encodeURIComponent(projectId)}/structures/${encodeURIComponent(structureId)}/items/${encodeURIComponent(itemId)}`,
      { method: 'PATCH', body: JSON.stringify(data) },
    );
  }

  async delete(
    projectId: string,
    structureId: string,
    itemId: string,
  ): Promise<{ deleted: boolean; id: string }> {
    return this.http.json<{ deleted: boolean; id: string }>(
      `/v1/projects/${encodeURIComponent(projectId)}/structures/${encodeURIComponent(structureId)}/items/${encodeURIComponent(itemId)}`,
      { method: 'DELETE' },
    );
  }
}

export function createItemsModule(client: {
  get: (path: string) => Promise<any>;
  post: (path: string, data?: unknown) => Promise<any>;
  patch: (path: string, data?: unknown) => Promise<any>;
  delete: (path: string) => Promise<any>;
}) {
  return {
    async list(
      projectId: string,
      structureId: string,
      opts: ListStructureItemsOptions = {},
    ): Promise<StructureItemsPage> {
      const params = new URLSearchParams();
      if (opts.limit !== undefined) params.set('limit', String(opts.limit));
      if (opts.cursor) params.set('cursor', opts.cursor);
      const qs = params.toString();
      return client.get(
        `/v1/projects/${projectId}/structures/${structureId}/items${qs ? `?${qs}` : ''}`,
      );
    },

    async get(projectId: string, structureId: string, itemId: string): Promise<StructureItem> {
      return client.get(`/v1/projects/${projectId}/structures/${structureId}/items/${itemId}`);
    },

    async create(
      projectId: string,
      structureId: string,
      data: Record<string, unknown>,
    ): Promise<StructureItem> {
      return client.post(`/v1/projects/${projectId}/structures/${structureId}/items`, data);
    },

    async update(
      projectId: string,
      structureId: string,
      itemId: string,
      data: Record<string, unknown>,
    ): Promise<StructureItem> {
      return client.patch(
        `/v1/projects/${projectId}/structures/${structureId}/items/${itemId}`,
        data,
      );
    },

    async delete(
      projectId: string,
      structureId: string,
      itemId: string,
    ): Promise<{ deleted: boolean; id: string }> {
      return client.delete(
        `/v1/projects/${projectId}/structures/${structureId}/items/${itemId}`,
      );
    },
  };
}

export type ItemsModule = ReturnType<typeof createItemsModule>;
