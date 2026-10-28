# Spec: supabase-js / postgrest-js wire-compat mode for `/api/rest/v1` (2026-10-28)

Goal: a supabase-js client pointed at `https://api.basefyio.com/api` works UNCHANGED against a basefyio
project, while basefyio-js / basefyio-python keep today's `{data,count}` envelope. Compat behaviour is
switched per request by header detection. Paths relative to `apps/platform-api/src/`.

## 0. Baseline facts
- Reads return `{data, count}` (`public-api.service.ts:138-141`); count query always runs (134-137); no `Content-Range`.
- supabase-js always sends `Accept-Profile: public` / `Content-Profile: public`; CORS `allowedHeaders` (`main.ts:64-72`) lacks
  `accept-profile`, `content-profile`, `range`, `range-unit`, `x-retry-count` → browser preflight fails. (main.ts is owned by the
  AUTH agent; ask it / coordinate: the REST agent must NOT edit main.ts.)
- Errors: `{statusCode, message, code?, timestamp}` (`all-exceptions.filter.ts:37-42`); postgrest-js uses the JSON body verbatim as `error`.
- basefyio-js `from()` uses the SQL route; only `rpc` hits rest/v1 and expects `T[]`. basefyio-python reads `body.data`/`count`,
  `{count}` on writes, list on rpc. Neither sends `X-Client-Info` or `Accept-Profile`.

## 1. Detecting a compat caller — new `postgrest/compat.ts`
```ts
export function isSupabaseCompat(h: IncomingHttpHeaders): boolean {
  const ci = String(h['x-client-info'] ?? '');
  return /^(supabase-(js|py|dart|swift|kt|csharp)|postgrest-(js|py|dart))/i.test(ci)
      || h['accept-profile'] !== undefined || h['content-profile'] !== undefined
      || /^application\/vnd\.pgrst\./i.test(String(h['accept'] ?? ''))
      || String(h['x-basefyio-compat'] ?? '').toLowerCase() === 'postgrest';
}
```
(supabase-js sends `X-Client-Info: supabase-js-node/<v>` / `-web`; postgrest-js `postgrest-js/<v>`. `X-Supabase-Api-Version` is auth-js only.)
Env kill-switch `REST_SUPABASE_COMPAT=auto|off|always` (default auto).
- Set `request.supabaseCompat` in `ApiKeyGuard.admit()` (`api-key.guard.ts:201-205`) next to `request.apiKeyPayload`.
  Guard errors (401 at lines 61/73/122) are thrown before admit → the filter recomputes from headers.
- Controller helper `compat(req)` next to `getPayload` (`public-api.controller.ts:107-111`). Pass an `opts` object to service methods; `RlsContext` unchanged.
- Pre-existing guard bugs to fix: `assertKeyMatchesTargetProject` (`api-key.guard.ts:282-286`) treats `body.projectId`/`query.projectId` as a
  project id → user tables with a `projectId` column get 403; skip for PublicApiController routes (or only compare id-shaped values).
  `?apikey=` reaches `parseQuery` as a filter (`parser.ts:289-298`) → add `apikey` to the skip list at `parser.ts:263`.

## 2. Reads (compat): bare array, Content-Range, Prefer: count, Range
- `select(projectId, table, query, ctx, opts?: { count?: 'exact'|'planned'|'estimated'|null; compat?: boolean })`. opts undefined → today's behaviour.
- Compat: run `buildCount` only when `opts.count` set; return `{ rows, total, offset }`. planned/estimated may map to exact.
- Controller: `@Res({ passthrough: true })`, `@Headers('prefer')`. Nest 10.4 sets status before the handler, so `res.status(206)` in a passthrough handler survives.
- `parsePrefer(h)`: values are comma-joined (`return=representation, count=exact`); split on `,` and `=`.
- `Content-Range`: `${offset}-${offset+n-1}/${total ?? '*'}`; n=0 → `*/${total ?? '*'}`. offset = `parsed.offset.get('') ?? 0`.
  postgrest-js reads only the part after `/` and only when Prefer has `count=`.
