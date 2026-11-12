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
A public bucket's files are also served with **no key at all** by the public route below.

**Private buckets and the anon key.** A private bucket is reached with a signed-in user's
token, a signed URL created by your server, or the service key — never with the bare anon key,
which ships inside every browser app. With the anon key alone every object route of a private
bucket answers `403` (listing, upload, download, render, signed URLs, delete, move, copy,
rename, folders, upload sessions), and `GET /buckets` lists only the public buckets. To let the
anon key **read** a private bucket or a prefix on purpose, set a `public-read` access rule on it
(below); writes always need a user or the service key. Operators can switch the refusal to
log-only with `STORAGE_PRIVATE_BUCKET_ANON=log` while they find the apps that depend on it.

## Buckets

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/projects/:projectId/storage/buckets` | anon + user | list buckets (the anon key alone sees only public ones) |
| POST | `/api/projects/:projectId/storage/buckets` | service | `{ name, public?, fileSizeLimit?, allowedMimeTypes? }` — create |
| PATCH | `/api/projects/:projectId/storage/buckets/:bucketName` | service | `{ public?, fileSizeLimit?, allowedMimeTypes? }` — change visibility and/or upload limits |
| DELETE | `/api/projects/:projectId/storage/buckets/:bucketName` | service | delete; `409` while it holds files unless `?force=true` |
| GET | `/api/projects/:projectId/storage/buckets/:bucketName/public-url` | anon | `?path=` → `{ public, url }` (`url` is `null` for a private bucket) |
| GET | `/api/projects/:projectId/storage/limits` | anon | `{ maxUploadBytes, signedUrlExpiry: { min, max, default } }` |

A bucket: `{ id, name, public, createdAt, objectCount, totalSize, fileSizeLimit,
allowedMimeTypes }`. Names are 3–63 characters of **lowercase** letters, digits and hyphens,
not starting or ending with a hyphen; anything else is a `400` — the API never rewrites a name.
`public` must be a JSON boolean (`"yes"` is a `400`), and a `PATCH` must change at least one
field. Buckets are created from the dashboard (Storage) or from your server — never from a
browser, since creation needs the service key.

`DELETE` refuses a bucket that still holds files with `409 Bucket "<name>" is not empty`;
repeat it with `?force=true` to delete the bucket together with everything in it (the answer
then carries `deletedObjects`). Empty folders do not count as content.

**Upload limits per bucket.** `fileSizeLimit` (bytes, `null` = the platform ceiling) and
`allowedMimeTypes` (`["image/png", "image/*"]`, empty or `null` = any type) apply to uploads and
upload sessions: a larger file is a `413`, another type a `415`. The platform-wide ceiling for
one request is `STORAGE_MAX_UPLOAD_MB` (default **500 MB**, reported by `GET /storage/limits`);
larger files go through upload sessions (up to `STORAGE_MAX_RESUMABLE_MB`, default 5 GB).

**Public buckets** give anyone the files whose names they know: anonymous `s3:GetObject`. They
do not hand out an index of their keys — the bucket's base URL on the storage host answers
`403` instead of a listing (`STORAGE_PUBLIC_BUCKET_LISTING=on` restores listing for an
operator who needs it; existing public buckets lose listing shortly after the API starts).
Pages, SVG and XML files are stored with `Content-Disposition: attachment`, so opened at their
URL they download instead of rendering on the shared storage host; `<img src>` is unaffected.

### The public file route

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/projects/:projectId/storage/public/:bucketName` | none | `?path=` — a public bucket's file, inline, no key needed |

What `getPublicUrl()` in the SDK points at: it works in `<img src>`, `<video src>` and plain
links. It answers `404` for a private bucket, a missing project or a missing file alike, and
supports `ETag`/`If-None-Match` (`304`), single byte ranges (`206`, for video seeking) and
`Cache-Control: public, max-age=300`.

