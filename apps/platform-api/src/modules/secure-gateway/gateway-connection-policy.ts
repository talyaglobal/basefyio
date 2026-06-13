import type { StorageProviderType } from './data-storage-provider.interface';

export interface GatewayConnectionPolicy {
  projectId: string;
  requireMtls: boolean;
  allowedAccess: 'READ' | 'READ_WRITE';
  maxConnections: number;
  queryTimeoutMs: number;
  maxRowLimit: number;
  maxPayloadBytes: number;
  providerType: StorageProviderType;
}

export function defaultPolicy(
  projectId: string,
  accessLevel: 'READ' | 'READ_WRITE' = 'READ',
): GatewayConnectionPolicy {
  return {
    projectId,
    requireMtls: true,
    allowedAccess: accessLevel,
    maxConnections: 5,
    queryTimeoutMs: 30_000,
    maxRowLimit: 1_000,
    maxPayloadBytes: 5 * 1024 * 1024, // 5 MB
    providerType: 'postgres-jsonb',
  };
}
