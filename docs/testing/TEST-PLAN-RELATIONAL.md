# UI Test Plan — Relational DB Test App (`relational_db_test_app`)

Manual end-to-end test plan for the PostgreSQL (relational) project type.
Mark each case: ✅ Pass / ❌ Fail / ⏭ Skipped. Note bugs inline under the case.

> **Pre-conditions:** Logged in as Owner, project "Relational DB Test App" exists and is Active. Run AFTER the NoSQL plan — shared features already validated there (Storage, Auth flows, Logs filters, Settings lifecycle) get a lighter smoke pass here; the focus is relational-only functionality.

---

## 1. Project Entry & Layout

- [ ] **R-1.1 Open project** — Open "Relational DB Test App". Header shows slug `relational_db_test_app`; badges: **Active** + **PostgreSQL/RELATIONAL**.
- [ ] **R-1.2 Sidebar tabs (relational set)** — Sidebar shows **SQL Editor** (NOT "Query") plus Overview, Data, Storage, Auth, REST API, Connection, Backup & Export, Integrations, **AI / Embeddings**, Settings, Logs.
- [ ] **R-1.3 Overview** — Loads with sane empty-project values.

## 2. Data Tab — Table Designer (DDL)

- [ ] **R-2.1 Create table** — Create table `customers` with initial columns: `id uuid` (PK, default `uuid_generate_v4()`), `name text not null`, `email text unique`, `age integer nullable`, `is_active boolean default true`, `created_at timestamp default now()`. Table appears with all constraints visible.
- [ ] **R-2.2 Type defaults suggestions** — In Add Column dialog, picking `timestamp` suggests `now()`, picking `uuid` suggests `uuid_generate_v4()`.
- [ ] **R-2.3 Invalid column names** — Try empty, `my col`, `select` (reserved word), non-ASCII. Rejected with clear validation.
- [ ] **R-2.4 Add column to existing table** — Add `score numeric` to `customers`. Appears in grid immediately.
- [ ] **R-2.5 Edit column** — Rename `score` → `rating`; toggle nullable; change default. Changes persist (verify via SQL editor `\d`-equivalent or information_schema query).
- [ ] **R-2.6 Risky type change** — With data present, change `age` integer → text and back. Either converts cleanly or fails with a clear PostgreSQL error surfaced in the UI (no silent failure).
- [ ] **R-2.7 Delete column** — Delete `rating` with data in it. Confirm dialog warns; column and its data removed.
- [ ] **R-2.8 Second table + foreign key** — Create `orders` (`id serial PK`, `customer_id uuid`, `total numeric`, `status text`). Create FK `orders.customer_id → customers.id`. FK shows in both tables' relation views.
- [ ] **R-2.9 FK violation** — Insert an order with a non-existent `customer_id` → clean FK violation error in UI.
- [ ] **R-2.10 Unique violation** — Insert two customers with the same `email` → clean unique constraint error.
- [ ] **R-2.11 NOT NULL violation** — Insert customer without `name` → clean not-null error.
- [ ] **R-2.12 Rename / duplicate / delete table** — Rename `orders` → `orders2` and back; Duplicate `customers` (schema + data) → verify copy; Delete the duplicate with confirm dialog. FK survives the rename round-trip.

## 3. Data Tab — Rows (CRUD + Grid)

- [ ] **R-3.1 Add rows** — Add ~10 customers via the Add Row form (varied: nulls in `age`, unicode names, long text >120 chars, `email` edge cases). Defaults (`id`, `created_at`, `is_active`) auto-populate.
- [ ] **R-3.2 Inline edit** — Click a cell, edit `name`, save. Type-aware editing: boolean cell gives toggle/select, timestamp accepts valid format only, integer rejects `abc`.
- [ ] **R-3.3 Delete row** — Delete a row → confirm dialog → removed. Delete a `customers` row referenced by an `orders` row → FK restriction error or cascade per schema (note behavior).
- [ ] **R-3.4 Search / sort / pagination / column visibility** — Same checks as NoSQL plan (search text, sort `age` ASC/DESC with NULLs, page size 50→100, hide columns + persist after reload).
- [ ] **R-3.5 Export CSV/JSON** — Both export correctly, unicode intact, NULLs represented consistently.
- [ ] **R-3.6 Import data** — Import a small CSV into `customers` (matching columns) → rows appear; import a CSV with a bad row (e.g. text in `age`) → clear per-row error or rejection summary.
- [ ] **R-3.7 Duplicate cleaner** — Insert 2 exact duplicate rows (in a PK-less or prepared scenario, or duplicate all-but-id), run Duplicate Cleaner → duplicates detected/removed as designed.
- [ ] **R-3.8 Row count & size** — Table row count and size shown match reality (10+ rows).

## 4. SQL Editor

