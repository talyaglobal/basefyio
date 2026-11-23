# Storage API (`/api/projects/:projectId/storage`)

Buckets and objects for one project, served from the platform's object store (MinIO by
default, or any S3-compatible store when the operator sets `STORAGE_DRIVER=s3`). Four route
groups: buckets, objects, access rules and resumable upload sessions, plus an image render
route for thumbnails and format conversion on read.

## Authentication

`apikey` header, or a dashboard session. The controller defaults to the **service key**;
object reads and writes are opened to a **signed-in end user** (anon key + the user's Bearer
token); two routes a browser reaches with no headers at all — a public file's URL and the
download and render behind it — accept the **anon key**, which may also travel as `?apikey=`.

## Buckets

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/projects/:projectId/storage/buckets` | anon + user | list buckets |
| POST | `/api/projects/:projectId/storage/buckets` | service | `{ name, public? }` — create |
| PATCH | `/api/projects/:projectId/storage/buckets/:bucketName` | service | `{ public }` — toggle visibility |
| DELETE | `/api/projects/:projectId/storage/buckets/:bucketName` | service | delete; a bucket that still holds files answers `409` ("not empty") unless `?force=true`, which deletes the bucket and every file in it |
| GET | `/api/projects/:projectId/storage/buckets/:bucketName/public-url` | anon | `?path=` → `{ public, url }` (`url` is `null` for a private bucket) |

A bucket: `{ id, name, public, createdAt, objectCount, totalSize }`. Names are 3–63
characters, letters, digits and hyphens, not starting or ending with a hyphen (400). Buckets
are created from the dashboard (Storage) or from your server — never from a browser, since
creation needs the service key.

### Bucket ownership

Inside the object store a bucket is named `bf-<project prefix>-<bucket name>`. Because both
parts may contain hyphens, two projects can spell the same stored name (project `a`'s bucket
`b-x` and project `a-b`'s bucket `x`). Every route therefore checks that the stored bucket
belongs to the calling project before it touches anything:

- a bucket created through the API, the dashboard, the MCP tools or the CLI records its project
  when it is created, and only that project reaches it;
- an older bucket without a record is reached by the one project whose prefix it starts with,
  and is recorded on first use;
- an older bucket whose name starts with the prefixes of more than one project is reached by
  none of them until the operator assigns it (`scripts/backfill-bucket-owners.ts --assign`);
- the platform's own buckets are never reachable from a project.

A bucket the project does not own answers exactly like a missing one: `404 Bucket "<name>" not
found`. Creating a bucket whose stored name lies in another project's namespace answers 409.
New projects get a storage prefix that overlaps no other project's, so their buckets are never
ambiguous.

A **public** bucket grants anonymous `GetObject` only: each file is readable at its URL, the bucket is never listed anonymously (listing goes through the API with a key). Files uploaded through the API as `text/html`, `application/xhtml+xml`, `image/svg+xml`, XML or JavaScript are stored with `Content-Disposition: attachment`, so the public storage host serves them as downloads rather than running them. Public URLs encode each path segment (`#`, `?` and spaces stay part of the key).

