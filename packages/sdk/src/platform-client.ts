import { HttpClient } from './http';
import { AuthResource } from './resources/auth';
import { ProjectsResource } from './resources/projects';
import type { HealthResult } from './types';

export interface PlatformClientOptions {
  /** Base URL of the platform API, e.g. http://localhost:4000 */
  url: string;
  /** Pre-existing JWT access token (optional — or call auth.signIn() after creation) */
  initialToken?: string;
  /** Custom fetch implementation (defaults to globalThis.fetch, requires Node 20+) */
  fetch?: typeof fetch;
}

export interface PlatformClient {
  readonly auth: AuthResource;
  readonly projects: ProjectsResource;
  setToken(token: string | null): void;
  getToken(): string | null;
  health(): Promise<HealthResult>;
}

export function createPlatformClient(options: PlatformClientOptions): PlatformClient {
  if (!options?.url) throw new Error('createPlatformClient: "url" is required');

  const fetchFn = options.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('No fetch implementation available. Pass options.fetch or use Node 20+.');
  }

  const baseUrl = options.url.replace(/\/+$/, '');
  const http = new HttpClient(baseUrl, fetchFn);

  if (options.initialToken) {
    http.setToken(options.initialToken);
  }

  return {
    auth: new AuthResource(http),
    projects: new ProjectsResource(http),

    setToken(token: string | null): void {
      http.setToken(token);
    },

    getToken(): string | null {
      return http.getToken();
    },

    health(): Promise<HealthResult> {
      return http.get('/health');
    },
  };
}
