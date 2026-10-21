# Backups: off-site copies, restore verification and preview branches

basefyio takes a nightly archive of every project (03:00 UTC), a daily physical
base backup of the cluster (02:00 UTC) and ships WAL every ten minutes — see
[Point-in-Time Recovery](./POINT_IN_TIME_RECOVERY.md). All of that lives in the
MinIO on the same host. This document covers the three things that turn those
files into something you can rely on:

- **Off-site copies** — every artifact encrypted and copied to a bucket you own,
  somewhere else. Off until configured.
- **Restore verification** — a weekly drill that rebuilds the newest nightly
  archive into a throwaway database and proves it restores. On by default.
- **Preview branches** — disposable copies of a project's database for trying a
  change against real structure.

---

## Off-site copies

### What gets copied

| local object | remote key (under `BACKUP_S3_PREFIX`, default `basefyio/`) |
|---|---|
| `bf-platform-auto-backups/<projectId>/<file>.zip` | `auto-backups/<projectId>/<file>.zip.enc` |
| `bf-platform-pitr/_cluster/base/<stamp>/<file>` | `pitr/_cluster/base/<stamp>/<file>.enc` |
| `bf-platform-pitr/_cluster/wal/<segment>.gz` | `pitr/_cluster/wal/<segment>.gz.enc` |
| `bf-platform-pitr/<projectId>/base/<stamp>.dump` | `pitr/<projectId>/base/<stamp>.dump.enc` |
| — | `manifests/<timestamp>.json`, one per reconcile run |

Each artifact is copied right after the job that produced it, while the file is
still on disk. A nightly **reconcile** at 05:00 UTC lists both sides and copies
whatever a fast-path upload missed, so the remote set converges on the local
one even after a bad night. WAL therefore reaches the remote bucket within
about fifteen minutes of being written (`archive_timeout` 5 min + the shipping
interval).

Nothing is ever deleted remotely. Retention off-site is the bucket's lifecycle
rule, and the credentials can be write-only — a host that is compromised cannot
erase its own backups.

### Configuration

Set these in the `platform-api` environment (`.env.production`, then the
`environment:` block). Values that contain `< > & |` or spaces must be quoted,
or the env file truncates itself from that line down.

| variable | default | meaning |
|---|---|---|
| `BACKUP_ENC_KEY` | — | 32 bytes, base64 or 64 hex characters. Encrypts every off-site copy. **Keep a copy outside the server** — without it the copies cannot be read. |
| `BACKUP_S3_ENDPOINT` | — | Full URL of the S3-compatible endpoint. Setting it turns off-site copies on. |
| `BACKUP_S3_BUCKET` | — | Remote bucket |
| `BACKUP_S3_ACCESS_KEY` / `BACKUP_S3_SECRET_KEY` | — | Credentials; `PutObject` + `ListBucket` (+ `GetObject` for restores) is enough |
| `BACKUP_S3_REGION` | `us-east-1` | Signing region |
| `BACKUP_S3_PATH_STYLE` | `true` | `false` for AWS S3 virtual-host addressing |
| `BACKUP_S3_PREFIX` | `basefyio/` | Key prefix inside the bucket |
| `BACKUP_S3_TIMEOUT_MS` | `600000` | Per-object upload timeout (WAL segments: at most 120 s) |
| `BACKUP_OFFSITE_ALLOW_PLAINTEXT` | `false` | Allow copies without `BACKUP_ENC_KEY`, e.g. when the bucket encrypts at rest |
| `BACKUP_ENCRYPT_LOCAL` | `false` | Also store the nightly archive encrypted in the local MinIO (`.enc`); the dashboard restore decrypts transparently |

Generate a key:

```bash
openssl rand -base64 32
```

If the `BACKUP_S3_*` variables are set but no key exists (and plaintext was not
allowed), the API logs an error at start, raises one ROOT alert and uploads
nothing. Nothing leaves the server unencrypted by accident.

#### Hetzner Object Storage

```
BACKUP_S3_ENDPOINT=https://fsn1.your-objectstorage.com
BACKUP_S3_BUCKET=my-basefyio-backups
BACKUP_S3_ACCESS_KEY=…
BACKUP_S3_SECRET_KEY=…
BACKUP_S3_REGION=fsn1
BACKUP_S3_PATH_STYLE=true
```