## Objects

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/projects/:projectId/storage/buckets/:bucketName/objects` | anon + user | `?prefix=` — list; optional `limit` (1–1000), `offset`, `sortBy` (`name`, `size`, `lastModified`) and `order` (`asc`, `desc`) page and order it |
| POST | `/api/projects/:projectId/storage/buckets/:bucketName/objects` | anon + user | `?path=` + multipart field `file` — upload one object |
| POST | `/api/projects/:projectId/storage/buckets/:bucketName/folders` | anon + user | `{ path }` — create a folder marker |
| POST | `/api/projects/:projectId/storage/buckets/:bucketName/objects/exists` | anon + user | `{ paths }` → `{ existing }` |
| POST | `/api/projects/:projectId/storage/buckets/:bucketName/objects/move` | anon + user | `{ sources, destFolder }` → `{ moved }`; `sources` must be a non-empty list of paths (400 otherwise); an existing destination is never overwritten (409), a missing source answers 404, and nothing is moved when any item is refused |
| POST | `/api/projects/:projectId/storage/buckets/:bucketName/objects/copy` | anon + user | `{ source, destination }` → `{ name, size }` — copy one object inside the bucket; 404 if the source is missing, 409 if the destination exists |
| POST | `/api/projects/:projectId/storage/buckets/:bucketName/objects/rename` | anon + user | `{ source, destination }` → `{ name }` — rename one object (the destination is the whole key); same 404 and 409 |
| GET | `/api/projects/:projectId/storage/buckets/:bucketName/objects/download` | anon | `?path=` — the bytes, as an attachment. Carries `ETag` and `Last-Modified` and answers `304` to a matching `If-None-Match`. A public bucket with no access rule on the key is cacheable by a CDN (`Cache-Control: public, max-age=300, stale-while-revalidate=60`); anything else is `private, no-cache` |
| GET | `/api/projects/:projectId/storage/buckets/:bucketName/objects/render` | anon | `?path=&width=&height=&format=&quality=&fit=` — a transformed image, inline |
| GET | `/api/projects/:projectId/storage/buckets/:bucketName/objects/url` | anon + user | `?path=&expiry=` → `{ url, expiresIn }` — a signed URL (60…604800 s, default 3600; a shorter or longer `expiry` is a 400, a missing object a 404) |
| DELETE | `/api/projects/:projectId/storage/buckets/:bucketName/objects` | anon + user | `{ paths }` → `{ message }` — the count is of objects that existed |

An object: `{ name, size, contentType, lastModified, etag }` (listings also carry `prefix`).
The single-request upload ceiling is `STORAGE_MAX_UPLOAD_MB` (default 500 MB); the body is
spooled to disk, not held in memory. Larger files use upload sessions (below).

### Image rendering

`render` takes an image object and returns a resized, re-encoded copy:

| Parameter | Values |
|---|---|
| `width`, `height` | pixels, each at most `STORAGE_TRANSFORM_MAX_DIMENSION` (4096) |
| `fit` | `cover` (default), `contain`, `fill`, `inside`, `outside` |
| `format` | `jpeg`, `png`, `webp`, `avif`; default keeps the source format |
| `quality` | 1–100 for lossy formats |

Responses carry `Cache-Control: public, max-age=<STORAGE_TRANSFORM_CACHE_SECONDS>` (3600)
and an `ETag` derived from the object and the parameters, so `If-None-Match` yields 304.
The source must be an image (415 otherwise) of at most `STORAGE_TRANSFORM_MAX_SOURCE_MB`
(25 MB, 413). At most `STORAGE_TRANSFORM_MAX_CONCURRENT` (4) renders run at once; beyond that
the route answers 503 with `Retry-After: 2`. 501 means the API image was built without the
image library.

```ts
bf.storage.from('avatars').getPublicUrl('u1/me.png', { transform: { width: 128, height: 128, format: 'webp' } })
```

### Who can read what

A **public** bucket's objects are readable by anyone through `public-url` and `download`. A
**private** bucket is still readable by any holder of the anon key through `download`, unless
an access rule narrows it:

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/projects/:projectId/storage/policies` | service | the project's rules |
| PUT | `/api/projects/:projectId/storage/buckets/:bucketName/policy` | service | `{ mode, pathPrefix? }` — set a rule on the bucket or on a key prefix |
| DELETE | `/api/projects/:projectId/storage/buckets/:bucketName/policy` | service | `?pathPrefix=` → `{ removed }` |

| `mode` | Effect on download, render, list, delete and overwrite |
|---|---|
| `public-read` | any valid key may read — what a bucket does with no rule; pins a prefix open inside a stricter bucket |
| `authenticated-read` | reads need a signed-in end user; the anon key alone is refused |
| `owner-only` | reads, deletes and overwrites are limited to the user who uploaded the object (recorded on the object as `x-amz-meta-owner`) |

The service key and dashboard team members are never restricted. A rule row:
`{ id, projectId, bucket, pathPrefix, mode, createdBy, createdAt, updatedAt }`.

## Signed upload URLs

To let someone upload one object without a key, mint a signed upload URL with the project key:
`POST /api/storage/v1/object/upload/sign/:bucket/:path(*)` (header `x-upsert: true` to allow
overwriting) answers `{ url }`; the holder `PUT`s the file to `/api/storage/v1` + `url`
(multipart, file under the empty field name, or the raw bytes). The token is valid for two hours
and names the project, the object and whether overwriting is allowed; the upload goes through the
normal path (plan storage limit, bucket rules, catalog). basefyio-js: `createSignedUploadUrl(path,
{ upsert })` and `uploadToSignedUrl(path, token, file)`. See also
[storage-v1-api.md](storage-v1-api.md).

