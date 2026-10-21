# CLI (`basefyio` / `bf`)

The command-line tool for working with basefyio projects from a terminal: sign in, create or
link a project, push and pull schema, run SQL and migrations, generate types, and take or
restore backups. Published on npm as `basefyio-cli` (MIT); source in `packages/cli`. This page
describes version 2.1.0. `backup` and `restore` are new in 2.1.0; every other command exists in
2.0.x as well.

There is **no `start` command**: the CLI talks to a running platform, it does not run one. To
run the platform itself, see the Quick Start in the [repository README](../../README.md).

## Install

```bash
npm install -g basefyio-cli
basefyio --version
basefyio --help          # bf is the same program under a shorter name
```

Needs Node.js 18 or newer. `basefyio upgrade` (alias `update`) reinstalls the latest published
version with `npm install -g basefyio-cli@latest`.

**Update notices and automatic updates.** Once a day, after a command has finished, the CLI asks
the npm registry for the latest version and prints a notice when a newer one exists. When a newer
version is already known, the next command first installs it and then re-runs itself on it.
Both are skipped for `login`, `logout` and `upgrade`, in CI (`CI` set), when output is not a
terminal, and when `NODE_ENV=test`. Turn the automatic install off with `BASEFYIO_AUTO_UPDATE=0`
(or `BASEFYIO_NO_AUTO_UPDATE=1`) and the notice with `BASEFYIO_NO_UPDATE_NOTIFIER=1`. A version
that failed to install (for example a system-wide Node that needs `sudo`) is not retried
automatically.

## Sign in

```bash
basefyio login                                    # hosted service, https://api.basefyio.com
basefyio login --api-url https://api.example.com  # your own installation
```

`login` signs you in through the browser; there is no password prompt in the terminal.

1. The CLI starts a one-shot HTTP listener on `127.0.0.1` on a port the operating system picks,
   and generates a random nonce.
2. It calls `POST /api/auth/cli-login-state` with the port and nonce. The API stores the
   request and answers with a URL on the dashboard (`<APP_URL>/cli-authorize?cli_state=…`).
   If that route is missing (an older API), the CLI falls back to
   `GET /api/auth/cli-login`, which redirects to the same page.
3. The browser opens that page. You sign in to the dashboard if you are not already, and click
   **Allow access**. The dashboard calls `POST /api/auth/cli-authorize`; the API wraps your
   session in a one-time code, and the dashboard sends the browser on to
   `http://127.0.0.1:<port>/callback?code=…`.
4. The CLI receives the code and exchanges it, together with its nonce, at
   `POST /api/auth/cli/exchange` for an access token and a refresh token. Any failure there
   answers 404, so a stolen code cannot be probed.

The URL is also printed, so you can paste it into a browser by hand. The listener only answers
`GET /callback`, checks the `Host` header and gives up after **5 minutes**. `--api-url` is saved
and used by every later command; run `basefyio login --api-url …` again to switch.

**Headless machines.** `login` refuses to run when standard output is not a terminal, when `CI`
is set, or inside an SSH session (`SSH_TTY`), and exits with 1 (“Browser login requires an
interactive terminal”). There is no token-based sign-in for CI yet. For automation that needs a
project's data, use the project's service key against the HTTP API directly, or an account
[API token](../API_TOKENS.md) on the routes that accept one.

**Staying signed in.** Before every command except `login` and `logout`, the CLI refreshes the
access token when it expires within 60 seconds (`POST /api/auth/refresh`). A request that still
gets `401` triggers one refresh and a retry. Only when the API rejects the refresh token itself
(a 4xx answer) are the saved tokens cleared; the CLI then starts the browser sign-in again and
asks you to re-run the command. A network failure during refresh never signs you out.

`basefyio logout` deletes the saved tokens and profile.

## Where configuration lives

