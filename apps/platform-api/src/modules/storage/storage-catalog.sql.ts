/**
 * SQL and row shapes for the storage catalog — the `storage.buckets` and
 * `storage.objects` tables the RLS bootstrap creates in every project
 * database (rls-bootstrap.sql §5). Pure: no connection, no Nest, so the
 * statements and the metadata layout are unit tested on their own.
 *
 * The row layout is Supabase's, so policies written for Supabase apply
 * unchanged and the facade's listing answers carry the same `metadata`
 * object supabase-js shows its users.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** The `metadata` column, as supabase-js expects it on a listed file. */
export interface CatalogObjectMetadata {
  eTag: string;
  size: number;
  mimetype: string;
  cacheControl: string;
  lastModified: string;
  contentLength: number;
  httpStatusCode: number;
}

export interface CatalogObjectInput {
  bucket: string;
  name: string;
  size: number;
  mimetype: string;
  etag?: string;
  /** e.g. `max-age=3600`; defaults to `no-cache` like Supabase does. */
  cacheControl?: string;
  lastModified?: Date | string;
  /** The uploader's subject; written to `owner_id`, and to `owner` when it is a UUID. */
  owner?: string;
  userMetadata?: Record<string, unknown> | null;
}

export interface CatalogBucketInput {
  name: string;
  public: boolean;
  fileSizeLimit?: number | null;
  allowedMimeTypes?: string[] | null;
  owner?: string;
}

export interface CatalogBucketRow {
  id: string;
  name: string;
  owner: string | null;
  owner_id: string | null;
  public: boolean;
  file_size_limit: number | null;
  allowed_mime_types: string[] | null;
  created_at: string;
  updated_at: string;
}

export interface CatalogObjectRow {
  id: string;
  bucket_id: string;
  name: string;
  owner: string | null;
  owner_id: string | null;
  metadata: CatalogObjectMetadata | null;
  user_metadata: Record<string, unknown> | null;
  version: string | null;
  created_at: string;
  updated_at: string;
  last_accessed_at: string;
}

/** Object-store metadata header carrying the caller's `metadata` option, as JSON. */
export const USER_METADATA_HEADER = 'x-amz-meta-user-metadata';

export function objectMetadata(input: CatalogObjectInput): CatalogObjectMetadata {
  const etag = input.etag ? (input.etag.startsWith('"') ? input.etag : `"${input.etag}"`) : '';
  const last = input.lastModified instanceof Date
    ? input.lastModified
    : input.lastModified
      ? new Date(input.lastModified)
      : new Date();
  return {
    eTag: etag,
    size: input.size,
    mimetype: input.mimetype || 'application/octet-stream',
    cacheControl: input.cacheControl || 'no-cache',
    lastModified: isNaN(last.getTime()) ? new Date().toISOString() : last.toISOString(),
    contentLength: input.size,
    httpStatusCode: 200,
  };
}

/**
 * Reads the catalog-relevant parts out of the headers an upload carried:
 * the owner tag, the cache directive and the user metadata document.
 */
export function catalogFieldsFromMeta(meta: Record<string, unknown> | undefined): {
  owner?: string;
  cacheControl?: string;
  userMetadata?: Record<string, unknown>;
} {
  const out: { owner?: string; cacheControl?: string; userMetadata?: Record<string, unknown> } = {};
  if (!meta) return out;
  for (const [key, raw] of Object.entries(meta)) {
    if (typeof raw !== 'string' || !raw) continue;
    const value = raw;
    // Headers as sent (`x-amz-meta-owner`) and as the client library hands
    // them back from a stat (`owner`) are both accepted.
    const k = key.toLowerCase().replace(/^x-amz-meta-/, '');
    if (k === 'owner') out.owner = value;
    else if (k === 'cache-control') out.cacheControl = value;
    else if (k === 'user-metadata') {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) out.userMetadata = parsed;
      } catch {
        /* not JSON; ignored */
      }
    }
  }
  return out;
}

