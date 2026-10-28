# Spec: Supabase Storage facade (`/api/storage/v1/*`) over MinIO (2026-10-28)

Goal: supabase-js `storage.from(b).upload/download/remove/list/getPublicUrl/createSignedUrl(s)/createSignedUploadUrl/move/copy/info/exists` and
`storage.createBucket/listBuckets/getBucket/updateBucket/emptyBucket/deleteBucket` work unchanged with `createClient('https://api.basefyio.com/api/p/<projectId>', anonKey)`.
Paths relative to `apps/platform-api/src/`. main.ts edits (CORS headers, `/p/<ref>` rewrite, body-parser `type` predicate, requestTimeout) are owned by the AUTH agent — coordinate; the storage agent does not edit main.ts.

## 0. Decisions
- `@Controller('storage/v1') @UseGuards(ApiKeyGuard) @SkipThrottle() @UseFilters(SupabaseStorageExceptionFilter)` in a new `modules/storage-facade/` (StorageFacadeModule imports StorageModule + a new ProjectDbModule; register in `app.module.ts` beside StorageModule (:121)). StorageModule must export `StorageAccessService`, `ImageTransformService` (`storage.module.ts:24`).
- Extract `getPool` (`public-api.service.ts:559-588`) + `runRlsTransaction` (485-534) into injectable `ProjectRlsRunner` (Prisma-only module); PublicApiService keeps its auto-heal wrapper (404-481) on top. (The REST agent is editing public-api.service.ts concurrently: do this extraction as an ADDITIVE new file `modules/project-db/project-rls-runner.ts` that duplicates the logic; do not modify public-api.service.ts.)
- Project resolution = `ApiKeyGuard` (`api-key.guard.ts:49-133`): apikey header or `?apikey=` (anon only); roles anon/authenticated(+jwtClaims)/service; `req.apiKeyPayload`. Use `storageCaller(req)` (`modules/storage/storage-caller.ts:21-34`); pass `userId = undefined` to StorageService (skips membership check, `storage.service.ts:163-177`).
- Public URLs carry no apikey → project from the `/api/p/<projectId>/` path rewrite (`req.headers['x-bf-project']`); authenticated routes 403 when the ref ≠ `apiKeyPayload.projectId`. Signed URLs carry the project inside the token.
- Errors: Supabase answers HTTP 400 for every 4xx with body `{statusCode:'404'|'409'|'403'…, error, message}` (string statusCode); 5xx stays. Controller-scoped filter required (global filter emits numeric statusCode + timestamp).
- Authorization: **Option A (recommended, behind `Project.storageAuthz = 'presets'|'rls'`, default presets; set `rls` for imported projects)**: a `storage` schema in the project DB with `storage.buckets`/`storage.objects` + `storage.foldername/filename/extension`; every operation evaluated under the caller's role via the RLS runner (dry-run + ROLLBACK for writes, never hold a tx across MinIO streaming; pool max 5). Option B (presets, `storage-access.service.ts`) preserved for existing projects.

## 1. storage-js contract (v2)
- `upload` → `POST /object/{bucket}/{path}`; header `x-upsert`; multipart with the file under the EMPTY field name `''` (+ `cacheControl`, `metadata` text fields) or raw body with `content-type`, `cache-control: max-age=<n>`, `x-metadata` (base64 JSON). Response `{Id, Key:"bucket/path"}`. `update` → PUT same path (always upsert).
- `download` → `GET /object/{bucket}/{path}` (apikey+Bearer); transform → `GET /render/image/authenticated/{bucket}/{path}?width=…`.
- `getPublicUrl` → client-side `${url}/object/public/{bucket}/{path}` (+`/render/image/public/…`, `?download=`).
- `createSignedUrl` → `POST /object/sign/{bucket}/{path}` `{expiresIn, transform?}` → `{signedURL:"/object/sign/{bucket}/{path}?token=…"}` (relative; `/render/image/sign/…` with transform). `createSignedUrls` → `POST /object/sign/{bucket}` `{expiresIn, paths}` → `[{error,path,signedURL}]`. `createSignedUploadUrl` → `POST /object/upload/sign/{bucket}/{path}` → `{url:"/object/upload/sign/{bucket}/{path}?token=…"}`; `uploadToSignedUrl` → `PUT …?token=` → `{Key}`.
- `remove` → `DELETE /object/{bucket}` `{prefixes:[…]}` → FileObject[]. `list` → `POST /object/list/{bucket}` `{prefix, limit=100, offset=0, sortBy:{column,order}, search}` → `[{name,id,updated_at,created_at,last_accessed_at,metadata:{eTag,size,mimetype,cacheControl,lastModified,contentLength,httpStatusCode}}]` (folders: id null, metadata null).
- `move`/`copy` → `POST /object/move|copy` `{bucketId, sourceKey, destinationKey, destinationBucket?}` → `{message:'Successfully moved'}` / `{Key}`. `info` → `GET /object/info/{bucket}/{path}`; `exists` → `HEAD /object/{bucket}/{path}`.
- Buckets: `GET /bucket` → `[{id,name,owner:'',public,file_size_limit,allowed_mime_types,created_at,updated_at}]`; `GET /bucket/{id}`; `POST /bucket` `{id,name,public,file_size_limit,allowed_mime_types}` → `{name}`; `PUT /bucket/{id}` → `{message}`; `POST /bucket/{id}/empty`; `DELETE /bucket/{id}` → `{message}`.
- Route order: declare literal routes (`object/list/:bucket`, `object/sign/…`, `object/upload/sign/…`, `object/public/…`, `object/authenticated/…`, `object/info/…`, `object/move`, `object/copy`) BEFORE `object/:bucket/*` (Express 4 wildcard; key in `req.params[0]`). Normalise keys: strip leading `/`, refuse `..`/`\0`, cap 1024 bytes (`normalisePrefix`, `storage-access.service.ts:50-56`).

