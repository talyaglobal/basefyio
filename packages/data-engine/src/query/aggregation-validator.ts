/**
 * Aggregation pipeline validator: untrusted aggregation DSL objects →
 * validated EntityAggregation AST.
 *
 * Mirrors the defensive posture of filter-object.ts: closed stage and
 * accumulator allowlists, safe-path enforcement on every field reference,
 * hard size caps, and prototype-pollution key rejection everywhere.
 * Providers only ever receive the compiled AST — raw user input never
 * reaches them. Error messages are shown verbatim in the query editor UI,
 * so they name the offending stage and say how to fix it.
 */

import { QueryValidationError } from '../interfaces/data-engine';
import type { JsonValue } from '../interfaces/types';
import {
  ALLOWED_ACCUMULATORS,
  ALLOWED_AGGREGATION_STAGES,
  BLOCKED_AGGREGATION_STAGES,
} from '../interfaces/query';
import type {
  Accumulator,
  AccumulatorOp,
  AggregationStage,
  EntityAggregation,
  GroupStage,
  LimitStage,
  MatchStage,
  PathRef,
  ProjectExpression,
  ProjectStage,
  SkipStage,
  SortStage,
  UnwindStage,
} from '../interfaces/query';
import {
  assertSafePath,
  compileFilterObject,
  compileSortObject,
} from './filter-object';

/** Entity names and $group output field names: plain identifiers only. */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Keys that could poison prototypes or smuggle behavior. Always rejected. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const MAX_PIPELINE_STAGES = 20;
const MAX_PROJECT_FIELDS = 50;
const MAX_GROUP_ID_PATHS = 5;
const MAX_GROUP_ACCUMULATORS = 20;
const MAX_LIMIT = 1000;
const MAX_SKIP = 100000;

function fail(message: string, ctx?: string): never {
  throw new QueryValidationError(ctx ? `${ctx}: ${message}` : message);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate a path and build a PathRef. isArrayPath reflects [] markers. */
function toPathRef(path: string, ctx: string): PathRef {
  assertSafePath(path, ctx);
  return { path, isArrayPath: path.includes('[]') };
}

/** Recursively validate a JSON literal, rejecting forbidden keys anywhere. */
function assertJsonLiteral(v: unknown, ctx: string): asserts v is JsonValue {
  const t = typeof v;
  if (v === null || t === 'string' || t === 'number' || t === 'boolean') return;
  if (Array.isArray(v)) {
    for (const item of v) assertJsonLiteral(item, ctx);
    return;
  }
  if (isPlainObject(v)) {
    for (const [k, val] of Object.entries(v)) {
      if (FORBIDDEN_KEYS.has(k)) fail(`key "${k}" is not allowed`, ctx);
      assertJsonLiteral(val, ctx);
    }
    return;
  }
  fail(`unsupported value type "${t}" — only JSON values are allowed`, ctx);
}

// ── Stage compilers ────────────────────────────────────────

function compileMatchStage(value: unknown, ctx: string): MatchStage {
  // compileFilterObject returns undefined for {} / null / undefined.
  const filter = compileFilterObject(value, ctx);
  if (filter === undefined) {
    fail('empty $match — remove the stage', ctx);
  }
  return { $match: filter };
}

function compileProjectStage(value: unknown, ctx: string): ProjectStage {
  if (!isPlainObject(value)) {
    fail('$project must be a plain object like { "title": 1, "alias": "field.path" }', ctx);
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    fail('$project must include at least one field', ctx);
  }
  if (entries.length > MAX_PROJECT_FIELDS) {
    fail(`$project has ${entries.length} fields — maximum is ${MAX_PROJECT_FIELDS}`, ctx);
  }

  const projection: Record<string, 1 | 0 | ProjectExpression> = {};
  for (const [key, v] of entries) {
    // Keys are output paths; assertSafePath also rejects forbidden keys.
    assertSafePath(key, ctx);
    if (v === 0 || v === 1) {
      projection[key] = v;
    } else if (typeof v === 'string') {
      // String values are path references into the source document.
      assertSafePath(v, ctx);
      projection[key] = v;
    } else if (isPlainObject(v)) {
      const objKeys = Object.keys(v);
      if (objKeys.length !== 1 || objKeys[0] !== '$literal') {
        fail(
          `invalid object value for $project field "${key}" — only { "$literal": <value> } is supported`,
          ctx,
        );
      }
      const literal: unknown = v.$literal;
      assertJsonLiteral(literal, `${ctx} $project "${key}" $literal`);
      projection[key] = { $literal: literal };
    } else {
      fail(
        `invalid value for $project field "${key}" — use 0, 1, a field path string, or { "$literal": <value> }`,
        ctx,
      );
    }
  }
  return { $project: projection };
}

function compileUnwindStage(value: unknown, ctx: string): UnwindStage {
  if (typeof value === 'string') {
    return { $unwind: { path: toPathRef(value, ctx) } };
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (key !== 'path' && key !== 'preserveNullAndEmpty') {
        fail(`unknown $unwind option "${key}" — supported: path, preserveNullAndEmpty`, ctx);
      }
    }
    const path: unknown = value.path;
    const preserveNullAndEmpty: unknown = value.preserveNullAndEmpty;
    if (typeof path !== 'string') {
      fail('$unwind requires a "path" string', ctx);
    }
    if (preserveNullAndEmpty !== undefined && typeof preserveNullAndEmpty !== 'boolean') {
      fail('$unwind option "preserveNullAndEmpty" must be a boolean', ctx);
    }
    const unwind: UnwindStage['$unwind'] = { path: toPathRef(path, ctx) };
    if (preserveNullAndEmpty !== undefined) {
      unwind.preserveNullAndEmpty = preserveNullAndEmpty;
    }
    return { $unwind: unwind };
  }
  fail('$unwind must be a path string or { "path": "field[]", "preserveNullAndEmpty"?: boolean }', ctx);
}