- Status 206 when total known and `offset > 0 || offset + n < total`, else 200. Optional 416 `PGRST103`.
- `Range` header: postgrest-js never sends it (`.range()` → offset/limit params already handled by `parser.ts:278-286`). Optional translation.
- Limit cap: `parser.ts:280` (`Math.min(n, 1000)`) and default `LIMIT 1000` at `builder.ts:491` — matches Supabase default max-rows; keep. Spec pins it at `postgrest.spec.ts:181-184`.
- Pre-existing count bug: `buildCount` (`builder.ts:46-57`) ignores `!inner` EXISTS predicates collected in `buildSelectBody` (164-167) → totals too high; reuse the inner-predicate sink.
- Ordering default: `orderTermSql` (`builder.ts:476-483`) uses ASC NULLS FIRST / DESC NULLS LAST; Postgres/PostgREST default is the opposite. Fix in compat mode (postgrest-js `.order('x')` sends `x.asc`).

## 3. single()/maybeSingle(), 406, HEAD
- `.single()` → `Accept: application/vnd.pgrst.object+json` (may carry `;nulls=stripped` → match with startsWith). `.maybeSingle()` sends no Accept; client-side.
- Compat + wantsObject: rows.length !== 1 → 406 `{code:'PGRST116', details:'The result contains 0 rows' | '<n> rows', hint:null, message:'JSON object requested, multiple (or no) rows returned'}`; else return `rows[0]`.
- For writes with `.select().single()`: throw INSIDE the `withRls` callback so the tx rolls back (`runRlsTransaction` rollback at `public-api.service.ts:524-530`); realtime publish happens after commit (289-296, 341-348, 378-385).
- HEAD: Express routes HEAD to the GET handler and strips the body; postgrest-js `head:true` uses HEAD and reads Content-Range. Check `req.method === 'HEAD'` → skip data query, run count only, set Content-Range.
- Optional: `Accept: text/csv`, `application/geo+json`, `vnd.pgrst.plan` → 406 `PGRST107`.

## 4. Writes: Prefer, upsert, missing=default, columns=
- Controller `insert` (`public-api.controller.ts:53-69`) cannot see `req.query` → pass it through (needs `on_conflict`, `columns`, `select`).
- postgrest-js: insert sends `Prefer: count=…`, `missing=default` only with `defaultToNull:false`, `columns="a","b"` for arrays; upsert sends
  `Prefer: resolution=merge-duplicates|ignore-duplicates` + `on_conflict=<cols>`; `.select()` after a write adds `select=` + `Prefer: return=representation`.
- Current insert (`public-api.service.ts:253-297`): keys of rows[0] only (266), missing → NULL (277), `RETURNING *` (285), `{count}` or rows (295).
  `quoteIdent` strips rather than rejects (542-557). `RESERVED_PARAMS` (49-51), `OPERATOR_MAP` (36-47), `ParsedFilter` (23-26) are dead code.
- Compat inserts: load schema via `schemaCache.get` wrapped in `withSchemaRetry` (158-178). Columns: `columns=` (validated with IDENT + TableInfo.columns)
  else union of keys across rows. Missing key → `DEFAULT` when `Prefer: missing=default`, else NULL. Upsert: conflict target = `on_conflict` cols (validated) else
  `TableInfo.primaryKey` (`schema-cache.ts:23-27`); merge-duplicates → `ON CONFLICT (…) DO UPDATE SET "x"=EXCLUDED."x"` for all inserted cols; ignore-duplicates → `DO NOTHING`.
  Optional `RETURNING *, (xmax = 0) AS __inserted` for realtime INSERT vs UPDATE. Empty array → 201 `[]` in compat (today 400 at 264).
- `select=` projection on representation: wrap `WITH _w AS (INSERT … RETURNING *) SELECT <list> FROM _w _bf0`; needs `buildSelectBody` (`builder.ts:154-180`)
  to accept a source alias instead of `FROM "${table}"` (line 173) with root where/paging disabled; seed bound params first (`boundParams` getter at 83-85).
- Response: 201 empty body for minimal/default; 201 array/object for representation; `Content-Range: */n` or `0-(n-1)/n` when count requested.

