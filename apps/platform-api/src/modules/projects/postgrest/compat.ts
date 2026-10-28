import { IncomingHttpHeaders } from 'http';

/**
 * supabase-js / postgrest-js wire compatibility.
 *
 * basefyio's own SDKs read a `{data, count}` envelope, so the REST data API
 * cannot simply become PostgREST. Instead the behaviour is switched per
 * request: a caller that is recognisably a PostgREST client gets PostgREST's
 * wire format (bare arrays, `Content-Range`, `Prefer`, 406 for `.single()`,
 * `{code, message, details, hint}` errors); everyone else keeps today's
 * envelope byte for byte. The detection and the small header grammars live
 * here, with no Nest dependency, so they can be unit tested on their own.
 */

export type CompatMode = 'auto' | 'off' | 'always';

/** `REST_SUPABASE_COMPAT=auto|off|always` (default auto). */
export function compatMode(env: NodeJS.ProcessEnv = process.env): CompatMode {
  const raw = String(env.REST_SUPABASE_COMPAT ?? 'auto').toLowerCase();
  return raw === 'off' || raw === 'always' ? raw : 'auto';
}

const CLIENT_INFO = /^(supabase-(js|py|dart|swift|kt|csharp)|postgrest-(js|py|dart))/i;

function first(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

/**
 * Is this request from a PostgREST-speaking client?
 *
 * supabase-js sends `X-Client-Info: supabase-js-node/<v>` (or `-web`) and
 * always an `Accept-Profile` / `Content-Profile`; bare postgrest-js sends the
 * profile headers only. A caller that is neither can opt in explicitly with
 * `X-Basefyio-Compat: postgrest`. Nothing basefyio-js or basefyio-python sends
 * matches any of these.
 */
export function isSupabaseCompat(
  h: IncomingHttpHeaders,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const mode = compatMode(env);
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  const ci = first(h['x-client-info']);
  return (
    CLIENT_INFO.test(ci) ||
    h['accept-profile'] !== undefined ||
    h['content-profile'] !== undefined ||
    /^application\/vnd\.pgrst\./i.test(first(h['accept'])) ||
    first(h['x-basefyio-compat']).toLowerCase() === 'postgrest'
  );
}

export type CountMode = 'exact' | 'planned' | 'estimated';

export interface Prefer {
  return?: 'minimal' | 'representation' | 'headers-only';
  count?: CountMode;
  resolution?: 'merge-duplicates' | 'ignore-duplicates';
  missing?: 'default' | 'null';
  params?: 'single-object' | 'multiple-objects';
  /** Every `key=value` seen, for anything not modelled above. */
  raw: Map<string, string>;
}

/**
 * Parse a `Prefer` header. postgrest-js appends several values, which Node
 * joins with `, `: `return=representation, count=exact`. Unknown keys are
 * kept in `raw`; a key repeated keeps its last value.
 */
export function parsePrefer(header: string | string[] | undefined): Prefer {
  const out: Prefer = { raw: new Map() };
  const text = Array.isArray(header) ? header.join(',') : (header ?? '');
  for (const part of text.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim().toLowerCase();
    if (!key) continue;
    out.raw.set(key, value);
    switch (key) {
      case 'return':
        if (value === 'minimal' || value === 'representation' || value === 'headers-only') {
          out.return = value;
        }
        break;
      case 'count':
        if (value === 'exact' || value === 'planned' || value === 'estimated') out.count = value;
        break;
      case 'resolution':
        if (value === 'merge-duplicates' || value === 'ignore-duplicates') out.resolution = value;
        break;
      case 'missing':
        if (value === 'default' || value === 'null') out.missing = value;
        break;
      case 'params':
        if (value === 'single-object' || value === 'multiple-objects') out.params = value;
        break;
    }
  }
  return out;
}

const OBJECT_MEDIA = 'application/vnd.pgrst.object+json';
const ARRAY_MEDIA = 'application/vnd.pgrst.array+json';

/** `.single()` sends `Accept: application/vnd.pgrst.object+json[;nulls=stripped]`. */
export function wantsObject(accept: string | string[] | undefined): boolean {
  return first(accept).trim().toLowerCase().startsWith(OBJECT_MEDIA);
}

/**
 * The media types this API can produce. Anything else that is a PostgREST
 * media type (`text/csv`, `application/geo+json`, `vnd.pgrst.plan`) is a clean
 * 406 rather than JSON the client will not parse.
 */
export function acceptSupported(accept: string | string[] | undefined): boolean {
  const raw = first(accept).trim();
  if (!raw) return true;
  return raw.split(',').some((part) => {
    const media = part.split(';')[0].trim().toLowerCase();
    return (
      media === '*/*' ||
      media === 'application/*' ||
      media === 'application/json' ||
      media === OBJECT_MEDIA ||
      media === ARRAY_MEDIA
    );
  });
}

/**
 * The `Range` request header (`items=0-9`) as a page. Unit-less or `items`
 * only; postgrest-js never sends it (`.range()` is `offset`/`limit` params)
 * so this is a courtesy to hand-written callers. `null` when absent or
 * malformed.
 */
export function parseRangeHeader(
  range: string | string[] | undefined,
  rangeUnit?: string | string[] | undefined,
): { offset: number; limit?: number } | null {
  const unit = first(rangeUnit).trim().toLowerCase();
  if (unit && unit !== 'items') return null;
  let raw = first(range).trim();
  if (!raw) return null;
  raw = raw.replace(/^items=/i, '');
  const m = raw.match(/^(\d+)-(\d*)$/);
  if (!m) return null;
  const offset = parseInt(m[1], 10);
  if (m[2] === '') return { offset };
  const to = parseInt(m[2], 10);
  if (to < offset) return null;
  return { offset, limit: to - offset + 1 };
}

/**
 * The `Content-Range` response header: `<from>-<to>/<total>`, `*` for an
 * empty page or an unknown total. postgrest-js reads only the part after the
 * slash, and only when it asked for a count.
 */
export function contentRange(offset: number, n: number, total: number | null | undefined): string {
  const tot = total === null || total === undefined ? '*' : String(total);
  if (n <= 0) return `*/${tot}`;
  return `${offset}-${offset + n - 1}/${tot}`;
}

/** 206 when the page is a strict subset of a known total, else 200. */
export function rangeStatus(offset: number, n: number, total: number | null | undefined): 200 | 206 {
  if (total === null || total === undefined) return 200;
  return offset > 0 || offset + n < total ? 206 : 200;
}

/** `Accept-Profile` (reads) / `Content-Profile` (writes) must be `public`. */
export function requestedProfile(
  h: IncomingHttpHeaders,
  method: string,
): string | undefined {
  const key = method === 'GET' || method === 'HEAD' ? 'accept-profile' : 'content-profile';
  const v = first(h[key]).trim();
  return v === '' ? undefined : v;
}

/** The `columns=` hint of an insert: `"a","b"` → `['a', 'b']`. */
export function parseColumnsParam(raw: string | string[] | undefined): string[] | undefined {
  const text = first(raw).trim();
  if (!text) return undefined;
  return text
    .split(',')
    .map((c) => c.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}
