/**
 * basefyio Data Engine — Schema & Validation Types
 *
 * The metadata hierarchy:
 *   ApplicationModel → EntityDefinition → EntityField → ValidationRule → Document Store
 *
 * JSON Schema is the COMPILED OUTPUT of EntityField definitions, never hand-edited.
 */

import type { JsonObject, JsonValue } from './types';

// ── Field Types ────────────────────────────────────────────

export type FieldKind =
  | 'scalar'
  | 'object'
  | 'array'
  | 'lookup'
  | 'attachment'
  // Mobile-first primitives
  | 'media'
  | 'relation'
  | 'computed'
  | 'counter'
  | 'localizedText'
  | 'viewerState'
  | 'syncState';

export type ScalarType =
  | 'text'
  | 'longText'
  | 'number'
  | 'currency'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'email'
  | 'phone'
  | 'url'
  | 'json'
  | 'multiLookup';

// ── Validation Rules ───────────────────────────────────────

export type ValidationRuleType =
  | 'required'
  | 'minLength'
  | 'maxLength'
  | 'regex'
  | 'email'
  | 'phone'
  | 'minValue'
  | 'maxValue'
  | 'lookupExists'
  | 'customExpression';

export interface ValidationRule {
  id: string;
  type: ValidationRuleType;
  config: JsonObject;
  errorMessage?: string;
}

// ── Entity Rules (cross-field / business rules) ────────────

export type EntityRuleTrigger = 'beforeCreate' | 'beforeUpdate';

export interface EntityRule {
  id: string;
  trigger: EntityRuleTrigger;
  /** Safe expression — no eval. e.g. "endDate >= startDate" */
  expression: string;
  errorMessage: string;
}

// ── UI Config (hints for form builder) ─────────────────────

export interface UiFieldConfig {
  placeholder?: string;
  helpText?: string;
  hidden?: boolean;
  readOnly?: boolean;
  section?: string;
  order?: number;
  width?: 'full' | 'half' | 'third';
  component?: string;
}

// ── Entity Field Model ─────────────────────────────────────

export interface EntityField {
  id: string;
  name: string;
  displayName: string;
  kind: FieldKind;
  type?: ScalarType;
  required: boolean;
  unique: boolean;
  indexed: boolean;
  validationRules: ValidationRule[];
  /** Nested object fields. Only when kind === 'object'. */
  children?: EntityField[];
  /** Array item schema. Only when kind === 'array'. */
  itemSchema?: EntityField;
  ui?: UiFieldConfig;
  /** Default value for this field. */
  defaultValue?: JsonValue;
  /** For 'lookup' / 'relation' kind: target entity name. */
  lookupEntity?: string;
  /** For 'computed' kind: safe expression to compute value. */
  computeExpression?: string;
  /** For 'counter' kind: initial value. */
  counterInitial?: number;
  /** For 'localizedText': supported locales. */
  locales?: string[];
}

// ── Entity Definition ──────────────────────────────────────

export interface EntityDefinitionMeta {
  id: string;
  projectId: string;
  applicationModelId?: string;
  logicalName: string;
  displayName: string;
  physicalCollection: string;
  storageStrategy: 'collection' | 'shared-records';
  provider: 'nosql' | 'postgres';
  storageClass: 'standard' | 'hot' | 'archive';
  schemaVersion: number;
  fields: EntityField[];
  rules: EntityRule[];
  // AI builder provenance
  generatedByAI: boolean;
  description?: string;
  icon?: string;
  aiPrompt?: string;
  aiReasoning?: JsonObject;
  confidenceScore?: number;
  sourceWorkbook?: string;
  sourceSheet?: string;
  createdAt: string;
  updatedAt: string;
}

// ── Entity Schema Version ──────────────────────────────────

export interface EntitySchemaVersionMeta {
  id: string;
  entityDefinitionId: string;
  version: number;
  /** Complete JSON Schema snapshot — deterministic output of compileSchema(fields). */
  snapshot: JsonObject;
  /** Optional forward migration script for breaking changes. */
  migrationScript?: string;
  createdBy: string;
  createdAt: string;
}

// ── AI Provenance (embed vs relation vs projection decisions) ─────

export type StructureDecision = 'embedded-object' | 'embedded-array' | 'separate-entity-with-lookup';

export interface StructureDecisionRecord {
  field: string;
  decision: StructureDecision;
  reason: string;
}

// ── Application Model (skeletal root aggregate) ────────────

export interface ApplicationModelMeta {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  definition: JsonObject;
  version: number;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

// ── Projection (mobile-ready read models) ──────────────────

export interface ProjectionInclude {
  field: string;
  source: string;
  match: Record<string, string>;
  compute: 'exists' | 'count' | 'first' | 'list';
}

export interface ComputedField {
  name: string;
  expression: string;
}

export type ProjectionCachePolicy = 'none' | 'short' | 'feed' | 'offline';

export interface AppProjectionDef {
  id: string;
  projectId: string;
  name: string;
  sourceEntity: string;
  shape: JsonObject;
  includes: ProjectionInclude[];
  computedFields: ComputedField[];
  cachePolicy: ProjectionCachePolicy;
}

// ── Mobile Screen Models ───────────────────────────────────

export type MobileScreenType =
  | 'feed'
  | 'detail'
  | 'form'
  | 'profile'
  | 'settings'
  | 'search'
  | 'chat'
  | 'notifications';

export interface MobileAction {
  name: string;
  type: 'navigate' | 'submit' | 'share' | 'like' | 'bookmark' | 'delete';
  target?: string;
}

export interface MobileScreenModel {
  id: string;
  name: string;
  route: string;
  type: MobileScreenType;
  dataSource: {
    type: 'entity' | 'projection';
    name: string;
  };
  layout: JsonObject;
  actions: MobileAction[];
}

// ── Form & Workflow (skeletal, reserved) ────────────────────

export interface FormDefinitionMeta {
  id: string;
  projectId: string;
  entityName: string;
  name: string;
  layout: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowDefinitionMeta {
  id: string;
  projectId: string;
  entityName: string;
  name: string;
  triggers: JsonObject;
  steps: JsonObject;
  createdAt: string;
  updatedAt: string;
}

// ── Validation Pipeline Result ─────────────────────────────

export interface ValidationError {
  /** JSON path to the invalid field. e.g. "customer.address.city" or "contacts[0].email" */
  path: string;
  message: string;
  rule?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}
