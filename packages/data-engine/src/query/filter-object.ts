/**
 * Shared compiler: untrusted Mongo-style filter/sort objects → validated
 * Filter / SortClause ASTs.
 *
 * Used by both query frontends (the JS query parser and the aggregation
 * validator). Everything here is defensive: field paths are restricted to a
 * safe charset (providers interpolate paths into JSONB/Mango/N1QL
 * expressions), operator and key allowlists are closed, and depth/size are
 * capped. User input never passes through unvalidated.
 */

import { QueryValidationError } from '../interfaces/data-engine';
import type { JsonValue } from '../interfaces/types';
import type {
  FieldFilter,
  Filter,
  FilterOperator,
  SortClause,
} from '../interfaces/query';

/** Paths may contain identifiers, dots, [] array markers, _, $ and -. */
export const SAFE_PATH_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(\[\])?(\.[A-Za-z_$][A-Za-z0-9_$]*(\[\])?)*$/;

/** Keys that could poison prototypes or smuggle behavior. Always rejected. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const MAX_FILTER_DEPTH = 8;
const MAX_LOGICAL_CONDITIONS = 50;
const MAX_IN_ITEMS = 1000;
const MAX_REGEX_LENGTH = 512;

/** Mongo-style operator → Basefyio FilterOperator. Closed allowlist. */
const OPERATOR_MAP: Record<string, FilterOperator> = {
  $eq: 'eq',
  $ne: 'neq',
  $neq: 'neq',
  $gt: 'gt',
  $gte: 'gte',
  $lt: 'lt',
  $lte: 'lte',
  $in: 'in',
  $nin: 'nin',
  $contains: 'contains',
  $containsAny: 'containsAny',
  $exists: 'exists',
  $regex: 'regex',
  $iregex: 'iregex',
  $like: 'like',
  $ilike: 'ilike',
};

const ARRAY_VALUE_OPERATORS = new Set<FilterOperator>(['in', 'nin', 'containsAny']);
const STRING_VALUE_OPERATORS = new Set<FilterOperator>(['regex', 'iregex', 'like', 'ilike']);
const ARRAY_PATH_OPERATORS = new Set<FilterOperator>(['contains', 'containsAny']);

function fail(message: string, ctx?: string): never {
  throw new QueryValidationError(ctx ? `${ctx}: ${message}` : message);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate a field path against the safe charset. Throws on violation. */
export function assertSafePath(path: string, ctx?: string): void {
  if (typeof path !== 'string' || path.length === 0) {
    fail('field path must be a non-empty string', ctx);
  }
  if (path.length > 256) {
    fail(`field path is too long (${path.length} > 256)`, ctx);
  }
  for (const segment of path.split('.')) {
    if (FORBIDDEN_KEYS.has(segment.replace(/\[\]$/, ''))) {
      fail(`field path segment "${segment}" is not allowed`, ctx);
    }
  }
  if (!SAFE_PATH_RE.test(path)) {
    fail(
      `invalid field path "${path}" — use dotted identifiers like "customer.address.city" (array paths end segments with [])`,
      ctx,
    );
  }
}

function assertJsonValue(v: unknown, ctx?: string): asserts v is JsonValue {
  const t = typeof v;
  if (v === null || t === 'string' || t === 'number' || t === 'boolean') return;
  if (Array.isArray(v)) {
    for (const item of v) assertJsonValue(item, ctx);
    return;
  }
  if (isPlainObject(v)) {
    for (const [k, val] of Object.entries(v)) {
      if (FORBIDDEN_KEYS.has(k)) fail(`key "${k}" is not allowed`, ctx);
      assertJsonValue(val, ctx);
    }
    return;
  }
  fail(`unsupported value type "${t}"`, ctx);
}

function makeFieldFilter(
  path: string,
  operator: FilterOperator,
  value: unknown,
  ctx?: string,
): FieldFilter {
  assertSafePath(path, ctx);

  if (ARRAY_VALUE_OPERATORS.has(operator)) {
    if (!Array.isArray(value)) {
      fail(`operator "$${operator}" on "${path}" requires an array value`, ctx);
    }
    if (value.length > MAX_IN_ITEMS) {
      fail(`operator "$${operator}" on "${path}" exceeds ${MAX_IN_ITEMS} items`, ctx);
    }
  }
  if (STRING_VALUE_OPERATORS.has(operator)) {
    if (typeof value !== 'string') {
      fail(`operator for "${path}" requires a string value`, ctx);
    }
    if (value.length > MAX_REGEX_LENGTH) {
      fail(`pattern on "${path}" is too long (max ${MAX_REGEX_LENGTH})`, ctx);
    }
    if (operator === 'regex' || operator === 'iregex') {
      try {
        // Syntactic sanity only — providers compile their own dialects.
        new RegExp(value);
      } catch {
        fail(`invalid regular expression on "${path}"`, ctx);
      }
    }
  }
  if (operator === 'exists' && typeof value !== 'boolean') {
    fail(`operator "$exists" on "${path}" requires a boolean value`, ctx);
  }

  assertJsonValue(value, ctx);

  return {
    type: 'field',
    path: {
      path,
      isArrayPath: path.includes('[]') || ARRAY_PATH_OPERATORS.has(operator),
    },
    operator,
    value: value as JsonValue,
  };
}

function compileEntry(
  key: string,
  value: unknown,
  depth: number,
  ctx?: string,
): Filter {
  if (FORBIDDEN_KEYS.has(key)) fail(`key "${key}" is not allowed`, ctx);

  if (key === '$and' || key === '$or') {
    if (!Array.isArray(value) || value.length === 0) {
      fail(`"${key}" requires a non-empty array of filter objects`, ctx);
    }
    if (value.length > MAX_LOGICAL_CONDITIONS) {
      fail(`"${key}" exceeds ${MAX_LOGICAL_CONDITIONS} conditions`, ctx);
    }
    return {
      type: key === '$and' ? 'and' : 'or',
      conditions: value.map((c) => compileNode(c, depth + 1, ctx)),
    };
  }

  if (key === '$not') {
    if (!isPlainObject(value)) {
      fail('"$not" requires a filter object', ctx);
    }
    return { type: 'not', condition: compileNode(value, depth + 1, ctx) };
  }

  if (key.startsWith('$')) {
    fail(
      `unknown top-level operator "${key}" — supported: $and, $or, $not`,
      ctx,
    );
  }

  // Field entry. Literal value → eq; operator object → one filter per $op.
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    const opKeys = keys.filter((k) => k.startsWith('$'));

    if (opKeys.length === 0) {
      fail(
        `nested object match on "${key}" is not supported — use a dotted path like "${key}.field" instead`,
        ctx,
      );
    }
    if (opKeys.length !== keys.length) {
      fail(`cannot mix operators and plain keys on "${key}"`, ctx);
    }

    const filters = keys.map((opKey) => {
      const operator = OPERATOR_MAP[opKey];
      if (!operator) {
        fail(
          `unknown operator "${opKey}" on "${key}" — supported: ${Object.keys(OPERATOR_MAP).join(', ')}`,
          ctx,
        );
      }
      return makeFieldFilter(key, operator, (value as Record<string, unknown>)[opKey], ctx);
    });

    return filters.length === 1 ? filters[0] : { type: 'and', conditions: filters };
  }

  assertJsonValue(value, ctx);
  return makeFieldFilter(key, 'eq', value, ctx);
}

