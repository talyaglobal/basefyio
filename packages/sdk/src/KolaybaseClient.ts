import { KolaybaseFetchClient } from './lib/fetch.js';
import type { KolaybaseClientOptions, KolaybaseResponse } from './lib/types.js';
import { KOLAYBASE_DEFAULT_API_URL } from './lib/types.js';
import { AuthClient } from './modules/auth.js';
import { DatabaseClient, QueryBuilder } from './modules/database.js';
import { StorageClient } from './modules/storage.js';

function getEnv(key: string): string | undefined {
  try {
    if (typeof globalThis !== 'undefined' && (globalThis as any).process?.env) {
      return (globalThis as any).process.env[key];
    }
  } catch {}
  return undefined;
}

export class KolaybaseClient {
  readonly auth: AuthClient;
  readonly storage: StorageClient;

  private db: DatabaseClient;
  private http: KolaybaseFetchClient;
  private projectId: string;

  constructor(options: KolaybaseClientOptions = {}) {
    const projectId = options.projectId || getEnv('KOLAYBASE_PROJECT_ID');
    const apiKey = options.apiKey || getEnv('KOLAYBASE_ANON_KEY');
    const apiUrl = (options.apiUrl || getEnv('KOLAYBASE_API_URL') || KOLAYBASE_DEFAULT_API_URL).replace(/\/+$/, '');

    if (!projectId) {
      throw new Error('Missing projectId. Pass it to createClient() or set KOLAYBASE_PROJECT_ID env variable.');
    }
    if (!apiKey) {
      throw new Error('Missing apiKey. Pass it to createClient() or set KOLAYBASE_ANON_KEY env variable.');
    }

    const baseUrl = apiUrl.endsWith('/api') ? apiUrl : `${apiUrl}/api`;
    this.projectId = projectId;

    this.http = new KolaybaseFetchClient(
      baseUrl,
      apiKey,
      options.headers ?? {},
      () => this.auth.getAccessToken(),
    );

    this.auth = new AuthClient(this.http, options.autoRefreshToken ?? true);
    this.db = new DatabaseClient(this.http, this.projectId);
    this.storage = new StorageClient(this.http, this.projectId);
  }

  /**
   * Start building a query on a table.
   *
   * @example
   * const { data } = await kb.from('users').select('*').eq('active', true)
   */
  from<T = Record<string, unknown>>(table: string): QueryBuilder<T> {
    return this.db.from<T>(table);
  }

  /**
   * Execute a raw SQL query.
   *
   * @example
   * const { data } = await kb.sql('SELECT * FROM users WHERE id = 1')
   */
  async sql<T = Record<string, unknown>>(query: string): Promise<KolaybaseResponse<T[]>> {
    return this.db.sql<T>(query);
  }

  /**
   * List all tables in the project database.
   */
  async listTables() {
    return this.db.listTables();
  }

  /**
   * Get column information for a table.
   */
  async getColumns(table: string) {
    return this.db.getColumns(table);
  }
}

/**
 * Create a new Kolaybase client.
 *
 * @example
 * ```ts
 * import { createClient } from 'kolaybase-js'
 *
 * // Reads KOLAYBASE_PROJECT_ID and KOLAYBASE_ANON_KEY from .env automatically
 * const kb = createClient()
 *
 * // Or pass explicitly
 * const kb2 = createClient({ projectId: '...', apiKey: '...' })
 * ```
 */
export function createClient(options?: KolaybaseClientOptions): KolaybaseClient {
  return new KolaybaseClient(options);
}
