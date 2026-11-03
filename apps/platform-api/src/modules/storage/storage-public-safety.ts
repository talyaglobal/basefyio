/**
 * Two rules for what anonymous visitors of the public storage host get.
 *
 * 1. A public bucket serves its files one by one, never a listing of them: anyone with a
 *    file's URL may read it, nobody may enumerate the bucket.
 * 2. Content a browser would run — HTML, SVG, XML, JavaScript — is stored as a download
 *    (`Content-Disposition: attachment`), so an uploaded page cannot execute on the shared
 *    storage origin (phishing, stored XSS).
 */

/** Media types a browser renders as an active document. */
const ACTIVE_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/xml',
  'application/xml',
  'text/xsl',
  'application/javascript',
  'text/javascript',
  'application/x-javascript',
  'application/ecmascript',
  'text/ecmascript',
]);

/** Extra object metadata for an upload of this media type: a download for active content. */
export function downloadOnlyHeaders(contentType: string | undefined): Record<string, string> {
  const type = (contentType || '').split(';')[0].trim().toLowerCase();
  return ACTIVE_TYPES.has(type) ? { 'Content-Disposition': 'attachment' } : {};
}

interface PolicyStatement {
  Effect?: string;
  Principal?: unknown;
  Action?: string | string[];
  Resource?: string | string[];
  [k: string]: unknown;
}

function isAnonymous(principal: unknown): boolean {
  if (principal === '*') return true;
  const aws = (principal as { AWS?: unknown } | undefined)?.AWS;
  return aws === '*' || (Array.isArray(aws) && aws.includes('*'));
}

/**
 * The bucket policy without anonymous listing, or null when it had none. Every other
 * statement — anonymous GetObject included — is kept exactly as it was.
 */
export function withoutAnonymousListing(policyJson: string): string | null {
  let policy: { Version?: string; Statement?: PolicyStatement[] };
  try {
    policy = JSON.parse(policyJson);
  } catch {
    return null;
  }
  const statements = Array.isArray(policy.Statement) ? policy.Statement : [];
  let changed = false;
  const kept: PolicyStatement[] = [];
  for (const s of statements) {
    const actions = Array.isArray(s.Action) ? s.Action : s.Action ? [s.Action] : [];
    const listing: string[] = actions.filter((a) => a === 's3:ListBucket' || a === 's3:ListBucketMultipartUploads');
    if (s.Effect !== 'Allow' || !isAnonymous(s.Principal) || listing.length === 0) {
      kept.push(s);
      continue;
    }
    changed = true;
    const rest = actions.filter((a) => !listing.includes(a));
    if (rest.length) kept.push({ ...s, Action: rest });
  }
  if (!changed) return null;
  return JSON.stringify({ ...policy, Statement: kept });
}
