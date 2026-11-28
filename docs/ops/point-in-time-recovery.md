> **Status of the hosted platform (28 November 2026):** basefyio moved to new infrastructure and the per-project
> exact-second restore described below is paused there (the dashboard refuses new restores with a 503,
> `PITR_RESTORE_ENABLED=false`). Nightly backups of active projects continue, and the whole database cluster keeps its own
> continuous archive. This page describes the design that self-hosted (Docker Compose) installations run.

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

Pick a timestamp (seconds included) and choose **Recover**. After you confirm, the dialog
follows the restore step by step and shows the outcome or the reason it failed; you can close
it and the panel keeps showing the status, also after a reload. A time outside the window is
flagged in the panel before anything is sent. Because recovery replaces the current
contents of the database, the confirmation names the time zone and asks you to type
`RESTORE`. Base backups are taken nightly for the whole cluster, so a new project can recover
once the first nightly run has finished; they cannot be started per project.

> **Anything written after the target instant is lost.** If you are unsure, take
> an export first (same page) — that snapshot is independent of PITR.

---

## Recovering over the API

All endpoints take a dashboard session or an API token: `backups:write` to start a
restore, `backups:read` for the window and job status.

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

A restore copies and replays a lot of data, so it runs as a background job. The request
validates the timestamp and answers at once with `202 Accepted`:

```http
POST /api/projects/{projectId}/pitr/restore
Content-Type: application/json

{ "targetTime": "2026-07-11T14:31:00.000Z" }
```

```json
{
  "jobId": "5b0c…",
  "projectId": "…",
  "status": "queued",
  "phase": "waiting",
  "message": "Waiting for a free restore slot",
  "targetTime": "2026-07-11T14:31:00.000Z",
  "method": null,
  "exact": null,
  "restoredTo": null,
  "queuePosition": 1,
  "createdAt": "…",
  "startedAt": null,
  "finishedAt": null
}
```

Rejected requests explain themselves: a timestamp in the future, one older than
`earliest`, a document (NoSQL) project, or a project whose first base backup has not run
yet (`400`); a restore already queued or running for the project (`409`, the active job
id in `details.jobId`); more than three restores for the project in the last hour (`429`);
a full queue or restores paused by the operator (`503`).

### Follow a restore

```http
GET /api/projects/{projectId}/pitr/restore/{jobId}
GET /api/projects/{projectId}/pitr/status          # the newest job, or { "job": null }
```

`status` moves `queued` → `running` → `succeeded` or `failed`. While running, `phase` is
`preparing`, `downloading`, `replaying`, `extracting` or `restoring`, and `message` says
what is happening. On success `restoredTo` is the instant reached and `exact` is `true`
for a WAL replay (`method: "wal-replay"`) or `false` when only the nearest nightly snapshot
was available (`method: "snapshot"`, and `message` says so). On failure `message` says why
and whether the database was changed. Poll every few seconds; a restore usually takes
several minutes.

### Safety limits

- **One restore at a time platform-wide** (`PITR_RESTORE_MAX_CONCURRENT`, default 1), at
  most 5 waiting (`PITR_RESTORE_MAX_QUEUED`), one active per project, 3 per project per hour
  (`PITR_RESTORE_MAX_PER_HOUR`). The checks run under one Postgres advisory lock, so they
  hold with several API replicas.
- **Isolated replay.** WAL is replayed in a throwaway Postgres container with no network,
  its own data directory on the scratch volume, a 1 GB memory cap, one CPU and a high OOM
  score (`PITR_RECOVERY_MEMORY_MB`, `PITR_RECOVERY_CPU_MILLIS`). The shared database server is
  never stopped, restarted or reconfigured; only the project's own database is written, with
  the project's own login.
- **All-or-nothing write.** The recovered dump is loaded with `pg_restore --single-transaction`,
  so a failure rolls back and leaves the database as it was. A dump with more than
  `PITR_ATOMIC_MAX_OBJECTS` (4000) objects is loaded object by object instead (one lock per
  object in a single transaction would strain the lock table every database shares); that
  load is never interrupted half way.
- **Hard deadline.** A job is stopped after `PITR_RESTORE_TIMEOUT_MINUTES` (60); WAL replay
  alone gets `PITR_RECOVERY_WAIT_MINUTES` (15). The throwaway container and scratch directory
  are removed on every failure.
- **Dead runs.** A running job refreshes a heartbeat every 30 s. If its API process dies
  (deploy, crash), the job is failed after 3 minutes and its leftovers are cleaned up; a job
  still queued after `PITR_RESTORE_QUEUE_MAX_MINUTES` (120) is cancelled.
- **Disk.** A restore refuses to start when the scratch volume cannot hold a copy of the
  cluster plus a reserve (10 % of the volume, at least 20 GB).
- **Kill switch.** `PITR_RESTORE_ENABLED=false` refuses new restores with a clear `503`;
  running ones finish.

---

## Operating notes

- WAL segments are archived to a local spool inside the database container and
  shipped to object storage every 10 minutes. The local copy is deleted only
  **after** the upload succeeds, so a failed upload retries rather than losing
  data.
- Base backups and archived segments older than the retention window are pruned
  automatically after the nightly backup run.
- Every recovery is written to the project activity log
  (`project.pitr_restored`) with the target timestamp and the base backup used; a failed one
  as `project.pitr_failed` with the reason. Failures the platform team should look at also
  raise the console alert `pitr_restore_failed`.
- Jobs are rows in `pitr_restore_jobs`; the operator detail of a failure is in its `error`
  column, which the API never returns.

## Related

- [API tokens and scopes](../reference/api-tokens.md) — granting an agent `backups:read` /
  `backups:write`