function compileNode(obj: unknown, depth: number, ctx?: string): Filter {
  if (depth > MAX_FILTER_DEPTH) {
    fail(`filter nesting exceeds ${MAX_FILTER_DEPTH} levels`, ctx);
  }
  if (!isPlainObject(obj)) {
    fail('filter must be an object', ctx);
  }

  const entries = Object.entries(obj);
  if (entries.length === 0) {
    fail('filter object must not be empty (omit the filter to match everything)', ctx);
  }

  const filters = entries.map(([k, v]) => compileEntry(k, v, depth, ctx));
  return filters.length === 1 ? filters[0] : { type: 'and', conditions: filters };
}

/**
 * Compile an untrusted Mongo-style filter object into a validated Filter AST.
 * An empty object (or undefined) returns undefined — "match everything".
 * Throws QueryValidationError with a human-readable message on any violation.
 */
export function compileFilterObject(
  obj: unknown,
  ctx?: string,
): Filter | undefined {
  if (obj === undefined || obj === null) return undefined;
  if (isPlainObject(obj) && Object.keys(obj).length === 0) return undefined;
  return compileNode(obj, 1, ctx);
}

/**
 * Compile an untrusted sort object ({ field: 1 | -1 | 'asc' | 'desc' }) into
 * SortClause[]. Key insertion order defines precedence.
 */
export function compileSortObject(obj: unknown, ctx?: string): SortClause[] {
  if (!isPlainObject(obj)) {
    fail('sort must be an object like { fieldName: 1 } or { fieldName: "desc" }', ctx);
  }
  const entries = Object.entries(obj);
  if (entries.length === 0) fail('sort object must not be empty', ctx);
  if (entries.length > 5) fail('sort supports at most 5 fields', ctx);

  return entries.map(([path, dir]) => {
    assertSafePath(path, ctx);
    let direction: 'asc' | 'desc';
    if (dir === 1 || dir === 'asc') direction = 'asc';
    else if (dir === -1 || dir === 'desc') direction = 'desc';
    else {
      fail(`invalid sort direction for "${path}" — use 1, -1, "asc" or "desc"`, ctx);
    }
    return { path: { path, isArrayPath: path.includes('[]') }, direction };
  });
}