| What | Where | Written by |
|---|---|---|
| Account: API URL, access and refresh token, e-mail | `config.json` in the OS config directory for `basefyio-nodejs` — `~/.config/basefyio-nodejs/` on Linux, `~/Library/Preferences/basefyio-nodejs/` on macOS, `%APPDATA%\basefyio-nodejs\Config\` on Windows | `login`, `logout` |
| Update check cache | `update-cache.json` in the same directory | the update notifier |
| Linked project: `projectId`, `projectName`, `projectSlug`, `teamId`, `linkedAt` | `.basefyio/config.json` in the directory where you ran `init` or `link` | `init`, `link`; removed by `unlink` |
| Project credentials | `.env` next to `.basefyio/` | `init`, `link`; edited by `secrets` |

Commands that need a project look for `.basefyio/` in the current directory and then in each
parent directory, so they work from any subdirectory of a linked project. They read `.env` from
the directory that holds `.basefyio/`.

`init` and `link` write these variables into `.env`. Keys that already exist are updated in
place; other lines are kept; new keys are appended under a comment. `.env` is also added to
`.gitignore` if it is not listed there.

| Variable | Value |
|---|---|
| `BASEFYIO_PROJECT_ID`, `BASEFYIO_PROJECT_SLUG` | the project |
| `BASEFYIO_ANON_KEY`, `BASEFYIO_SERVICE_KEY` | the project keys — the service key bypasses row-level security; never ship it to a browser |
| `BASEFYIO_API_URL` | the API URL you signed in to |
| `BASEFYIO_DB_HOST`, `BASEFYIO_DB_PORT`, `BASEFYIO_DB_NAME`, `BASEFYIO_DB_USER`, `BASEFYIO_DB_PASSWORD` | the project database owner |
| `DATABASE_URL`, `BASEFYIO_DATABASE_URL` | the pooled connection string (PgBouncer) |
| `DIRECT_URL` | the direct connection string |
| `BASEFYIO_KEYCLOAK_REALM` | the project's identity realm |

## Exit codes and `--json`

A command that finishes exits with `0`. A command that cannot continue — not signed in, no
linked project, a refused API call, a failed SQL statement or migration, a bad option value —
prints the reason and exits with `1`. A few commands report a problem and still exit `0`:
`secrets list|set|unset` and `unlink` when the file operation fails, `logs` when it cannot reach
the database, `db seed` when no seed file exists and `db diff` when Prisma cannot produce a diff.
`backup create` and `backup download` print a warning when the downloaded size differs from the
size the server reported; check the archive in that case, because the exit code is still `0`.

`--json` exists on `backup create`, `backup list`, `backup status` and `restore`. It prints the
API's result as JSON instead of tables and spinners. The shape is **best effort and may change
between versions**; do not build long-lived tooling on it without pinning the CLI version.

## Command reference

Every command below needs `basefyio login` first, except `secrets`, `unlink`, `inspect`,
`gen types`, `gen client`, `db pull`, `db reset`, `db dump`, `db diff` and `migration new`, which
only read local files or connect to Postgres with the credentials in `.env`.

### Account

| Command | Does |
|---|---|
| `basefyio login [--api-url <url>]` | browser sign-in, described above; `--api-url` defaults to `https://api.basefyio.com` |
| `basefyio logout` | forget the saved tokens and profile |
| `basefyio upgrade` (alias `update`) | `npm install -g basefyio-cli@latest`; on a permissions error it prints the command to re-run with `sudo` (or from an administrator terminal on Windows) |

### Projects

```
basefyio init [-n, --name <name>]
basefyio link [--project-id <id>]
basefyio unlink
basefyio status [--show-keys]
basefyio projects                    (alias: list)
basefyio projects:create [-n, --name <name>] [-d, --description <description>]
basefyio projects:delete <projectId>
```

