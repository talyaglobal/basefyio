/**
 * Basefyio Data Engine — Provider Interface
 *
 * This is the contract that every provider (NoSQL store, PostgreSQL) must implement.
 * No vendor-specific types, SDKs, or naming may appear in this file.
 */

import type {
  DocResult,
  IsolationTier,
  JsonObject,
  Page,
  ProviderCapabilities,
  TenantDataPlane,
  WriteOpts,
} from './types';

import type {
  EntityQuery,
  EntityAggregation,
  Filter,
  IndexDef,
  QueryExplainResult,
} from './query';

// ── Entity Collection ──────────────────────────────────────

/**
 * Operations on a single entity's documents within a project.
 * The _projectId filter is injected server-side — callers cannot omit or override it.
 */
export interface EntityCollection {
  /** Insert a new document. Returns the created document with envelope. */
  insert(doc: JsonObject, opts?: WriteOpts): Promise<DocResult>;

  /** Get a document by _id. Returns null if not found (or soft-deleted). */
  get(id: string): Promise<DocResult | null>;

  /**
   * Partial update — merge fields into existing document.
   * If opts.ifMatch is set, fails with ConcurrencyError if _version doesn't match.
   */
  update(id: string, patch: JsonObject, opts?: WriteOpts): Promise<DocResult>;

  /**
   * Full replacement — replace entire user data, keeping envelope.
   * If opts.ifMatch is set, fails with ConcurrencyError if _version doesn't match.
   */
  replace(id: string, doc: JsonObject, opts?: WriteOpts): Promise<DocResult>;

  /** Soft-delete a document (sets _deletedAt, _status='deleted'). */
  delete(id: string, opts?: WriteOpts): Promise<void>;

  /** Query documents with filter, sort, pagination, projection. */
  query(q: EntityQuery): Promise<Page<DocResult>>;

  /** Count documents matching an optional filter. */
  count(filter?: Filter): Promise<number>;

  /** Ensure indexes exist for this entity's collection. Idempotent. */
  ensureIndexes(defs: IndexDef[]): Promise<void>;
}

// ── Data Engine (top-level interface) ──────────────────────

export interface DataEngine {
  /**
   * Provision data plane for a project.
   * Idempotent — safe to retry on failure.
   */
  provisionTenant(
    projectId: string,
    tier?: IsolationTier,
  ): Promise<TenantDataPlane>;

  /**
   * Deprovision data plane for a project.
   * Soft-deletes documents; actual purge happens after retention window.
   */
  deprovisionTenant(projectId: string): Promise<void>;

  /**
   * Get an EntityCollection handle for a specific entity within a project.
   * The returned collection automatically scopes all operations to the project.
   *
   * @param projectId - The project that owns this data.
   * @param entity - Logical entity name (e.g. "patients", "orders").
   */
  collection(projectId: string, entity: string): EntityCollection;

  /** Report what this provider supports. Callers branch on capabilities, never on provider name. */
  capabilities(): ProviderCapabilities;

  /** Health check — returns true if the backing store is reachable and responsive. */
  ping(): Promise<boolean>;

  /**
   * Execute an aggregation pipeline against an entity.
   * _projectId is injected server-side into the first $match.
   */
  aggregate(
    projectId: string,
    aggregation: EntityAggregation,
  ): Promise<Page<JsonObject>>;

  /**
   * Explain a query or aggregation without executing it.
   * Never exposes provider-specific query text.
   */
  explain(
    projectId: string,
    query: EntityQuery | EntityAggregation,
  ): Promise<QueryExplainResult>;
}

// ── Errors ─────────────────────────────────────────────────

export class DataEngineError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
  ) {
    super(message);
    this.name = 'DataEngineError';
  }
}

export class DocumentNotFoundError extends DataEngineError {
  constructor(entity: string, id: string) {
    super(`Document "${id}" not found in entity "${entity}"`, 'DOCUMENT_NOT_FOUND', 404);
    this.name = 'DocumentNotFoundError';
  }
}

export class ConcurrencyError extends DataEngineError {
  constructor(entity: string, id: string, expected: number, actual: number) {
    super(
      `Concurrency conflict on "${entity}/${id}": expected version ${expected}, found ${actual}`,
      'CONCURRENCY_CONFLICT',
      409,
    );
    this.name = 'ConcurrencyError';
  }
}

export class EntityNotFoundError extends DataEngineError {
  constructor(entity: string) {
    super(`Entity "${entity}" is not registered`, 'ENTITY_NOT_FOUND', 404);
    this.name = 'EntityNotFoundError';
  }
}

export class SchemaValidationError extends DataEngineError {
  public readonly errors: Array<{ path: string; message: string }>;

  constructor(errors: Array<{ path: string; message: string }>) {
    super(
      `Validation failed: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
      'SCHEMA_VALIDATION_FAILED',
      422,
    );
    this.name = 'SchemaValidationError';
    this.errors = errors;
  }
}

export class TenantNotProvisionedError extends DataEngineError {
  constructor(projectId: string) {
    super(
      `Data plane not provisioned for project "${projectId}"`,
      'TENANT_NOT_PROVISIONED',
      503,
    );
    this.name = 'TenantNotProvisionedError';
  }
}

export class QueryValidationError extends DataEngineError {
  constructor(message: string) {
    super(message, 'QUERY_VALIDATION_FAILED', 400);
    this.name = 'QueryValidationError';
  }
}

export class DocumentTooLargeError extends DataEngineError {
  constructor(sizeKb: number, maxKb: number) {
    super(
      `Document size ${sizeKb}KB exceeds maximum ${maxKb}KB`,
      'DOCUMENT_TOO_LARGE',
      413,
    );
    this.name = 'DocumentTooLargeError';
  }
}
