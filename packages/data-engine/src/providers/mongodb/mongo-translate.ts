/**
 * MongoDB translation layer — pure functions from the engine-neutral
 * Filter/Aggregation AST to native MongoDB filters and pipelines.
 *
 * Stored document layout (mirrors the CouchDB provider):
 *   { _id, envelope: { projectId, entity, status, ... }, data: { ...user } }
 *
 * Public envelope paths (_createdAt, _status, …) map to envelope.* fields;
 * everything else lives under data.*. After a $group or $project stage the
 * document is reshaped to user space, so later stages address top-level keys
 * directly — translation tracks that switch via `PathContext.reshaped`.
 *
 * No `mongodb` import here: this module is unit-testable without the driver.
 */

import { QueryValidationError } from '../../interfaces/data-engine';
import type { JsonValue } from '../../interfaces/types';
import type {
  AggregationStage,
  EntityAggregation,
  Filter,
  FieldFilter,
  PathRef,
  SortClause,
} from '../../interfaces/query';

// ── Path mapping ───────────────────────────────────────────

/** Public envelope paths → stored envelope fields. */
const ENVELOPE_PATHS: Record<string, string> = {
  _id: '_id',
  _entity: 'envelope.entity',
  _projectId: 'envelope.projectId',
  _schemaVersion: 'envelope.schemaVersion',
  _version: 'envelope.version',
  _lastEventId: 'envelope.lastEventId',
  _eventSequence: 'envelope.eventSequence',
  _status: 'envelope.status',
  _createdAt: 'envelope.createdAt',
  _updatedAt: 'envelope.updatedAt',
  _createdBy: 'envelope.createdBy',
  _deletedAt: 'envelope.deletedAt',
};

export interface PathContext {
  /**
   * True once a $group/$project has reshaped documents to user space —
   * from then on paths address the document directly (no data./envelope. prefix).
   */
  reshaped: boolean;
}

/**
 * Map a validated AST path to its stored MongoDB path. `[]` array markers
 * are dropped — MongoDB traverses arrays implicitly in dotted paths.
 */
export function toStoredPath(path: string, ctx?: PathContext): string {
  const clean = path.replace(/\[\]/g, '');
  if (ctx?.reshaped) return clean;
  const envelope = ENVELOPE_PATHS[clean];
  if (envelope) return envelope;
  return `data.${clean}`;
}

// ── LIKE → regex ───────────────────────────────────────────

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/** SQL LIKE pattern (`%` any run, `_` any char) → anchored regex source. */
export function likeToRegexSource(pattern: string): string {
  let out = '^';
  for (const ch of pattern) {
    if (ch === '%') out += '.*';
    else if (ch === '_') out += '.';
    else out += ch.replace(REGEX_SPECIALS, '\\$&');
  }
  return `${out}$`;
}

// ── Filter AST → Mongo filter ──────────────────────────────

type MongoFilter = Record<string, unknown>;

function fieldToMongo(f: FieldFilter, ctx?: PathContext): MongoFilter {
  const path = toStoredPath(f.path.path, ctx);
  const v = f.value as JsonValue;

  switch (f.operator) {
    case 'eq':
      return { [path]: { $eq: v } };
    case 'neq':
      return { [path]: { $ne: v } };
    case 'gt':
      return { [path]: { $gt: v } };
    case 'gte':
      return { [path]: { $gte: v } };
    case 'lt':
      return { [path]: { $lt: v } };
    case 'lte':
      return { [path]: { $lte: v } };
    case 'in':
      return { [path]: { $in: Array.isArray(v) ? v : [v] } };
    case 'nin':
      return { [path]: { $nin: Array.isArray(v) ? v : [v] } };
    case 'contains':
      // Array-contains; $all on a single value also matches scalar equality,
      // mirroring the "field holds or contains" semantic of the other providers.
      return { [path]: { $all: [v] } };
    case 'containsAny':
      return { [path]: { $in: Array.isArray(v) ? v : [v] } };
    case 'exists':
      return { [path]: { $exists: v !== false } };
    case 'regex':
      return { [path]: { $regex: String(v) } };
    case 'iregex':
      return { [path]: { $regex: String(v), $options: 'i' } };
    case 'like':
      return { [path]: { $regex: likeToRegexSource(String(v)) } };
    case 'ilike':
      return { [path]: { $regex: likeToRegexSource(String(v)), $options: 'i' } };
    default:
      throw new QueryValidationError(`Unsupported filter operator "${f.operator}"`);
  }
}

