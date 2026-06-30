/**
 * Tenancy provisioning types and state machine.
 *
 * State machine: PENDING → PROVISIONING → READY | FAILED
 *                                           ↓
 *                                     DELETING → DELETED
 */

export type ProvisioningStatus =
  | 'PENDING'
  | 'PROVISIONING'
  | 'READY'
  | 'FAILED'
  | 'DELETING'
  | 'DELETED';

export interface ProvisioningState {
  projectId: string;
  status: ProvisioningStatus;
  provider: 'nosql' | 'postgres';
  namespace: string;
  tier: 'shared' | 'dedicated-scope';
  retryCount: number;
  lastError?: string;
  provisionedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Valid state transitions. */
export const VALID_TRANSITIONS: Record<ProvisioningStatus, ProvisioningStatus[]> = {
  PENDING: ['PROVISIONING'],
  PROVISIONING: ['READY', 'FAILED'],
  READY: ['DELETING'],
  FAILED: ['PROVISIONING', 'DELETING'],
  DELETING: ['DELETED', 'FAILED'],
  DELETED: [],
};

export function canTransition(from: ProvisioningStatus, to: ProvisioningStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Backoff schedule for provisioning retries: 1m, 5m, 15m, 1h. */
export const RETRY_BACKOFF_MS = [
  1 * 60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
  60 * 60 * 1000,
];

export const MAX_PROVISION_RETRIES = RETRY_BACKOFF_MS.length;
