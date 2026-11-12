/**
 * Request-input normalisation for the Data Engine REST API.
 *
 * Clients send filters and sorts in more than one shape, and every shape that
 * has ever been documented or shipped by an SDK keeps working:
 *
 *   filter — the document format the docs and the SDK use:
 *              { "status": "active", "total": { "$gte": 10 }, "$or": [ … ] }
 *            the engine-neutral Filter AST (accepted since the first release):
 *              { "type": "field", "path": { "path": "status" }, "operator": "eq", "value": "active" }
 *              { "type": "and" | "or", "conditions": [ … ] }, { "type": "not", "condition": … }
 *
 *   sort   — [{ "path": "_createdAt", "direction": "desc" }]          (SDK / docs)
 *            [{ "path": { "path": "_createdAt" }, "direction": "desc" }] (AST)
 *            { "path": "_createdAt", "direction": "desc" }             (single clause)
 *            { "_createdAt": -1, "name": "asc" }                      (document format)
 *            "-_createdAt,name"                                      (plain query string)
 *
 * Everything is validated here — paths against the safe charset, operators
 * against a closed allowlist, sizes and depth capped — so providers only ever
 * see a well-formed AST. Every violation is a QueryValidationError (HTTP 400)
 * with a message that names the offending part.
 */

import { QueryValidationError } from '../interfaces/data-engine';
import type { JsonValue } from '../interfaces/types';
import type {
  Filter,
  FilterOperator,
  PathRef,
  SortClause,
} from '../interfaces/query';
import { assertSafePath, compileFilterObject, compileSortObject } from './filter-object';

const MAX_AST_DEPTH = 8;
const MAX_LOGICAL_CONDITIONS = 50;
const MAX_LIST_ITEMS = 1000;
const MAX_PATTERN_LENGTH = 512;
export const MAX_SORT_FIELDS = 5;

const AST_OPERATORS: ReadonlySet<FilterOperator> = new Set<FilterOperator>([
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'nin',
  'contains', 'containsAny', 'exists', 'regex', 'iregex', 'like', 'ilike',
]);
const LIST_OPERATORS: ReadonlySet<FilterOperator> = new Set<FilterOperator>(['in', 'nin', 'containsAny']);
const PATTERN_OPERATORS: ReadonlySet<FilterOperator> = new Set<FilterOperator>(['regex', 'iregex', 'like', 'ilike']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const FIELD_NODE_KEYS = new Set(['type', 'path', 'operator', 'value']);
const LOGICAL_NODE_KEYS = new Set(['type', 'conditions']);
const NOT_NODE_KEYS = new Set(['type', 'condition']);

function fail(message: string): never {
  throw new QueryValidationError(message);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseJsonParam(raw: string, name: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    fail(`${name} is not valid JSON`);
  }
}

// ── Filter ─────────────────────────────────────────────────

/**
 * True when `value` is shaped like a Filter AST node rather than a document
 * filter. The check is strict (exact key set per node type) so a document
 * filter on a user field that happens to be called "type" — `{ "type": "and" }`
 * — is still read as a document filter.
 */
export function isFilterAst(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  const onlyKeys = (allowed: Set<string>) => keys.every((k) => allowed.has(k));
  switch (value.type) {
    case 'field':
      return 'path' in value && 'operator' in value && onlyKeys(FIELD_NODE_KEYS);
    case 'and':
    case 'or':
      return Array.isArray(value.conditions) && onlyKeys(LOGICAL_NODE_KEYS);
    case 'not':
      return isPlainObject(value.condition) && onlyKeys(NOT_NODE_KEYS);
    default:
      return false;
  }
}

function assertFilterValue(v: unknown, where: string, depth = 0): void {
  if (depth > MAX_AST_DEPTH) fail(`filter value on "${where}" is nested too deeply`);
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) fail(`filter value on "${where}" must be a finite number`);
    return;
  }
  if (Array.isArray(v)) {
    for (const item of v) assertFilterValue(item, where, depth + 1);
    return;
  }
  if (isPlainObject(v)) {
    for (const [k, val] of Object.entries(v)) {
      if (FORBIDDEN_KEYS.has(k) || k.startsWith('$')) {
        fail(`key "${k}" is not allowed inside a filter value on "${where}"`);
      }
      assertFilterValue(val, where, depth + 1);
    }
    return;
  }
  fail(`unsupported filter value type "${typeof v}" on "${where}"`);
}

