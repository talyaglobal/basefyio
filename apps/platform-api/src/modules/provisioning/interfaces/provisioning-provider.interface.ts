export const PROVISIONING_PROVIDER = 'PROVISIONING_PROVIDER';

// ── Current-resource snapshot passed to plan() ───────────────

/** Snapshot of a DB resource row, passed by the executor to the provider for diffing. */
export interface ProviderCurrentResource {
  id: string;
  /** Prisma `kind` value (uppercase in DB, e.g. 'SERVER'). */
  type: string;
  name: string;
  status: string;
  desiredSpec: Record<string, unknown>;
  actualSpec: Record<string, unknown> | null;
  externalId: string | null;
}

// ── Provider plan types ──────────────────────────────────────

export type UpdateStrategy = 'resize' | 'rebuild' | 'set_rules' | 'update';

export interface ProviderPlanAction {
  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'NOOP';
  resourceType: string;
  resourceName: string;
  reason: string;
  desiredSpec?: Record<string, unknown>;
  currentSpec?: Record<string, unknown>;
  /** Provider-classified sub-strategy for UPDATE actions. Absent for non-UPDATE actions. */
  updateStrategy?: UpdateStrategy;
  /** Provider-specific extra data not covered by the generic fields. */
  providerMeta?: Record<string, unknown>;
}

export interface ProviderPlan {
  actions: ProviderPlanAction[];
  /** Unsupported resource kinds or other non-fatal validation problems. */
  validationErrors: string[];
}

// ── Execute input / result ───────────────────────────────────

export interface ProvisioningExecuteInput {
  operationId: string;
  projectId: string;
  providerType: string;
  region: string;
  datacenter: string | null;
  /** The operation's input payload (desired resource spec). */
  desiredSpec: unknown;
  /** OpenBao path reference only — the provider resolves the actual secret; the executor never does. */
  credentialOpenbaoPath: string;
  /** Current resources from DB, used by the provider's planner for diffing. */
  currentResources: ProviderCurrentResource[];
  /**
   * Whether the calling operation is a dry-run.
   * When true, providers must NOT resolve secrets or make mutating API calls.
   * Defaults to false; the executor always passes false (DRY_RUN ops never reach it).
   */
  dryRun?: boolean;
}

/**
 * Domain shape for a single resource reported by the provider.
 * Maps to ProvisioningResource rows via the projection layer —
 * never stored directly as a DB row.
 */
export interface ProvisioningResourceResult {
  /** Provider-assigned identifier for the resource. */
  externalId: string;
  /** Matches a ProvisioningResourceKind value (case-insensitive). */
  type: string;
  name: string;
  desiredSpec: Record<string, unknown>;
  actualSpec: Record<string, unknown>;
  /** Only ACTIVE is valid for a successful execution result. */
  status: 'ACTIVE';
}

export interface ProvisioningExecuteResult {
  success: boolean;
  resources: ProvisioningResourceResult[];
  metadata?: Record<string, unknown>;
}

// ── Provider interface ───────────────────────────────────────

export interface IProvisioningProvider {
  /**
   * Compute a provider-specific plan from current + desired state.
   * Validates resource kinds and returns validation errors for unsupported types
   * rather than throwing — unsupported kinds are skipped, not fatal.
   */
  plan(input: ProvisioningExecuteInput): ProviderPlan;

  /**
   * Apply the plan against the provider backend.
   * Phase 8: dry-run only — no real API calls; returns plan metadata with empty resources.
   * Phase 9+: real calls; returns created/updated resource rows.
   */
  apply(input: ProvisioningExecuteInput): Promise<ProvisioningExecuteResult>;
}
