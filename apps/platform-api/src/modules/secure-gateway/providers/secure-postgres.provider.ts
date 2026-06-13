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
 * mTLS-secured PostgreSQL provider.
 * Requires sslCert, sslKey, and sslCa in ConnectionParams.
 *
 * Key-material invariant:
 *  - sslKey is passed directly to the pg driver's ssl.key field — never logged,
 *    serialised, or stored outside of pool runtime memory.
 *  - On disconnect() the local sslKeyRef is cleared; the pg driver's internal
 *    copy is released when the pool object is garbage-collected.
 *  - Error messages are sanitized via sanitizePgError() before re-throwing.
 */
@Injectable()
export class SecurePostgresProvider implements DataStorageProvider {
  readonly providerType: StorageProviderType = 'secure-postgres';
  private readonly logger = new Logger(SecurePostgresProvider.name);

  private pool: Pool | null = null;
  // Held only so disconnect() can clear it; never logged or serialised.
  private sslKeyRef: string | undefined;

  async connect(params: ConnectionParams): Promise<void> {
    if (!params.sslCert || !params.sslKey || !params.sslCa) {
      throw new Error('SecurePostgresProvider: mTLS requires sslCert, sslKey, and sslCa');
    }

    // Idempotent — clear any existing pool first
    await this.disconnect();

    this.sslKeyRef = params.sslKey;

    const newPool = new Pool({
      host: params.host,
      port: params.port,
      database: params.database,
      user: params.username,
      max: POOL_MAX,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      ssl: {
        cert: params.sslCert,
        key: params.sslKey, // in-memory only — never logged or serialised
        ca: params.sslCa,
        rejectUnauthorized: true,
      },
    });

    let client: PoolClient | undefined;
    try {
      client = await newPool.connect();
      await client.query('SELECT 1');
      this.pool = newPool;
      this.logger.log(
        `mTLS connected to secure-postgres at ${params.host}:${params.port}/${params.database}`,
      );
    } catch (err) {
      await newPool.end().catch(() => {});
      this.sslKeyRef = undefined;
      throw sanitizePgError(err);
    } finally {
      client?.release();
    }
  }

  /**
   * Execute a parameterized query.
   * Params are bound via pg placeholders ($1, $2, …) — no string interpolation.
   */
  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.pool) {
      throw new Error('SecurePostgresProvider: not connected. Call connect() first.');
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
    const p = this.pool;
    this.pool = null;
    // Clear our reference to the private key; pg's internal copy is released with the pool
    this.sslKeyRef = undefined;
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
