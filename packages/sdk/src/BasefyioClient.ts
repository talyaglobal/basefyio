import { BasefyioFetchClient } from './lib/fetch.js';
import type { AuthStorage, BasefyioClientOptions, BasefyioResponse } from './lib/types.js';
import { toBasefyioError, toJson } from './lib/errors.js';
import { BASEFYIO_DEFAULT_API_URL } from './lib/types.js';
import { resolveEnv } from './lib/env.js';
import { AuthClient } from './modules/auth.js';
import { DatabaseClient, QueryBuilder } from './modules/database.js';
import { StorageClient } from './modules/storage.js';
import { CollectionManager, CollectionClient } from './modules/collection.js';
import { DataEngineClient, EntityClient } from './modules/data-engine.js';
import { RealtimeClient } from './modules/realtime.js';

export class BasefyioClient {
  readonly auth: AuthClient;
  readonly storage: StorageClient;
  readonly collections: CollectionManager;
  readonly data: DataEngineClient;
  readonly realtime: RealtimeClient;

  private db: DatabaseClient;
  private http: BasefyioFetchClient;
  private projectId: string;

  constructor(options: BasefyioClientOptions = {}) {
    const projectId = options.projectId || resolveEnv('BASEFYIO_PROJECT_ID', 'KOLAYBASE_PROJECT_ID');
    const apiKey = options.apiKey || resolveEnv('BASEFYIO_ANON_KEY', 'KOLAYBASE_ANON_KEY');
    const apiUrl = (options.apiUrl || resolveEnv('BASEFYIO_API_URL', 'KOLAYBASE_API_URL') || BASEFYIO_DEFAULT_API_URL).replace(/\/+$/, '');

    // In a browser there is no process.env to read, so the variables cannot
    // be the answer there; say what is.
    const inBrowser = typeof (globalThis as { window?: unknown }).window !== 'undefined';
    const fromEnv = inBrowser
      ? 'Environment variables are not read in the browser: pass it to createClient({ projectId, apiKey }) explicitly.'
      : 'Pass it to createClient() or set the BASEFYIO_PROJECT_ID / BASEFYIO_ANON_KEY environment variables.';
    if (!projectId) {
      throw new Error(`Missing projectId. ${fromEnv}`);
    }
    if (!apiKey) {
      throw new Error(`Missing apiKey. ${fromEnv}`);
    }

    const baseUrl = apiUrl.endsWith('/api') ? apiUrl : `${apiUrl}/api`;
    this.projectId = projectId;

    this.http = new BasefyioFetchClient(
      baseUrl,
      apiKey,
      options.headers ?? {},
      () => this.auth.getAccessToken(),
    );

    this.auth = new AuthClient(
      this.http,
      options.autoRefreshToken ?? true,
      sessionPersistence(options, projectId),
    );
    this.db = new DatabaseClient(this.http, this.projectId);
    this.storage = new StorageClient(this.http, this.projectId);
    this.collections = new CollectionManager(this.http, this.projectId);
    this.data = new DataEngineClient(this.http, this.projectId);
    // Realtime adds /api itself; an apiUrl given with /api must not get it twice.
    this.realtime = new RealtimeClient(apiUrl.replace(/\/api$/, ''), apiKey, {
      tokenAccessor: () => this.auth.getAccessToken(),
    });
  }

  /**
   * Call a database function (`POST /api/rest/v1/rpc/<fn>`): `args` are its
   * arguments by name. Resolves to `{ data, error }` like every other call —
   * `data` is the rows the function returned, and a failure is returned as
   * `error` instead of being thrown.
   *
   * For code written against earlier releases, a successful result is also
   * still the rows array itself (`const rows = await bf.rpc(...)` keeps
   * working); that form is deprecated — read `data`.
   *
   * @example
   * const { data, error } = await bf.rpc('hello', { name: 'world' })
   */
  async rpc<T = Record<string, unknown>>(
    fn: string,
    args: Record<string, unknown> = {},
  ): Promise<BasefyioResponse<T[]>> {
    try {
      const rows = await this.http.json<T[]>(`/rest/v1/rpc/${encodeURIComponent(fn)}`, {
        method: 'POST',
        body: toJson(args),
      });
      const data = Array.isArray(rows) ? rows : [];
      return Object.assign(data.slice(), { data, error: null }) as unknown as BasefyioResponse<T[]>;
    } catch (err: unknown) {
      return { data: null, error: toBasefyioError(err) };
    }
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
   * Execute a raw SQL query, with its values bound.
   *
   * **Pass values as `params`, never inside the query string.** A value written
   * into SQL can become syntax, and it can also be read as an *operation*: the
   * API scans the statement for forbidden operations and reads string literals
   * too, so a sentence containing "copy", "grant" or "load" is refused as the
   * operation it names. A bound value is neither.
   *
   * @example
   * const { data } = await bf.sql('SELECT * FROM users WHERE id = $1', [id])
   */
  async sql<T = Record<string, unknown>>(
    query: string,
    params?: unknown[],
  ): Promise<BasefyioResponse<T[]>> {
    return this.db.sql<T>(query, params);
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

/** The session store for `auth.persistSession`, or null to keep the session in memory. */
function sessionPersistence(
  options: BasefyioClientOptions,
  projectId: string,
): { storage: AuthStorage; key: string } | null {
  if (!options.auth?.persistSession) return null;
  let storage = options.auth.storage;
  if (!storage) {
    try {
      storage = (globalThis as { localStorage?: AuthStorage }).localStorage;
    } catch {
      storage = undefined;
    }
  }
  if (!storage) return null;
  return { storage, key: options.auth.storageKey ?? `basefyio.auth.${projectId}` };
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