function compileGroupId(id: unknown, ctx: string): PathRef | PathRef[] | null {
  if (id === null) return null;
  if (typeof id === 'string') return toPathRef(id, ctx);
  if (Array.isArray(id)) {
    if (id.length === 0) {
      fail('$group "_id" array must contain at least one path string (or use null to group everything)', ctx);
    }
    if (id.length > MAX_GROUP_ID_PATHS) {
      fail(`$group "_id" array has ${id.length} paths — maximum is ${MAX_GROUP_ID_PATHS}`, ctx);
    }
    return id.map((p) => {
      if (typeof p !== 'string') {
        fail('$group "_id" array items must be field path strings', ctx);
      }
      return toPathRef(p, ctx);
    });
  }
  fail('$group "_id" must be null, a field path string, or an array of field path strings', ctx);
}

function compileAccumulator(key: string, value: unknown, ctx: string): Accumulator {
  if (!isPlainObject(value)) {
    fail(
      `accumulator "${key}" must be an object with exactly one operator, e.g. { "$sum": "stats.views" }`,
      ctx,
    );
  }
  const opKeys = Object.keys(value);
  if (opKeys.length !== 1) {
    fail(`accumulator "${key}" must have exactly one operator key, found ${opKeys.length}`, ctx);
  }
  const op = opKeys[0];
  if (!ALLOWED_ACCUMULATORS.has(op)) {
    fail(
      `unknown accumulator "${op}" on "${key}" — supported: ${[...ALLOWED_ACCUMULATORS].join(', ')}`,
      ctx,
    );
  }
  const opValue: unknown = value[op];
  if (op === '$count') {
    if (opValue !== null) {
      fail(`accumulator "$count" on "${key}" takes null, e.g. { "$count": null }`, ctx);
    }
    return { op: '$count' };
  }
  if (typeof opValue !== 'string') {
    fail(`accumulator "${op}" on "${key}" requires a field path string`, ctx);
  }
  return { op: op as AccumulatorOp, path: toPathRef(opValue, ctx) };
}