## 2. StorageService primitives (`modules/storage/storage.service.ts`)
`minioBucketName` 96-98 (`${bucketPrefix}${storagePrefix??slug}-${bucket}`), `physicalBucketName` 759-761; `listBuckets` 181-214 (heavy; add light `listBucketNames`); `createBucket` 216-250 (name regex 219 rejects `_`/`.`; 409 at 228; public policy 236-238); `deleteBucket` 252-268; `toggleBucketPublic` 315-331; `listObjects` 361-392 (no mimetype); `createFolder` 395-418; `moveObjects` 525-574 (folder-only; add `moveObject(src,dest)` via copyObject+removeObject 566-567); `uploadObjectStream(projectId,userId,bucket,path,body,size,contentType,meta)` 624-674 (quota 639, meta → putObject headers 654-657, size verify 659-666); `getObject` 676-695 (no Range; add `getPartialObject`); `deleteObjects` 697-723; `getPresignedUrl` 725-740 (MinIO host `storage.${DOMAIN}`); `resolveBucket` 750-756; `statObjectIn` 768-775; `bucketIsPublic` 763-765; multipart primitives 780-808.
Upload limits: `MAX_FILE_SIZE` 500 MB (`storage.controller.ts:59`, `STORAGE_MAX_UPLOAD_MB`), `ContentLengthGuard`, `spoolMulterOptions` (`upload-spool.ts`), semaphore 8 → 503; pattern `storage.controller.ts:262-319`. Transforms: `ImageTransformService.parseTransformQuery` (139), flow `storage.controller.ts:358-436`; Supabase `{width,height,resize,format,quality}` → `{width,height,fit:resize,quality,format: format==='origin'?undefined:format}`.

