/**
 * @basefyio/data-engine
 *
 * Provider-agnostic document data plane for the Basefyio platform.
 *
 * Usage:
 *   const engine = createDataEngine(config);
 *   const collection = engine.collection('prj_123', 'patients');
 *   await collection.insert({ firstName: 'John' }, { userId: 'user_1' });
 */

// ── Interfaces ─────────────────────────────────────────────

export type {
  DataEngine,
  EntityCollection,
} from './interfaces/data-engine';

export {
  DataEngineError,
  DocumentNotFoundError,
  ConcurrencyError,
  EntityNotFoundError,
  SchemaValidationError,
  TenantNotProvisionedError,
  QueryValidationError,
  DocumentTooLargeError,
} from './interfaces/data-engine';

// ── Types ──────────────────────────────────────────────────

export type {
  JsonPrimitive,
  JsonArray,
  JsonObject,
  JsonValue,
  DocumentEnvelope,
  DocumentStatus,
  StoredDocument,
  DocResult,
  IsolationTier,
  EntityStorageStrategy,
  TenantDataPlane,
  ProviderCapabilities,
  VectorCapabilities,
  WriteOpts,
  Page,
  DataEngineEvent,
  DataEngineEventType,
  DataEngineConfig,
} from './interfaces/types';

export { RESERVED_FIELDS } from './interfaces/types';

// ── Query ──────────────────────────────────────────────────

export type {
  PathRef,
  FilterOperator,
  FieldFilter,
  LogicalFilter,
  NotFilter,
  Filter,
  SortClause,
  IndexField,
  IndexDef,
  EntityQuery,
  MatchStage,
  ProjectStage,
  UnwindStage,
  GroupStage,
  SortStage,
  LimitStage,
  SkipStage,
  AggregationStage,
  EntityAggregation,
  DataEngineSqlQuery,
  SavedDataQueryDef,
  QueryExplainResult,
  ProjectExpression,
  Accumulator,
  AccumulatorOp,
} from './interfaces/query';

export {
  BLOCKED_AGGREGATION_STAGES,
  ALLOWED_AGGREGATION_STAGES,
  ALLOWED_ACCUMULATORS,
} from './interfaces/query';

// ── Schema ─────────────────────────────────────────────────

export type {
  FieldKind,
  ScalarType,
  ValidationRuleType,
  ValidationRule,
  EntityRuleTrigger,
  EntityRule,
  UiFieldConfig,
  EntityField,
  EntityDefinitionMeta,
  EntitySchemaVersionMeta,
  StructureDecision,
  StructureDecisionRecord,
  ApplicationModelMeta,
  ProjectionInclude,
  ComputedField,
  ProjectionCachePolicy,
  AppProjectionDef,
  MobileScreenType,
  MobileAction,
  MobileScreenModel,
  FormDefinitionMeta,
  WorkflowDefinitionMeta,
  ValidationError,
  ValidationResult,
} from './interfaces/schema';

// ── Tenancy ────────────────────────────────────────────────

export {
  sanitizeEntityName,
  dedicatedScopeName,
  validateEntityName,
  SHARED_NAMESPACE,
  SHARED_RECORDS_COLLECTION,
  DEFAULT_CONTAINER,
} from './tenancy/names';

export type {
  ProvisioningStatus,
  ProvisioningState,
} from './tenancy/provisioning';

export {
  VALID_TRANSITIONS,
  canTransition,
  RETRY_BACKOFF_MS,
  MAX_PROVISION_RETRIES,
} from './tenancy/provisioning';

// ── Validation / Schema Compiler ───────────────────────────

export {
  compileFieldsToJsonSchema,
  findReservedFieldConflicts,
  findViewerStateInDocument,
} from './validation/schema';

// ── Provider Factory ───────────────────────────────────────

import type { DataEngine } from './interfaces/data-engine';
import type { DataEngineConfig } from './interfaces/types';

/**
 * Create a DataEngine instance based on configuration.
 *
 * DATA_ENGINE_PROVIDER=nosql → requires couchbase peer dependency
 * DATA_ENGINE_PROVIDER=postgres → requires pg peer dependency
 */
export async function createDataEngine(config: DataEngineConfig): Promise<DataEngine> {
  switch (config.provider) {
    case 'nosql': {
      const { NoSqlDataEngine } = await import('./providers/nosql/nosql-engine');
      return new NoSqlDataEngine(config);
    }
    case 'postgres': {
      const { PostgresDataEngine } = await import('./providers/postgres/postgres-engine');
      return new PostgresDataEngine(config);
    }
    default:
      throw new Error(
        `Unknown DATA_ENGINE_PROVIDER: "${config.provider}". Expected "nosql" or "postgres".`,
      );
  }
}
