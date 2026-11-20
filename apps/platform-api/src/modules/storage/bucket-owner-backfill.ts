import {
  PLATFORM_BUCKETS,
  classifyBucket,
  effectivePrefix,
  isPlatformBucket,
  physicalPrefix,
  prefixesOverlap,
} from './bucket-names';

/**
 * Plan for `scripts/backfill-bucket-owners.ts`: which physical buckets get a
 * storage_bucket_owners row. Pure, so the decision is tested without MinIO or Postgres.
 *
 * - `unambiguous`: exactly one project prefix (any status) matches. The runtime would record it
 *   lazily on first use anyway; `--apply` records it now.
 * - `dated`: several prefixes match, but only one of those projects existed when MinIO created
 *   the bucket. Strong evidence, still an owner decision: recorded only with `--apply-dated`.
 * - `assigned`: named by `--assign <physical>=<projectId>` (the documented migration path for an
 *   ambiguous bucket); must be one of the matching projects.
 * - `ambiguous`: refused to every project until assigned. `listedUnder` is the project the old
 *   listing (longest prefix, ACTIVE projects) showed it under, as a hint.
 */

export interface BackfillProject {
  id: string;
  slug: string;
  storagePrefix: string | null;
  status: string;
  createdAt: Date;
}

export interface BackfillBucket {
  name: string;
  creationDate: Date;
}

export type BackfillDecision =
  | { physical: string; kind: 'recorded'; projectId: string }
  | { physical: string; kind: 'platform' }
  | { physical: string; kind: 'orphan' }
  | { physical: string; kind: 'unambiguous'; projectId: string }
  | { physical: string; kind: 'dated'; projectId: string; candidates: string[] }
  | { physical: string; kind: 'assigned'; projectId: string; candidates: string[] }
  | { physical: string; kind: 'ambiguous'; candidates: string[]; listedUnder: string | null };

export interface BackfillPlan {
  decisions: BackfillDecision[];
  /** Pairs of projects (any status) whose storage namespaces overlap: the source of ambiguity. */
  overlappingPairs: Array<[string, string]>;
  /** `--assign` entries that were not applied, with the reason. */
  rejectedAssignments: Array<{ physical: string; projectId: string; reason: string }>;
}

export function planBucketOwnerBackfill(input: {
  bucketPrefix: string;
  buckets: BackfillBucket[];
  projects: BackfillProject[];
  owners: Map<string, string>;
  assignments?: Map<string, string>;
}): BackfillPlan {
  const prefixed = input.projects.map((p) => ({ ...p, physicalPrefix: physicalPrefix(input.bucketPrefix, effectivePrefix(p)) }));
  const decisions: BackfillDecision[] = [];
  const rejectedAssignments: BackfillPlan['rejectedAssignments'] = [];
  const assignments = new Map(input.assignments ?? []);

  for (const b of input.buckets) {
    const physical = b.name;
    const recorded = input.owners.get(physical);
    if (recorded) {
      decisions.push({ physical, kind: 'recorded', projectId: recorded });
      continue;
    }
    const candidates = prefixed.filter((p) => physical.startsWith(p.physicalPrefix));
    if (PLATFORM_BUCKETS.includes(physical) || candidates.length === 0) {
      decisions.push({ physical, kind: PLATFORM_BUCKETS.includes(physical) ? 'platform' : 'orphan' });
      continue;
    }
    if (candidates.every((c) => isPlatformBucket(physical, c.physicalPrefix, input.bucketPrefix))) {
      decisions.push({ physical, kind: 'platform' });
      continue;
    }
    const ids = candidates.map((c) => c.id);
    if (candidates.length === 1) {
      const only = candidates[0];
      const v = classifyBucket({ physical, project: only, bucketPrefix: input.bucketPrefix, allProjects: prefixed });
      if (v.kind === 'owned') decisions.push({ physical, kind: 'unambiguous', projectId: only.id });
      else decisions.push({ physical, kind: 'platform' });
      continue;
    }
    const assigned = assignments.get(physical);
    if (assigned) {
      assignments.delete(physical);
      const target = candidates.find((c) => c.id === assigned);
      if (target && !isPlatformBucket(physical, target.physicalPrefix, input.bucketPrefix)) {
        decisions.push({ physical, kind: 'assigned', projectId: assigned, candidates: ids });
        continue;
      }
      rejectedAssignments.push({ physical, projectId: assigned, reason: 'project prefix does not match this bucket' });
    }
    const existed = candidates.filter((c) => c.createdAt.getTime() <= b.creationDate.getTime());
    if (existed.length === 1 && !isPlatformBucket(physical, existed[0].physicalPrefix, input.bucketPrefix)) {
      decisions.push({ physical, kind: 'dated', projectId: existed[0].id, candidates: ids });
      continue;
    }
    const active = candidates.filter((c) => c.status === 'ACTIVE').sort((x, y) => y.physicalPrefix.length - x.physicalPrefix.length);
    decisions.push({ physical, kind: 'ambiguous', candidates: ids, listedUnder: active[0]?.id ?? null });
  }
  for (const [physical, projectId] of assignments) {
    rejectedAssignments.push({
      physical,
      projectId,
      reason: input.owners.has(physical) ? 'already recorded' : 'not an ambiguous bucket in the store',
    });
  }

  const overlappingPairs: Array<[string, string]> = [];
  for (let i = 0; i < prefixed.length; i++) {
    for (let j = i + 1; j < prefixed.length; j++) {
      if (prefixesOverlap(prefixed[i].physicalPrefix, prefixed[j].physicalPrefix)) {
        overlappingPairs.push([prefixed[i].id, prefixed[j].id]);
      }
    }
  }
  return { decisions, overlappingPairs, rejectedAssignments };
}

/** Rows to write for a plan: unambiguous and assigned always, dated only when asked. */
export function rowsToWrite(plan: BackfillPlan, opts: { dated: boolean }): Array<{ physicalName: string; projectId: string }> {
  return plan.decisions.flatMap((d) =>
    d.kind === 'unambiguous' || d.kind === 'assigned' || (d.kind === 'dated' && opts.dated)
      ? [{ physicalName: d.physical, projectId: d.projectId }]
      : [],
  );
}
