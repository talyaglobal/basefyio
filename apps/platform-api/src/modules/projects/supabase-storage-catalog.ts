/**
 * Pure helpers for the storage half of a Supabase import: the `storage`
 * schema rows (buckets, objects) and the row-level security policies on them,
 * read from the source's catalog and replayed into the project database so
 * the Supabase-compatible storage facade (`storageAuthz = 'rls'`) judges
 * requests by the policies the app was written against.
 *
 * No connection in here — the importer feeds rows in and runs the
 * statements out — so the SQL is unit tested on its own.
 */

export interface SourceStorageBucket {
  id: string;
  name: string | null;
  public: boolean | null;
  owner: string | null;
  owner_id: string | null;
  file_size_limit: number | string | null;
  allowed_mime_types: string[] | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}

export interface SourceStorageObject {
  id: string;
  bucket_id: string;
  name: string;
  owner: string | null;
  owner_id: string | null;
  metadata: Record<string, unknown> | null;
  user_metadata?: Record<string, unknown> | null;
  version: string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
  last_accessed_at: Date | string | null;
}

/** One row of `pg_policies WHERE schemaname = 'storage'`. */
export interface SourceStoragePolicy {
  tablename: string;
  policyname: string;
  permissive: string | null;
  roles: string[] | string | null;
  cmd: string | null;
  qual: string | null;
  with_check: string | null;
}

export const SOURCE_STORAGE_BUCKETS_SQL = `
  select id, name, public, owner::text as owner, owner_id, file_size_limit, allowed_mime_types, created_at, updated_at
    from storage.buckets`;

/** Newer instances carry `user_metadata`; the fallback is for those that do not. */
export const SOURCE_STORAGE_OBJECTS_SQL = `
  select id::text as id, bucket_id, name, owner::text as owner, owner_id, metadata, user_metadata, version,
         created_at, updated_at, last_accessed_at
    from storage.objects`;
export const SOURCE_STORAGE_OBJECTS_LEGACY_SQL = `
  select id::text as id, bucket_id, name, owner::text as owner, owner_id, metadata, null::jsonb as user_metadata, version,
         created_at, updated_at, last_accessed_at
    from storage.objects`;

export const SOURCE_STORAGE_POLICIES_SQL = `
  select tablename, policyname, permissive, roles, cmd, qual, with_check
    from pg_policies
   where schemaname = 'storage'
   order by tablename, policyname`;

/** What the destination's `auth.uid()` returns, to decide whether policies need a cast. */
export const DESTINATION_UID_RETURN_SQL = `
  select pg_get_function_result(p.oid) as returns
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'auth' and p.proname = 'uid'
   limit 1`;

export const DEST_UPSERT_BUCKET_SQL = `
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types, owner, owner_id, created_at, updated_at)
  values ($1, $2, $3, $4, $5, $6, $7, coalesce($8, now()), coalesce($9, now()))
  on conflict (id) do update set
    name = excluded.name,
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types,
    owner = coalesce(excluded.owner, storage.buckets.owner),
    owner_id = coalesce(excluded.owner_id, storage.buckets.owner_id),
    updated_at = now()`;

/**
 * The source's id and timestamps win over a row the upload hook wrote
 * moments earlier, so references an app kept to object ids keep resolving.
 */
export const DEST_UPSERT_OBJECT_SQL = `
  insert into storage.objects (id, bucket_id, name, owner, owner_id, metadata, user_metadata, version,
                               created_at, updated_at, last_accessed_at)
  values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9, now()), coalesce($10, now()), coalesce($11, now()))
  on conflict (bucket_id, name) do update set
    id = excluded.id,
    owner = excluded.owner,
    owner_id = excluded.owner_id,
    metadata = coalesce(excluded.metadata, storage.objects.metadata),
    user_metadata = excluded.user_metadata,
    version = excluded.version,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at,
    last_accessed_at = excluded.last_accessed_at`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: unknown): string | null => (typeof v === 'string' && UUID_RE.test(v) ? v : null);
const dateOrNull = (v: unknown): Date | null => {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string' && v) {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
};

/**
 * Bucket ids are the logical names the platform stores under; Supabase's
 * `id` and `name` normally agree, and when they do not the name wins
 * because that is what the objects were uploaded as.
 */
export function logicalBucketName(bucket: Pick<SourceStorageBucket, 'id' | 'name'>): string {
  return (bucket.name || bucket.id || '').trim();
}

export function destBucketParams(bucket: SourceStorageBucket): unknown[] {
  const name = logicalBucketName(bucket);
  const limit = bucket.file_size_limit === null || bucket.file_size_limit === undefined ? null : Number(bucket.file_size_limit);
  return [
    name,
    name,
    !!bucket.public,
    Number.isFinite(limit as number) ? limit : null,
    bucket.allowed_mime_types ?? null,
    uuidOrNull(bucket.owner),
    bucket.owner_id ?? bucket.owner ?? null,
    dateOrNull(bucket.created_at),
    dateOrNull(bucket.updated_at),
  ];
}

