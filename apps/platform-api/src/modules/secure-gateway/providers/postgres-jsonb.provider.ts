import { Injectable, Logger } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import type {
  ConnectionParams,
  DataStorageProvider,
  QueryResult,
  StorageProviderType,
} from '../data-storage-provider.interface';
import { sanitizePgError } from './provider-error-sanitizer';

const POOL_MAX = 5;
const IDLE_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Standard PostgreSQL provider without mTLS.
 * Uses a persistent pg.Pool for the lifetime of a gateway session.
 * Queries are always parameterized — string interpolation is never used.
 */
@Injectable()
export class PostgresJsonbProvider implements DataStorageProvider {
  readonly providerType: StorageProviderType = 'postgres-jsonb';
  private readonly logger = new Logger(PostgresJsonbProvider.name);

  private pool: Pool | null = null;

  async connect(params: ConnectionParams): Promise<void> {
    // Idempotent — tear down any existing pool before creating a new one
    await this.disconnect();

    const newPool = new Pool({
      host: params.host,
      port: params.port,
      database: params.database,
      user: params.username,
      password: params.password,
      max: POOL_MAX,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    });

    // Verify connectivity before committing the pool reference
    let client: PoolClient | undefined;
    try {
      client = await newPool.connect();
      await client.query('SELECT 1');
      this.pool = newPool;
      this.logger.log(`Connected to postgres-jsonb at ${params.host}:${params.port}/${params.database}`);
    } catch (err) {
      await newPool.end().catch(() => {});
      throw sanitizePgError(err);
    } finally {
      client?.release();
    }
  }

  /**
   * Execute a parameterized query.
   * params are bound via the pg driver's placeholder mechanism ($1, $2, …).
   * String interpolation into sql is never performed.
   */
  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.pool) {
      throw new Error('PostgresJsonbProvider: not connected. Call connect() first.');
    }

    const client = await this.pool.connect();
    try {
      const result = await client.query(sql, params as any[] | undefined);
      return {
        rows: result.rows,
        rowCount: result.rowCount ?? result.rows.length,
      };
    } catch (err) {
      throw sanitizePgError(err);
    } finally {
      client.release();
    }
  }

  async disconnect(): Promise<void> {
    // Null the reference first so concurrent callers see it gone immediately
    const p = this.pool;
    this.pool = null;
    if (p) {
      await p.end().catch((err) =>
        this.logger.warn(`Pool end warning: ${sanitizePgError(err).message}`),
      );
    }
  }

  async ping(): Promise<boolean> {
    if (!this.pool) return false;
    const client = await this.pool.connect().catch(() => null);
    if (!client) return false;
    try {
      await client.query('SELECT 1');
      return true;
    } catch {
      return false;
    } finally {
      client.release();
    }
  }
}