/** Translate the engine-neutral Filter AST to a native MongoDB filter document. */
export function filterToMongo(filter: Filter, ctx?: PathContext): MongoFilter {
  switch (filter.type) {
    case 'field':
      return fieldToMongo(filter, ctx);
    case 'and':
      return { $and: filter.conditions.map((c) => filterToMongo(c, ctx)) };
    case 'or':
      return { $or: filter.conditions.map((c) => filterToMongo(c, ctx)) };
    case 'not':
      // $nor of one branch negates an arbitrary sub-filter, which $not cannot.
      return { $nor: [filterToMongo(filter.condition, ctx)] };
    default:
      throw new QueryValidationError('Unsupported filter node');
  }
}

// ── Sort / projection ──────────────────────────────────────

export function sortToMongo(
  sort: SortClause[],
  ctx?: PathContext,
): Record<string, 1 | -1> {
  const out: Record<string, 1 | -1> = {};
  for (const clause of sort) {
    out[toStoredPath(clause.path.path, ctx)] = clause.direction === 'desc' ? -1 : 1;
  }
  return out;
}

/** Inclusion projection for find(): selected user paths + the full envelope. */
export function selectToMongo(select: PathRef[]): Record<string, 1> {
  const out: Record<string, 1> = { envelope: 1 };
  for (const ref of select) {
    out[toStoredPath(ref.path)] = 1;
  }
  return out;
}

// ── Aggregation → Mongo pipeline ───────────────────────────

export interface TranslatedPipeline {
  pipeline: Record<string, unknown>[];
  /** False when documents still carry the stored envelope/data layout —
   *  the engine must flatten rows to user space after execution. */
  reshaped: boolean;
}

function groupIdToMongo(
  id: PathRef | PathRef[] | null,
  ctx: PathContext,
): unknown {
  if (id === null) return null;
  if (Array.isArray(id)) {
    const composite: Record<string, string> = {};
    for (const ref of id) {
      // Composite keys surface as _id.<lastSegment> — keep segment names readable.
      const key = ref.path.replace(/\[\]/g, '').split('.').pop() as string;
      composite[key] = `$${toStoredPath(ref.path, ctx)}`;
    }
    return composite;
  }
  return `$${toStoredPath(id.path, ctx)}`;
}

function stageToMongo(
  stage: AggregationStage,
  ctx: PathContext,
): Record<string, unknown> {
  if ('$match' in stage) {
    return { $match: filterToMongo(stage.$match, ctx) };
  }

  if ('$project' in stage) {
    const projection: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(stage.$project)) {
      if (value === 1) {
        projection[key] = ctx.reshaped ? 1 : `$${toStoredPath(key, ctx)}`;
      } else if (value === 0) {
        projection[key] = 0;
      } else if (typeof value === 'string') {
        projection[key] = `$${toStoredPath(value, ctx)}`;
      } else {
        projection[key] = { $literal: value.$literal };
      }
    }
    ctx.reshaped = true;
    return { $project: projection };
  }

  if ('$unwind' in stage) {
    return {
      $unwind: {
        path: `$${toStoredPath(stage.$unwind.path.path, ctx)}`,
        preserveNullAndEmptyArrays: stage.$unwind.preserveNullAndEmpty ?? false,
      },
    };
  }

  if ('$group' in stage) {
    const group: Record<string, unknown> = {
      _id: groupIdToMongo(stage.$group._id, ctx),
    };
    for (const [name, acc] of Object.entries(stage.$group.accumulators)) {
      if (acc.op === '$count') {
        group[name] = { $sum: 1 };
      } else {
        if (!acc.path) {
          throw new QueryValidationError(
            `Accumulator "${name}" (${acc.op}) requires a path`,
          );
        }
        group[name] = { [acc.op]: `$${toStoredPath(acc.path.path, ctx)}` };
      }
    }
    ctx.reshaped = true;
    return { $group: group };
  }

  if ('$sort' in stage) {
    return { $sort: sortToMongo(stage.$sort, ctx) };
  }

  if ('$limit' in stage) {
    return { $limit: stage.$limit };
  }

  if ('$skip' in stage) {
    return { $skip: stage.$skip };
  }

  throw new QueryValidationError('Unsupported aggregation stage');
}

/**
 * Translate a validated EntityAggregation into a native MongoDB pipeline,
 * prefixed with the tenant/entity scope $match (callers cannot override it).
 */
export function aggregationToMongoPipeline(
  aggregation: EntityAggregation,
  scope: { projectId: string; entity: string },
): TranslatedPipeline {
  const ctx: PathContext = { reshaped: false };
  const pipeline: Record<string, unknown>[] = [
    {
      $match: {
        'envelope.projectId': scope.projectId,
        'envelope.entity': scope.entity,
        'envelope.status': { $ne: 'deleted' },
      },
    },
  ];
  for (const stage of aggregation.pipeline) {
    pipeline.push(stageToMongo(stage, ctx));
  }
  return { pipeline, reshaped: ctx.reshaped };
}
