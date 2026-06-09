import { BasefyioFetchClient } from './lib/fetch.js';
import type { BasefyioClientOptions, BasefyioResponse } from './lib/types.js';
import { BASEFYIO_DEFAULT_API_URL } from './lib/types.js';
import { AuthClient } from './modules/auth.js';
import { DatabaseClient, QueryBuilder } from './modules/database.js';
import { StorageClient } from './modules/storage.js';
import { CollectionManager, CollectionClient } from './modules/collection.js';
import { DataEngineClient, EntityClient } from './modules/data-engine.js';

function getEnv(key: string): string | undefined {
  try {
    if (typeof globalThis !== 'undefined' && (globalThis as any).process?.env) {
      return (globalThis as any).process.env[key];
    }
  } catch {}
  return undefined;
}

export class BasefyioClient {
  readonly auth: AuthClient;
  readonly storage: StorageClient;
  readonly collections: CollectionManager;
  readonly data: DataEngineClient;

  private db: DatabaseClient;
  private http: BasefyioFetchClient;
  private projectId: string;

  constructor(options: BasefyioClientOptions = {}) {
    const projectId = options.projectId || getEnv('BASEFYIO_PROJECT_ID');
    const apiKey = options.apiKey || getEnv('BASEFYIO_ANON_KEY');
    const apiUrl = (options.apiUrl || getEnv('BASEFYIO_API_URL') || BASEFYIO_DEFAULT_API_URL).replace(/\/+$/, '');

    if (!projectId) {
      throw new Error('Missing projectId. Pass it to createClient() or set BASEFYIO_PROJECT_ID env variable.');
    }
    if (!apiKey) {
      throw new Error('Missing apiKey. Pass it to createClient() or set BASEFYIO_ANON_KEY env variable.');
    }

    const baseUrl = apiUrl.endsWith('/api') ? apiUrl : `${apiUrl}/api`;
    this.projectId = projectId;

    this.http = new BasefyioFetchClient(
      baseUrl,
      apiKey,
      options.headers ?? {},
      () => this.auth.getAccessToken(),
    );

    this.auth = new AuthClient(this.http, options.autoRefreshToken ?? true);
    this.db = new DatabaseClient(this.http, this.projectId);
    this.storage = new StorageClient(this.http, this.projectId);
    this.collections = new CollectionManager(this.http, this.projectId);
    this.data = new DataEngineClient(this.http, this.projectId);
  }

  /**
   * Start building a query on a table.
   *
   * @example
   * const { data } = await bf.from('users').select('*').eq('active', true)
   */
  from<T = Record<string, unknown>>(table: string): QueryBuilder<T> {
    return this.db.from<T>(table);
  }

  /**
   * Execute a raw SQL query.
   *
   * **WARNING: This method executes raw SQL. NEVER pass unsanitized user input
   * directly into the query string, as this creates SQL injection vulnerabilities.
   * Always validate and sanitize any dynamic values before including them.**
   *
   * @example
   * const { data } = await bf.sql('SELECT * FROM users WHERE id = 1')
   */
  async sql<T = Record<string, unknown>>(query: string): Promise<BasefyioResponse<T[]>> {
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

  /**
   * Get a CollectionClient for document operations on a NoSQL collection.
   *
   * @example
   * const { data } = await bf.collection('posts').insert({ title: 'Hello' })
   * const { data } = await bf.collection('posts').find({ status: 'active' }).sort('views', 'desc').limit(10)
   * await bf.collection('posts').updateById(id, { views: 42 })
   */
  collection<T = Record<string, unknown>>(name: string): CollectionClient<T> {
    return this.collections.get<T>(name);
  }
}

/**
 * Create a new basefyio client.
 *
 * @example
 * ```ts
 * import { createClient } from 'basefyio-js'
 *
 * // Reads BASEFYIO_PROJECT_ID and BASEFYIO_ANON_KEY from .env automatically
 * const bf= createClient()
 *
 * // Or pass explicitly
 * const bf2 = createClient({ projectId: '...', apiKey: '...' })
 * ```
 */
export function createClient(options?: BasefyioClientOptions): BasefyioClient {
  return new BasefyioClient(options);
}