## Objects

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/projects/:projectId/storage/buckets/:bucketName/objects` | anon + user | `?prefix=&recursive=&search=&sortBy=&order=&limit=&offset=` — list |
| POST | `/api/projects/:projectId/storage/buckets/:bucketName/objects` | anon + user | `?path=` + multipart field `file` — upload one object (same path = overwrite) |
| POST | `/api/projects/:projectId/storage/buckets/:bucketName/folders` | anon + user | `{ path }` — create a folder marker |
| POST | `/api/projects/:projectId/storage/buckets/:bucketName/objects/exists` | anon + user | `{ paths }` → `{ existing }` |
| POST | `/api/projects/:projectId/storage/buckets/:bucketName/objects/move` | anon + user | `{ sources, destFolder }` → `{ moved }` — into a folder |
| POST | `/api/projects/:projectId/storage/buckets/:bucketName/objects/copy` | anon + user | `{ from, to, overwrite? }` → `{ from, to, count, copied }` |
| POST | `/api/projects/:projectId/storage/buckets/:bucketName/objects/rename` | anon + user | `{ from, to, overwrite? }` → `{ from, to, moved }` |
| GET | `/api/projects/:projectId/storage/buckets/:bucketName/objects/download` | anon | `?path=` — the bytes, as an attachment |
| GET | `/api/projects/:projectId/storage/buckets/:bucketName/objects/render` | anon | `?path=&width=&height=&format=&quality=&fit=` — a transformed image, inline |
| GET | `/api/projects/:projectId/storage/buckets/:bucketName/objects/url` | anon + user | `?path=&expiry=` → `{ url, expiresIn }` — a signed URL (60…604800 s, default 3600) |
| DELETE | `/api/projects/:projectId/storage/buckets/:bucketName/objects` | anon + user | `{ paths }` → `{ message, deleted, notFound }` |

("anon" rows: the anon key alone works on public buckets; see *Private buckets and the anon
key* above.)

An object: `{ name, size, contentType, lastModified, etag }`. A listing entry is either a file
(`name` is its full key) or a folder (`prefix` is the folder's key ending in `/`, `name` is
`""`, `size` is 0). Listing options, all optional (without them the listing is exactly what the
store returns): `recursive=true` lists everything below `prefix` instead of one level; `search`
keeps entries whose own name contains the text (case-insensitive); `sortBy` = `name` | `size`
| `lastModified` with `order` = `asc` | `desc` (folders stay ahead of files); `limit`
(1–1000) and `offset` page the result. The answer stays an array; `X-Total-Count` carries the
number of matching entries before paging.

`copy` and `rename` take one file, or a folder (`from` and `to` both ending in `/`) with
everything in it; `404` for a missing source, `409` when the destination exists and
`overwrite` is not `true`. `move` needs a non-empty `sources` array (`400` otherwise).
`DELETE /objects` needs a non-empty `paths` array (at most 1000); a path ending in `/` deletes
the folder's whole contents. `deleted` lists the keys that were removed and `notFound` the
requested files that were not there, so the count in `message` is what really went.

Signed URLs: `expiry` is a whole number of seconds from 60 to 604800 (7 days), default 3600; a
URL is only minted for an object that exists (`404` otherwise).

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

A **public** bucket's objects are readable by anyone through `public-url`, `download` and the
public file route. A **private** bucket is readable by signed-in users of your app, through
signed URLs and with the service key; the anon key alone is refused. Access rules narrow or
open this per bucket or prefix:

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/projects/:projectId/storage/policies` | service | the project's rules |
| PUT | `/api/projects/:projectId/storage/buckets/:bucketName/policy` | service | `{ mode, pathPrefix? }` — set a rule on the bucket or on a key prefix |
| DELETE | `/api/projects/:projectId/storage/buckets/:bucketName/policy` | service | `?pathPrefix=` → `{ removed }` |

| `mode` | Effect on download, render, list, delete and overwrite |
|---|---|
| `public-read` | any valid key may read, the anon key alone included — the explicit way to open reads of a private bucket or prefix; pins a prefix open inside a stricter bucket |
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
| 400 | `Bucket name must be 3-63 characters of lowercase letters…`; `public must be true or false`; `Nothing to update…`; `force must be true or false`; `path must name a file inside the bucket`; `paths must be a non-empty array of strings`; `sources must be a non-empty array of strings`; `Folder name is required`; `Invalid folder path`; `Invalid destination`; `Cannot move a folder into itself`; `Expiry must be a whole number of seconds between 60 and 604800`; bad listing options; a chunk at the wrong offset |
| 403 | anon key on a service route; bare anon key on a user route; anon key alone on a private bucket (`Bucket "<name>" is private…`); an access rule refused the read |
| 404 | `Bucket "<name>" not found`; `Object "<key>" not found`; unknown upload session; the public file route for anything it does not serve |
| 409 | `Bucket "<name>" already exists`; `Bucket "<name>" is not empty…` without `force`; copy/rename onto an existing path without `overwrite` |
| 413 | upload above `STORAGE_MAX_UPLOAD_MB` or the bucket's `fileSizeLimit`; render source above the transform limit |
| 415 | render of a non-image; upload of a type outside the bucket's `allowedMimeTypes` |
| 501 / 503 | transforms unavailable on this build / too many concurrent renders |

Source: `apps/platform-api/src/modules/storage/storage.controller.ts`,
`storage-policy.controller.ts`, `upload-session.controller.ts`, `storage-public.controller.ts`,
`storage-objects.ts`, `storage.service.ts`,
`storage-access.service.ts`, `image-transform.service.ts`, `upload-session.service.ts`;
SDK: `packages/sdk/src/modules/storage.ts`.
