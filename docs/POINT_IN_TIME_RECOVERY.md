# Point-in-Time Recovery (PITR)

Restoring a nightly backup answers "what did the database look like last night?".
Point-in-time recovery answers the question you actually have during an incident:
**"what did it look like at 14:31, one minute before that DELETE?"**

basefyio keeps a continuous record of every change alongside periodic base
backups, so any instant inside the retention window can be reconstructed.

- **Recovery window:** 7 days
- **Granularity:** any second inside the window
- **Coverage:** relational (PostgreSQL) and document (MongoDB) projects
- **Recovery point objective:** at most 5 minutes of writes, even on an idle
  database (`archive_timeout` forces a segment out every 5 minutes)

---

## How it works

### PostgreSQL — base backups + WAL

PostgreSQL records every change in its **write-ahead log (WAL)** before applying
it. With `archive_mode=on`, each finished WAL segment is archived rather than
recycled.

1. A **base backup** of every active project is taken daily.
2. WAL segments are archived continuously and shipped to object storage every
   10 minutes.
3. Recovering to time *T* restores the newest base backup taken at or before *T*,
   then replays WAL forward until *T*.

Because recovery only rolls **forward** from a base backup, the earliest
recoverable instant is the oldest base backup still inside the window.

### MongoDB — dumps + oplog

MongoDB's **oplog** is the equivalent continuous record, and it only exists on a
replica set — which is why basefyio runs Mongo as a single-node replica set even
when no second node is needed.

1. A daily `mongodump` provides the base.
2. Oplog entries are captured periodically.
3. Recovering to time *T* restores the base and replays oplog entries with
   `--oplogLimit` set to *T*.

---

## Recovering from the dashboard

Open your project → **Backup & Export** → **Point-in-time recovery**.

The panel shows the live recovery window:

| Field | Meaning |
| --- | --- |
| Earliest | Oldest instant you can recover to |
| Latest | How current the archived change log is |
| Retention | Length of the window (7 days) |

Pick a timestamp and choose **Recover**. Because recovery replaces the current
contents of the database, the confirmation asks you to type `RESTORE`.

> **Anything written after the target instant is lost.** If you are unsure, take
> an export first (same page) — that snapshot is independent of PITR.

---

## Recovering over the API

Both endpoints require a dashboard session or an API token with `backups:write`
(`backups:read` is enough for the window).

### Read the recovery window

```http
GET /api/projects/{projectId}/pitr/window
```

```json
{
  "earliest": "2026-07-04T02:00:11.000Z",
  "latest": "2026-07-11T09:50:00.000Z",
  "baseBackupCount": 7,
  "walSegmentCount": 412,
  "retentionDays": 7
}
```

`earliest` is `null` until the first base backup completes — a project created
minutes ago has nothing to recover from yet.

### Recover to a timestamp

```http
POST /api/projects/{projectId}/pitr/restore
Content-Type: application/json

{ "targetTime": "2026-07-11T14:31:00.000Z" }
```

```json
{
  "restoredTo": "2026-07-11T14:31:00.000Z",
  "baseBackupTaken": "2026-07-11T02:00:09.000Z",
  "message": "Database restored to the requested point in time"
}
```

Rejected requests explain themselves: a timestamp in the future, one older than
`earliest`, or a project whose first base backup has not run yet.

---

## Operating notes

- WAL segments are archived to a local spool inside the database container and
  shipped to object storage every 10 minutes. The local copy is deleted only
  **after** the upload succeeds, so a failed upload retries rather than losing
  data.
- Base backups and archived segments older than the retention window are pruned
  automatically after the nightly backup run.
- Every recovery is written to the project activity log
  (`project.pitr_restored`) with the target timestamp and the base backup used.

## Related

- [API tokens and scopes](./API_TOKENS.md) — granting an agent `backups:read` /
  `backups:write`
