import type { BasefyioFetchClient } from '../lib/fetch.js';

export interface EndpointSnippets {
  psql?: string;
  dbeaver?: string;
  compass?: string;
  sdkExample?: string;
}

export interface EndpointView {
  engineType: string;
  host: string;
  port: number;
  username: string;
  database: string;
  requiresClientCert: boolean;
  accessLevel: string;
  active: boolean;
  connectionString: string;   // never includes password
  sslMode: string;
  snippets: EndpointSnippets;
}

export interface ProjectAccessInfo {
  projectId: string;
  slug: string;
  endpoints: EndpointView[];
  entitlements: Record<string, boolean>;
  warning?: string;
}

export class AccessClient {
  constructor(private readonly http: BasefyioFetchClient) {}

  async getProjectAccess(projectId: string): Promise<ProjectAccessInfo> {
    return this.http.json<ProjectAccessInfo>(
      `/v1/projects/${encodeURIComponent(projectId)}/access`,
    );
  }
}