function astPath(raw: unknown): PathRef {
  const path = typeof raw === 'string' ? raw : isPlainObject(raw) ? raw.path : undefined;
  if (typeof path !== 'string') {
    fail('filter node "path" must be a string or { "path": "<field path>" }');
  }
  assertSafePath(path, 'filter');
  return { path, isArrayPath: path.includes('[]') };
}

function validateAstNode(node: unknown, depth: number): Filter {
  if (depth > MAX_AST_DEPTH) fail(`filter nesting exceeds ${MAX_AST_DEPTH} levels`);
  if (!isFilterAst(node)) {
    fail(
      'invalid filter node — expected { "type": "field", "path", "operator", "value" }, ' +
        '{ "type": "and" | "or", "conditions": [ … ] } or { "type": "not", "condition": { … } }',
    );
  }
  const n = node as Record<string, unknown>;

  if (n.type === 'and' || n.type === 'or') {
    const conditions = n.conditions as unknown[];
    if (conditions.length === 0) fail(`"${n.type}" requires at least one condition`);
    if (conditions.length > MAX_LOGICAL_CONDITIONS) {
      fail(`"${n.type}" exceeds ${MAX_LOGICAL_CONDITIONS} conditions`);
    }
    return {
      type: n.type,
      conditions: conditions.map((c) => validateAstNode(c, depth + 1)),
    };
  }

  if (n.type === 'not') {
    return { type: 'not', condition: validateAstNode(n.condition, depth + 1) };
  }

  const path = astPath(n.path);
  const operator = n.operator as FilterOperator;
  if (typeof operator !== 'string' || !AST_OPERATORS.has(operator)) {
    fail(
      `unknown filter operator "${String(n.operator)}" on "${path.path}" — supported: ${[...AST_OPERATORS].join(', ')}`,
    );
  }
  let value = n.value as unknown;
  if (operator === 'exists') {
    if (value === undefined) value = true;
    if (typeof value !== 'boolean') fail(`operator "exists" on "${path.path}" requires a boolean value`);
  } else if (value === undefined) {
    fail(`operator "${operator}" on "${path.path}" requires a value`);
  }
  if (LIST_OPERATORS.has(operator)) {
    if (!Array.isArray(value)) fail(`operator "${operator}" on "${path.path}" requires an array value`);
    if (value.length > MAX_LIST_ITEMS) {
      fail(`operator "${operator}" on "${path.path}" exceeds ${MAX_LIST_ITEMS} items`);
    }
  }
  if (PATTERN_OPERATORS.has(operator)) {
    if (typeof value !== 'string') fail(`operator "${operator}" on "${path.path}" requires a string value`);
    if (value.length > MAX_PATTERN_LENGTH) {
      fail(`pattern on "${path.path}" is too long (max ${MAX_PATTERN_LENGTH})`);
    }
    if (operator === 'regex' || operator === 'iregex') {
      try {
        new RegExp(value);
      } catch {
        fail(`invalid regular expression on "${path.path}"`);
      }
    }
  }
  assertFilterValue(value, path.path);

  return {
    type: 'field',
    path: {
      path: path.path,
      isArrayPath: path.isArrayPath || operator === 'contains' || operator === 'containsAny',
    },
    operator,
    value: value as JsonValue,
  };
}

/**
 * Normalise an untrusted filter (a JSON string or an already-parsed value) to
 * a validated Filter AST. `undefined`, `null`, `""` and `{}` mean "match
 * everything" and return undefined.
 */
export function normalizeFilterInput(input: unknown): Filter | undefined {
  let value = input;
  if (typeof value === 'string') {
    if (value.trim() === '') return undefined;
    value = parseJsonParam(value, 'filter');
  }
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) {
    fail('filter must be a JSON object, e.g. {"status":"active"}');
  }
  if (Object.keys(value).length === 0) return undefined;
  if (isFilterAst(value)) return validateAstNode(value, 1);
  return compileFilterObject(value, 'filter');
}

// ── Sort ───────────────────────────────────────────────────

function sortDirection(raw: unknown, path: string): 'asc' | 'desc' {
  if (raw === undefined || raw === null) return 'asc';
  if (raw === 1 || raw === 'asc' || raw === 'ASC') return 'asc';
  if (raw === -1 || raw === 'desc' || raw === 'DESC') return 'desc';
  fail(`invalid sort direction "${String(raw)}" for "${path}" — use "asc", "desc", 1 or -1`);
}

