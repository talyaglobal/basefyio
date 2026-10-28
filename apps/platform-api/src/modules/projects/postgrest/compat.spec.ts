import {
  acceptSupported,
  compatMode,
  contentRange,
  isSupabaseCompat,
  parseColumnsParam,
  parsePrefer,
  parseRangeHeader,
  rangeStatus,
  requestedProfile,
  wantsObject,
} from './compat';

const env = (REST_SUPABASE_COMPAT?: string) => (REST_SUPABASE_COMPAT === undefined ? {} : { REST_SUPABASE_COMPAT });

describe('isSupabaseCompat — who gets the PostgREST wire format', () => {
  it('recognises supabase-js by X-Client-Info', () => {
    expect(isSupabaseCompat({ 'x-client-info': 'supabase-js-node/2.100.1' }, env())).toBe(true);
    expect(isSupabaseCompat({ 'x-client-info': 'supabase-js-web/2.100.1' }, env())).toBe(true);
    expect(isSupabaseCompat({ 'x-client-info': 'postgrest-js/2.103.2' }, env())).toBe(true);
    expect(isSupabaseCompat({ 'x-client-info': 'supabase-py/2.0' }, env())).toBe(true);
  });

  it('recognises bare postgrest-js by its profile headers', () => {
    expect(isSupabaseCompat({ 'accept-profile': 'public' }, env())).toBe(true);
    expect(isSupabaseCompat({ 'content-profile': 'public' }, env())).toBe(true);
  });

  it('recognises a PostgREST media type and the explicit opt-in', () => {
    expect(isSupabaseCompat({ accept: 'application/vnd.pgrst.object+json' }, env())).toBe(true);
    expect(isSupabaseCompat({ 'x-basefyio-compat': 'PostgREST' }, env())).toBe(true);
  });

  it('leaves basefyio-js / basefyio-python and plain fetch alone', () => {
    expect(isSupabaseCompat({}, env())).toBe(false);
    expect(isSupabaseCompat({ accept: 'application/json', 'x-client-info': 'basefyio-js/1.0' }, env())).toBe(false);
    expect(isSupabaseCompat({ 'x-supabase-api-version': '2024-01-01' }, env())).toBe(false);
  });

  it('honours the kill switch', () => {
    expect(isSupabaseCompat({ 'accept-profile': 'public' }, env('off'))).toBe(false);
    expect(isSupabaseCompat({}, env('always'))).toBe(true);
    expect(compatMode(env('nonsense'))).toBe('auto');
  });
});

describe('parsePrefer', () => {
  it('splits comma-joined values the way Node presents repeated headers', () => {
    const p = parsePrefer('return=representation, count=exact');
    expect(p.return).toBe('representation');
    expect(p.count).toBe('exact');
  });

  it('reads upsert and insert hints', () => {
    const p = parsePrefer(['resolution=merge-duplicates', 'missing=default', 'params=single-object']);
    expect(p.resolution).toBe('merge-duplicates');
    expect(p.missing).toBe('default');
    expect(p.params).toBe('single-object');
  });

  it('ignores unknown values but keeps them in raw', () => {
    const p = parsePrefer('return=whatever, tx=commit, bare');
    expect(p.return).toBeUndefined();
    expect(p.raw.get('tx')).toBe('commit');
    expect(p.raw.has('bare')).toBe(false);
  });

  it('tolerates an absent header', () => {
    expect(parsePrefer(undefined).raw.size).toBe(0);
  });
});

describe('wantsObject / acceptSupported', () => {
  it('matches .single() with and without nulls=stripped', () => {
    expect(wantsObject('application/vnd.pgrst.object+json')).toBe(true);
    expect(wantsObject('application/vnd.pgrst.object+json;nulls=stripped')).toBe(true);
    expect(wantsObject('application/json')).toBe(false);
    expect(wantsObject(undefined)).toBe(false);
  });

  it('accepts JSON and the pgrst JSON types, refuses csv, geojson and plans', () => {
    expect(acceptSupported(undefined)).toBe(true);
    expect(acceptSupported('*/*')).toBe(true);
    expect(acceptSupported('application/vnd.pgrst.array+json;nulls=stripped')).toBe(true);
    expect(acceptSupported('text/csv')).toBe(false);
    expect(acceptSupported('application/geo+json')).toBe(false);
    expect(acceptSupported('application/vnd.pgrst.plan+text; for="application/json"')).toBe(false);
  });
});

describe('Range / Content-Range', () => {
  it('parses a Range header into offset and limit', () => {
    expect(parseRangeHeader('0-9')).toEqual({ offset: 0, limit: 10 });
    expect(parseRangeHeader('items=20-29', 'items')).toEqual({ offset: 20, limit: 10 });
    expect(parseRangeHeader('5-')).toEqual({ offset: 5 });
  });

  it('rejects other units, inverted and malformed ranges', () => {
    expect(parseRangeHeader('0-9', 'bytes')).toBeNull();
    expect(parseRangeHeader('9-0')).toBeNull();
    expect(parseRangeHeader('abc')).toBeNull();
    expect(parseRangeHeader(undefined)).toBeNull();
  });

  it('renders Content-Range as PostgREST does', () => {
    expect(contentRange(0, 3, 3)).toBe('0-2/3');
    expect(contentRange(10, 5, 100)).toBe('10-14/100');
    expect(contentRange(0, 0, 0)).toBe('*/0');
    expect(contentRange(0, 2, null)).toBe('0-1/*');
    expect(contentRange(0, 0, null)).toBe('*/*');
  });

  it('answers 206 only for a strict subset of a known total', () => {
    expect(rangeStatus(0, 3, 3)).toBe(200);
    expect(rangeStatus(0, 2, 3)).toBe(206);
    expect(rangeStatus(1, 2, 3)).toBe(206);
    expect(rangeStatus(0, 2, null)).toBe(200);
  });
});

describe('profiles and columns', () => {
  it('reads Accept-Profile for reads and Content-Profile for writes', () => {
    expect(requestedProfile({ 'accept-profile': 'public', 'content-profile': 'other' }, 'GET')).toBe('public');
    expect(requestedProfile({ 'accept-profile': 'public', 'content-profile': 'other' }, 'POST')).toBe('other');
    expect(requestedProfile({}, 'GET')).toBeUndefined();
  });

  it('strips the quotes postgrest-js puts around column names', () => {
    expect(parseColumnsParam('"a","b"')).toEqual(['a', 'b']);
    expect(parseColumnsParam('a, b')).toEqual(['a', 'b']);
    expect(parseColumnsParam(undefined)).toBeUndefined();
    expect(parseColumnsParam('')).toBeUndefined();
  });
});