| Command | Does | Uses |
|---|---|---|
| `init` | Asks for the team (when you belong to more than one), a name (default: the directory name, or `--name`) and a description; creates the project, links the current directory and writes `.env`. Refuses if the directory is already linked. | `GET /api/teams`, `POST /api/projects`, `GET /api/projects/:id/connect` |
| `link` | Links the current directory to an existing project — the one named by `--project-id`, or one you pick from every project in every team you belong to — and writes `.env`. | `GET /api/teams`, `GET /api/projects`, `GET /api/projects/:id`, `GET /api/projects/:id/connect` |
| `unlink` | Deletes `.basefyio/` in the current directory. `.env` is left as it is. | — |
| `status` | Shows the linked project's id, slug, status, database host, port, name, user and password, realm, anon key and service key. Secrets are masked unless `--show-keys` is given. | `GET /api/projects/:id` |
| `projects` | Lists the projects of your **first** team (name, slug, status, created, id). Use `link` to see every team. | `GET /api/teams`, `GET /api/projects` |
| `projects:create` | Creates a project in your first team without linking it; prompts for a name when `--name` is missing. | `POST /api/projects` |
| `projects:delete <projectId>` | Asks for confirmation and for the project name typed exactly, then deletes the project. Only the team owner or the project's creator may. Deletion is reversible: the database is renamed and the realm disabled, and the project can be restored from the dashboard's deleted-projects list. | `GET /api/projects/:id`, `DELETE /api/projects/:id` |

### Database

```
basefyio db push
basefyio push                         (same as db push)
basefyio db pull
basefyio db reset [-f, --force]
basefyio db seed
basefyio db dump [-o, --output <file>]     default: schema.sql
basefyio db diff
basefyio db execute [-f, --file <path>] [-q, --query <sql>]
```

Two different paths reach the database, and it matters which one a command uses:

- **Through the API** — `POST /api/sql/execute` with your dashboard session. The statement runs
  as the project's owner database user, the API's SQL guard applies (see
  [sql-api.md](./sql-api.md)) and every statement is written to the audit log.
- **Directly** — a Postgres connection with `DATABASE_URL` from `.env` (the PgBouncer URL `init`
  and `link` wrote), owner credentials, no SQL guard.

| Command | Does | Path |
|---|---|---|
| `db push` | Finds the first of `prisma/schema.prisma`, `db/schema.sql`, `schema.sql`. A Prisma schema is applied with `npx prisma db push` (with `DATABASE_URL` from `.env`); a SQL file is sent as one request. | Prisma: direct · SQL: API |
| `db pull` | With `prisma/schema.prisma` present, runs `npx prisma db pull`. Otherwise writes `db/schema.sql` with a `CREATE TABLE IF NOT EXISTS` per table in `public` (columns, nullability and defaults only — no keys, indexes or constraints). | direct |
| `db reset` | **Drops every table in the `public` schema** (`DROP TABLE … CASCADE`). Asks first unless `--force`. Data is gone; take a backup before. | direct |
| `db seed` | Runs the first seed file found: `prisma/seed.ts` or `prisma/seed.js` through `npx prisma db seed`, or `db/seed.sql` / `seeds/seed.sql` through the API. | Prisma: direct · SQL: API |
| `db dump` | Writes a `CREATE TABLE IF NOT EXISTS` script for the base tables in `public` (column types, lengths, nullability, defaults) to `--output`, default `schema.sql`. It is a schema sketch, not a restorable dump — use `backup create` for that. | direct |
| `db diff` | Runs `npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-url <DATABASE_URL>` and prints Prisma's output. Needs Prisma in the project. | direct |
| `db execute` | Runs `--file` or `--query` (one of them is required) and prints the returned rows as a table, or the affected row count. | API |

The CLI sends SQL text as it is, without bound parameters. The SQL guard reads string literals
too, so a statement is refused when its text names a forbidden operation even inside a quoted
value.

### Inspect

```
basefyio inspect [-t, --table <name>]
```

Without `--table`: every base table in `public` with its estimated row count
(`pg_class.reltuples`, shown as `—` until Postgres has analysed the table) and total size,
largest first. With `--table`: its columns, indexes, foreign keys and size. Connects directly with
`DATABASE_URL`.

