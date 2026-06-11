/**
 * Basefyio Data Engine — Core Type Definitions
 *
 * These types form the contract that all providers must implement.
 * No vendor-specific types may appear here.
 */

// ── Primitives ─────────────────────────────────────────────

export type JsonPrimitive = string | number | boolean | null;
export type JsonArray = JsonValue[];
export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

// ── Document Envelope ──────────────────────────────────────

/** Reserved envelope fields present on every stored document. */
export interface DocumentEnvelope {
  _id: string;
  _entity: string;
  _projectId: string;
  _schemaVersion: number;
  _version: number;
  _lastEventId: string | null;
  _eventSequence: number;
  _status: DocumentStatus;
  _createdAt: string;
  _updatedAt: string;
  _createdBy: string;
  _deletedAt: string | null;
}

export type DocumentStatus =
  | 'active'
  | 'draft'
  | 'archived'
  | 'deleted'
  | 'pending_approval';

/** A complete stored document: envelope + user data. */
export type StoredDocument = DocumentEnvelope & { [key: string]: JsonValue };

/** Result returned to callers after writes. */
export interface DocResult {
  _id: string;
  _version: number;
  _entity: string;
  _projectId: string;
  _schemaVersion: number;
  _status: DocumentStatus;
  _createdAt: string;
  _updatedAt: string;
  _createdBy: string;
  _eventSequence: number;
  [key: string]: JsonValue;
}

/** Reserved field names that user schemas may not define. */
export const RESERVED_FIELDS: ReadonlySet<string> = new Set([
  '_id', '_entity', '_projectId', '_schemaVersion', '_version',
  '_lastEventId', '_eventSequence', '_status',
  '_createdAt', '_updatedAt', '_createdBy', '_deletedAt',
]);

// ── Tenancy ────────────────────────────────────────────────

export type IsolationTier = 'shared' | 'dedicated-scope';

export type EntityStorageStrategy = 'collection' | 'shared-records';

export interface TenantDataPlane {
  projectId: string;
  tier: IsolationTier;
  /** Physical namespace in the store (e.g. scope name). */
  namespace: string;
  provisionedAt: string;
}

// ── Provider Capabilities ──────────────────────────────────

export interface VectorCapabilities {
  embeddings: boolean;
  hybridSearch: boolean;
}

export interface ProviderCapabilities {
  transactions: boolean;
  fullTextSearch: boolean;
  vectorSearch: boolean;
  ttl: boolean;
  vector?: VectorCapabilities;
}

// ── Write Options ──────────────────────────────────────────

export interface WriteOpts {
  /** Expected _version for optimistic concurrency (CAS). */
  ifMatch?: number;
  /** User ID performing the write. */
  userId?: string;
  /** Override _status (default: 'active'). */
  status?: DocumentStatus;
}

// ── Pagination ─────────────────────────────────────────────

export interface Page<T> {
  data: T[];
  total: number;
  hasMore: boolean;
  nextCursor?: string;
}

// ── Events ─────────────────────────────────────────────────

export type DataEngineEventType =
  | 'document.created'
  | 'document.updated'
  | 'document.deleted'
  | 'entity.created'
  | 'entity.schema.changed';

export interface DataEngineEvent {
  id: string;
  type: DataEngineEventType;
  projectId: string;
  entity: string;
  documentId?: string;
  schemaVersion: number;
  timestamp: string;
  payload?: JsonObject;
}

// ── Configuration ──────────────────────────────────────────

export interface DataEngineConfig {
  provider: 'nosql' | 'postgres' | 'couchdb';
  /** NoSQL store connection string. */
  connectionString?: string;
  username?: string;
  password?: string;
  /** Top-level container name (e.g. bucket). */
  container: string;
  /** Default namespace for shared tenants. */
  namespace: string;
  maxDocumentKb: number;
  maxNestingDepth: number;
  maxArrayItems: number;
}
