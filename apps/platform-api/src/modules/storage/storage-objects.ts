import { BadRequestException } from '@nestjs/common';

/**
 * Pure helpers for object keys, listings, content headers and per-bucket
 * upload limits. Kept apart from StorageService so they can be tested without
 * an object store.
 */

// ── Keys ─────────────────────────────────────────────────

/** Strips leading slashes and refuses traversal and NUL bytes. `what` names the field in the error. */
export function cleanKey(raw: unknown, what = 'path'): string {
  if (typeof raw !== 'string') throw new BadRequestException(`${what} must be a string`);
  const key = raw.trim().replace(/^\/+/, '');
  if (!key) throw new BadRequestException(`${what} is required`);
  if (key.includes('\0') || key.split('/').some((seg) => seg === '..')) {
    throw new BadRequestException(`Invalid ${what}`);
  }
  return key;
}

/** A non-empty array of strings, at most `max` long; anything else is a 400 naming the field. */
export function stringList(raw: unknown, what: string, max = 1000): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((p) => typeof p !== 'string')) {
    throw new BadRequestException(`${what} must be a non-empty array of strings`);
  }
  if (raw.length > max) throw new BadRequestException(`${what} accepts at most ${max} entries per request`);
  return raw as string[];
}

// ── Listings ─────────────────────────────────────────────

export interface ListedObject {
  name: string;
  prefix?: string;
  size: number;
  lastModified: Date | string;
  etag?: string;
}

export type ListSortKey = 'name' | 'size' | 'lastModified';

export interface ListOptions {
  limit?: number;
  offset?: number;
  sortBy?: ListSortKey;
  order?: 'asc' | 'desc';
  /** Case-insensitive substring of the entry's own name (not its folder). */
  search?: string;
}

const SORT_KEYS: readonly ListSortKey[] = ['name', 'size', 'lastModified'];
export const MAX_LIST_LIMIT = 1000;

/** Reads `limit`, `offset`, `sortBy`, `order` and `search` from a query string; absent values stay absent. */
export function parseListOptions(query: Record<string, unknown>): ListOptions {
  const out: ListOptions = {};
  const int = (name: string, min: number, max: number): number | undefined => {
    const raw = query[name];
    if (raw === undefined || raw === '') return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new BadRequestException(`${name} must be an integer between ${min} and ${max}`);
    }
    return n;
  };
  out.limit = int('limit', 1, MAX_LIST_LIMIT);
  out.offset = int('offset', 0, Number.MAX_SAFE_INTEGER);
  if (query.sortBy !== undefined && query.sortBy !== '') {
    if (!SORT_KEYS.includes(query.sortBy as ListSortKey)) {
      throw new BadRequestException(`sortBy must be one of ${SORT_KEYS.join(', ')}`);
    }
    out.sortBy = query.sortBy as ListSortKey;
  }
  if (query.order !== undefined && query.order !== '') {
    if (query.order !== 'asc' && query.order !== 'desc') throw new BadRequestException('order must be asc or desc');
    out.order = query.order;
  }
  if (typeof query.search === 'string' && query.search.trim()) out.search = query.search.trim().slice(0, 200);
  return out;
}

/** The entry's own name: the last path segment of a file, the last folder of a prefix. */
export function displayName(o: ListedObject): string {
  const full = o.prefix ?? o.name ?? '';
  return full.replace(/\/$/, '').split('/').pop() ?? '';
}

/**
 * Search, sort and page a listing. Folders stay ahead of files whatever the
 * sort, so a page never interleaves them. With no options the listing comes
 * back untouched — the order the store returned, as before.
 */
export function pageListing<T extends ListedObject>(
  objects: T[],
  opts: ListOptions,
): { items: T[]; total: number } {
  let rows = objects;
  if (opts.search) {
    const needle = opts.search.toLowerCase();
    rows = rows.filter((o) => displayName(o).toLowerCase().includes(needle));
  }
  if (opts.sortBy) {
    const dir = opts.order === 'desc' ? -1 : 1;
    const key = opts.sortBy;
    const value = (o: T): number | string => {
      if (key === 'size') return o.size ?? 0;
      if (key === 'lastModified') return new Date(o.lastModified as any).getTime() || 0;
      return displayName(o).toLowerCase();
    };
    rows = [...rows].sort((a, b) => {
      const fa = a.prefix ? 0 : 1;
      const fb = b.prefix ? 0 : 1;
      if (fa !== fb) return fa - fb;
      const va = value(a);
      const vb = value(b);
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
  }
  const total = rows.length;
  const offset = opts.offset ?? 0;
  const items = opts.limit !== undefined ? rows.slice(offset, offset + opts.limit) : offset ? rows.slice(offset) : rows;
  return { items, total };
}

// ── Content headers ──────────────────────────────────────

const ACTIVE_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/xml',
  'application/xml',
  'text/xsl',
  'application/xslt+xml',
]);