## 3. Endpoints
- 3.1 upload: `@AnonKeyAllowed()`; multipart via `AnyFilesInterceptor(spoolMulterOptions(max))` + `files[0]` (empty field name; multer drops parts without filename — Blob gets "blob"); raw body streamed (`uploadObjectStream(..., req, Number(content-length)||undefined, content-type, meta)`); steps: resolveBucket (404 `{statusCode:'404',error:'Bucket not found'}`) → bucket limits → authorize (§5) → upload with `{...ownerMeta(caller), 'Cache-Control': 'max-age=<n>'}` → catalog upsert → `{Id, Key}`. No upsert + exists → 400 `{statusCode:'409',error:'Duplicate',message:'The resource already exists'}`.
- 3.2 download/authenticated + HEAD: authorize SELECT → `getObject` (Range variant) → headers Content-Type/Length/ETag/Last-Modified/Cache-Control/Accept-Ranges; `Content-Disposition: attachment` only with `?download`; `Cross-Origin-Resource-Policy: cross-origin` on byte responses (helmet default blocks `<img>`).
- 3.3 public: separate unguarded controller; project from ref; bucket public (catalog or `bucketIsPublic`) else 400 `{statusCode:'404',error:'not_found'}`; stream (keeps api host); `?download`; `/render/image/public/…` transform flow. Call the guard's `wake` logic for paused projects (extract into a service) and `usage.trackBandwidth`.
- 3.4 list: option A SQL (below); option B `listObjects` with prefix normalised to trailing `/`, folders `{name,id:null,…metadata:null}`, files with metadata, `filterListing` (`storage-access.service.ts:217-250`), in-memory sort/search/offset/limit.
- 3.5 remove: option A `DELETE … RETURNING` under RLS then `removeObjects`; option B `assertCanModifyAll` (182-211) then `deleteObjects` (exact names, no `/` expansion). Return removed rows.
- 3.6 signed download: HS256 JWT (`jsonwebtoken`, already used in `api-key.guard.ts:12`) `{pid, url:'bucket/key', t?, iat, exp}` with new env `STORAGE_URL_SIGNING_SECRET`; return `{signedURL:'/object/sign/<bucket>/<key>?token=…'}`; `GET /object/sign/…?token=` and `/render/image/sign/…` unguarded: verify sig+exp+url, stream with pid. Expiry 1..`STORAGE_SIGNED_URL_MAX_SECONDS` (default 31536000). Batch endpoint authorizes each path.
- 3.7 signed upload: `POST /object/upload/sign/…` (authorize INSERT dry run) → token `{pid,url,owner,upsert,exp:+7200}` → `{url}`; `PUT …?token=` unguarded → 3.1 handling with owner meta → `{Key}`.
- 3.8 move/copy: option A per table; option B `assertCanModifyAll`/`assertCanRead` then `moveObject`/`copyObject` (cross-bucket source `/${srcPhysical}/${key}`); responses `{message:'Successfully moved'}` / `{Key}`.
- 3.9 info: `statObjectIn` → `{id,name,bucket_id,size,content_type,cache_control,etag,last_modified,created_at,metadata}`.
- 3.10 buckets: logical name as id/name; `GET /bucket` from catalog or light listing; `POST /bucket` → `createBucket(projectId, undefined, id, public)` + catalog limits → `{name}` (409 → Duplicate); `PUT` → toggleBucketPublic + catalog → `{message:'Successfully updated'}`; `DELETE` → 409 if non-empty else deleteBucket → `{message:'Successfully deleted'}`; `POST …/empty` → `{message:'Successfully emptied'}`; create/update/delete/empty `@ServiceKeyOnly()`; list/get: option A SELECT on `storage.buckets` under RLS, option B `@AuthenticatedKeyOnly`.

## 4. Presets today (option B) — owner = object metadata `x-amz-meta-owner` (`storage-caller.ts:42-65`), modes public-read|authenticated-read|owner-only (`storage-access.service.ts:18`), `StoragePolicy` (`schema.prisma:2122-2138`), longest prefix wins (63-77), 30 s cache. Importer uploads have NO owner (`supabase-import.service.ts:1459-1463, 4107-4114`) → pass `{'x-amz-meta-owner': owner_id}` there. No bucket model in Prisma (public = MinIO policy).

