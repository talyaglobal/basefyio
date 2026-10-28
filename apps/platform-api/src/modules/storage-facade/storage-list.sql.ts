/**
 * The listing query behind `POST /object/list/:bucket` when a project
 * authorises with RLS (`storageAuthz = 'rls'`): one SELECT over
 * `storage.objects` that yields the folders and files directly under a
 * prefix, the way Supabase's `storage.search()` does, so the project's row
 * policies decide what the caller sees.
 *
 * Pure — no connection — so the SQL and the option handling are unit tested.
 */

export const LIST_SORT_COLUMNS = ['name', 'updated_at', 'created_at', 'last_accessed_at'] as const;
export type ListSortColumn = (typeof LIST_SORT_COLUMNS)[number];

export const LIST_DEFAULT_LIMIT = 100;
/** A hard ceiling so a listing cannot be turned into a full-table read. */
export const LIST_MAX_LIMIT = 1000;

export interface ListOptions {
  /** Normalised: '' for the root, otherwise ending in '/'. */
  prefix: string;
  limit: number;
  offset: number;
  sortBy: { column: ListSortColumn; order: 'asc' | 'desc' };
  search: string;
}

/** Normalises storage-js's `list()` body; unknown sort columns and bad numbers fall back. */
export function normaliseListOptions(body: Record<string, unknown> | undefined): ListOptions {
  const raw = (body ?? {}) as Record<string, unknown>;
  let prefix = String(raw.prefix ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (prefix.includes('..') || prefix.includes('\0')) prefix = '';
  if (prefix) prefix += '/';

  const limitN = Number(raw.limit);
  const limit = Number.isInteger(limitN) && limitN > 0 ? Math.min(limitN, LIST_MAX_LIMIT) : LIST_DEFAULT_LIMIT;
  const offsetN = Number(raw.offset);
  const offset = Number.isInteger(offsetN) && offsetN >= 0 ? offsetN : 0;

  const sortRaw = (raw.sortBy ?? {}) as { column?: unknown; order?: unknown };
  const column = (LIST_SORT_COLUMNS as readonly string[]).includes(String(sortRaw.column))
    ? (String(sortRaw.column) as ListSortColumn)
    : 'name';
  const order = String(sortRaw.order ?? '').toLowerCase() === 'desc' ? 'desc' : 'asc';

  const search = typeof raw.search === 'string' ? raw.search : '';
  return { prefix, limit, offset, sortBy: { column, order }, search };
}

export interface ListRow {
  name: string;
  id: string | null;
  updated_at: string | null;
  created_at: string | null;
  last_accessed_at: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Folders come from the first segment after the prefix of every deeper
 * object; files are the objects with no further '/'. Folder markers
 * (names ending in '/') never count. The sort column is whitelisted above,
 * so interpolating it is safe.
 */
export function buildListQuery(bucket: string, opts: ListOptions): { text: string; values: unknown[] } {
  const prefixLength = opts.prefix.length;
  const text = `
    WITH scoped AS (
      SELECT id, name, updated_at, created_at, last_accessed_at, metadata,
             substr(name, $3::int + 1) AS rest
      FROM storage.objects
      WHERE bucket_id = $1
        AND ($2::text = '' OR left(name, $3::int) = $2::text)
        AND name NOT LIKE '%/'
    ),
    entries AS (
      SELECT DISTINCT split_part(rest, '/', 1) AS name,
             NULL::uuid AS id, NULL::timestamptz AS updated_at, NULL::timestamptz AS created_at,
             NULL::timestamptz AS last_accessed_at, NULL::jsonb AS metadata
      FROM scoped WHERE position('/' in rest) > 0
      UNION ALL
      SELECT rest AS name, id, updated_at, created_at, last_accessed_at, metadata
      FROM scoped WHERE position('/' in rest) = 0 AND rest <> ''
    )
    SELECT name, id, updated_at, created_at, last_accessed_at, metadata
    FROM entries
    WHERE $4::text = '' OR name ILIKE '%' || $4::text || '%'
    ORDER BY ${opts.sortBy.column} ${opts.sortBy.order.toUpperCase()} NULLS LAST, name ASC
    LIMIT $5::int OFFSET $6::int`;
  return {
    text,
    values: [bucket, opts.prefix, prefixLength, opts.search, opts.limit, opts.offset],
  };
}

/** A listing entry as storage-js returns it. */
export interface FileObject {
  name: string;
  id: string | null;
  updated_at: string | null;
  created_at: string | null;
  last_accessed_at: string | null;
  metadata: Record<string, unknown> | null;
}

export function fileObjectFromRow(row: ListRow): FileObject {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null);
  return {
    name: row.name,
    id: row.id ?? null,
    updated_at: iso(row.updated_at),
    created_at: iso(row.created_at),
    last_accessed_at: iso(row.last_accessed_at),
    metadata: row.metadata ?? null,
  };
}

/**
 * In-memory counterpart for the preset mode, where the listing comes from
 * the object store: same search, sort, offset and limit as the SQL.
 */
export function applyListOptions(entries: FileObject[], opts: ListOptions): FileObject[] {
  let out = entries;
  if (opts.search) {
    const needle = opts.search.toLowerCase();
    out = out.filter((e) => e.name.toLowerCase().includes(needle));
  }
  const col = opts.sortBy.column;
  const dir = opts.sortBy.order === 'desc' ? -1 : 1;
  out = [...out].sort((a, b) => {
    const av = a[col];
    const bv = b[col];
    if (av === bv) return a.name.localeCompare(b.name);
    if (av === null || av === undefined) return 1; // NULLS LAST
    if (bv === null || bv === undefined) return -1;
    return (av < bv ? -1 : 1) * dir;
  });
  return out.slice(opts.offset, opts.offset + opts.limit);
}