export function destObjectParams(
  object: SourceStorageObject,
  bucketIdToName: ReadonlyMap<string, string>,
): unknown[] {
  return [
    object.id,
    bucketIdToName.get(object.bucket_id) ?? object.bucket_id,
    object.name,
    uuidOrNull(object.owner),
    object.owner_id ?? object.owner ?? null,
    object.metadata ? JSON.stringify(object.metadata) : null,
    object.user_metadata ? JSON.stringify(object.user_metadata) : null,
    object.version ?? null,
    dateOrNull(object.created_at),
    dateOrNull(object.updated_at),
    dateOrNull(object.last_accessed_at),
  ];
}

/** The owner to stamp on an uploaded object, as `x-amz-meta-owner`; nothing when the source recorded none. */
export function ownerMetaFor(object: Pick<SourceStorageObject, 'owner' | 'owner_id'> | undefined): Record<string, string> {
  const owner = object?.owner_id || object?.owner;
  return owner ? { 'x-amz-meta-owner': owner } : {};
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** pg_policies.roles is name[]; node-pg parses it, but a raw `{a,b}` is handled too. */
export function parsePolicyRoles(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') {
    return value.replace(/^\{|\}$/g, '').split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
  }
  return [];
}

/**
 * Supabase's `auth.uid()` returns uuid; a project bootstrapped here returns
 * text. A policy comparing `owner = auth.uid()` (owner is uuid) would then
 * fail to compile, so the call is cast where the destination returns text.
 * Already-cast calls are left alone.
 */
export function castAuthUid(expression: string): string {
  return expression.replace(/(?<![\w.])auth\.uid\(\)(?!\s*\)\s*::uuid)/g, '(auth.uid())::uuid');
}

export interface StoragePolicyStatement {
  table: string;
  name: string;
  drop: string;
  create: string;
}

/**
 * CREATE POLICY statements for the source's storage policies, each preceded
 * by a DROP so a re-run replaces rather than fails. Policies on tables other
 * than buckets and objects (none exist in practice) are skipped.
 */
export function buildStoragePolicyStatements(
  rows: readonly SourceStoragePolicy[],
  options: { castAuthUid: boolean },
): StoragePolicyStatement[] {
  const out: StoragePolicyStatement[] = [];
  for (const row of rows) {
    const table = String(row.tablename || '').toLowerCase();
    if (table !== 'buckets' && table !== 'objects') continue;
    const name = String(row.policyname || '').trim();
    if (!name) continue;
    const target = `storage.${quoteIdent(table)}`;
    const cmd = String(row.cmd || 'ALL').toUpperCase();
    const command = ['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(cmd) ? cmd : 'ALL';
    const permissive = String(row.permissive || 'PERMISSIVE').toUpperCase() === 'RESTRICTIVE' ? 'RESTRICTIVE' : 'PERMISSIVE';
    const roles = parsePolicyRoles(row.roles);
    const to = roles.length ? roles.map((r) => (r === 'public' ? 'public' : quoteIdent(r))).join(', ') : 'public';
    const fix = (expr: string | null | undefined) => (expr ? (options.castAuthUid ? castAuthUid(expr) : expr) : null);
    const using = command === 'INSERT' ? null : fix(row.qual);
    const check = command === 'SELECT' || command === 'DELETE' ? null : fix(row.with_check);

    let create = `CREATE POLICY ${quoteIdent(name)} ON ${target} AS ${permissive} FOR ${command} TO ${to}`;
    if (using) create += ` USING (${using})`;
    if (check) create += ` WITH CHECK (${check})`;
    out.push({ table, name, drop: `DROP POLICY IF EXISTS ${quoteIdent(name)} ON ${target}`, create });
  }
  return out;
}

/** Roles the policies name that the bootstrap does not create; each is created NOLOGIN if absent. */
export function extraRolesIn(rows: readonly SourceStoragePolicy[]): string[] {
  const known = new Set(['public', 'anon', 'authenticated', 'service_role']);
  const extra = new Set<string>();
  for (const row of rows) for (const r of parsePolicyRoles(row.roles)) if (!known.has(r) && /^[a-z_][a-z0-9_]*$/i.test(r)) extra.add(r);
  return [...extra];
}

export function createRoleIfAbsentSql(role: string): string {
  return `do $$ begin if not exists (select 1 from pg_roles where rolname = '${role.replace(/'/g, "''")}') then create role ${quoteIdent(role)} nologin; end if; end $$`;
}
