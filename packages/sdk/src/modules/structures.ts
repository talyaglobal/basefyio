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
  createdAt: string;
  updatedAt: string;
}

export interface CreateStructureInput {
  name: string;
  kind: 'relational' | 'json';
}

export class StructuresClient {
  constructor(private readonly http: BasefyioFetchClient) {}

  /** List all data structures for a project. */
  async list(projectId: string): Promise<DataStructure[]> {
    return this.http.json<DataStructure[]>(
      `/v1/projects/${encodeURIComponent(projectId)}/structures`,
    );
  }

  /** Create a new data structure within a project. */
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
}
