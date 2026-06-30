/**
 * basefyio Data Engine — Query & Filter AST
 *
 * Both query modes (SQL-like and Aggregation DSL) compile to these types.
 * No provider-specific query syntax appears here.
 */

import type { JsonValue } from './types';

// ── Path References ────────────────────────────────────────

/**
 * A safe reference to a nested field path, validated against the entity schema.
 * Examples: "name", "customer.address.city", "contacts[].email"
 */
export interface PathRef {
  /** Dot-notation path. Array items use []. */
  path: string;
  /** Whether this path traverses an array (contains []). */
  isArrayPath: boolean;
}

// ── Filter AST ─────────────────────────────────────────────

export type FilterOperator =
  | 'eq' | 'neq'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'nin'
  | 'contains' | 'containsAny'
  | 'exists'
  | 'regex' | 'iregex'
  | 'like' | 'ilike';

export interface FieldFilter {
  type: 'field';
  path: PathRef;
  operator: FilterOperator;
  value: JsonValue;
}

export interface LogicalFilter {
  type: 'and' | 'or';
  conditions: Filter[];
}

export interface NotFilter {
  type: 'not';
  condition: Filter;
}

export type Filter = FieldFilter | LogicalFilter | NotFilter;

// ── Sort ───────────────────────────────────────────────────

export interface SortClause {
  path: PathRef;
  direction: 'asc' | 'desc';
}

// ── Index Definitions ──────────────────────────────────────

export interface IndexField {
  path: string;
  order?: 'asc' | 'desc';
}

export interface IndexDef {
  name: string;
  fields: IndexField[];
  partialFilter?: Filter;
}

// ── Entity Query (Mode 1: SQL-like compiles to this) ───────

export interface EntityQuery {
  entity: string;
  select?: PathRef[];
  filter?: Filter;
  sort?: SortClause[];
  limit?: number;
  offset?: number;
  cursor?: string;
  /** Include soft-deleted documents. Default: false. */
  includeSoftDeleted?: boolean;
}

// ── Aggregation AST (Mode 2: Aggregation DSL) ──────────────

export interface MatchStage {
  $match: Filter;
}

export interface ProjectStage {
  $project: Record<string, 1 | 0 | ProjectExpression>;
}

export type ProjectExpression = string | { $literal: JsonValue };

export interface UnwindStage {
  $unwind: {
    path: PathRef;
    preserveNullAndEmpty?: boolean;
  };
}

export type AccumulatorOp = '$count' | '$sum' | '$avg' | '$min' | '$max';

export interface Accumulator {
  op: AccumulatorOp;
  /** Path to accumulate. Null for $count. */
  path?: PathRef;
}

export interface GroupStage {
  $group: {
    _id: PathRef | PathRef[] | null;
    accumulators: Record<string, Accumulator>;
  };
}

export interface SortStage {
  $sort: SortClause[];
}

export interface LimitStage {
  $limit: number;
}

export interface SkipStage {
  $skip: number;
}

export type AggregationStage =
  | MatchStage
  | ProjectStage
  | UnwindStage
  | GroupStage
  | SortStage
  | LimitStage
  | SkipStage;

export interface EntityAggregation {
  entity: string;
  pipeline: AggregationStage[];
  cursor?: string;
}

// ── SQL-like Query (parsed from user SQL text) ─────────────

export interface DataEngineSqlQuery {
  select: PathRef[];
  from: string;
  where?: Filter;
  orderBy?: SortClause[];
  limit?: number;
  cursor?: string;
  params?: JsonValue[];
}

// ── Saved Query ────────────────────────────────────────────

export interface SavedDataQueryDef {
  id: string;
  projectId: string;
  name: string;
  mode: 'sql' | 'aggregation';
  entity?: string;
  sql?: string;
  pipeline?: AggregationStage[];
  paramsSchema?: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
}

// ── Explain ────────────────────────────────────────────────

export interface QueryExplainResult {
  mode: 'sql' | 'aggregation';
  entity: string;
  selectedPaths: string[];
  filterPaths: string[];
  unwindPaths: string[];
  groupKeys: string[];
  sortFields: string[];
  matchingIndexes: string[];
  recommendedIndexes: IndexDef[];
  estimatedRisk: 'low' | 'medium' | 'high';
  usesNestedPaths: boolean;
  usesArrayPaths: boolean;
}

// ── Blocked stages / operators ─────────────────────────────

export const BLOCKED_AGGREGATION_STAGES: ReadonlySet<string> = new Set([
  '$lookup', '$out', '$merge', '$function', '$where', '$accumulator',
]);

export const ALLOWED_AGGREGATION_STAGES: ReadonlySet<string> = new Set([
  '$match', '$project', '$unwind', '$group', '$sort', '$limit', '$skip',
]);

export const ALLOWED_ACCUMULATORS: ReadonlySet<string> = new Set([
  '$count', '$sum', '$avg', '$min', '$max',
]);