- [ ] **R-4.1 Tab label & editor** — Sidebar shows **SQL Editor**; CodeMirror loads with syntax highlighting and autocomplete (type `SEL` → suggestion; table names suggested after `FROM`).
- [ ] **R-4.2 SELECT** — Run `SELECT * FROM customers ORDER BY created_at DESC;`. Result grid shows rows + duration + row count.
- [ ] **R-4.3 JOIN** — Run a JOIN across `customers`/`orders`. Correct combined result.
- [ ] **R-4.4 Aggregate** — `SELECT is_active, count(*), avg(age) FROM customers GROUP BY is_active;` → correct vs. grid data.
- [ ] **R-4.5 DML** — `INSERT`, `UPDATE`, `DELETE` one row via SQL → affected-row feedback; Data grid reflects changes after refresh.
- [ ] **R-4.6 DDL via SQL** — `CREATE TABLE tmp_test (id serial primary key, note text); DROP TABLE tmp_test;` → both succeed; table list updates.
- [ ] **R-4.7 Error surfacing** — Run invalid SQL (`SELEC * FORM x`) and a query on a missing table → PostgreSQL error message shown readably, editor state preserved.
- [ ] **R-4.8 Run with limit** — Use "Run with limit" on `SELECT * FROM customers` → LIMIT 50 applied automatically.
- [ ] **R-4.9 Large result handling** — (Optional) `SELECT * FROM generate_series(1, 20000);` → pagination works; total shows approximate/capped at 10k ("10,000+"), no browser freeze.
- [ ] **R-4.10 Dangerous statement guard** — Run `DROP TABLE customers` (DON'T confirm if warned). Note whether UI warns/asks confirmation or executes directly. If it executed: restore from backup and file as a finding.
- [ ] **R-4.11 Multi-tab + saved queries** — Multiple SQL tabs hold independent content; save a query, reload, load it back; delete saved query.
- [ ] **R-4.12 Result export** — Export a SELECT result to CSV/JSON (and XLSX if offered).
- [ ] **R-4.13 SQL injection-ish input as data** — `INSERT INTO customers (name) VALUES ('Robert''); DROP TABLE orders;--');` → inserts as plain text, `orders` still exists.

## 5. REST API Tab

- [ ] **R-5.1 Endpoints per table** — Lists endpoints for `customers` and `orders` incl. filter params (`select`, `filter`, `order`, `limit`, `offset`). Request body example excludes PK-with-default.
- [ ] **R-5.2 Full CRUD via curl** — GET list (with `order=age.desc&limit=3`), GET single by id, POST, PATCH (`?id=eq.{id}`), DELETE — each verified against the Data grid.
- [ ] **R-5.3 Filtered GET** — `GET /rest/v1/customers?age=gt.30` (or UI-documented filter syntax) returns the right subset.
- [ ] **R-5.4 Key enforcement** — No key → 401/403; anon vs service key behave per spec.

## 6. AI / Embeddings (relational-only)

- [ ] **R-6.1 pgvector toggle** — Enable pgvector → status flips to Enabled with timestamp; disable works too (re-enable after).
- [ ] **R-6.2 API key field** — Enter a dummy OpenAI key → saved masked; Test connection fails gracefully with dummy key (clear error, no crash); Clear key works.
- [ ] **R-6.3 Usage stats** — Embedding count = 0 and storage shown without errors on a fresh project.

## 7. Connection Tab

- [ ] **R-7.1 PostgreSQL strings** — Shows `DATABASE_URL` (pooled) AND `DIRECT_URL` (direct, for migrations) — no NoSQL connstr. Copy works.
- [ ] **R-7.2 External client connect** — (Optional but valuable) Connect with psql/DBeaver using `DIRECT_URL` → `SELECT count(*) FROM customers` matches UI.
- [ ] **R-7.3 Presets + AI prompt** — Framework presets reformat env; AI Quick Connect prompt includes Prisma/Postgres instructions this time.
- [ ] **R-7.4 Password generator** — Generates 12+ char password meeting complexity rules.

## 8. Backup & Export

- [ ] **R-8.1 Full export ZIP** — Export all sections → ZIP contains SQL schema + data for `customers`/`orders`.
- [ ] **R-8.2 Restore as new project** — Restore backup as new project → tables, FK, and rows intact (verify FK exists in the copy). Delete the copy.
- [ ] **R-8.3 Restore overwrite** — Modify a row, restore over existing → reverted, with clear warning beforehand.
- [ ] **R-8.4 Supabase import (if test account available)** — Validate connection → select sections → import → result summary lists tables/rows/warnings; imported data browsable. Otherwise ⏭ with reason.

## 9. Shared-Feature Smoke (already deep-tested on NoSQL)

- [ ] **R-9.1 Storage** — Create bucket, upload + download one file, delete.
- [ ] **R-9.2 Auth** — Create one user, signin via endpoint, delete user.
- [ ] **R-9.3 Logs** — DDL changes (table/column created), imports, and export jobs from above all appear in the activity feed; live update works.
- [ ] **R-9.4 Settings lifecycle** — Rename round-trip; assign folder + tag; trash → restore; duplicate → delete copy.
- [ ] **R-9.5 Integrations** — GitHub/Vercel connect screens load; status badges correct (full OAuth flow optional — note if skipped).

## 10. Cross-Project & Dashboard Checks (both projects exist now)

- [ ] **X-10.1 Type badges** — Projects page shows NoSQL badge on one card, PostgreSQL on the other; list view shows the same.
- [ ] **X-10.2 Search & filters** — Dashboard search by name finds each; folder/tag filters from earlier still work; sort by size reflects which project holds more data.
- [ ] **X-10.3 Cross-navigation** — Switch between the two projects repeatedly via Projects page → each loads its own correct editor (Query vs SQL Editor), no state bleed (saved queries, grids, tabs stay per-project).
- [ ] **X-10.4 Multi-select** — Select both project checkboxes on dashboard → bulk actions (if any) behave; deselect works.
- [ ] **X-10.5 Stale session & offline** — Repeat the silent re-login and offline checks once in this project (per product rule: never show "session expired").

---

**Result summary:** ___ / ___ passed · Bugs filed: ___
