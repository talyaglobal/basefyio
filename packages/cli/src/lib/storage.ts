/**
 * Pure helpers behind `basefyio storage …`: shapes of the platform API answers and how they are
 * printed. No network, no terminal, so the rules (never print a secret twice, which bucket name an
 * S3 client uses) are testable without a server.
 */

export interface BucketSummary {
  name: string;
  public: boolean;
  objectCount?: number;
  totalSize?: number;
  createdAt?: string;
}

export interface S3BucketRef {
  name: string | null;
  physical: string;
}

export interface S3ConnectionInfo {
  enabled: boolean;
  unavailableReason: string | null;
  endpoint: string;
  region: string;
  pathStyle: boolean;
  buckets: S3BucketRef[];
  unreachable: Array<{ physical: string; reason: string }>;
  maxKeys: number;
}

export interface S3KeyView {
  id: string;
  name: string;
  accessKeyId: string;
  secretLast4: string;
  createdAt: string;
}

export interface S3KeyCreated extends S3KeyView {
  secretAccessKey: string;
  endpoint: string;
  region: string;
  pathStyle: boolean;
  buckets: S3BucketRef[];
}

/** Bucket names follow the API's rule: 3-63 letters, digits and hyphens, no hyphen at either end. */
export function validateBucketName(name: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{1,61}[A-Za-z0-9]$/.test(name ?? '')) {
    return 'Bucket name must be 3-63 characters: letters, digits and hyphens, not starting or ending with a hyphen';
  }
  return null;
}

/** The secret as the list shows it: never more than its last four characters. */
export function maskedSecret(last4: string): string {
  return `••••••••${last4}`;
}

export function keyRows(keys: S3KeyView[]): string[][] {
  return keys.map((k) => [k.id, k.name, k.accessKeyId, maskedSecret(k.secretLast4), k.createdAt.slice(0, 10)]);
}

/** `name (physical)`, or just the physical name when it is outside the project's prefix. */
export function bucketLabel(b: S3BucketRef): string {
  return b.name ? `${b.name}  →  ${b.physical}` : b.physical;
}

/**
 * Lines for `storage status`: everything an S3 client needs except a secret.
 * The secret is never part of this view.
 */
export function connectionLines(info: S3ConnectionInfo): Array<[string, string]> {
  return [
    ['S3 access keys', info.enabled ? 'enabled' : `not available: ${info.unavailableReason ?? 'disabled'}`],
    ['Endpoint', info.endpoint],
    ['Region', info.region],
    ['Path-style', info.pathStyle ? 'yes (forcePathStyle: true)' : 'no'],
    ['Secret', 'shown once by  basefyio storage create-key'],
  ];
}

/**
 * Environment lines for a freshly created key, in the names AWS SDKs read. Printed once, right
 * after creation; the platform cannot show the secret again.
 */
export function awsEnvLines(created: S3KeyCreated): string[] {
  return [
    `AWS_ACCESS_KEY_ID=${created.accessKeyId}`,
    `AWS_SECRET_ACCESS_KEY=${created.secretAccessKey}`,
    `AWS_REGION=${created.region}`,
    `AWS_ENDPOINT_URL_S3=${created.endpoint}`,
  ];
}

export function formatSize(bytes?: number): string {
  if (bytes === undefined || bytes === null) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}
