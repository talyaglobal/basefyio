import { KolaybaseFetchClient } from './lib/fetch.js';
import type { KolaybaseClientOptions, KolaybaseResponse } from './lib/types.js';
import { AuthClient } from './modules/auth.js';
import { DatabaseClient, QueryBuilder } from './modules/database.js';
import { StorageClient } from './modules/storage.js';

export class KolaybaseClient {
  readonly auth: AuthClient;
  readonly storage: StorageClient;

  private db: DatabaseClient;
  private http: KolaybaseFetchClient;
  private projectId: string;

  constructor(options: KolaybaseClientOptions) {
    const apiUrl = options.apiUrl.replace(/\/+$/, '');
    const baseUrl = apiUrl.endsWith('/api') ? apiUrl : `${apiUrl}/api`;

    this.projectId = options.projectId;

    this.http = new KolaybaseFetchClient(
      baseUrl,
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
 * import { createClient } from '@kolaybase/sdk'
 *
 * const kb = createClient({
 *   apiUrl: 'http://localhost:4000',
 *   projectId: 'your-project-id',
 * })
 *
 * await kb.auth.signIn({ username: 'admin', password: 'pass' })
 *
 * const { data } = await kb.from('users').select('*')
 * ```
 */
export function createClient(options: KolaybaseClientOptions): KolaybaseClient {
  return new KolaybaseClient(options);
}
