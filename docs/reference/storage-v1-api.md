# Supabase Storage API (`/api/storage/v1`)

The Supabase Storage protocol over the platform's object store, so `@supabase/storage-js`
and supabase-js work unchanged:

```js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient('https://api.basefyio.com/api/p/<projectId>', '<anon key>');

await supabase.storage.from('avatars').upload('u1/me.png', file, { upsert: true });
const { data } = supabase.storage.from('avatars').getPublicUrl('u1/me.png');
```

The client's base URL names the project (`/api/p/<projectId>`); the platform rewrites that
prefix away and keeps the id for the routes that carry no key. The same routes answer under
`/api/storage/v1` for callers that send the `apikey` header.

## Authentication

| Caller | Headers | Role |
|---|---|---|
| anon key | `apikey: <anon>` (and, as supabase-js does, `Authorization: Bearer <anon>`) | `anon` |
| signed-in user | `apikey: <anon>` + `Authorization: Bearer <user access token>` | `authenticated` |
| service key | `apikey: <service>` — server side only, never from a browser | `service_role` |
| nobody | — (public files, signed URLs) | — |

The anon key may also travel as `?apikey=`; the service key never may.

## Authorisation modes

Each project authorises object access one of two ways (`Project.storageAuthz`, read with
`GET /api/projects/:projectId/storage/catalog`):

- **`presets`** (default) — the StoragePolicy access rules of the
  [Storage API](./storage-api.md) (`public-read`, `authenticated-read`, `owner-only`, longest
  prefix wins). A bare anon key reads what the rules allow and never writes; a signed-in user
  or the service key writes.
- **`rls`** — the project's own row-level security policies on `storage.objects` and
  `storage.buckets` in the project database, evaluated under the caller's role with the
  JWT claims in `request.jwt.claims` — the policies a Supabase app ships with. Writes are
  first tried as a statement and rolled back; only then is the store touched. The
  Supabase import switches a project to this mode when it copied storage policies.

Switch with `PATCH /api/projects/:projectId/storage/authz` `{ "mode": "rls" }` (service key or
a team member). Going to `rls` needs the catalog (`POST /api/projects/:id/ensure-rls-bootstrap`
creates it) and runs a backfill first.

The **catalog** — `storage.buckets` / `storage.objects`, Supabase's layout — is kept in step
with the store by every write in either mode; `POST /api/projects/:projectId/storage/catalog/backfill`
rebuilds it from the store. Fresh projects' `auth.uid()` returns `text`, so policies there
compare `owner_id = auth.uid()`; imported projects keep Supabase's `uuid` signature and
`owner = auth.uid()`.

## Objects

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/api/storage/v1/object/:bucket/:path(*)` | writer | upload; `x-upsert: true` to overwrite |
| PUT | `/api/storage/v1/object/:bucket/:path(*)` | writer | update (always overwrites) |
| GET | `/api/storage/v1/object/:bucket/:path(*)` | reader | download; `?download[=name]` for an attachment; `Range` → 206 |
| GET | `/api/storage/v1/object/authenticated/:bucket/:path(*)` | reader | same as above |
| HEAD | `/api/storage/v1/object/:bucket/:path(*)` | reader | `exists()`: headers only |
| GET | `/api/storage/v1/object/info/:bucket/:path(*)` | reader | `{ id, name, bucket_id, size, content_type, cache_control, etag, last_modified, created_at, updated_at, metadata }` |
| POST | `/api/storage/v1/object/list/:bucket` | reader | `{ prefix, limit=100, offset=0, sortBy: { column, order }, search }` → `FileObject[]` |
| DELETE | `/api/storage/v1/object/:bucket` | writer | `{ prefixes: [...] }` → the removed `FileObject[]` |
| POST | `/api/storage/v1/object/move` | writer | `{ bucketId, sourceKey, destinationKey, destinationBucket? }` → `{ message }` |
| POST | `/api/storage/v1/object/copy` | writer | same body → `{ Key }` |
| POST | `/api/storage/v1/object/sign/:bucket/:path(*)` | reader | `{ expiresIn, transform? }` → `{ signedURL }` (relative) |
| POST | `/api/storage/v1/object/sign/:bucket` | reader | `{ expiresIn, paths }` → `[{ error, path, signedURL }]` |
| POST | `/api/storage/v1/object/upload/sign/:bucket/:path(*)` | writer | `x-upsert` → `{ url }` (relative, valid 2 h) |
| GET | `/api/storage/v1/render/image/authenticated/:bucket/:path(*)` | reader | `?width&height&resize&format&quality` — a transformed image |

An upload body is either multipart (the file under the empty field name, plus `cacheControl`
and `metadata` text fields) or the raw bytes with `content-type`, `cache-control: max-age=<n>`
and `x-metadata` (base64 JSON). The answer is `{ Id, Key: "bucket/path" }`. The ceiling is
`STORAGE_MAX_UPLOAD_MB` (default 500 MB; bodies are spooled to disk); a bucket's own
`file_size_limit` and `allowed_mime_types` apply as well.

A `FileObject` is `{ name, id, updated_at, created_at, last_accessed_at, metadata }`; a folder
has `id: null` and `metadata: null`; a file's `metadata` is
`{ eTag, size, mimetype, cacheControl, lastModified, contentLength, httpStatusCode }`.

Byte responses carry `Content-Type`, `Content-Length`, `ETag`, `Last-Modified`,
`Cache-Control`, `Accept-Ranges: bytes` and `Cross-Origin-Resource-Policy: cross-origin`, so an
`<img>` on another origin may show the file.

Keys are at most 1024 bytes, never contain `..` or NUL, and never end in `/`. The segments
`public`, `sign`, `upload`, `authenticated`, `info`, `list`, `move` and `copy` name verbs under
`object/`, so a bucket with one of those names cannot be reached through this surface.

## Public and signed routes (no key)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/storage/v1/object/public/:bucket/:path(*)` | a file in a public bucket (`getPublicUrl`); `?download` |
| GET | `/api/storage/v1/render/image/public/:bucket/:path(*)` | the same, transformed |
| GET | `/api/storage/v1/object/sign/:bucket/:path(*)` | `?token=` from `createSignedUrl`; `?download` |
| GET | `/api/storage/v1/render/image/sign/:bucket/:path(*)` | `?token=` minted with a `transform` |
| PUT | `/api/storage/v1/object/upload/sign/:bucket/:path(*)` | `?token=` from `createSignedUploadUrl` → `{ Key }` |

