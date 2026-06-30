import { BadRequestException } from '@nestjs/common';

/**
 * Translates a MongoDB-like filter object into a PostgreSQL WHERE clause
 * that operates on a JSONB `data` column.
 *
 * Supported operators:
 *   { field: value }             → data @> '{"field": value}'
 *   { field: { $eq: v } }       → data->>'field' = $N
 *   { field: { $ne: v } }       → data->>'field' != $N
 *   { field: { $gt: v } }       → (data->>'field')::numeric > $N
 *   { field: { $gte: v } }      → (data->>'field')::numeric >= $N
 *   { field: { $lt: v } }       → (data->>'field')::numeric < $N
 *   { field: { $lte: v } }      → (data->>'field')::numeric <= $N
 *   { field: { $in: [...] } }   → data->>'field' IN ($N, ...)
 *   { field: { $nin: [...] } }  → data->>'field' NOT IN ($N, ...)
 *   { field: { $contains: v } } → data->'field' @> '["v"]'  (array containment)
 *   { field: { $exists: bool }} → data ? 'field' / NOT (data ? 'field')
 *   { field: { $regex: pat } }  → data->>'field' ~ $N
 *   { field: { $iregex: pat } } → data->>'field' ~* $N
 *   { $and: [...] }             → (clause AND clause AND ...)
 *   { $or:  [...] }             → (clause OR  clause OR  ...)
 *   Nested paths: "a.b.c"       → data #>> '{a,b,c}'
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

const VALID_FIELD_RE = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;

function validateFieldName(field: string): void {
  if (!VALID_FIELD_RE.test(field)) {
    throw new BadRequestException(`Invalid field name in filter: "${field}"`);
  }
}

/**
 * Returns the SQL expression to extract a text value from the `data` JSONB column.
 * Supports dotted paths like "address.city" → data #>> '{address,city}'.
 */
function jsonTextField(field: string): string {
  const parts = field.split('.');
  if (parts.length === 1) {
    return `data->>'${parts[0]}'`;
  }
  return `data #>> '{${parts.join(',')}}'`;
}

/**
 * Returns the SQL expression to extract a JSONB value from the `data` column.
 * Supports dotted paths like "tags.0" → data #> '{tags,0}'.
 */
function jsonJsonbField(field: string): string {
  const parts = field.split('.');
  if (parts.length === 1) {
    return `data->'${parts[0]}'`;
  }
  return `data #> '{${parts.join(',')}}'`;
}

function buildClauses(
  filter: Record<string, unknown>,
  params: unknown[],
): string[] {
  const clauses: string[] = [];

  for (const [key, value] of Object.entries(filter)) {
    // Logical operators
    if (key === '$and') {
      if (!Array.isArray(value)) {
        throw new BadRequestException('$and must be an array');
      }
      const sub = value.map((f) => {
        const inner = buildClauses(f as Record<string, unknown>, params);
        return inner.length === 1 ? inner[0] : `(${inner.join(' AND ')})`;
      });
      clauses.push(`(${sub.join(' AND ')})`);
      continue;
    }

    if (key === '$or') {
      if (!Array.isArray(value)) {
        throw new BadRequestException('$or must be an array');
      }
      const sub = value.map((f) => {
        const inner = buildClauses(f as Record<string, unknown>, params);
        return inner.length === 1 ? inner[0] : `(${inner.join(' AND ')})`;
      });
      clauses.push(`(${sub.join(' OR ')})`);
      continue;
    }

    validateFieldName(key);

    // Simple equality: { field: "value" } or { field: 123 }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      params.push(JSON.stringify({ [key.split('.')[0]]: value }));
      clauses.push(`data @> $${params.length}::jsonb`);
      continue;
    }

    // Operator object: { field: { $gt: 5, $lt: 10 } }
    const ops = value as Record<string, unknown>;

    for (const [op, opVal] of Object.entries(ops)) {
      switch (op) {
        case '$eq': {
          params.push(opVal);
          clauses.push(`${jsonTextField(key)} = $${params.length}`);
          break;
        }
        case '$ne': {
          params.push(opVal);
          clauses.push(`${jsonTextField(key)} != $${params.length}`);
          break;
        }
        case '$gt':
        case '$gte':
        case '$lt':
        case '$lte': {
          params.push(opVal);
          const sqlOp = COMPARISON_OPS[op];
          clauses.push(
            `(${jsonTextField(key)})::numeric ${sqlOp} $${params.length}`,
          );
          break;
        }
        case '$in': {
          if (!Array.isArray(opVal) || opVal.length === 0) {
            throw new BadRequestException('$in requires a non-empty array');
          }
          const placeholders = opVal.map((v) => {
            params.push(v);
            return `$${params.length}`;
          });
          clauses.push(
            `${jsonTextField(key)} IN (${placeholders.join(', ')})`,
          );
          break;
        }
        case '$nin': {
          if (!Array.isArray(opVal) || opVal.length === 0) {
            throw new BadRequestException('$nin requires a non-empty array');
          }
          const ninPlaceholders = opVal.map((v) => {
            params.push(v);
            return `$${params.length}`;
          });
          clauses.push(
            `${jsonTextField(key)} NOT IN (${ninPlaceholders.join(', ')})`,
          );
          break;
        }
        case '$contains': {
          // Array containment: data->'tags' @> '["value"]'
          params.push(JSON.stringify([opVal]));
          clauses.push(
            `${jsonJsonbField(key)} @> $${params.length}::jsonb`,
          );
          break;
        }
        case '$exists': {
          if (opVal === true) {
            clauses.push(`data ? '${key}'`);
          } else {
            clauses.push(`NOT (data ? '${key}')`);
          }
          break;
        }
        case '$regex': {
          params.push(opVal);
          clauses.push(`${jsonTextField(key)} ~ $${params.length}`);
          break;
        }
        case '$iregex': {
          params.push(opVal);
          clauses.push(`${jsonTextField(key)} ~* $${params.length}`);
          break;
        }
        default:
          throw new BadRequestException(`Unknown filter operator: ${op}`);
      }
    }
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
 * into a SQL ORDER BY clause for JSONB fields.
 */
export function buildNoSqlSort(
  sort: Record<string, number> | undefined | null,
): string {
  if (!sort || Object.keys(sort).length === 0) return '';

  const parts: string[] = [];
  for (const [field, dir] of Object.entries(sort)) {
    validateFieldName(field);
    // Sort on created_at / updated_at directly (they are real columns, not inside data)
    const isMetaColumn = field === 'created_at' || field === 'updated_at';
    const expr = isMetaColumn ? `"${field}"` : jsonTextField(field);
    const direction = dir === -1 ? 'DESC' : 'ASC';
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