### Code generation

```
basefyio gen types [-o, --output <dir>]                 default: ./types
basefyio gen client [-l, --lang <language>] [-o, --output <dir>]
                    language: typescript (default) | javascript | python; dir default: ./lib
```

- `gen types` reads the tables and columns of the `public` schema over a direct connection and
  writes `<dir>/database.ts`: one interface per table plus a `Database` interface mapping table
  names to them. Columns that are nullable or have a default are optional.
- `gen client` writes a small standalone client — `basefyio.ts`, `basefyio.js` or
  `basefyio.py` — with the project id filled in. It is a starting point only: it sends the key as
  `Authorization: Bearer`, posts to `<url>/sql/execute` without the `/api` prefix and builds
  `WHERE` clauses by putting values into the SQL text. The current API expects the key in the
  `apikey` header, so the generated file does not authenticate as written. For an application,
  use [`basefyio-js`](./js-sdk.md) or the Python client in `packages/sdk-python`.

### Migrations

```
basefyio migration new <name>                 (alias: migrate)
basefyio migration up [-s, --step <n>] [--dry-run]
basefyio migration down [-s, --step <n>] [--dry-run]     default: 1
basefyio migration status                     (alias: migration list)
```

Migrations are plain SQL files in `./migrations`, named `<UTC timestamp>_<name>.sql` and applied
in file-name order. A file has an up part and an optional down part:

```sql
-- up
create table posts (id bigint generated always as identity primary key, title text not null);

-- down
drop table posts;
```

A file without the `-- up` / `-- down` markers is applied whole and cannot be rolled back.

| Command | Does |
|---|---|
| `migration new <name>` | Creates `migrations/<timestamp>_<name>.sql` from the template above; the name is lower-cased and every character other than `a-z0-9` becomes `_`. |
| `migration up` | Creates the tracking table `_bf_migrations (id, name, applied_at)` in the project database if needed, then applies every local file not recorded there, at most `--step` of them. Stops at the first failure and exits 1. `--dry-run` lists what would run. |
| `migration down` | Runs the down part of the newest applied migrations, `--step` of them (default 1), and removes them from the tracking table. A file without a down part is skipped. |
| `migration status` | Lists every local file as applied or pending. |

All migration SQL goes through the API (`POST /api/sql/execute`) as the owner, so the SQL guard
applies. A migration's SQL and its tracking-table row are two separate requests, not one
transaction: if the second fails, re-running `up` applies the file again — write migrations that
tolerate that (`if not exists`).

### Logs

```
basefyio logs [-n, --tail <lines>]          default: 50
```

Reads the SQL audit log for the linked project. It does this by connecting **directly to the
platform's own database** with built-in local-development credentials, so it only works on a
development machine where that database is reachable that way. Against the hosted service or a
production installation it prints “Could not fetch logs”.

### Secrets

```
basefyio secrets list
basefyio secrets set <key> <value>
basefyio secrets unset <key>
```

These edit the linked project's local `.env` file only — nothing is sent to the platform. `list`
masks the values of keys containing `PASSWORD`, `SECRET`, `KEY` or `TOKEN`.

### Backups

```
basefyio backup create [-o, --out <file>] [--no-wait]
                       [--skip-database] [--skip-auth] [--skip-storage] [--skip-config]
                       [-p, --project <id>] [--timeout <minutes>] [--json]
basefyio backup list   [-p, --project <id>] [--kind auto|manual|all] [--json]
basefyio backup status <jobId> [-p, --project <id>] [--json]
basefyio backup download <jobId> [-o, --out <file>] [-p, --project <id>]
basefyio restore <target> [-p, --project <id>] [--new-project <name>] [--team <id>] [-y, --yes] [--json]
```

The project is `--project`, else the linked project, else `BASEFYIO_PROJECT_ID` from `.env`.