/**
 * Types a browser runs as a page of its own when opened at their URL. Served
 * from the storage origin every project shares, such a file could script or
 * phish under that origin, so it is stored with `Content-Disposition:
 * attachment`: opened directly it downloads, while `<img src>` and friends
 * ignore the header and keep working.
 */
export function isActiveContentType(contentType: string | undefined): boolean {
  const base = (contentType || '').split(';')[0].trim().toLowerCase();
  return ACTIVE_TYPES.has(base) || base.endsWith('+xml');
}

/** Extra object headers to store for an upload of this type; empty for ordinary files. */
export function activeContentHeaders(contentType: string | undefined, key: string): Record<string, string> {
  if (!isActiveContentType(contentType)) return {};
  const fileName = encodeURIComponent(key.split('/').pop() || 'download');
  return { 'Content-Disposition': `attachment; filename="${fileName}"; filename*=UTF-8''${fileName}` };
}

// ── Per-bucket upload limits ─────────────────────────────

export interface BucketLimits {
  /** Bytes; null = the platform ceiling. */
  fileSizeLimit: number | null;
  /** Empty = any type. */
  allowedMimeTypes: string[];
}

export const NO_LIMITS: BucketLimits = { fileSizeLimit: null, allowedMimeTypes: [] };

const MIME_PATTERN_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/([a-z0-9][a-z0-9!#$&^_.+-]*|\*)$/;
const MAX_MIME_PATTERNS = 50;

/**
 * Validates the limit fields of a bucket create/update body. Returns only the
 * fields that were present, so an update leaves the others alone; `null`
 * clears a limit.
 */
export function parseBucketLimits(body: Record<string, unknown>): Partial<BucketLimits> {
  const out: Partial<BucketLimits> = {};
  if ('fileSizeLimit' in body) {
    const v = body.fileSizeLimit;
    if (v === null) out.fileSizeLimit = null;
    else if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) out.fileSizeLimit = v;
    else throw new BadRequestException('fileSizeLimit must be a positive whole number of bytes, or null');
  }
  if ('allowedMimeTypes' in body) {
    const v = body.allowedMimeTypes;
    if (v === null) out.allowedMimeTypes = [];
    else if (Array.isArray(v) && v.every((t) => typeof t === 'string')) {
      const types = [...new Set((v as string[]).map((t) => t.trim().toLowerCase()).filter(Boolean))];
      if (types.length > MAX_MIME_PATTERNS) {
        throw new BadRequestException(`allowedMimeTypes accepts at most ${MAX_MIME_PATTERNS} entries`);
      }
      const bad = types.find((t) => !MIME_PATTERN_RE.test(t));
      if (bad) throw new BadRequestException(`"${bad}" is not a MIME type (use e.g. "image/png" or "image/*")`);
      out.allowedMimeTypes = types;
    } else {
      throw new BadRequestException('allowedMimeTypes must be an array of MIME types, or null');
    }
  }
  return out;
}

/** Whether `contentType` matches one of the patterns ("image/png", "image/*"); any type when there are none. */
export function mimeAllowed(contentType: string | undefined, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return true;
  const base = (contentType || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  return patterns.some((p) => (p.endsWith('/*') ? base.startsWith(p.slice(0, -1)) : base === p));
}

/** The reason an upload breaks the bucket's limits, or null when it fits. */
export function limitViolation(
  limits: BucketLimits,
  bucket: string,
  size: number,
  contentType: string | undefined,
): { status: 413 | 415; message: string } | null {
  if (limits.fileSizeLimit !== null && size > limits.fileSizeLimit) {
    return {
      status: 413,
      message: `File is ${size} bytes; bucket "${bucket}" accepts files up to ${limits.fileSizeLimit} bytes`,
    };
  }
  if (!mimeAllowed(contentType, limits.allowedMimeTypes)) {
    return {
      status: 415,
      message: `Bucket "${bucket}" does not accept ${contentType || 'files without a type'}; allowed: ${limits.allowedMimeTypes.join(', ')}`,
    };
  }
  return null;
}

// ── Bucket names ─────────────────────────────────────────

/** What the API accepts for a new bucket: what the docs promise, nothing the store would silently rewrite. */
export const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export function assertBucketName(name: unknown): string {
  if (typeof name !== 'string' || !BUCKET_NAME_RE.test(name)) {
    throw new BadRequestException(
      'Bucket name must be 3-63 characters of lowercase letters, digits and hyphens, and cannot start or end with a hyphen',
    );
  }
  return name;
}