## Resumable uploads

For large files, upload in chunks that survive a dropped connection. Base path
`/api/projects/:projectId/storage/buckets/:bucketName/upload-sessions`; every route needs a
signed-in user (or the service key).

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/projects/:projectId/storage/buckets/:bucketName/upload-sessions` | `{ path, size, contentType?, chunkSize? }` → session |
| GET | `/api/projects/:projectId/storage/buckets/:bucketName/upload-sessions` | open sessions you may resume, newest first (all for the service key and the dashboard, only your own for a signed-in user) |
| GET | `/api/projects/:projectId/storage/buckets/:bucketName/upload-sessions/:sessionId` | the session (also `Upload-Offset` / `Upload-Length` headers) |
| HEAD | `/api/projects/:projectId/storage/buckets/:bucketName/upload-sessions/:sessionId` | headers only |
| PATCH | `/api/projects/:projectId/storage/buckets/:bucketName/upload-sessions/:sessionId` | `Upload-Offset: <bytes so far>` header + the raw chunk body → session with the new offset |
| POST | `/api/projects/:projectId/storage/buckets/:bucketName/upload-sessions/:sessionId/complete` | assemble and store → the object |
| DELETE | `/api/projects/:projectId/storage/buckets/:bucketName/upload-sessions/:sessionId` | → `{ id, status: "aborted" }` |

A session: `{ id, bucket, path, offset, size, chunkSize, contentType, status, expiresAt }`.
A `PATCH` whose `Upload-Offset` does not match the stored offset answers `409` with the right offset in the `Upload-Offset` header and the body; resume from there.
Chunks are `STORAGE_RESUMABLE_CHUNK_MB` (8 MB, clamped to 5–64), the whole upload at most
`STORAGE_MAX_RESUMABLE_MB` (5120), and an unfinished session is swept after
`STORAGE_RESUMABLE_TTL_HOURS` (24). The header names follow the tus vocabulary so existing
clients feel at home, but this is not a tus-conformant server (no negotiation, no
extensions, JSON bodies on every response). The SDK wraps the whole exchange:

```ts
await bf.storage.from('videos').uploadResumable('talks/keynote.mp4', file, {
  chunkSize: 8 * 1024 * 1024,
  onProgress: ({ uploaded, total, percent }) => render(percent),
});
```

## S3 access keys

Off unless the server sets `S3_KEYS_ENABLED=true` (and, optionally, lists the project in
`S3_KEYS_PROJECTS`); see [configuration.md](configuration.md). Only with the bundled MinIO
(`STORAGE_DRIVER=minio`).

An S3 access key lets a standard S3 client (AWS SigV4, path-style) read and write the project's
buckets directly on the storage host, without the platform API in the path.

| Setting | Value |
|---|---|
| Endpoint | `GET …/s3-keys/info` → `endpoint` (hosted: `https://storage.basefyio.com`) |
| Region | `us-east-1` (`S3_KEYS_REGION`) |
| Addressing | path-style (`forcePathStyle: true`) |
| Bucket | the **physical** name, `bf-<storage prefix or slug>-<bucket>` (`info.buckets[].physical`) |

Routes, under `/api/projects/:projectId/storage/s3-keys`. A dashboard session or a platform token;
tokens need `secrets:read` (GET) or `secrets:write`, never `storage:*`. Creating and revoking also
need the team's credentials permission (the one that rotates project keys).

| Method | Path | Answer |
|---|---|---|
| GET | `/info` | `{ enabled, unavailableReason, endpoint, region, pathStyle, buckets: [{ name, physical }], unreachable: [{ physical, reason }], maxKeys }` |
| GET | `/` | `[{ id, name, accessKeyId, secretLast4, createdAt, createdBy }]` |
| POST | `/` body `{ name }` (1–60 chars) | the key plus `secretAccessKey`, `endpoint`, `region`, `pathStyle`, `buckets`; **the only time the secret is returned** |
| DELETE | `/:keyId` | `{ revoked: true }` |