A backup is the same `.zip` archive the dashboard's export produces: the database dump, the
project's auth users, its storage objects and its configuration (each can be left out with a
`--skip-*` flag).

| Command | Does | Uses |
|---|---|---|
| `backup create` | Starts an export job, polls it every 2 seconds with its progress, then downloads the archive to `--out` or `<slug>-backup-<UTC yyyymmdd-hhmmss>.zip`. A generated name never overwrites an existing file; an explicit `--out` may. The download is written to `<file>.part` and renamed when complete. `--timeout` (minutes, default 60) bounds the wait. `--no-wait` prints the job id and returns. | `POST /api/projects/:id/export`, `GET /api/projects/:id/export/jobs/:jobId/status`, `GET /api/projects/:id/export/jobs/:jobId/download` |
| `backup status <jobId>` | The job's state, progress, and archive name and size once completed. | `GET /api/projects/:id/export/jobs/:jobId/status` |
| `backup download <jobId>` | Downloads a completed job's archive. The server keeps it for **24 hours**. | `GET /api/projects/:id/export/jobs/:jobId/download` |
| `backup list` | The project's cloud backups, newest first, numbered `#1`, `#2`, …: the daily automatic backups (kept 7 days) and manual exports (kept 24 hours). `--kind` filters. | `GET /api/projects/:id/backups` |
| `restore <target>` | Restores a backup into the project, or into a new project with `--new-project <name>` (in `--team`, default the project's team). | local archive: `POST /api/projects/import-export-zip` · cloud backup: `POST /api/projects/:id/backups/restore` |

`<target>` is either a path to an existing local `.zip` file, or a cloud backup named by its
object key, its filename (when only one backup has it), its row number from `backup list`
(`#2`), or `latest`, `latest:auto`, `latest:manual`. A local archive is uploaded; a cloud backup
is restored on the server without leaving it. The server holds an uploaded archive in memory
while restoring it, so the CLI warns above 1 GB and suggests restoring a cloud backup instead.

Before anything changes, `restore` prints the plan and asks for confirmation: restoring into the
current project requires typing the project name; restoring into a new project asks yes/no.
`--yes` skips the question and is **required** when the CLI is not running in a terminal.

**What a restore does.** Tables present in the archive are dropped and recreated with the
archived data; tables that are not in the archive are left untouched. Auth users in the archive
are recreated with temporary passwords, so they must reset their passwords. Storage buckets and
objects in the archive are written to the project. The server applies the database dump
statement by statement and does not stop at the first failing one, so a partly applied dump is
not reported as a failure — check the result with `basefyio inspect` and read the warnings the
command prints.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Browser login requires an interactive terminal` | `login` was run in CI, over SSH or with output piped. Sign in on a desktop terminal. |
| The browser says “Authorization successful” but the terminal keeps waiting | Something blocks the loopback request to `127.0.0.1` (firewall, browser policy). Press Ctrl+C and run `basefyio login` again. |
| `Session expired … Run: basefyio login` | The refresh token was rejected (expired, revoked, or the account was signed out everywhere). Sign in again. |
| `Network error: Could not connect to basefyio API` | The API URL saved by `login --api-url` is wrong or unreachable. |
| `Not linked to a project` / `Not in a basefyio project` | Run the command inside a directory that holds `.basefyio/`, or run `basefyio link` (or pass `--project` to `backup` and `restore`). |
| `DATABASE_URL not found in .env` | Run `basefyio link` to rewrite the credentials. |
| An `db execute` / `migration up` statement is refused | The API's SQL guard refused it; see the list of refused operations in [sql-api.md](./sql-api.md). |
| `Refusing to restore without --yes in a non-interactive session` | Add `--yes` in scripts. |

Source: `packages/cli/src/index.ts`, `packages/cli/src/commands/*.ts`,
`packages/cli/src/lib/{api,config,browser-login,backups,update-check}.ts`;
`apps/platform-api/src/modules/auth/auth.controller.ts` (CLI sign-in routes).