These need the project in the URL (`/api/p/<projectId>/storage/v1/…`), as `getPublicUrl`
produces; a signed URL also carries the project inside its token. A private bucket answers
`not_found` on the public route. A deactivated project is woken by any of these.

Signed URLs are HS256 tokens naming the project, the object and the purpose. They are signed
with `STORAGE_URL_SIGNING_SECRET`, or — when it is not set — with a key derived from the
project's service key. `expiresIn` is 1…`STORAGE_SIGNED_URL_MAX_SECONDS` (default one year).
Changing the secret, or the service key when it stands in, invalidates every URL minted before.

## Buckets

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/api/storage/v1/bucket` | reader¹ | `[{ id, name, owner, public, file_size_limit, allowed_mime_types, created_at, updated_at }]` |
| GET | `/api/storage/v1/bucket/:id` | reader¹ | one bucket |
| POST | `/api/storage/v1/bucket` | service | `{ id, name, public, file_size_limit, allowed_mime_types }` → `{ name }` |
| PUT | `/api/storage/v1/bucket/:id` | service | same fields → `{ message: "Successfully updated" }` |
| POST | `/api/storage/v1/bucket/:id/empty` | service | → `{ message: "Successfully emptied" }` |
| DELETE | `/api/storage/v1/bucket/:id` | service | must be empty → `{ message: "Successfully deleted" }` |

¹ In `rls` mode, what the policies on `storage.buckets` allow; in `presets` mode, a signed-in
user or the service key. Bucket names are 3–63 characters of letters, digits and hyphens.

## Catalog (operator)

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/api/projects/:projectId/storage/catalog` | service / team | `{ storageAuthz, catalogAvailable }` |
| POST | `/api/projects/:projectId/storage/catalog/backfill` | service / team | rebuild the catalog from the store → `{ buckets, objects, skipped }` |
| PATCH | `/api/projects/:projectId/storage/authz` | service / team | `{ mode: "presets" \| "rls" }` |

## Errors

Supabase's shape, which storage-js reads into `StorageApiError`:

```json
{ "statusCode": "404", "error": "not_found", "message": "Object not found" }
```

`statusCode` is a **string**; the HTTP status is 400 for client errors other than 402, 413, 415,
416 and 429, which keep their own. Common codes: `404` `not_found` / `Bucket not found`,
`409` `Duplicate` (`The resource already exists`), `403` `Unauthorized` (a preset rule, or
`new row violates row-level security policy`), `401` `InvalidJWT` (a bad or expired signed
URL), `413` `Payload too large`, `415` `invalid_mime_type`, `400` `InvalidRequest`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `STORAGE_URL_SIGNING_SECRET` | — (per-project derivation) | signs download and upload URLs |
| `STORAGE_SIGNED_URL_MAX_SECONDS` | `31536000` | ceiling for `expiresIn` |
| `STORAGE_MAX_UPLOAD_MB` | `500` | single-request upload ceiling |
| `STORAGE_MAX_CONCURRENT_UPLOADS` | `8` | uploads streaming at once per instance (503 beyond) |
| `STORAGE_UPLOAD_TMP_DIR` | `<os tmp>/basefyio-uploads` | upload spool |

Not covered here: `listV2` (the cursor-paginated listing), bucket types other than files,
analytics and vector buckets.