export const ENSURE_BUCKET_SQL = `
  INSERT INTO storage.buckets (id, name, public, owner, owner_id)
  VALUES ($1, $1, $2, $3, $4)
  ON CONFLICT (id) DO NOTHING`;

export const UPSERT_BUCKET_SQL = `
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types, owner, owner_id)
  VALUES ($1, $1, $2, $3, $4, $5, $6)
  ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = COALESCE(EXCLUDED.file_size_limit, storage.buckets.file_size_limit),
    allowed_mime_types = COALESCE(EXCLUDED.allowed_mime_types, storage.buckets.allowed_mime_types),
    updated_at = now()`;

export function upsertBucketParams(input: CatalogBucketInput): unknown[] {
  return [
    input.name,
    !!input.public,
    input.fileSizeLimit ?? null,
    input.allowedMimeTypes ?? null,
    isUuid(input.owner) ? input.owner : null,
    input.owner ?? null,
  ];
}

export const UPDATE_BUCKET_SQL = `
  UPDATE storage.buckets SET
    public = COALESCE($2, public),
    file_size_limit = CASE WHEN $3::boolean THEN $4 ELSE file_size_limit END,
    allowed_mime_types = CASE WHEN $5::boolean THEN $6 ELSE allowed_mime_types END,
    updated_at = now()
  WHERE id = $1`;

export const DELETE_BUCKET_SQL = `DELETE FROM storage.buckets WHERE id = $1`;
export const DELETE_BUCKET_OBJECTS_SQL = `DELETE FROM storage.objects WHERE bucket_id = $1`;

export const SELECT_BUCKET_SQL = `
  SELECT id, name, owner, owner_id, public, file_size_limit, allowed_mime_types, created_at, updated_at
  FROM storage.buckets WHERE id = $1`;

export const SELECT_BUCKETS_SQL = `
  SELECT id, name, owner, owner_id, public, file_size_limit, allowed_mime_types, created_at, updated_at
  FROM storage.buckets ORDER BY name`;

export const UPSERT_OBJECT_SQL = `
  INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata, user_metadata, version)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  ON CONFLICT (bucket_id, name) DO UPDATE SET
    owner = COALESCE(EXCLUDED.owner, storage.objects.owner),
    owner_id = COALESCE(EXCLUDED.owner_id, storage.objects.owner_id),
    metadata = EXCLUDED.metadata,
    user_metadata = COALESCE(EXCLUDED.user_metadata, storage.objects.user_metadata),
    version = EXCLUDED.version,
    updated_at = now(),
    last_accessed_at = now()
  RETURNING id`;

export function upsertObjectParams(input: CatalogObjectInput): unknown[] {
  return [
    input.bucket,
    input.name,
    isUuid(input.owner) ? input.owner : null,
    input.owner ?? null,
    JSON.stringify(objectMetadata(input)),
    input.userMetadata ? JSON.stringify(input.userMetadata) : null,
    input.etag ? input.etag.replace(/^"|"$/g, '') : null,
  ];
}

export const DELETE_OBJECTS_SQL = `
  DELETE FROM storage.objects WHERE bucket_id = $1 AND name = ANY($2::text[])`;

export const MOVE_OBJECT_SQL = `
  UPDATE storage.objects SET bucket_id = $3, name = $4, updated_at = now(), last_accessed_at = now()
  WHERE bucket_id = $1 AND name = $2`;

export const SELECT_OBJECT_SQL = `
  SELECT id, bucket_id, name, owner, owner_id, metadata, user_metadata, version,
         created_at, updated_at, last_accessed_at
  FROM storage.objects WHERE bucket_id = $1 AND name = $2`;

export const SELECT_OBJECT_NAMES_SQL = `
  SELECT name FROM storage.objects WHERE bucket_id = $1 ORDER BY name`;

/** `undefined_table` / `invalid_schema_name`: the project has no catalog yet. */
export function isCatalogMissingError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return code === '42P01' || code === '3F000';
}