## 5. PATCH / DELETE
- update (`public-api.service.ts:299-349`): empty body refusal 312, missing filter 318-322 (keep, emit PostgREST shape; PostgREST uses 21000), SET placeholders not pushed into builder (326-333) → push `setValues` into `builder.boundParams` before CTE projection.
- delete (351-386). Controller update 71-88, remove 90-105.
- Compat status: PATCH/DELETE minimal → 204 no body; representation → 200 array/object; POST → 201. `Content-Range: */n` when count requested.
- `select=` on PATCH/DELETE: same CTE projection.

## 6. RPC
- Add `@Get('rpc/:fn')` (also serves HEAD; two segments, no clash with `:table`); POST returns 200 (Nest default 201). postgrest-js `get:true`/`head:true` → GET/HEAD with args as query (arrays as `{a,b}`); `count` → Prefer.
- **Live bug** `public-api.service.ts:242`: `"${k}" := ${params.length}` lacks `$` → every arg becomes an integer literal; fix `:= $${params.length}`. Add a regression spec with args.
- Metadata (219-227): `LIMIT 1` picks an arbitrary overload; `proargnames` includes OUT columns. Use the query:
  `SELECT p.oid::regprocedure AS signature, p.prosecdef, COALESCE(array_to_json(p.proargnames),'[]') argnames, COALESCE(array_to_json(p.proargmodes),'[]') argmodes, p.pronargs, p.pronargdefaults, p.proretset, p.provolatile, t.typtype, t.typname, t.typrelid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_type t ON t.oid=p.prorettype WHERE n.nspname='public' AND p.proname=$1 AND p.prokind='f'`
  and pick the overload whose IN/INOUT/VARIADIC names cover the provided keys and whose required names are all present.
- Not found: compat → 404 `{code:'PGRST202', message:'Could not find the function public.<fn>(<args>) in the schema cache', details:…, hint:null}`; non-compat keeps BadRequest (`public-api.rpc.spec.ts:78-81`).
- Definer gate (231-235) keep; compat emits `{code:'42501'}` 403.
- Result shaping (compat): non-set scalar/json → `SELECT "fn"(…) AS v` → bare `rows[0].v`; composite → object; setof → array (SETOF scalar → array of bare values); void → 204.
  Nest sends non-objects as text: set `res.type('application/json')` and return `JSON.stringify(value)` (`'null'` for null).
- GET args: query keys matching IN-arg names are args; the rest (minus select/order/limit/offset/apikey) are filters on the result (phase 2). `Prefer: params=single-object` → `"fn"($1::json)`; also auto-detect single unnamed json param (PostgREST 12).

## 7. Errors — new `postgrest/errors.ts` + `postgrest/compat.filter.ts`
- `PostgrestHttpError extends HttpException` with body `{code, message, details, hint}`.
- `sqlstateStatus(code, role)`: 404: 42P01, 42883; 409: 23503, 23505; 403: 42501 (401 when anonymous); 405: 25006; 503: class 08, 53; 413: class 54; 403: classes 0L, 0P, 28;
  500: 09, 25, 2D, 38, 39, 3B, 40, 55, 57, 58, F0, HV, P0 (P0001 → 400), XX, 42P17; 400 otherwise.
- `pgToPostgrest(e, role)` → `{code:e.code, message:e.message, details:e.detail ?? null, hint:e.hint ?? null}`.
- PGRST map: 400 PGRST100/200/204; 404 PGRST205/202; 406 PGRST116/106; 416 PGRST103; 300 PGRST201 (ambiguous embed; `schema-cache.ts:198-200` returns null today → PGRST200 at `builder.ts:199-206`).
- Keep `mapPgError` byte-compatible for non-compat (`pg-error.util.spec.ts`): attach raw pg fields to the exception, or pass `ctx.compat` through `withRls` (add `compat?: boolean` to `RlsContext` at 30-34).
- Filter bound with `@UseFilters(PostgrestCompatFilter)` on `PublicApiController` (22-25); controller filters beat the global one and catch guard throws. When `!isSupabaseCompat(req.headers)` delegate to `new AllExceptionsFilter().catch(ex, host)`; else write exactly `{code, message, details, hint}`.

