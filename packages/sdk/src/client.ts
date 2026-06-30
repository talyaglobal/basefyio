import { HttpClient } from './http';
import { SqlResource } from './resources/sql';
import { StorageResource } from './resources/storage';
import type { HealthResult } from './types';

export interface ClientOptions {
  /** Base URL of the platform API, e.g. http://localhost:4000 */
  url: string;
  /** UUID of the project to scope operations to */
  projectId: string;
  /** Project API key for authentication */
  apiKey: string;
  /** Custom fetch implementation (defaults to globalThis.fetch, requires Node 20+) */
  fetch?: typeof fetch;
}

export interface ProjectClient {
  readonly sql: SqlResource;
  readonly storage: StorageResource;
  health(): Promise<HealthResult>;
}

export function createClient(options: ClientOptions): ProjectClient {
  if (!options?.url) throw new Error('createClient: "url" is required');
  if (!options.projectId) throw new Error('createClient: "projectId" is required');
  if (!options.apiKey) throw new Error('createClient: "apiKey" is required');

  const fetchFn = options.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('No fetch implementation available. Pass options.fetch or use Node 20+.');
  }

  const baseUrl = options.url.replace(/\/+$/, '');
  const http = new HttpClient(baseUrl, fetchFn);
  http.setApiKey(options.apiKey);

  return {
    sql: new SqlResource(http, options.projectId),
    storage: new StorageResource(http, options.projectId),
    health(): Promise<HealthResult> {
      return http.get('/health');
    },
  };
}
