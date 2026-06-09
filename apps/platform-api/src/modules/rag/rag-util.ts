/**
 * Pure RAG helpers — no NestJS / Drizzle / Prisma imports, so they are
 * unit-testable in isolation. Validation that needs HTTP semantics lives in the
 * DTOs; these are the framework-free invariants reused by service, repository
 * and tests.
 */
import { createHash } from 'node:crypto';

export type RagDocStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'INDEXED'
  | 'FAILED'
  | 'STALE';

export type RagIndexJobKindValue = 'INDEX' | 'REINDEX' | 'REINDEX_INCOMPLETE';

/**
 * Statuses that `reindex-incomplete` is allowed to queue. INDEXED (and the
 * transient PROCESSING) are intentionally excluded — an INDEXED document is only
 * re-queued when the caller passes force=true.
 */
export const RAG_INCOMPLETE_STATUSES: readonly RagDocStatus[] = [
  'FAILED',
  'PENDING',
  'STALE',
];

export function isIncompleteStatus(status: RagDocStatus): boolean {
  return RAG_INCOMPLETE_STATUSES.includes(status);
}

// Search bounds (must match the DTO decorators).
export const SEARCH_LIMIT_MIN = 1;
export const SEARCH_LIMIT_MAX = 25;
export const SEARCH_THRESHOLD_MIN = 0;
export const SEARCH_THRESHOLD_MAX = 1;

export function searchLimitValid(limit: number): boolean {
  return (
    Number.isFinite(limit) &&
    Number.isInteger(limit) &&
    limit >= SEARCH_LIMIT_MIN &&
    limit <= SEARCH_LIMIT_MAX
  );
}

export function searchThresholdValid(threshold: number): boolean {
  return (
    Number.isFinite(threshold) &&
    threshold >= SEARCH_THRESHOLD_MIN &&
    threshold <= SEARCH_THRESHOLD_MAX
  );
}

export function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Idempotency key for a RAG index job. Always includes projectId so the same
 * logical job in different projects never collides (matches the composite
 * unique index on (project_id, dedupe_key)).
 */
export function ragJobDedupeKey(parts: {
  projectId: string;
  kind: RagIndexJobKindValue;
  documentId?: string | null;
  sourceHash?: string | null;
}): string {
  return [
    parts.projectId,
    parts.kind,
    parts.documentId ?? 'ALL',
    parts.sourceHash ?? 'NOHASH',
  ].join(':');
}

/** Clamp importance into the DB-enforced 0–100 range. */
export function clampImportance(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export const IMPORTANCE_MIN = 0;
export const IMPORTANCE_MAX = 100;

export function importanceValid(n: number): boolean {
  return Number.isInteger(n) && n >= IMPORTANCE_MIN && n <= IMPORTANCE_MAX;
}
