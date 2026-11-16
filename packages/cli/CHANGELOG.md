# Changelog

All notable changes to `basefyio-cli` are documented here.

## 2.2.0

### Fixed — migrations past 100 (upgrade before running `migration up`)

**If a project has more than 100 migrations, upgrade to 2.2.0 before running
`basefyio migration up`.** Earlier versions read only the first 100 rows of the migration
tracking table, so `status` under-counted and `up` could re-run a migration that was already
applied.

- **Applied set is now read in full.** The SQL endpoint pages every `SELECT` (100 rows by
  default); the CLI now pages through the whole `_bf_migrations` table instead of reading a
  single capped page. `migration status` counts and `migration up` pending lists are exact at
  any size, and an already-applied migration is never re-run. If the server reports more rows
  than were read, the command aborts rather than proceeding with a short list.
- **A failed read no longer looks like "nothing applied."** A network error, 5xx or auth
  failure while reading the applied set now aborts `status`, `up` and `down` with a non-zero
  exit and the server's message — instead of silently treating the project as empty and trying
  to apply every migration from the first.
- **Apply-and-record is now atomic.** `migration up` sends the migration SQL and its tracking
  `INSERT` in one request, run in a single transaction; `migration down` does the same with the
  rollback SQL and the tracking `DELETE`. A migration can no longer be applied but left
  unrecorded (which previously caused it to run again on the next `up`).
- **Clearer failures.** On error the CLI now prints the server's status code and message, not
  just `Request failed with status code 400`.