What a key can do, and what it cannot:

- Each key is a MinIO user whose policy names the project's buckets by exact ARN
  (`arn:aws:s3:::<bucket>` and `/*`): `GetBucketLocation`, `ListBucket`,
  `ListBucketMultipartUploads`, `GetObject`, `PutObject`, `DeleteObject`,
  `AbortMultipartUpload`, `ListMultipartUploadParts`. No bucket creation or deletion, no bucket
  policy (a key cannot make a bucket public), no listing of all buckets, no admin API.
- Creating or deleting a bucket through the API updates the policy of every key of the project.
  A bucket is removed from the policy **before** it is deleted; if that update fails the delete
  answers 502 and nothing is removed.
- A bucket whose physical name could belong to two projects (`bf-a-` + `b-x` and `bf-a-b-` + `x`
  are the same string) is granted only to the project recorded as its creator; an older bucket
  without a record is left out and listed under `unreachable`. Creating a bucket whose name would
  fall into another project's namespace answers 409.
- The secret is not stored by the platform (MinIO keeps it, as SigV4 requires); the list shows the
  last four characters. Revoking deletes the MinIO user first, so the key fails on its next request.
- At most `S3_KEYS_MAX_PER_PROJECT` (5) active keys per project (409 beyond). Keys of a deleted
  project are removed by a sweep every 10 minutes; a deactivated project's keys reach nothing until
  it is active again.
- Refused (403) for projects with `storageAuthz = 'rls'`.
- Every create and revoke writes an audit-log row and a project activity entry, without the secret.

**A key bypasses the API's storage rules**: access rules (`StoragePolicy`), per-bucket size and
MIME limits, the per-upload quota check, the storage catalog and upload events. Stored bytes are
still measured by the six-hourly usage pass. Treat a key as a service-level credential.

| Status | When |
|---|---|
| 403 | keys not enabled (server, project list, driver, `rls` project); not a team member; role without the credentials permission; token without `secrets:*` |
| 404 | unknown project or key (also another project's key) |
| 409 | key limit reached |
| 502 | MinIO refused the change; nothing was issued or revoked |

## Examples

```bash
API=https://api.basefyio.com/api/projects/$PROJECT_ID/storage
# upload as a signed-in user
curl -s "$API/buckets/avatars/objects?path=u1/me.png" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TOKEN" -F file=@me.png
# signed URL for 10 minutes
curl -s "$API/buckets/avatars/objects/url?path=u1/me.png&expiry=600" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TOKEN"
# create a bucket from your server
curl -s "$API/buckets" -H "apikey: $SERVICE_KEY" -H "Content-Type: application/json" -d '{"name":"avatars","public":false}'
```

## Errors

| Status | When |
|---|---|
| 400 | `Bucket name must be 3-63 chars…`; `File path is required`; `Folder name is required`; `Invalid folder path`; `Invalid destination`; `Cannot move a folder into itself`; `Expiry must be between 60 and 604800 seconds`; a chunk at the wrong offset |
| 403 | anon key on a service route; bare anon key on a user route; an access rule refused the read |
| 404 | `Bucket "<name>" not found` (also a bucket another project owns, an ambiguous legacy bucket or a platform bucket: the answer is the same as for a missing one); `Object "<key>" not found`; unknown upload session |
| 409 | `Bucket "<name>" already exists`; `Bucket name "<name>" overlaps another project's storage namespace`; `Bucket name "<name>" is reserved` |
| 502 | deleting a bucket whose S3 key policy could not be updated |
| 413 | upload above `STORAGE_MAX_UPLOAD_MB`; render source above the transform limit |
| 415 | render of a non-image |
| 501 / 503 | transforms unavailable on this build / too many concurrent renders |

Source: `apps/platform-api/src/modules/storage/storage.controller.ts`,
`storage-policy.controller.ts`, `upload-session.controller.ts`, `storage.service.ts`,
`storage-access.service.ts`, `image-transform.service.ts`, `upload-session.service.ts`,
`s3-keys.controller.ts`, `s3-keys.service.ts`, `s3-key-policy.ts`, `minio-admin.client.ts`,
`bucket-names.ts` (ownership rules), `bucket-owner-backfill.ts`;
SDK: `packages/sdk/src/modules/storage.ts`.
