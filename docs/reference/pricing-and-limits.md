# Pricing and limits

What a project gets, what it costs, and what happens at a limit. Two short answers first.

- **Is disk billed by the MB, or by package?** By package. A plan is charged at its flat
  monthly price. Database size and file storage are not metered into the invoice: they are
  covered by the plan, up to the plan's limits.
- **Is it unlimited?** No, except on the **Legacy** plan (accounts that existed before the
  current plans; not offered to new customers), which has no caps. Free, Pro and Business each
  have a limit for database size and for file storage. **Enterprise** limits are agreed per
  organization (see below).

The plan catalogue is live data: `GET /api/billing/plans` (public) and the Billing page show
the values in force. The table below lists the figures of the hosted service as of
2026-11-23; if it differs from the Billing page, the Billing page is right. A self-hosted
installation starts from different defaults and its operator can change them.

## Limits per plan

| | Free | Pro | Business | Legacy |
|---|---|---|---|---|
| Price per month | $0 | $20 | $100 | $0 (grandfathered) |
| Projects | 2 | 10 | 100 | Unlimited |
| Database size | 1 GB | 30 GB | 300 GB | Unlimited |
| File storage | 1 GB | 30 GB | 300 GB | Unlimited |
| Team members | 2 | 10 | 100 | Unlimited |
| Egress per month | 1 GB | 50 GB | 500 GB | Unlimited |
| API requests per month | 50,000 | 1,000,000 | 10,000,000 | Unlimited |
| Monthly active users | 50,000 | 100,000 | Unlimited | Unlimited |
| Compute | Shared | Shared today (see below) | Shared today (see below) | Shared |
| Embeddings on the platform's key | — | 1,000,000 tokens per project per day | 1,000,000 tokens per project per day | 1,000,000 tokens per project per day |

**Embeddings.** Computing embeddings with the platform's key (pgvector embeddings, and Data
Engine vectors the platform computes from your records' text) is included from the Pro plan,
Legacy teams included, up to 1,000,000 tokens per project per UTC day; Enterprise gets the same.
With the project's own embedding provider key it is available on every plan, without a limit.
See [embeddings-api.md](./embeddings-api.md#plans-and-the-daily-limit).

**Enterprise** is not bought in the dashboard: it is arranged with our team
(support@talyasmart.com) and set up for the organization. Its limits are the ones agreed for the
workload; a limit left empty means no cap. It is not listed in `GET /api/billing/plans`, and the
Billing page does not offer a self-serve change to or from it.

**Limits are per organization**, not per project: the database limit is compared with the sum
of the sizes of all the organization's projects, and the file storage limit with all of their
files. The project Overview shows both numbers.

## What a project gets

- **Region and location.** EU (Germany), Nuremberg. It is the only region today; data stays
  in the EU.
- **Compute.** Every project runs on the platform's shared PostgreSQL server, together with
  other projects. It gets a share of the server's CPU and memory; no CPU or RAM is reserved
  for it, so there is no per-project RAM figure to quote. Dedicated sizes (Micro to XL, with a
  stated vCPU and RAM) are part of the Pro and Business plans' design but are **not available
  yet**: the New project dialog lists them as disabled. When they open, the Overview shows the
  size, vCPU and RAM of the container.
- **Connection.** The host and port on the project's Overview and Connect pages. The host is a
  DNS name of the connection pooler (PgBouncer, port `6432` unless the operator changed it),
  not a fixed IP address: use the name, because the address behind it can change.
- **Database and file storage against the limit.** The Overview card shows this project's size,
  the organization's total, and the plan's limit. The word *Unlimited* appears only for a plan
  that has no cap.

## How storage is billed

A plan is charged once per billing period at its flat monthly price. Database and file storage
do not add to it. Billing also shows a **Project costs** table, a running **estimate** of what
each project's usage would cost at standard rates (compute by the hour, storage per GB-month,
egress per GB); it is information, not an invoice, and nothing in it is charged on top of the
plan. The current standard rates are public at `GET /api/billing/rates` and on the pricing
page. On Free, the plan costs $0, so none of it is charged.

