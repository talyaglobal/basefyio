/**
 * Which physical buckets a project's S3 keys may reach, and the MinIO policy that says so
 * (feedback #225). Pure functions: the service feeds them the bucket listing and the projects.
 *
 * Physical names are `<bucketPrefix><prefix>-<name>`, and both prefix and name may contain `-`,
 * so `bf-a-` + `b-x` and `bf-a-b-` + `x` are the same string. A wildcard ARN such as
 * `arn:aws:s3:::bf-a-*` would therefore reach every bucket of project `a-b`. The policy lists
 * buckets by exact name instead, and a bucket is granted only when its owner is known:
 *
 *  - a `storage_bucket_owners` record says this project created it, or
 *  - no record exists and this project's prefix is the only project prefix the name starts with
 *    (projects of any status count, so a deleted project's leftovers stay ambiguous).
 *
 * Anything else is left out (fail closed) and reported as unreachable.
 */

export interface GrantProject {
  id: string;
  /** Physical prefix including the trailing hyphen, e.g. `bf-acme-x1y2z3-`. */
  prefix: string;
}

export interface GrantInput {
  project: GrantProject;
  /** Every other project (any status) with its physical prefix. */
  others: GrantProject[];
  /** Every physical bucket in the store. */
  buckets: string[];
  /** Recorded owners: physical name → project id. */
  owners: Map<string, string>;
  /** Physical names no customer key may ever reach (platform buckets), as prefixes. */
  reservedPrefixes: string[];
}

export interface GrantResult {
  /** Physical bucket names the policy grants, sorted. */
  granted: string[];
  /** Unrecorded, unambiguous buckets to record for this project. */
  backfill: string[];
  /** Buckets under this project's prefix that are not granted, with the reason. */
  unreachable: Array<{ physical: string; reason: string }>;
}

export function computeGrantSet(input: GrantInput): GrantResult {
  const granted: string[] = [];
  const backfill: string[] = [];
  const unreachable: GrantResult['unreachable'] = [];
  const reserved = (b: string) => input.reservedPrefixes.some((p) => b.startsWith(p));

  for (const bucket of input.buckets) {
    const owner = input.owners.get(bucket);
    const underOwnPrefix = bucket.startsWith(input.project.prefix);
    if (!underOwnPrefix && owner !== input.project.id) continue;

    if (reserved(bucket)) {
      if (underOwnPrefix) unreachable.push({ physical: bucket, reason: 'reserved platform namespace' });
      continue;
    }
    if (owner !== undefined) {
      if (owner === input.project.id) granted.push(bucket);
      // Recorded for another project: not ours, and not worth naming.
      continue;
    }
    const overlapping = input.others.some((o) => o.id !== input.project.id && bucket.startsWith(o.prefix));
    if (overlapping) {
      unreachable.push({
        physical: bucket,
        reason: "name overlaps another project's storage namespace; copy the files to a new bucket",
      });
      continue;
    }
    granted.push(bucket);
    backfill.push(bucket);
  }
  granted.sort();
  return { granted, backfill, unreachable };
}

/** Bucket-level actions a key gets. No ListAllMyBuckets: that would name other customers' buckets. */
export const S3_KEY_BUCKET_ACTIONS = ['s3:GetBucketLocation', 's3:ListBucket', 's3:ListBucketMultipartUploads'];

/**
 * Object-level actions. Nothing that changes a bucket itself: no PutBucketPolicy (a key could
 * make a bucket public), no DeleteBucket, versioning, lifecycle, replication or notification.
 */
export const S3_KEY_OBJECT_ACTIONS = [
  's3:GetObject',
  's3:PutObject',
  's3:DeleteObject',
  's3:AbortMultipartUpload',
  's3:ListMultipartUploadParts',
];

/** Never a bucket name: S3 names cannot contain `_`. Used when a project has no reachable bucket. */
const NO_BUCKET = 'arn:aws:s3:::basefyio_no_bucket';

export function s3KeyPolicy(buckets: readonly string[]): object {
  if (buckets.length === 0) {
    // MinIO refuses an empty statement list; a key with this policy authenticates and reaches nothing.
    return {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Deny', Action: ['s3:*'], Resource: [NO_BUCKET, `${NO_BUCKET}/*`] }],
    };
  }
  for (const b of buckets) {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(b)) throw new Error(`Refusing to grant invalid bucket name "${b}"`);
  }
  return {
    Version: '2012-10-17',
    Statement: [
      { Effect: 'Allow', Action: S3_KEY_BUCKET_ACTIONS, Resource: buckets.map((b) => `arn:aws:s3:::${b}`) },
      { Effect: 'Allow', Action: S3_KEY_OBJECT_ACTIONS, Resource: buckets.map((b) => `arn:aws:s3:::${b}/*`) },
    ],
  };
}

export function s3KeyPolicyName(projectId: string): string {
  return `bf-s3keys-${projectId}`;
}
