import { BadRequestException } from '@nestjs/common';
import type { Filter, PathRef, SortClause } from '@basefyio/data-engine';

/**
 * Converts the engine-agnostic Filter AST produced by the JS query parser
 * into the legacy Mongo-style filter object understood by
 * `projects/nosql-filter.util.ts` (buildNoSqlFilter / buildNoSqlSort /
 * buildNoSqlProjection).
 *
 * The legacy dialect supports a strict subset of the AST operators:
 * eq neq gt gte lt lte in nin contains exists regex iregex plus $and/$or
 * with dotted paths. Everything else (not, like, ilike, containsAny, array
 * paths) fails fast with a 400 instead of silently returning wrong rows.
 */

const OPERATOR_TO_LEGACY: Record<string, string> = {
  eq: '$eq',
  neq: '$ne',
  gt: '$gt',
  gte: '$gte',
  lt: '$lt',
  lte: '$lte',
  in: '$in',
  nin: '$nin',
  contains: '$contains',
  exists: '$exists',
  regex: '$regex',
  iregex: '$iregex',
};

const SUPPORTED_OPERATORS =
  'eq, neq, gt, gte, lt, lte, in, nin, contains, exists, regex, iregex, and, or';

function unsupported(operator: string): never {
  throw new BadRequestException(
    `operator "${operator}" is not supported for NoSQL collections — supported operators: ${SUPPORTED_OPERATORS}`,
  );
}

function legacyPath(path: PathRef): string {
  if (path.isArrayPath || path.path.includes('[]')) {
    throw new BadRequestException(
      `array path "${path.path}" is not supported for NoSQL collections — use plain dotted paths`,
    );
  }
  return path.path;
}

function convert(filter: Filter): Record<string, unknown> {
  switch (filter.type) {
    case 'field': {
      const legacyOp = OPERATOR_TO_LEGACY[filter.operator];
      if (!legacyOp) unsupported(filter.operator);
      return { [legacyPath(filter.path)]: { [legacyOp]: filter.value } };
    }
    case 'and': {
      const parts = filter.conditions.map(convert);
      // Merge into a single object when all top-level keys are distinct
      // (implicit AND in the legacy dialect); fall back to $and otherwise
      // so conditions on the same path are preserved.
      const merged: Record<string, unknown> = {};
      let collision = false;
      outer: for (const part of parts) {
        for (const key of Object.keys(part)) {
          if (Object.prototype.hasOwnProperty.call(merged, key)) {
            collision = true;
            break outer;
          }
        }
        Object.assign(merged, part);
      }
      return collision ? { $and: parts } : merged;
    }
    case 'or':
      return { $or: filter.conditions.map(convert) };
    case 'not':
      unsupported('not');
  }
}

/** Filter AST → legacy Mongo-style filter object (undefined = match all). */
export function filterAstToLegacyFilter(
  filter: Filter | undefined,
): Record<string, unknown> | undefined {
  if (!filter) return undefined;
  return convert(filter);
}

/** SortClause[] → legacy sort spec, e.g. { createdAt: -1, name: 1 }. */
export function sortClausesToLegacySort(
  sort: SortClause[] | undefined,
): Record<string, 1 | -1> | undefined {
  if (!sort || sort.length === 0) return undefined;
  const out: Record<string, 1 | -1> = {};
  for (const clause of sort) {
    out[legacyPath(clause.path)] = clause.direction === 'desc' ? -1 : 1;
  }
  return out;
}

/** select paths → legacy projection spec, e.g. { name: 1, email: 1 }. */
export function selectPathsToLegacyProjection(
  select: PathRef[] | undefined,
): Record<string, 1> | undefined {
  if (!select || select.length === 0) return undefined;
  const out: Record<string, 1> = {};
  for (const path of select) {
    out[legacyPath(path)] = 1;
  }
  return out;
}
