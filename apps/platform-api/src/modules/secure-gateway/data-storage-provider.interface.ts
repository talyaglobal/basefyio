export const DATA_STORAGE_PROVIDER = 'DATA_STORAGE_PROVIDER';

export type StorageProviderType = 'postgres-jsonb' | 'secure-postgres' | 'secure-mongo';

export interface ConnectionParams {
  host: string;
  port: number;
  database: string;
  username?: string;
  password?: string;
  /** Client certificate PEM — used for mTLS; never persisted */
  sslCert?: string;
  /** Client private key PEM — in-memory only, never persisted */
  sslKey?: string;
  /** CA certificate PEM */
  sslCa?: string;
  requireMtls?: boolean;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  /** True when the provider returned more rows than the configured row limit */
  truncated?: boolean;
}

export interface DataStorageProvider {
  readonly providerType: StorageProviderType;
  connect(params: ConnectionParams): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  disconnect(): Promise<void>;
  ping(): Promise<boolean>;
}
