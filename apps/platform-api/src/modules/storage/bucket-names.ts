/**
 * The only place that turns a project and a bucket name into a physical bucket name, and the
 * rules that decide whether a physical bucket belongs to a project.
 *
 * Physical names are `<bucketPrefix><project prefix>-<bucket name>` (default `bf-<slug>-<name>`),
 * and both the project prefix and the bucket name may contain `-`. The separator is therefore
 * ambiguous: `bf-a-` + `b-x` and `bf-a-b-` + `x` are the same bucket. A member of project `a`
 * who asks for bucket `b-x` would otherwise reach project `a-b`'s bucket `x`.
 *
 * Every tenant route resolves its bucket through {@link classifyBucket} (via
 * `StorageService.ownedBucket`), which answers "owned" only when:
 *
 *  - `storage_bucket_owners` records this project as the creator, or
 *  - no record exists and this project's prefix is the only project prefix (projects of any
 *    status) that the physical name starts with (an unambiguous legacy bucket).
 *
 * Platform buckets ({@link PLATFORM_BUCKETS}) are never owned by a project. `bucket-names.spec.ts`
 * fails when code elsewhere builds a `bf-…` bucket name by hand or names a platform bucket that
 * is missing from the list.
 */

/** Every bucket the platform itself owns. A new platform bucket must be added here. */
export const PLATFORM_BUCKETS: readonly string[] = [
  'bf-platform-auto-backups',
  'bf-platform-avatars',
  'bf-platform-data-imports',
  'bf-platform-exports',
  'bf-platform-feedback',
  'bf-platform-marketing',
  'bf-platform-pitr',
];

/** Namespace of the platform buckets; a project prefix equal to it reaches no bucket at all. */
export const PLATFORM_NAMESPACE = 'platform-';

/** Lower-case, anything outside `[a-z0-9-]` becomes `-` (what MinIO accepts). */
function sanitise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

/** The project's namespace inside the store, trailing hyphen included: `bf-acme-x1y2z3-`. */
export function physicalPrefix(bucketPrefix: string, projectPrefix: string): string {
  return sanitise(`${bucketPrefix}${projectPrefix}-`);
}

/** Physical bucket name. Unchecked: callers outside StorageService must use `ownedBucket`. */
export function physicalBucketName(bucketPrefix: string, projectPrefix: string, bucketName: string): string {
  return sanitise(`${bucketPrefix}${projectPrefix}-${bucketName}`);
}

/** A project's effective prefix: the frozen `storagePrefix`, or the slug. */
export function effectivePrefix(project: { slug: string; storagePrefix?: string | null }): string {
  return project.storagePrefix ?? project.slug;
}

/**
 * Two namespaces overlap when one starts with the other (`bf-a-` and `bf-a-b-`): then some
 * physical name lies in both and its owner cannot be read from the name.
 */
export function prefixesOverlap(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

/** A platform bucket, or a name built by a project whose prefix is the bare platform namespace. */
export function isPlatformBucket(physical: string, projectPhysicalPrefix: string, bucketPrefix: string): boolean {
  if (PLATFORM_BUCKETS.includes(physical)) return true;
  const platform = sanitise(`${bucketPrefix}${PLATFORM_NAMESPACE}`);
  // A legacy project whose slug is exactly `platform` builds names in the platform namespace only.
  return projectPhysicalPrefix.length <= platform.length && physical.startsWith(platform);
}

export type BucketOwnership =
  /** Recorded for this project, or unambiguous legacy (`record` = write the owner row now). */
  | { kind: 'owned'; record: boolean }
  /** Recorded for another project. */
  | { kind: 'foreign'; ownerId: string }
  /** No record, and more than one project prefix matches (or none is this project). */
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'platform' };

export interface ClassifyInput {
  physical: string;
  project: { id: string; physicalPrefix: string };
  bucketPrefix: string;
  /** Project id recorded in storage_bucket_owners; null/undefined when there is no row. */
  recordedOwner?: string | null;
  /** Physical prefixes of every project, any status. Only read when there is no record. */
  allProjects?: ReadonlyArray<{ id: string; physicalPrefix: string }>;
}

export function classifyBucket(input: ClassifyInput): BucketOwnership {
  const { physical, project } = input;
  if (isPlatformBucket(physical, project.physicalPrefix, input.bucketPrefix)) return { kind: 'platform' };
  if (input.recordedOwner) {
    return input.recordedOwner === project.id
      ? { kind: 'owned', record: false }
      : { kind: 'foreign', ownerId: input.recordedOwner };
  }
  const candidates = new Set(
    (input.allProjects ?? []).filter((p) => physical.startsWith(p.physicalPrefix)).map((p) => p.id),
  );
  if (physical.startsWith(project.physicalPrefix)) candidates.add(project.id);
  if (candidates.size === 1 && candidates.has(project.id)) return { kind: 'owned', record: true };
  return { kind: 'ambiguous', candidates: [...candidates] };
}

/**
 * Whether a new bucket name lands in another project's namespace: another project's prefix that
 * is at least as long as this one's matches the physical name. Such a create is refused, so a
 * name is never taken from the project whose namespace it reads as.
 */
export function inOtherNamespace(
  physical: string,
  project: { id: string; physicalPrefix: string },
  allProjects: ReadonlyArray<{ id: string; physicalPrefix: string }>,
): boolean {
  return allProjects.some(
    (p) =>
      p.id !== project.id &&
      p.physicalPrefix.length >= project.physicalPrefix.length &&
      physical.startsWith(p.physicalPrefix),
  );
}

/**
 * Whether a candidate project prefix (slug or storagePrefix, before sanitising) overlaps an
 * existing project's namespace or the platform's. New projects never get an overlapping prefix
 * (ProjectsService), which closes the ambiguity for every bucket they create.
 */
export function prefixIsAmbiguous(candidate: string, existing: ReadonlyArray<string>): boolean {
  const mine = physicalPrefix('', candidate);
  if (prefixesOverlap(mine, PLATFORM_NAMESPACE)) return true;
  return existing.some((e) => prefixesOverlap(mine, physicalPrefix('', e)));
}
