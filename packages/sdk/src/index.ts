export interface BasefyioClientOptions {
  /** Base URL of the platform API, e.g. http://localhost:4000 */
  url: string;
  /** Project slug to scope requests to */
  projectSlug: string;
  /** Project API key */
  apiKey: string;
  /** Custom fetch implementation (defaults to global fetch) */
  fetch?: typeof fetch;
}

export interface SqlResult<T = unknown> {
  data: T[] | null;
  error: string | null;
}

export interface HealthResult {
  status: string;
  [key: string]: unknown;
}

export interface BasefyioClient {
  /** Hit the platform health endpoint. */
  health(): Promise<HealthResult>;
  /** Execute a SQL statement against the project database. */
  sql<T = unknown>(query: string, params?: unknown[]): Promise<SqlResult<T>>;
}

export function createClient(options: BasefyioClientOptions): BasefyioClient {
  if (!options?.url) throw new Error('createClient: "url" is required');
  if (!options.projectSlug) throw new Error('createClient: "projectSlug" is required');
  if (!options.apiKey) throw new Error('createClient: "apiKey" is required');

  const baseUrl = options.url.replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error(
      'No fetch implementation available. Use Node 20+ or pass options.fetch.',
    );
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${options.apiKey}`,
    'x-basefyio-project': options.projectSlug,
  };

  return {
    async health(): Promise<HealthResult> {
      const res = await doFetch(`${baseUrl}/health`, { headers });
      if (!res.ok) throw new Error(`health check failed: ${res.status}`);
      return (await res.json()) as HealthResult;
    },

    async sql<T = unknown>(query: string, params: unknown[] = []): Promise<SqlResult<T>> {
      const res = await doFetch(`${baseUrl}/projects/${options.projectSlug}/sql`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, params }),
      });
      const body = (await res.json().catch(() => null)) as
        | { data?: T[]; error?: string }
        | null;
      if (!res.ok) {
        return { data: null, error: body?.error ?? `request failed: ${res.status}` };
      }
      return { data: body?.data ?? [], error: null };
    },
  };
}