## 5. Option A — RLS on `storage.objects`
- 5.0 Gaps: importer dumps `--schema=public` only (1937) → storage policies/rows not copied (KolayStartup: 245 policy refs on storage.objects/buckets; these were NOT loaded by the manual migration either — copy them from the source `pg_policies WHERE schemaname='storage'` and replay); fresh projects `auth.uid()` RETURNS text (`rls-bootstrap.sql:109`), imported uuid → document `owner_id = auth.uid()::text`; for KolayStartup the policies use `auth.uid()` cast to uuid (manual load replaced `auth.uid()` → `(auth.uid())::uuid`; do the same when replaying storage policies).
- 5.1 Schema SQL appended to `rls-bootstrap.sql` (idempotent; runs as admin → `ALTER … OWNER TO "%BF_PROJECT_OWNER%"`):
```sql
CREATE SCHEMA IF NOT EXISTS storage AUTHORIZATION "%BF_PROJECT_OWNER%";
CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL UNIQUE, owner uuid, owner_id text, public boolean NOT NULL DEFAULT false, avif_autodetection boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[], created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets(id), name text NOT NULL, owner uuid, owner_id text, metadata jsonb, user_metadata jsonb, version text, path_tokens text[] GENERATED ALWAYS AS (string_to_array(name, '/')) STORED, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), last_accessed_at timestamptz DEFAULT now(), CONSTRAINT objects_bucket_name_key UNIQUE (bucket_id, name));
CREATE INDEX IF NOT EXISTS objects_bucket_name_pattern ON storage.objects (bucket_id, name text_pattern_ops);
ALTER TABLE storage.buckets OWNER TO "%BF_PROJECT_OWNER%"; ALTER TABLE storage.objects OWNER TO "%BF_PROJECT_OWNER%";
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY; ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role; GRANT ALL ON storage.buckets, storage.objects TO anon, authenticated, service_role;
-- storage.foldername(name) text[] = all but last segment; storage.filename(name) = last segment; storage.extension(name) = after last '.'; IMMUTABLE sql; OWNER TO project owner; GRANT EXECUTE; wrap CREATE in DO guards (do not replace on imported DBs).
```
- 5.2 Catalog sync (owner role, outside RLS) via `StorageCatalogService`: createBucket/toggleBucketPublic/deleteBucket, uploadObject/uploadObjectStream (after size check 662: `INSERT … ON CONFLICT (bucket_id,name) DO UPDATE … RETURNING id`; owner uuid only when sub is a UUID, owner_id always), deleteObjects, moveObjects/moveObject, `UploadSessionService.complete` (`upload-session.service.ts:277`, owner = `row.ownerSub`). Folder markers skipped. Backfill command for `rls` switch (listObjectsV2 + stat owner). Importer: copy `storage.buckets`/`storage.objects` rows + replay storage policies + owner meta.
- 5.3 Per-operation SQL under `ctx={role: payload.dbRole, jwtClaims}` (service_role BYPASSRLS): upload → INSERT dry run → ROLLBACK (42501 → 403 RLS message; 23505 → Duplicate); upsert/PUT → INSERT … ON CONFLICT DO UPDATE dry run; download/info/exists/sign → `SELECT id, metadata FROM storage.objects WHERE bucket_id=$1 AND name=$2` (0 rows → 400 `{statusCode:'404',error:'not_found',message:'Object not found'}`); list → CTE SQL (folders from DISTINCT first segment, files, UNION, whitelist sortBy, LIMIT/OFFSET); remove → `DELETE … RETURNING *` then removeObjects; move → UPDATE RETURNING inside a short tx around copy+remove; copy → SELECT source + INSERT dry run; signed upload → INSERT dry run; public GET → owner-role `SELECT public FROM storage.buckets`.
- 5.4 Option B kept verbatim: `resolveMode` 138-142, `assertCanRead` 155, `assertCanOverwrite` 166-175, `assertCanModifyAll` 182-211, `filterListing` 217-250, `statFn` (`storage.controller.ts:91-97`).

## 6. Risks (act on)
1 CORS: allowedHeaders need `x-upsert, cache-control, x-metadata, range`; exposedHeaders `Content-Length, ETag, Content-Disposition, Accept-Ranges` (main.ts — AUTH agent). 2 helmet CORP same-origin blocks `<img>` → set `Cross-Origin-Resource-Policy: cross-origin` on byte responses. 3 multipart empty field name → AnyFilesInterceptor. 4 global json/urlencoded parsers eat raw uploads → `type` predicate excluding storage upload routes (main.ts — AUTH agent). 5 `server.requestTimeout=120_000` (main.ts:133) cuts slow uploads. 6 500 MB ceiling/spool disk. 7 Range/206 for video. 8 public URL project resolution via `/p/<ref>`. 9 paused projects on unguarded routes → wake. 10 bandwidth billing on public/signed routes. 11 bucket naming regex/collisions (`_`/`.`), 63-char physical cap — store logical↔physical in `storage.buckets`. 12 route shadowing. 13 never hold a tx across streaming. 14 catalog drift → reconcile. 15 `auth.uid()` type. 16 table ownership for `CREATE POLICY` by owner (`project-policies.service.ts:93-96`). 17 error shape (string statusCode). 18 signing secret rotation invalidates URLs. 19 option B listing O(n). 20 `GET /bucket` cost.

## 7. Tests
Specs with stubbed MinIO (`storage.service` methods mocked) + stubbed RLS runner driving the REAL `@supabase/storage-js` (dependency of supabase-js in node_modules) client against the Nest app: upload (multipart Blob + raw), duplicate 409, update/upsert, download bytes+headers, HEAD exists, list (folders/files/sort/search/offset), remove, createSignedUrl → GET signed, createSignedUploadUrl → PUT, move/copy, buckets CRUD with service key, error shape. Docs: `docs/reference/storage-v1-api.md` + `DOC_MAP` entry in `docs/route-coverage.spec.ts:28-60`.

## 8. Deploy notes (implementation landed 2026-10-28)

What shipped: `modules/project-db/` (ProjectRlsRunner), `modules/storage-facade/` (keyed `storage/v1` controller, unguarded public/signed controller, catalog operator routes, signing, error filter), `modules/storage/storage-catalog.*` (catalog sync from every StorageService write and from completed upload sessions), rls-bootstrap.sql §5 (storage schema), `Project.storageAuthz`, importer storage parts, `docs/reference/storage-v1-api.md`.