#### AWS S3

```
BACKUP_S3_ENDPOINT=https://s3.eu-central-1.amazonaws.com
BACKUP_S3_BUCKET=my-basefyio-backups
BACKUP_S3_ACCESS_KEY=…
BACKUP_S3_SECRET_KEY=…
BACKUP_S3_REGION=eu-central-1
BACKUP_S3_PATH_STYLE=false
```

A write-only IAM policy for the credentials:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:PutObject"], "Resource": "arn:aws:s3:::my-basefyio-backups/*" },
    { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::my-basefyio-backups" }
  ]
}
```

Without `s3:GetObject` the API cannot check whether an object is already
present and simply uploads it again; add it if you prefer fewer uploads. A
write-only key can still overwrite a key it wrote, so turn on bucket versioning
(or Object Lock where the provider offers it) to keep earlier copies safe.

Lifecycle rules worth setting on the bucket: expire `basefyio/auto-backups/`
after 35 days and `basefyio/pitr/` after 14 days (longer than the 7-day local
retention, so the remote always holds more history than the host).

### Starting the first copy

After the variables are in place and the API has restarted, seed the bucket
without waiting for 05:00:

```http
POST /api/projects/backups/offsite/reconcile      (ROOT user)
```

Then watch `manifests/<timestamp>.json` appear in the bucket. The project's
**Backup & Export** page shows an "Off-site" chip on every archive that has a
copy, and the health card says whether copies are enabled and encrypted.

### Encryption format

Copies are AES-256-GCM, format `BFENC1`: a 23-byte header (`BFENC1`, version,
a 4-byte key fingerprint, a 12-byte IV) authenticated together with the body,
and a 16-byte tag at the end. An altered or truncated file fails to decrypt
rather than yielding broken SQL; the fingerprint lets the tools say "wrong key"
instead of "corrupt".

Decrypt with the dependency-free script (needs only Node):

```bash
BACKUP_ENC_KEY=… node scripts/backup-decrypt.mjs auto-backup-shop.zip.enc auto-backup-shop.zip
```

Copies made by `scripts/backup-offsite.sh` are `age` files instead
(`age -d -i key.txt file.age > file`).

### Restoring from the off-site bucket

The dashboard restores from the local MinIO. When the host itself is gone:

1. Download the archive with any S3 client (`aws s3 cp`, `mc cp`, `rclone`).
2. Decrypt it with `scripts/backup-decrypt.mjs`.
3. Import it into a new or existing project: **Import from ZIP** in the
   new-project dialog, or
   `POST /api/projects/import-export-zip` (multipart `file`, plus `teamId` or
   `existingProjectId`).

For a point-in-time restore, copy the decrypted `pitr/_cluster/...` and
`pitr/<projectId>/...` objects back into the local `bf-platform-pitr` bucket
under their original keys (without `.enc`); the existing replay then finds them.

### Host cron variant

Operators who prefer the host to do the copying — or want a second,
independent copy — can run `scripts/backup-offsite.sh` from cron. It mirrors
the same two buckets, encrypts each object with `age -r <recipient>`, skips
objects already present, and never deletes. The header of the script lists its
variables and an example cron line.

---

## Restore verification

A backup nobody has restored is a hope. Every **Sunday at 05:00 UTC** the API
picks the project that has gone longest without a verdict (among those with a
nightly archive younger than 48 hours and under the size cap) and:

1. downloads its newest archive and streams `database/dump.sql` and
   `database/tables.json` out of it;
2. creates `bfverify_<unix time>_<hex>` on the cluster from `template0`;
3. replays the dump with `psql -v ON_ERROR_STOP=0` — the same path the
   dashboard restore uses — and counts the `ERROR:` lines;
4. counts every restored table and compares with the counts recorded at dump
   time;
5. drops the throwaway database (always, also on failure or timeout) and
   records the verdict in `backup_verifications`.

`database/tables.json` is new in every nightly archive: the export opens a
snapshot (`pg_export_snapshot()`), runs `pg_dump --snapshot` under it and
counts every table inside the same snapshot — so the numbers describe exactly
the rows the archive holds, not the live table a second later. Older archives
without the file are verified for a clean replay and a non-empty result only
(`countsCompared: false`).

| verdict | meaning |
|---|---|
| `PASSED` | no psql errors, every recorded table present, every known count equal |
| `FAILED` | anything else — the details list missing tables, mismatched counts and the first psql errors; a ROOT alert is raised |
| `SKIPPED` | no archive yet, archive above `BACKUP_VERIFY_MAX_ARCHIVE_MB`, not enough temp space, or the drill would push the disk above `BACKUP_VERIFY_MAX_DISK_PERCENT` |

The project's **Backup & Export** page shows the last verdict and the history,
and **Verify now** runs the drill immediately for that project
(`POST /api/projects/:id/backups/verify`, one at a time per API instance).

| variable | default | meaning |
|---|---|---|
| `BACKUP_VERIFY_ENABLED` | `true` | Kill switch for the weekly drill (manual runs still work) |
| `BACKUP_VERIFY_PROJECT_IDS` | — | Comma-separated project ids to drill instead of the rotation |
| `BACKUP_VERIFY_PROJECTS_PER_RUN` | `1` | Projects per weekly run |
| `BACKUP_VERIFY_MAX_ARCHIVE_MB` | `256` | Larger archives are skipped; among the rest the smallest goes first |
| `BACKUP_VERIFY_MAX_DISK_PERCENT` | `85` | Skipped when the drill would push the data volume above this usage |
| `BACKUP_VERIFY_TIMEOUT_MS` | `1800000` | Whole-run bound; the drill is marked failed and cleaned up |
| `BACKUP_TABLE_COUNTS` | `true` | Write `database/tables.json` into nightly archives |
| `BACKUP_COUNT_MAX_TABLES` | `300` | Tables counted per archive (the rest are listed with `rows: null`) |
| `BACKUP_COUNT_TIMEOUT_MS` | `20000` | Per-table count timeout at dump time; a slow table is recorded as unknown |

Routes (dashboard session or an API token with `backups:read` / `backups:write`):

```
GET  /api/projects/:id/backups/health          off-site state, local encryption, latest verdict, history
GET  /api/projects/:id/backups/verifications   history (?limit=)
POST /api/projects/:id/backups/verify          start a drill now → 202 { verificationId }
```

From a shell, `scripts/verify-restore.sh <archive.zip>` or
`scripts/verify-restore.sh --latest <projectId>` runs the same drill against
the production cluster and exits 0 on `PASSED`.

---

## Preview branches

A preview branch is a child project — its own database, its own authentication
realm, its own API keys — populated from the parent's database. Use it to try a
migration or a feature against real structure without touching the project
people depend on.

```
POST   /api/projects/:id/branches              { "name": "pr-42", "dataMode": "schema" | "full" }
GET    /api/projects/:id/branches
DELETE /api/projects/:id/branches/:branchId
```

- `name`: 2–40 characters, lowercase letters, digits and hyphens; unique per
  parent.
- `dataMode`: `schema` (default) copies tables, functions, policies and
  sequences; `full` also copies every row. Full copies are limited to parents
  under `BRANCH_MAX_DB_MB` (default 2048).
- Population runs in the background (`pg_dump --format=custom` → `pg_restore
  --clean --if-exists`, then the role bootstrap is re-applied); the branch shows
  `pending`, then `ready` or `failed` with a reason.
- Branches are free: they do not count against the plan's project limit, and
  are capped at `BRANCH_LIMIT_PER_PROJECT` (default 3) per parent. A plan can
  turn the feature off with the `project_branches` entitlement.
- Not copied: authentication users, storage objects, realtime bindings, flows.
  The branch starts with an empty realm and empty buckets.
- Deleting a branch moves it to the ordinary project trash (24 h, then purged).
  Deleting a parent moves its live branches to the trash with it; restoring the
  parent does **not** restore the branches — restore them one by one if needed.
- Merging a branch back into its parent is not offered. Apply the change you
  tried to the parent through the same migration path you would have used
  anyway.

Projects on a dedicated database container and document-store (NoSQL)
projects cannot be branched yet. Branches are identified everywhere in the
dashboard by a branch badge, and a parent's **Branches** page lists them.
