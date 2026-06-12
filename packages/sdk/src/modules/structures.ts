import type { BasefyioFetchClient } from '../lib/fetch.js';

export interface DataStructure {
  id: string;
  projectId: string;
  name: string;
  kind: 'relational' | 'json';
  badge: 'SQL' | 'JSON';
  editorMode: 'sql' | 'js-query';
  dataEditorMode: 'row' | 'document';
  aiRecommended: boolean;
  aiReasons: unknown | null;
  /** ISO 8601 string (server serialises Date to JSON). */
  createdAt: string;
  /** ISO 8601 string (server serialises Date to JSON). */
  updatedAt: string;
}

export interface CreateStructureInput {
  name: string;
  kind: 'relational' | 'json';
}

export interface UpdateStructureInput {
  name?: string;
}

export class StructuresClient {
  constructor(private readonly http: BasefyioFetchClient) {}

  async list(projectId: string): Promise<DataStructure[]> {
    return this.http.json<DataStructure[]>(
      `/v1/projects/${encodeURIComponent(projectId)}/structures`,
    );
  }

  async get(projectId: string, structureId: string): Promise<DataStructure> {
    return this.http.json<DataStructure>(
      `/v1/projects/${encodeURIComponent(projectId)}/structures/${encodeURIComponent(structureId)}`,
    );
  }

  async create(projectId: string, input: CreateStructureInput): Promise<DataStructure> {
    return this.http.json<DataStructure>(
      `/v1/projects/${encodeURIComponent(projectId)}/structures`,
      {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  async update(
    projectId: string,
    structureId: string,
    input: UpdateStructureInput,
  ): Promise<DataStructure> {
    return this.http.json<DataStructure>(
      `/v1/projects/${encodeURIComponent(projectId)}/structures/${encodeURIComponent(structureId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  async delete(projectId: string, structureId: string): Promise<void> {
    await this.http.json<void>(
      `/v1/projects/${encodeURIComponent(projectId)}/structures/${encodeURIComponent(structureId)}`,
      { method: 'DELETE' },
    );
  }
}