## What happens at a limit

| Resource | At the limit |
|---|---|
| Projects | Creating another project is refused until you delete or deactivate one, or upgrade. |
| Team members | Inviting another member is refused. |
| File storage | An upload that would take the organization over its limit is refused (HTTP `402`, `Quota Exceeded`) until you delete files or upgrade. |
| Database size | A move to a plan whose limit your databases exceed is blocked until you delete data. Growth past the limit follows the rollout mode below. |
| API requests, egress, monthly active users, database size | Follow the rollout mode of each limit, below. |

### API requests, egress, monthly active users and database size

Each of these four limits has a rollout mode, set by the operator for the whole platform and
shown on the Billing page next to each figure:

- **warn** (the default today): nothing is refused. Usage is counted and shown against the
  limit; the platform logs which organizations would be refused.
- **enforce**: the owners of the organization are mailed once a month at **80%** and at
  **100%** of the limit, and Billing shows a notice. Past the limit plus a **10% grace**:

  | Limit | What is refused | Answer |
  |---|---|---|
  | API requests per month | Every request that names a project, until the counter resets on the 1st (UTC) or you upgrade | `429`, `Retry-After` until the 1st |
  | Egress per month | The same | `429`, `Retry-After` until the 1st |
  | Monthly active users | **New sign-ups** of your projects' end users (email/password sign-up, anonymous sign-in). Existing users keep signing in and refreshing their sessions. | `402` |
  | Database size | Writes that add data through the API: inserts and updates over `/rest/v1` and collections, the table editor, imports, and SQL scripts with `INSERT`, `UPDATE`, `MERGE`, `CREATE`, `ALTER` or `COPY`. Reading, `DELETE`, `TRUNCATE`, `DROP` and `VACUUM` keep working, so you can always free space. | `402` |

  A refusal is JSON with `code: "plan_limit_exceeded"`, the `resource`, the `current` and
  `limit` figures, a `message` and an `upgradeUrl`. Upgrading lifts it within a minute.
- **off**: the limit is not evaluated.

Never refused, in any mode: health checks, the Billing and payment routes (you can always pay
and upgrade), the dashboard itself (only its writes that add data fall under the database-size limit), and the project sign-in and session-refresh routes.
Legacy plans, Enterprise limits left empty, and a monthly figure that still belongs to the
previous month are never enforced.

What the database-size limit cannot stop: connections straight to PostgreSQL through the
connection pooler (`db.basefyio.com:6432`) do not pass through the API, so writes made that
way are not refused; they still count toward the size, which is measured every hour. Database
functions called over `/rest/v1/rpc` and a `SELECT` that calls a function which writes are not
refused either. First sign-ins through an external identity provider (OAuth) are not counted as
sign-ups for the MAU limit.

## How often usage is measured

| Figure | Measured |
|---|---|
| Database size | From PostgreSQL's own size of the database, every hour for every project. The Overview also re-measures when the stored value is older than one hour. |
| File storage | Every six hours, and right after an import. Uploads are checked against the last measured total, so a limit can be passed by a little before the next measurement. |
| API requests and egress | Every request that names a project (its API key or `x-project-id`) through the API, on every path the SDKs use (`/rest/v1`, `/auth/v1`, `/storage/v1`, `/realtime/v1`); egress is the response bytes only (uploads and other request bodies are not counted). Counted continuously, written to the database every few hours; reset on the first of each month (UTC). |
| Monthly active users | Distinct end users of the organization's projects who signed in, refreshed a session or called the API with their user token during the calendar month (UTC); anonymous sign-ins count too. Updated every hour; reset on the first of each month. |

## Over the API

`GET /api/projects/:id/resources` (dashboard session only) returns what the Overview card
shows: `region`, `compute` (`mode`: `shared` or `dedicated`, with `vcpu` and `memoryGb` for a
dedicated container), `plan`, `uncapped`, and `database` and `storage`, each with
`projectBytes`, `organizationBytes`, `limitBytes` (`null` = no cap) and `measuredAt`.