### Environment

| Variable | Required | Default | Notes |
|---|---|---|---|
| `STORAGE_URL_SIGNING_SECRET` | recommended | — | HS256 key for `createSignedUrl` / `createSignedUploadUrl` tokens. Unset → each project signs with a key derived from its service key (boot logs a warning). Rotating it invalidates every outstanding signed URL. |
| `STORAGE_SIGNED_URL_MAX_SECONDS` | no | `31536000` | Ceiling for `expiresIn` (1…n). |
| `STORAGE_MAX_UPLOAD_MB`, `STORAGE_MAX_CONCURRENT_UPLOADS`, `STORAGE_UPLOAD_TMP_DIR` | no | existing | Shared with the dashboard upload route; the facade uses the same spool and semaphore sizes. |

### Database (control plane)

- `projects.storage_authz TEXT NOT NULL DEFAULT 'presets'` — `prisma/migrations/20261028120000_project_storage_authz/migration.sql`; production applies `schema.prisma` through `prisma db push` at container start, and the build runs `prisma generate` (`prebuild`). Nothing to run by hand beyond the usual image build.

### Project databases

- The RLS bootstrap now carries §5 (`storage` schema, `storage.buckets` / `storage.objects`, helpers, grants). It is idempotent and runs for every new project at provisioning. **Existing projects do not get it until the bootstrap is re-applied:** `POST /api/projects/:id/ensure-rls-bootstrap` (dashboard session) or `apps/platform-api/scripts/backfill-rls.ts`. Until then the catalog hooks log at debug level and skip (uploads are unaffected).
- Dedicated-host projects: `ensureRlsBootstrap` still refuses them (unchanged); apply §5 through the provisioning flow.
- After the bootstrap, `POST /api/projects/:id/storage/catalog/backfill` fills the catalog from the store; `GET /api/projects/:id/storage/catalog` reports `{ storageAuthz, catalogAvailable }`.

### main.ts (AUTH agent — not done by the storage agent)

1. CORS: `allowedHeaders` += `x-upsert`, `cache-control`, `x-metadata`, `range`; `exposedHeaders` += `Content-Length`, `ETag`, `Content-Disposition`, `Accept-Ranges`.
2. The `/api/p/<projectId>/…` rewrite that sets `req.headers['x-bf-project'] = <projectId>` and strips the prefix, registered before the router (the facade's public routes and `getPublicUrl` depend on it; the keyed routes refuse a header that names another project).
3. Body parsers: `isJsonBody` / `isFormBody` from `common/middleware/supabase-paths.middleware` (done). Without them a raw upload whose content type is JSON is consumed by the parser; the facade then falls back to `req.rawBody` (the app is created with `rawBody: true`), so it still works but buffers the body in memory.
4. `server.requestTimeout` is 120 s; a 500 MB upload on a slow link needs more — raise to at least 600 s for the storage routes (or globally).
5. The storage integration spec (`storage-v1.storage-js.spec.ts`) sets all of 2 and 3 up on its own test app, so main.ts can be verified against it.

### Smoke test after deploy

```bash
# keyed
curl -s -H "apikey: $ANON" https://api.basefyio.com/api/storage/v1/bucket
# public URL (project in the path)
curl -sI https://api.basefyio.com/api/p/$PROJECT/storage/v1/object/public/<public-bucket>/<key>
# storage-js
node -e "const {StorageClient}=require('@supabase/storage-js');new StorageClient('https://api.basefyio.com/api/p/$PROJECT/storage/v1',{apikey:'$ANON'}).from('<bucket>').list().then(console.log)"
```

### Switching a project to RLS

1. `POST /api/projects/:id/ensure-rls-bootstrap`
2. Write policies on `storage.objects` / `storage.buckets` (fresh projects: `owner_id = auth.uid()`; Supabase imports keep `owner = auth.uid()`).
3. `PATCH /api/projects/:id/storage/authz { "mode": "rls" }` — runs the backfill first and refuses while the catalog is missing.
4. The Supabase importer does 1–3 itself when the source password is given and storage policies were found.

### Deferred

- `listV2` (cursor pagination), analytics and vector buckets, bucket `type`.
- Option B listing is O(n) per request (store listing + per-object stat for owner-only); fine for dashboard-sized buckets, not for very large public buckets — move such projects to `rls`.
- Catalog reconciliation beyond the manual backfill (no scheduled drift check).
- Policies are replayed as text; a policy referencing a function the destination lacks is reported in the import warnings and skipped.
