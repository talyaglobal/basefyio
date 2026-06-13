import { Injectable, Logger, NotImplementedException } from '@nestjs/common';
import type {
  ConnectionParams,
  DataStorageProvider,
  QueryResult,
  StorageProviderType,
} from '../data-storage-provider.interface';

/**
 * mTLS-secured MongoDB provider — guarded stub.
 *
 * connect() and ping() are wired stubs; query() throws NotImplementedException
 * to give a clear signal rather than silently returning empty rows.
 *
 * Full implementation requires a real MongoDB driver with TLS stream support.
 * Until that adapter is ready, select GATEWAY_STORAGE_PROVIDER=postgres-jsonb
 * or GATEWAY_STORAGE_PROVIDER=secure-postgres.
 */
@Injectable()
export class SecureMongoProvider implements DataStorageProvider {
  readonly providerType: StorageProviderType = 'secure-mongo';
  private readonly logger = new Logger(SecureMongoProvider.name);

  private connected = false;

  async connect(params: ConnectionParams): Promise<void> {
    if (!params.sslCert || !params.sslKey || !params.sslCa) {
      throw new Error('SecureMongoProvider: mTLS requires sslCert, sslKey, and sslCa');
    }
    // Stub: track connected state; real driver setup deferred
    this.connected = true;
    this.logger.warn(
      `SecureMongoProvider is a stub — query() will throw. ` +
      `Connected to ${params.host}:${params.port}/${params.database} (not verified).`,
    );
  }

  query(_sql: string, _params?: unknown[]): Promise<QueryResult> {
    throw new NotImplementedException(
      'SecureMongoProvider: MongoDB query execution is not yet implemented. ' +
      'Use postgres-jsonb or secure-postgres as GATEWAY_STORAGE_PROVIDER.',
    );
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async ping(): Promise<boolean> {
    return this.connected;
  }
}
