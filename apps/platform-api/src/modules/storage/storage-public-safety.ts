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

/**
 * Media types a browser may show in place (#N2, 2026-11-24). Anything else is
 * served as a download of opaque bytes, whatever type was stored with it: a
 * denylist missed `+xml` types and objects stored before the upload rule, and an
 * uploaded page must never run on a shared API or storage origin.
 */
const INLINE_SAFE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp',
  'image/x-icon', 'image/vnd.microsoft.icon', 'image/heic', 'image/heif', 'image/tiff',
  'application/pdf', 'text/plain', 'text/csv', 'application/json',
]);

function inlineSafe(type: string): boolean {
  return INLINE_SAFE_TYPES.has(type) || /^(video|audio|font)\/[a-z0-9.+-]+$/.test(type);
}

/**
 * How a stored object is sent to a browser: its type and whether it may be shown in
 * place. Unsafe types go out as `application/octet-stream` attachments, so neither the
 * stored type nor a missing disposition can make the browser render them.
 */
export function servedAs(storedType: string | undefined, wantsDownload: boolean): {
  contentType: string;
  inline: boolean;
} {
  const raw = (storedType || '').trim();
  const type = raw.split(';')[0].trim().toLowerCase();
  if (!type || !inlineSafe(type)) return { contentType: 'application/octet-stream', inline: false };
  return { contentType: raw, inline: !wantsDownload };
}

/** A response that is never a document: no scripts, no plugins, no same-origin access. */
export const SANDBOX_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";

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
