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
| DELETE | `/api/projects/:projectId/storage/buckets/:bucketName` | service | delete (must be empty) |
| GET | `/api/projects/:projectId/storage/buckets/:bucketName/public-url` | anon | `?path=` → `{ public, url }` (`url` is `null` for a private bucket) |

A bucket: `{ id, name, public, createdAt, objectCount, totalSize }`. Names are 3–63
characters, letters, digits and hyphens, not starting or ending with a hyphen (400). Buckets
are created from the dashboard (Storage) or from your server — never from a browser, since
creation needs the service key.

## Objects

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/projects/:projectId/storage/buckets/:bucketName/objects` | anon + user | `?prefix=` — list |
| POST | `/api/projects/:projectId/storage/buckets/:bucketName/objects` | anon + user | `?path=` + multipart field `file` — upload one object |
| POST | `/api/projects/:projectId/storage/buckets/:bucketName/folders` | anon + user | `{ path }` — create a folder marker |
| POST | `/api/projects/:projectId/storage/buckets/:bucketName/objects/exists` | anon + user | `{ paths }` → `{ existing }` |
| POST | `/api/projects/:projectId/storage/buckets/:bucketName/objects/move` | anon + user | `{ sources, destFolder }` → `{ moved }` |
| GET | `/api/projects/:projectId/storage/buckets/:bucketName/objects/download` | anon | `?path=` — the bytes, as an attachment |
| GET | `/api/projects/:projectId/storage/buckets/:bucketName/objects/render` | anon | `?path=&width=&height=&format=&quality=&fit=` — a transformed image, inline |
| GET | `/api/projects/:projectId/storage/buckets/:bucketName/objects/url` | anon + user | `?path=&expiry=` → `{ url, expiresIn }` — a signed URL (60…604800 s, default 3600) |
| DELETE | `/api/projects/:projectId/storage/buckets/:bucketName/objects` | anon + user | `{ paths }` → `{ message }` |

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

## Resumable uploads

For large files, upload in chunks that survive a dropped connection. Base path
`/api/projects/:projectId/storage/buckets/:bucketName/upload-sessions`; every route needs a
signed-in user (or the service key).

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/projects/:projectId/storage/buckets/:bucketName/upload-sessions` | `{ path, size, contentType?, chunkSize? }` → session |
| GET | `/api/projects/:projectId/storage/buckets/:bucketName/upload-sessions/:sessionId` | the session (also `Upload-Offset` / `Upload-Length` headers) |
| HEAD | `/api/projects/:projectId/storage/buckets/:bucketName/upload-sessions/:sessionId` | headers only |
| PATCH | `/api/projects/:projectId/storage/buckets/:bucketName/upload-sessions/:sessionId` | `Upload-Offset: <bytes so far>` header + the raw chunk body → session with the new offset |
| POST | `/api/projects/:projectId/storage/buckets/:bucketName/upload-sessions/:sessionId/complete` | assemble and store → the object |
| DELETE | `/api/projects/:projectId/storage/buckets/:bucketName/upload-sessions/:sessionId` | → `{ id, status: "aborted" }` |

A session: `{ id, bucket, path, offset, size, chunkSize, contentType, status, expiresAt }`.
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
| 404 | `Bucket "<name>" not found`; `Object "<key>" not found`; unknown upload session |
| 409 | `Bucket "<name>" already exists` |
| 413 | upload above `STORAGE_MAX_UPLOAD_MB`; render source above the transform limit |
| 415 | render of a non-image |
| 501 / 503 | transforms unavailable on this build / too many concurrent renders |

Source: `apps/platform-api/src/modules/storage/storage.controller.ts`,
`storage-policy.controller.ts`, `upload-session.controller.ts`, `storage.service.ts`,
`storage-access.service.ts`, `image-transform.service.ts`, `upload-session.service.ts`;
SDK: `packages/sdk/src/modules/storage.ts`.