function compileGroupStage(value: unknown, ctx: string): GroupStage {
  if (!isPlainObject(value)) {
    fail('$group must be a plain object with "_id" and at least one accumulator field', ctx);
  }
  if (!Object.prototype.hasOwnProperty.call(value, '_id')) {
    fail('$group requires an "_id" key (null, a field path string, or an array of field path strings)', ctx);
  }
  const groupId = compileGroupId(value._id, ctx);

  const accumulatorEntries = Object.entries(value).filter(([k]) => k !== '_id');
  if (accumulatorEntries.length === 0) {
    fail('$group requires at least one accumulator field besides "_id"', ctx);
  }
  if (accumulatorEntries.length > MAX_GROUP_ACCUMULATORS) {
    fail(
      `$group has ${accumulatorEntries.length} accumulator fields — maximum is ${MAX_GROUP_ACCUMULATORS}`,
      ctx,
    );
  }

  const accumulators: Record<string, Accumulator> = {};
  for (const [key, v] of accumulatorEntries) {
    // Check forbidden keys first: "__proto__" etc. would pass IDENTIFIER_RE.
    if (FORBIDDEN_KEYS.has(key)) {
      fail(`$group output field "${key}" is not allowed`, ctx);
    }
    if (!IDENTIFIER_RE.test(key)) {
      fail(
        `invalid $group output field name "${key}" — use letters, digits and underscores, starting with a letter or underscore`,
        ctx,
      );
    }
    accumulators[key] = compileAccumulator(key, v, ctx);
  }
  return { $group: { _id: groupId, accumulators } };
}

function compileSortStage(value: unknown, ctx: string): SortStage {
  return { $sort: compileSortObject(value, ctx) };
}

function compileLimitStage(value: unknown, ctx: string): LimitStage {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    fail(`$limit must be an integer between 1 and ${MAX_LIMIT}`, ctx);
  }
  return { $limit: value };
}

function compileSkipStage(value: unknown, ctx: string): SkipStage {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_SKIP) {
    fail(`$skip must be an integer between 0 and ${MAX_SKIP}`, ctx);
  }
  return { $skip: value };
}

// ── Stage dispatcher ───────────────────────────────────────

function compileStage(stage: unknown, index: number): AggregationStage {
  const ctx = `pipeline[${index}]`;
  if (!isPlainObject(stage)) {
    fail('each stage must be a plain object with exactly one key, e.g. { "$match": { ... } }', ctx);
  }
  const keys = Object.keys(stage);
  if (keys.length === 0) {
    fail('stage object is empty — expected exactly one stage key', ctx);
  }
  if (keys.length > 1) {
    fail(
      `stage must have exactly one key, found ${keys.length} (${keys.join(', ')}) — split into separate stages`,
      ctx,
    );
  }
  const key = keys[0];
  if (!ALLOWED_AGGREGATION_STAGES.has(key)) {
    if (BLOCKED_AGGREGATION_STAGES.has(key)) {
      fail(`stage "${key}" is blocked`, ctx);
    }
    fail(`unknown stage "${key}" — supported: ${[...ALLOWED_AGGREGATION_STAGES].join(', ')}`, ctx);
  }
  const value: unknown = stage[key];
  switch (key) {
    case '$match':
      return compileMatchStage(value, ctx);
    case '$project':
      return compileProjectStage(value, ctx);
    case '$unwind':
      return compileUnwindStage(value, ctx);
    case '$group':
      return compileGroupStage(value, ctx);
    case '$sort':
      return compileSortStage(value, ctx);
    case '$limit':
      return compileLimitStage(value, ctx);
    case '$skip':
      return compileSkipStage(value, ctx);
    default:
      // Unreachable — the allowlist above is exhaustive.
      fail(`unknown stage "${key}"`, ctx);
  }
}

// ── Public API ─────────────────────────────────────────────

/**
 * Validate an untrusted aggregation pipeline and compile it into a typed
 * EntityAggregation AST. Throws QueryValidationError (HTTP 400) with a
 * human-readable, stage-scoped message on any violation.
 */
export function validateAggregation(entity: string, pipeline: unknown): EntityAggregation {
  if (typeof entity !== 'string' || FORBIDDEN_KEYS.has(entity) || !IDENTIFIER_RE.test(entity)) {
    fail(
      `invalid entity name "${String(entity)}" — use letters, digits and underscores, starting with a letter or underscore`,
    );
  }
  if (!Array.isArray(pipeline)) {
    fail('pipeline must be an array of stage objects');
  }
  if (pipeline.length === 0) {
    fail('pipeline must contain at least one stage');
  }
  if (pipeline.length > MAX_PIPELINE_STAGES) {
    fail(`pipeline has ${pipeline.length} stages — maximum is ${MAX_PIPELINE_STAGES}`);
  }
  return {
    entity,
    pipeline: pipeline.map((stage, index) => compileStage(stage, index)),
  };
}
