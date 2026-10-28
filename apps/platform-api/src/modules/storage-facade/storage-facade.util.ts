import { createHash } from 'crypto';
import type { Request } from 'express';
import { StorageFacadeError } from './storage-facade.errors';
import type { FileObject } from './storage-list.sql';
import type { ImageTransformOptions } from '../storage/image-transform.service';

/** Longest object key accepted, in bytes. */
export const MAX_KEY_BYTES = 1024;

/**
 * Route segments under `object/` and `render/image/` that name a verb, not
 * a bucket. A bucket with one of these names cannot be reached through the
 * facade (the verb route wins), which is documented rather than worked around.
 */
export const RESERVED_BUCKET_SEGMENTS = new Set(['public', 'sign', 'upload', 'authenticated', 'info', 'list', 'move', 'copy', 'list-v2']);

/** Strips a leading slash, refuses traversal and NULs, caps the length; '' is refused. */
export function normaliseKey(raw: unknown): string {
  const key = String(raw ?? '').replace(/^\/+/, '').replace(/\/+/g, '/');
  if (!key || key.endsWith('/')) throw StorageFacadeError.invalid('Invalid object key');
  if (key.split('/').some((seg) => seg === '..' || seg === '.') || key.includes('\0')) {
    throw StorageFacadeError.invalid('Invalid object key');
  }
  if (Buffer.byteLength(key, 'utf8') > MAX_KEY_BYTES) {
    throw StorageFacadeError.invalid(`Object key longer than ${MAX_KEY_BYTES} bytes`);
  }
  return key;
}

export function normaliseBucketName(raw: unknown): string {
  const name = String(raw ?? '').trim();
  if (!name || name.includes('/') || name.includes('\0')) throw StorageFacadeError.invalid('Invalid bucket name');
  return name;
}

/** The wildcard tail of an Express 4 route (`req.params[0]`), URL-decoded. */
export function wildcardKey(req: Request): string {
  const params = req.params as Record<string, string | undefined>;
  const raw = params.path ?? params[0] ?? '';
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw StorageFacadeError.invalid('Malformed object key');
  }
  return normaliseKey(decoded);
}

/** `max-age=3600` from storage-js's `cacheControl: '3600'`; any value is kept as given. */
export function cacheControlHeader(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = String(raw).trim();
  if (/^\d+$/.test(value)) return `max-age=${value}`;
  return value.slice(0, 200);
}

/** The `x-metadata` header (base64 JSON) or the multipart `metadata` field (JSON). */
export function decodeUserMetadata(raw: unknown, base64 = false): Record<string, unknown> | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    const text = base64 ? Buffer.from(raw, 'base64').toString('utf8') : raw;
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    /* not JSON */
  }
  throw StorageFacadeError.invalid('metadata must be a JSON object');
}

/** Transform query as storage-js sends it → ImageTransformService options. */
export function transformOptionsFromQuery(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (query.width !== undefined && query.width !== '') out.width = query.width;
  if (query.height !== undefined && query.height !== '') out.height = query.height;
  if (query.quality !== undefined && query.quality !== '') out.quality = query.quality;
  if (query.resize !== undefined && query.resize !== '') out.fit = query.resize;
  else if (query.fit !== undefined && query.fit !== '') out.fit = query.fit;
  if (query.format !== undefined && query.format !== '' && query.format !== 'origin') out.format = query.format;
  return out;
}

/** The query a signed render URL was minted for, stored in the token. */
export function transformClaimFromOptions(transform: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!transform || typeof transform !== 'object') return undefined;
  const out: Record<string, unknown> = {};
  for (const k of ['width', 'height', 'resize', 'format', 'quality'] as const) {
    if (transform[k] !== undefined && transform[k] !== null && transform[k] !== '') out[k] = transform[k];
  }
  return Object.keys(out).length ? out : undefined;
}

/** Parses `Range: bytes=a-b` against a known size; null when there is no usable header. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  let start: number;
  let end: number;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) throw StorageFacadeError.rangeNotSatisfiable();
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end) {
    throw StorageFacadeError.rangeNotSatisfiable();
  }
  return { start, end };
}

/** RFC 6266 value for the download header; the plain form is ASCII-only. */
export function contentDisposition(kind: 'inline' | 'attachment', fileName: string): string {
  const safe = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

let mimeLookup: ((name: string) => string | false) | null | undefined;

/** A content type guessed from the extension, for listings the store cannot annotate. */
export function mimeFromName(name: string): string {
  if (mimeLookup === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('mime-types');
      mimeLookup = typeof mod?.lookup === 'function' ? mod.lookup : null;
    } catch {
      mimeLookup = null;
    }
  }
  const found = mimeLookup ? mimeLookup(name) : false;
  return found || 'application/octet-stream';
}

/**
 * A stable id for an object the catalog has no row for (preset mode without
 * a catalog): derived from bucket and key so the same object answers the
 * same id on every listing, in UUID form because clients expect one.
 */
export function syntheticObjectId(bucket: string, key: string): string {
  const h = createHash('sha1').update(`${bucket}/${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface StatLike {
  size: number;
  etag?: string;
  lastModified?: Date;
  metaData?: Record<string, unknown>;
}

/** The `metadata` object of a listed file, from what the store reports. */
export function metadataFromStat(stat: StatLike, name: string): Record<string, unknown> {
  const mimetype = (stat.metaData?.['content-type'] as string | undefined) || mimeFromName(name);
  const cacheControl = (stat.metaData?.['cache-control'] as string | undefined) || 'no-cache';
  const last = stat.lastModified instanceof Date ? stat.lastModified : new Date();
  const etag = stat.etag ? (stat.etag.startsWith('"') ? stat.etag : `"${stat.etag}"`) : '';
  return {
    eTag: etag,
    size: stat.size,
    mimetype,
    cacheControl,
    lastModified: last.toISOString(),
    contentLength: stat.size,
    httpStatusCode: 200,
  };
}

/** A listed file in preset mode, from the store's own listing or stat. */
export function fileObjectFromStat(bucket: string, key: string, displayName: string, stat: StatLike, id?: string): FileObject {
  const last = stat.lastModified instanceof Date ? stat.lastModified.toISOString() : new Date().toISOString();
  return {
    name: displayName,
    id: id ?? syntheticObjectId(bucket, key),
    updated_at: last,
    created_at: last,
    last_accessed_at: last,
    metadata: metadataFromStat(stat, key),
  };
}

export function folderObject(name: string): FileObject {
  return { name, id: null, updated_at: null, created_at: null, last_accessed_at: null, metadata: null };
}

/** The `info()` answer: Supabase's object record with `size` and `content_type` flattened. */
export function objectInfo(
  bucket: string,
  key: string,
  stat: StatLike,
  row?: { id?: string | null; created_at?: unknown; updated_at?: unknown; user_metadata?: unknown } | null,
): Record<string, unknown> {
  const meta = metadataFromStat(stat, key);
  const last = meta.lastModified as string;
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : last);
  return {
    id: row?.id ?? syntheticObjectId(bucket, key),
    name: key,
    bucket_id: bucket,
    size: stat.size,
    content_type: meta.mimetype,
    cache_control: meta.cacheControl,
    etag: meta.eTag,
    last_modified: last,
    created_at: iso(row?.created_at),
    updated_at: iso(row?.updated_at),
    metadata: (row?.user_metadata as Record<string, unknown> | null | undefined) ?? null,
  };
}

/** Transform options as the ImageTransformService wants them, from a signed claim or a query. */
export type TransformQuery = Record<string, unknown>;
export type TransformOpts = ImageTransformOptions;
