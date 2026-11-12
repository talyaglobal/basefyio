import { BadRequestException } from '@nestjs/common';

/**
 * Translates a MongoDB-like filter object into a PostgreSQL WHERE clause
 * that operates on a JSONB `data` column.
 *
 * Supported operators:
 *   { field: value }              → equality; on an array field, matches when an element equals value
 *   { field: { a: 1 } }           → the field contains this sub-document
 *   { field: { $eq: v } }         → text equality (or an array element equal to v)
 *   { field: { $ne: v } }         → text inequality
 *   { field: { $gt|$gte|$lt|$lte: v } } → numeric comparison
 *   { field: { $in: [...] } }     → membership (or any array element is a member)
 *   { field: { $nin: [...] } }    → not a member (missing fields match)
 *   { field: { $contains: v } }   → array contains v
 *   { field: { $all: [...] } }    → array contains every value
 *   { field: { $elemMatch: {…} } } → some array element matches the sub-filter
 *   { field: { $exists: bool } }  → field present / absent
 *   { field: { $regex|$iregex: pat } } → regular expression, case-sensitive / insensitive
 *   { field: { $like|$ilike: pat } }   → SQL LIKE (% and _), case-sensitive / insensitive
 *   { $and: [...] }, { $or: [...] }    → boolean combinations
 *   Nested paths: "a.b.c"         → data #>> '{a,b,c}'
 */

export interface FilterResult {
  where: string;
  params: unknown[];
}

const COMPARISON_OPS: Record<string, string> = {
  $gt: '>',
  $gte: '>=',
  $lt: '<',
  $lte: '<=',
};

const VALID_FIELD_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)*$/;
const MAX_DEPTH = 8;