function sortClause(raw: unknown): SortClause {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    const desc = trimmed.startsWith('-');
    const path = desc ? trimmed.slice(1) : trimmed.replace(/^\+/, '');
    assertSafePath(path, 'sort');
    return { path: { path, isArrayPath: path.includes('[]') }, direction: desc ? 'desc' : 'asc' };
  }
  if (!isPlainObject(raw)) {
    fail('each sort entry must be { "path": "<field>", "direction": "asc" | "desc" }');
  }
  const extra = Object.keys(raw).filter((k) => k !== 'path' && k !== 'direction');
  if (extra.length > 0) {
    fail(`unknown sort key "${extra[0]}" — a sort entry takes "path" and "direction"`);
  }
  const ref = astPathForSort(raw.path);
  return { path: ref, direction: sortDirection(raw.direction, ref.path) };
}

function astPathForSort(raw: unknown): PathRef {
  const path = typeof raw === 'string' ? raw : isPlainObject(raw) ? raw.path : undefined;
  if (typeof path !== 'string') {
    fail('sort "path" must be a field path string, e.g. { "path": "_createdAt", "direction": "desc" }');
  }
  assertSafePath(path, 'sort');
  return { path, isArrayPath: path.includes('[]') };
}

const DIRECTION_TOKENS = new Set<unknown>([1, -1, 'asc', 'desc', 'ASC', 'DESC']);

/** `{ path, direction }` (one clause) as opposed to `{ field: 1 }` (document format). */
function isSingleClauseObject(obj: Record<string, unknown>): boolean {
  if (!('path' in obj)) return false;
  const keys = Object.keys(obj);
  if (keys.some((k) => k !== 'path' && k !== 'direction')) return false;
  // `{ "path": 1 }` / `{ "path": "desc" }` sorts a user field named "path".
  if (keys.length === 1 && DIRECTION_TOKENS.has(obj.path)) return false;
  return typeof obj.path === 'string' || isPlainObject(obj.path);
}

/**
 * Normalise an untrusted sort (JSON string, plain "a,-b" string or parsed
 * value) to SortClause[]. Empty input returns undefined (provider default
 * order). Invalid directions are rejected instead of silently sorting asc.
 */
export function normalizeSortInput(input: unknown): SortClause[] | undefined {
  let value = input;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      value = parseJsonParam(trimmed, 'sort');
    } else {
      value = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  if (value === undefined || value === null) return undefined;

  let clauses: SortClause[];
  if (Array.isArray(value)) {
    clauses = value.map((entry) => sortClause(entry));
  } else if (isPlainObject(value)) {
    if (Object.keys(value).length === 0) return undefined;
    clauses = isSingleClauseObject(value) ? [sortClause(value)] : compileSortObject(value, 'sort');
  } else {
    fail('sort must be an array like [{"path":"_createdAt","direction":"desc"}] or an object like {"_createdAt":-1}');
  }

  if (clauses.length === 0) return undefined;
  if (clauses.length > MAX_SORT_FIELDS) fail(`sort supports at most ${MAX_SORT_FIELDS} fields`);
  return clauses;
}

// ── Projection ─────────────────────────────────────────────

/**
 * Normalise a projection: "a,b.c", ["a","b.c"] or {"a":1,"b.c":1}. Returns
 * undefined for "everything". Envelope fields are always returned.
 */
export function normalizeSelectInput(input: unknown): PathRef[] | undefined {
  let value = input;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    value = trimmed.startsWith('[') || trimmed.startsWith('{')
      ? parseJsonParam(trimmed, 'select')
      : trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (value === undefined || value === null) return undefined;

  let paths: string[];
  if (Array.isArray(value)) {
    paths = value.map((p) => {
      if (typeof p !== 'string') fail('select entries must be field path strings');
      return p;
    });
  } else if (isPlainObject(value)) {
    paths = Object.entries(value)
      .filter(([, include]) => include === 1 || include === true)
      .map(([p]) => p);
  } else {
    fail('select must be a comma-separated list of field paths, e.g. select=name,address.city');
  }

  if (paths.length === 0) return undefined;
  if (paths.length > 100) fail('select supports at most 100 fields');
  return paths.map((path) => {
    assertSafePath(path, 'select');
    return { path, isArrayPath: path.includes('[]') };
  });
}