## 8. Profiles, schema cache, select edge cases
- Only `public` (`schema-cache.ts:83-86,102,132`; rpc 224). Compat: `Accept-Profile`/`Content-Profile` present and ≠ public → 406 `PGRST106 "The schema must be one of the following: public"`.
- Schema cache loads after `SET LOCAL ROLE` (`public-api.service.ts:127`) from `information_schema.columns` → privilege-filtered; consider `pg_attribute`/`pg_class`.
- `...rel(*)` spread and aggregates (`count()`, `col.sum()`) unsupported → clear PGRST100 in compat. `like(all)`/`ilike(any)` not in FILTER_OPS.

## 9. Role switching / claims — already correct
- Full JWT payload → `request.jwt.claims` (`public-api.service.ts:504-510`), `request.jwt.role` (511-514), single claims (`jwt-claim-settings.ts:12-26`). `auth.jwt()->'app_metadata'` works once Keycloak emits it. If merging `{role: ctx.role, ...claims}` update `public-api.rls-claims.spec.ts:45`.

## 10. Tests
- `@supabase/supabase-js ^2.100.1` is a runtime dep (`package.json:51`); `@supabase/postgrest-js` 2.103.2 installed with CJS build; `supertest ^7.2.2` dev dep; Node 24 has fetch.
- New `modules/projects/public-api.supabase-compat.spec.ts`: Test module with PublicApiController + PublicApiService + stubs (Prisma/Config/ProjectsService/RealtimeDataService), `overrideGuard(ApiKeyGuard)` injecting `apiKeyPayload` + `supabaseCompat`, `app.setGlobalPrefix('api')`, `listen(0)`; stub `withRls` (`public-api.rpc.spec.ts:36-39`) and `schemaCache.get` (extract `fixtureSchema()` from `postgrest.spec.ts:14-37` into `postgrest/test-fixtures.ts`); drive with real `PostgrestClient`/`createClient`. Assert: select array + count from Content-Range + head; range 206; single 406 PGRST116; insert 201; upsert ON CONFLICT DO UPDATE / DO NOTHING; defaultToNull:false → DEFAULT; update/delete 204/200; rpc arg binding `$1` (regression), scalar/composite/setof shaping, get:true; PGRST202 404; pg 23505 → `error.code`, details, 409; Accept-Profile other → 406 PGRST106. Regression block without X-Client-Info keeps `{data,count}` / `{count}` / `T[]` / old error body.
- Unit specs: `postgrest/compat.spec.ts` (parsePrefer, isSupabaseCompat, contentRange, parseRangeHeader), `postgrest/errors.spec.ts`, extend `postgrest.spec.ts` (CTE projection, buildCount+!inner).
- Pinned specs to respect/update: `public-api.rpc.spec.ts:78-81`, `postgrest.spec.ts:181-184`, `public-api.rls-claims.spec.ts:45`, `common/guards/api-key-scope.contract.spec.ts:159-164` (no @ServiceKeyOnly on public-api.controller), `docs/route-coverage.spec.ts:30` (document new `GET /api/rest/v1/rpc/:fn` in `docs/reference/rest-api.md`).
- Docs: `docs/reference/rest-api.md` lines 39-43, 69-70, 82-84, 97-98, 121-124.

## 11. Exports to reuse
`parser.ts`: parseQuery, parseSelect, parseConditionValue, parseLogicChildren (export assertIdent). `builder.ts`: SelectBuilder(schema, cache).build/.buildCount/.buildWriteWhere/.boundParams.
`schema-cache.ts`: SchemaCache.get/invalidate/resolveRelationship; ProjectSchema, TableInfo{name,columns:Set,primaryKey[]}. `types.ts`: ParsedQuery, PostgrestParseError, FILTER_OPS…
`pg-error.util.ts`: mapPgError. `public-api.service.ts`: PublicApiService, RlsContext, PgDbRole (private withRls/runRlsTransaction/withSchemaRetry/toHttp/validateTableName/quoteIdent/schemaCache).

## 12. Route order
`TenantEmbeddingModule` before ProjectsModule (`app.module.ts:97-102`); `PublicApiController` registered at `projects.module.ts:69`; `@Get('rpc/:fn')` (two segments) cannot shadow `:table`.