function validateFieldName(field: string): void {
  if (!VALID_FIELD_RE.test(field)) {
    throw new BadRequestException(`Invalid field name in filter: "${field}"`);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Where the filter is evaluated: the document's `data` column, or (inside
 * $elemMatch) one array element.
 */
interface Scope {
  root: string;
  depth: number;
}

const DOCUMENT: Scope = { root: 'data', depth: 0 };

/**
 * SQL expression for a text value at `field` ("" = the scope root itself).
 * Supports dotted paths like "address.city" → data #>> '{address,city}'.
 * Field names are validated against VALID_FIELD_RE before they get here.
 */
function jsonTextField(field: string, scope: Scope = DOCUMENT): string {
  if (field === '') return `(${scope.root} #>> '{}')`;
  const parts = field.split('.');
  if (parts.length === 1) {
    return `${scope.root}->>'${parts[0]}'`;
  }
  return `${scope.root} #>> '{${parts.join(',')}}'`;
}

/**
 * SQL expression for a JSONB value at `field` ("" = the scope root itself).
 * Supports dotted paths like "tags.0" → data #> '{tags,0}'.
 */
function jsonJsonbField(field: string, scope: Scope = DOCUMENT): string {
  if (field === '') return scope.root;
  const parts = field.split('.');
  if (parts.length === 1) {
    return `${scope.root}->'${parts[0]}'`;
  }
  return `${scope.root} #> '{${parts.join(',')}}'`;
}

/** The array at `field` when it is one, else an empty array. */
function arrayAt(field: string, scope: Scope): string {
  const expr = jsonJsonbField(field, scope);
  return `(CASE WHEN jsonb_typeof(${expr}) = 'array' THEN ${expr} ELSE '[]'::jsonb END)`;
}

/** { "a.b": v } → { a: { b: v } } — the containment document for a dotted path. */
function nest(field: string, value: unknown): Record<string, unknown> {
  const parts = field.split('.');
  let out: unknown = value;
  for (let i = parts.length - 1; i >= 0; i--) out = { [parts[i]]: out };
  return out as Record<string, unknown>;
}

function bind(params: unknown[], value: unknown): string {
  params.push(value);
  return `$${params.length}`;
}

/** Equality via JSONB containment, also matching an element of an array field. */
function equalityClause(field: string, value: unknown, params: unknown[], scope: Scope): string {
  if (field === '') {
    // Inside $elemMatch on scalars: compare the element itself.
    const p = bind(params, JSON.stringify(value));
    return `${scope.root} = ${p}::jsonb`;
  }
  const exact = bind(params, JSON.stringify(nest(field, value)));
  if (Array.isArray(value)) return `${scope.root} @> ${exact}::jsonb`;
  const element = bind(params, JSON.stringify(nest(field, [value])));
  return `(${scope.root} @> ${exact}::jsonb OR ${scope.root} @> ${element}::jsonb)`;
}

/** Text membership, also matching any element of an array field. */
function membershipClause(field: string, values: unknown[], params: unknown[], scope: Scope): string {
  const placeholders = values.map((v) => bind(params, v)).join(', ');
  if (field === '') return `${jsonTextField('', scope)} IN (${placeholders})`;
  return (
    `(${jsonTextField(field, scope)} IN (${placeholders}) OR EXISTS (` +
    `SELECT 1 FROM jsonb_array_elements_text(${arrayAt(field, scope)}) AS m(v) WHERE m.v IN (${placeholders})))`
  );
}

function requireString(op: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${op} requires a string value`);
  }
  return value;
}

function operatorClauses(
  key: string,
  ops: Record<string, unknown>,
  params: unknown[],
  scope: Scope,
): string[] {
  const clauses: string[] = [];
  for (const [op, opVal] of Object.entries(ops)) {
    switch (op) {
      case '$eq': {
        const p = bind(params, opVal);
        const text = jsonTextField(key, scope);
        clauses.push(
          key === ''
            ? `${text} = ${p}`
            : `(${text} = ${p} OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(${arrayAt(key, scope)}) AS m(v) WHERE m.v = ${p}))`,
        );
        break;
      }
      case '$ne':
      case '$neq': {
        clauses.push(`${jsonTextField(key, scope)} != ${bind(params, opVal)}`);
        break;
      }
      case '$gt':
      case '$gte':
      case '$lt':
      case '$lte': {
        if (typeof opVal !== 'number' && (typeof opVal !== 'string' || Number.isNaN(Number(opVal)))) {
          throw new BadRequestException(`${op} requires a number`);
        }
        const p = bind(params, opVal);
        const text = jsonTextField(key, scope);
        // Only numeric values take part, so a text value never aborts the query.
        clauses.push(
          `(CASE WHEN ${text} ~ '^-?[0-9]+(\\.[0-9]+)?([eE][-+]?[0-9]+)?$' THEN (${text})::numeric ${COMPARISON_OPS[op]} ${p}::numeric ELSE FALSE END)`,
        );
        break;
      }
      case '$in': {
        if (!Array.isArray(opVal) || opVal.length === 0) {
          throw new BadRequestException('$in requires a non-empty array');
        }
        clauses.push(membershipClause(key, opVal, params, scope));
        break;
      }
      case '$nin': {
        if (!Array.isArray(opVal) || opVal.length === 0) {
          throw new BadRequestException('$nin requires a non-empty array');
        }
        clauses.push(`NOT COALESCE(${membershipClause(key, opVal, params, scope)}, FALSE)`);
        break;
      }
      case '$contains': {
        // Array containment: data->'tags' @> '["value"]'
        clauses.push(`${jsonJsonbField(key, scope)} @> ${bind(params, JSON.stringify([opVal]))}::jsonb`);
        break;
      }
      case '$all': {
        if (!Array.isArray(opVal) || opVal.length === 0) {
          throw new BadRequestException('$all requires a non-empty array');
        }
        clauses.push(`${jsonJsonbField(key, scope)} @> ${bind(params, JSON.stringify(opVal))}::jsonb`);
        break;
      }
      case '$elemMatch': {
        if (!isPlainObject(opVal) || Object.keys(opVal).length === 0) {
          throw new BadRequestException('$elemMatch requires a non-empty filter object');
        }
        if (scope.depth + 1 > MAX_DEPTH) {
          throw new BadRequestException('$elemMatch is nested too deeply');
        }
        const alias = `el${scope.depth + 1}`;
        const inner: Scope = { root: `${alias}.value`, depth: scope.depth + 1 };
        const opKeys = Object.keys(opVal).filter((k) => k.startsWith('$') && k !== '$and' && k !== '$or');
        // { $gte: 80 } applies to each (scalar) element; { qty: { $gt: 2 } } to element fields.
        const sub = opKeys.length === Object.keys(opVal).length
          ? operatorClauses('', opVal, params, inner)
          : buildClauses(opVal, params, inner);
        clauses.push(
          `EXISTS (SELECT 1 FROM jsonb_array_elements(${arrayAt(key, scope)}) AS ${alias}(value) WHERE ${sub.join(' AND ') || 'TRUE'})`,
        );
        break;
      }
      case '$exists': {
        if (typeof opVal !== 'boolean') {
          throw new BadRequestException('$exists requires true or false');
        }
        const present = !key.includes('.') && key !== ''
          ? `${scope.root} ? '${key}'`
          : `${jsonJsonbField(key, scope)} IS NOT NULL`;
        clauses.push(opVal ? present : `NOT (${present})`);
        break;
      }
      case '$regex': {
        clauses.push(`${jsonTextField(key, scope)} ~ ${bind(params, requireString(op, opVal))}`);
        break;
      }
      case '$iregex': {
        clauses.push(`${jsonTextField(key, scope)} ~* ${bind(params, requireString(op, opVal))}`);
        break;
      }
      case '$like': {
        clauses.push(`${jsonTextField(key, scope)} LIKE ${bind(params, requireString(op, opVal))}`);
        break;
      }
      case '$ilike': {
        clauses.push(`${jsonTextField(key, scope)} ILIKE ${bind(params, requireString(op, opVal))}`);
        break;
      }
      default:
        throw new BadRequestException(
          `Unknown filter operator: ${op} — supported: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $contains, $all, $elemMatch, $exists, $regex, $iregex, $like, $ilike`,
        );
    }
  }
  return clauses;
}

function logicalClause(
  key: '$and' | '$or',
  value: unknown,
  params: unknown[],
  scope: Scope,
): string {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BadRequestException(`${key} must be a non-empty array of filter objects`);
  }
  const sub = value.map((f) => {
    if (!isPlainObject(f) || Object.keys(f).length === 0) {
      throw new BadRequestException(`every ${key} entry must be a non-empty filter object`);
    }
    const inner = buildClauses(f, params, { ...scope, depth: scope.depth + 1 });
    return inner.length === 1 ? inner[0] : `(${inner.join(' AND ')})`;
  });
  return `(${sub.join(key === '$and' ? ' AND ' : ' OR ')})`;
}

function buildClauses(
  filter: Record<string, unknown>,
  params: unknown[],
  scope: Scope = DOCUMENT,
): string[] {
  if (scope.depth > MAX_DEPTH * 2) {
    throw new BadRequestException('Filter is nested too deeply');
  }
  const clauses: string[] = [];

  for (const [key, value] of Object.entries(filter)) {
    // Logical operators
    if (key === '$and' || key === '$or') {
      clauses.push(logicalClause(key, value, params, scope));
      continue;
    }

    validateFieldName(key);

    // Simple equality: { field: "value" } or { field: 123 }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      clauses.push(equalityClause(key, value, params, scope));
      continue;
    }

    const keys = Object.keys(value);
    const opKeys = keys.filter((k) => k.startsWith('$'));

    // Sub-document: { address: { city: "Ankara" } } — contains these fields.
    if (opKeys.length === 0) {
      clauses.push(`${scope.root} @> ${bind(params, JSON.stringify(nest(key, value)))}::jsonb`);
      continue;
    }
    if (opKeys.length !== keys.length) {
      throw new BadRequestException(`Cannot mix operators and plain keys on "${key}"`);
    }

    // Operator object: { field: { $gt: 5, $lt: 10 } }
    clauses.push(...operatorClauses(key, value as Record<string, unknown>, params, scope));
  }

  return clauses;
}

/**
 * Parses a MongoDB-like filter object and returns a SQL WHERE clause
 * with parameterized values targeting a JSONB `data` column.
 *
 * @param filter - The filter object (may be undefined/null for "match all")
 * @param paramOffset - Starting parameter index (for composing with outer queries)
 * @returns { where, params } where `where` is empty string if no filter
 */
export function buildNoSqlFilter(
  filter: Record<string, unknown> | undefined | null,
  paramOffset = 0,
): FilterResult {
  if (!filter || Object.keys(filter).length === 0) {
    return { where: '', params: [] };
  }
  if (!isPlainObject(filter)) {
    throw new BadRequestException('filter must be a JSON object, e.g. {"status":"active"}');
  }

  // We build params starting from index 0, then shift placeholders by paramOffset
  const params: unknown[] = [];
  const clauses = buildClauses(filter, params);

  if (!clauses.length) {
    return { where: '', params: [] };
  }

  // Rewrite $N placeholders to account for paramOffset
  let where = clauses.join(' AND ');
  if (paramOffset > 0) {
    // Replace $1, $2, ... with $(1+offset), $(2+offset), ...
    where = where.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) + paramOffset}`);
  }

  return { where, params };
}

/**
 * Parses a sort specification like { "createdAt": -1, "name": 1 }
 * (also "asc" / "desc") into a SQL ORDER BY clause for JSONB fields.
 */
export function buildNoSqlSort(
  sort: Record<string, unknown> | undefined | null,
): string {
  if (!sort || Object.keys(sort).length === 0) return '';
  if (!isPlainObject(sort)) {
    throw new BadRequestException('sort must be a JSON object like {"created_at":-1}');
  }

  const parts: string[] = [];
  for (const [field, dir] of Object.entries(sort)) {
    validateFieldName(field);
    // Sort on created_at / updated_at directly (they are real columns, not inside data)
    const isMetaColumn = field === 'created_at' || field === 'updated_at';
    const expr = isMetaColumn ? `"${field}"` : jsonTextField(field);
    let direction: 'ASC' | 'DESC';
    if (dir === -1 || dir === 'desc' || dir === 'DESC') direction = 'DESC';
    else if (dir === 1 || dir === 'asc' || dir === 'ASC') direction = 'ASC';
    else {
      throw new BadRequestException(`Invalid sort direction for "${field}" — use 1, -1, "asc" or "desc"`);
    }
    parts.push(`${expr} ${direction} NULLS LAST`);
  }

  return parts.join(', ');
}

/**
 * Builds a JSONB projection that returns only selected fields.
 * E.g. { name: 1, email: 1 } → jsonb_build_object('name', data->'name', 'email', data->'email')
 * Returns null if no projection (= return full data).
 */
export function buildNoSqlProjection(
  project: Record<string, 0 | 1> | undefined | null,
): string | null {
  if (!project || Object.keys(project).length === 0) return null;

  const included = Object.entries(project).filter(([, v]) => v === 1);
  if (!included.length) return null;

  const args = included
    .map(([field]) => {
      validateFieldName(field);
      return `'${field}', ${jsonJsonbField(field)}`;
    })
    .join(', ');

  return `jsonb_build_object(${args})`;
}

/**
 * Parse a JSON-encoded query parameter (filter / sort / project), answering
 * 400 — not 500 — when it is malformed.
 */
export function parseJsonQueryParam<T = Record<string, unknown>>(
  raw: string | undefined,
  name: string,
): T | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequestException(`${name} is not valid JSON`);
  }
  if (!isPlainObject(parsed)) {
    throw new BadRequestException(`${name} must be a JSON object`);
  }
  return parsed as T;
}
