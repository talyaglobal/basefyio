# Claude Chrome Extension — UI Test Prompt

Copy everything below the line into the Claude Chrome extension. Keep this tab on the basefyio dashboard before starting.

---

You are a meticulous QA engineer performing a full manual UI regression test of **basefyio**, a backend-as-a-service platform (similar to Supabase). I am logged in as the **root/Owner user** in this browser tab — do NOT log out. Execute every test case below, in order, and report results.

## About the application

basefyio lets teams create **Projects**, each of which is a managed backend. There are two project types:

- **NoSQL projects** (MongoDB/Data Engine): data lives in schema-less **collections** of JSON documents. The query tool is the **Query** tab with two dialects: a **JS dialect** (`collection('name').find({}).limit(50)` — parsed, never evaluated) and a **MongoDB-style Aggregation mode** (JSON pipeline arrays with `$match`, `$group`, `$sort`, `$project`, `$unwind`, `$limit`, `$skip`). Aggregation mode may be hidden if the engine doesn't expose the `aggregationPipeline` capability — that is expected behavior, not a bug; record it.
- **Relational projects** (PostgreSQL): data lives in **tables** with typed columns, constraints, and foreign keys. The query tool is the **SQL Editor** tab (CodeMirror, autocomplete, run-with-limit).

Inside every project the sidebar has: Overview, Data, Query/SQL Editor (type-dependent), Storage (S3-style buckets/files), Auth (per-project Keycloak realm with users, signup/signin settings, providers, email), REST API (auto-generated endpoints per table/collection with copy-curl), Connection (connection strings, env presets for Next.js/Vite/Expo/Node, AI quick-connect prompt, password generator), Backup & Export (ZIP export with section checkboxes, cloud backups, restore to existing or as new project, Supabase/ZIP import), Integrations (GitHub, Vercel), Settings (name, description, folder, tags), and Logs (live activity feed with filters). Relational projects additionally have **AI / Embeddings** (pgvector toggle, OpenAI key, usage stats). The project sidebar has Auto/Open modes (toggle at bottom; Open mode is resizable by dragging its right edge). The Projects dashboard has grid/list views, search, sort, folders, tags, trash (24h retention), and a New Project dialog with a RELATIONAL/NOSQL type selector.

Data grids everywhere support: pagination (page size 50/100/250/500), text search, column sorting, column show/hide (persisted), inline cell edit, add/delete row or document, side detail panel, CSV/JSON export. Cells truncate at 120 chars; row counts above 10k display as approximate.

## Test environment

- Two test projects already exist under "All Projects": **"NoSQL DB Test App"** (slug `nosql_db_test_app`, NoSQL badge) and **"Relational DB Test App"** (slug `relational_db_test_app`, PostgreSQL badge). Test the NoSQL project first, then the relational one.
- You are Owner; everything is permitted. Still, follow the safety rules below.

## Execution rules

1. Execute cases **in the listed order** (later cases depend on data created earlier).
2. For each case record: **ID — ✅ PASS / ❌ FAIL / ⏭ SKIP** + one-line note. For every FAIL add: steps, expected, actual, any visible error message, and the page URL.
3. Watch for: console-style error toasts, infinite spinners, layout breaks, untranslated text, raw error dumps, anything rendering as `[object Object]`, `undefined`, or `NaN`.
4. **Safety rules:**
   - Never permanently delete the two main test projects. Trash/restore cycles are part of the tests — always restore.
   - In case R-4.10 (`DROP TABLE customers`): if the UI shows a confirmation/warning, CANCEL it and mark PASS. If it executes immediately without warning, mark FAIL (finding: no guard) — then recreate the table per §R-2.1 before continuing.
   - Delete every extra artifact you create (duplicated projects, restored-as-new projects, temp tables, extra buckets) right after its test case.
5. **Browser-only constraints:** you cannot use a terminal, psql, or DevTools offline mode. Where a case says "via curl/terminal": instead verify the copy-curl button copies a complete command (method, URL, headers, body) and mark the execution part ⏭ "needs terminal". Skip external-client and offline cases the same way.
6. If a page errors or hangs, reload once and retry; if it still fails, mark FAIL and move on.
7. If aggregation mode is unavailable (capability-gated), mark §N-6 cases ⏭ with note "aggregation capability not enabled", not FAIL.

---

# PART 1 — NoSQL DB Test App

## §N-1 Project entry & layout
- **N-1.1** Open "NoSQL DB Test App" from Projects. Workspace opens; header shows name + slug; badges Active + NoSQL.
- **N-1.2** Sidebar shows: Overview, Data, **Query** (not "SQL Editor"), Storage, Auth, REST API, Connection, Backup & Export, Integrations, Settings, Logs. No relational-only Embeddings item (or it's clearly gated).
- **N-1.3** Toggle sidebar Auto ↔ Open at the bottom. Auto: rail expands on hover. Open: persistent; drag right edge to resize. Reload → mode and width persist.
- **N-1.4** Click the anon API key copy button in the sidebar → confirmation toast appears.
- **N-1.5** Overview page loads with sane values for a new project (no stuck skeletons).

## §N-2 Collections
- **N-2.1** Open Data tab → empty state with a "Create collection" action.
- **N-2.2** Create collection `customers` → appears, count 0.
- **N-2.3** Try invalid names: empty, `my collection`, `türkçe-isim`, `1abc`, a 100+ char name → each rejected with clear validation; nothing created.
- **N-2.4** Create `customers` again → rejected with "already exists" style error.
- **N-2.5** Create `orders` → both listed; switching collections updates the grid.

## §N-3 Documents (CRUD)
- **N-3.1** In `customers`, insert: `{ "name": "Alice", "email": "alice@test.com", "age": 31, "active": true }` → appears in grid, count 1, system fields (`_id`, `_createdAt`) populated.
- **N-3.2** Insert: `{ "name": "Bob", "address": { "city": "Istanbul", "zip": "34000" }, "tags": ["vip", "beta"], "age": 45, "active": false }` → nested object and array render correctly.
- **N-3.3** In the insert dialog: paste minified JSON → Prettify formats it. Paste invalid JSON `{name: 'x'` → clear parse error, insert blocked.
- **N-3.4** Insert ~10 more varied docs (missing fields, nulls, unicode name `"Ülkü Çağrı"`, a string longer than 120 chars, ages spread 18–80, mixed `active`) → all save; long strings truncate without breaking layout.
- **N-3.5** Edit one doc: change `age`, add `score: 9.5` → grid updates; `_updatedAt` changes.
- **N-3.6** Open the side detail panel on Bob's doc → full JSON visible; edit and save from the panel works.
- **N-3.7** Delete one document → confirm dialog → removed, count decrements.
- **N-3.8** ⏭ allowed if impossible in one browser: concurrent two-tab edit of the same doc (note last-write-wins vs conflict error if you can do it with two tabs).

## §N-4 Grid features
- **N-4.1** Search `Alice` → only matches. Search `zzzznonsense` → empty state, not an error. Clear → all back.
- **N-4.2** Sort by `age` ASC then DESC → order correct including docs missing the field.
- **N-4.3** Hide 2 columns, reload page → still hidden; re-show.
- **N-4.4** Change page size 50 → 100 → control works (with ~12 docs, just confirm no errors and the selector persists).
- **N-4.5** Export collection as CSV → file downloads; spot-check unicode and nested fields.
- **N-4.6** Export as JSON → valid JSON array, nesting preserved.
- **N-4.7** Duplicate `orders` → copy appears. Delete the copy → confirm dialog → gone.

## §N-5 Query tab — JS dialect
- **N-5.1** Query tab opens in JS mode with default template `collection('my_collection').find({}).limit(50)`.
- **N-5.2** Run `collection('customers').find({}).limit(50)` → table results + row count + duration shown.
- **N-5.3** Run `collection('customers').find({ active: true })` → only active docs.
- **N-5.4** Run `collection('customers').find({}).sort('age').skip(1).limit(3)` → sort/skip/limit respected.
- **N-5.5** Run `collection('customers').fimd({})` and `collection(customers).find()` → readable parser errors, no crash.
- **N-5.6** Run `collection('does_not_exist').find({})` → clear error or empty result (record which).
- **N-5.7** Run `collection('customers').find({}); alert(1)` → rejected by parser; no alert ever fires.
- **N-5.8** Toggle Table ↔ JSON result views on the same result.
- **N-5.9** Export query results CSV and JSON (and XLSX if offered).

## §N-6 Query tab — Aggregation mode (skip-with-note if capability-gated)
- **N-6.1** Aggregation mode/tab visible.
- **N-6.2** It requires selecting a target entity/collection from a dropdown listing `customers`, `orders`.
- **N-6.3** Run `[{ "$match": {} }, { "$sort": { "_createdAt": -1 } }, { "$limit": 50 }]` on `customers` → docs returned.
- **N-6.4** Run `[{ "$group": { "_id": "$active", "count": { "$sum": 1 }, "avgAge": { "$avg": "$age" } } }]` → groups match grid data.
- **N-6.5** Run a pipeline with `$project` (subset of fields) then `$unwind` on `tags` → correct shape.
- **N-6.6** Run non-array `{ "$match": {} }` and unsupported `[{ "$merge": {} }]` → clear validation errors.

## §N-7 Query tabs & saved queries
- **N-7.1** Create 2 more query tabs, rename one; each keeps its own source/mode; delete one tab → others intact.
- **N-7.2** Save the N-5.3 query as `active-customers` → listed under JS mode.
- **N-7.3** Save the N-6.4 pipeline as `customers-by-status` → listed under Aggregation with its entity (skip if §N-6 skipped).
- **N-7.4** Reload the page, load both saved queries → correct dialect, source, and entity restored.
- **N-7.5** Delete one saved query → gone, stays gone after reload.

## §N-8 REST API tab
- **N-8.1** Page lists auto-generated endpoints for `customers` and `orders` with color-coded GET/POST/PATCH/DELETE badges.
- **N-8.2** Copy-curl for `GET /rest/v1/customers` → clipboard gets a complete command (URL, apikey/Authorization headers). Execution part ⏭ "needs terminal".
- **N-8.3–N-8.5** ⏭ "needs terminal" (POST/PATCH/DELETE round-trips, key enforcement) — but verify the documented request body examples and query params (`select`, `filter`, `order`, `limit`, `offset`) render correctly for both collections.

## §N-9 Auth tab
- **N-9.1** Shows realm name, Enabled status, user count 0.
- **N-9.2** Add user `testuser@test.com` with a password → listed as enabled.
- **N-9.3** ⏭ "needs terminal" for signin endpoint call — instead confirm the SDK auth endpoints (signup/signin) are displayed.
- **N-9.4** Toggle "Allow signup" and "Require email verification", save, reload → persisted. Restore original values.
- **N-9.5** Edit user (change password), disable user, then delete user → count back to 0; each step has appropriate confirmation.

## §N-10 Storage tab
- **N-10.1** Create bucket `test-bucket` → appears.
- **N-10.2** Upload a small file (create/select any small image or text file via the picker) → listed with size/date; download returns it.
- **N-10.3** Copy file URL / pre-signed URL → clipboard gets a URL; open it in a new tab → file served.
- **N-10.4** Rename the file, then delete it (confirm dialog).
- **N-10.5** Try deleting a non-empty bucket (re-upload first) → blocked or clearly warned; empty it, delete bucket → succeeds.

## §N-11 Connection tab
- **N-11.1** Shows a NoSQL connection string (`NOSQL_CONNSTR` — Mongo/CouchDB style), PROJECT_ID, API_URL, ANON_KEY, SERVICE_KEY — and NOT a PostgreSQL `DATABASE_URL` as primary. Copy buttons work.
- **N-11.2** Switch framework presets (Next.js / Vite / Expo / Node) → env block reformats per preset.
- **N-11.3** Toggle .env ↔ JSON raw format; copy-all works.
- **N-11.4** Generate the AI quick-connect prompt → contains the env block and NoSQL-appropriate guidance (no Postgres/Prisma-only assumptions).

## §N-12 Backup & Export tab
- **N-12.1** Start an export with all sections checked → progress runs to completed → ZIP downloads named like `project-…-{timestamp}.zip`.
- **N-12.2** Export with only Database checked → completes (note the smaller scope).
- **N-12.3** Cloud backups list shows the backup(s) with metadata. "Restore as new project" → new project appears containing `customers`/`orders` data → verify, then DELETE that restored project permanently.
- **N-12.4** Edit one document, then restore the earlier backup **to the existing project** → the edit is reverted; the overwrite confirm dialog warned clearly beforehand.
- **N-12.5** Start another export and cancel it mid-flight → job shows canceled, no stuck "running" job.

## §N-13 Logs tab
- **N-13.1** Activity feed contains entries for the session's actions (collection created, documents inserted, export jobs, auth changes) with actor + timestamp.
- **N-13.2** Keep Logs open, insert a doc in another browser tab of the same project → new entry prepends live without refresh (⏭ if a second tab isn't possible).
- **N-13.3** Text search, type filter, and date range each narrow the feed; pagination works.

## §N-14 Settings & lifecycle
- **N-14.1** Rename to `NoSQL DB Test App v2`, add a description, save → dashboard card updates. Rename back.
- **N-14.2** From the Projects page create a folder and a tag; assign both to this project via Settings → card shows them; the folder filter in the dashboard sidebar finds the project.
- **N-14.3** Pause the project → badge PAUSED (note what data access does while paused). Resume → Active.
- **N-14.4** Duplicate the project (with data) → copy contains collections + docs → then delete the copy permanently.
- **N-14.5** Move project to trash → Trash count becomes 1, card leaves All Projects. Restore → open it and run one query to confirm it's fully functional.
- **N-14.6** Project card size value is formatted sanely (KB/MB, not raw bytes or NaN).

## §N-15 Negative sweep
- **N-15.1** Navigate directly to the project's query URL (deep link) → loads the NoSQL Query experience, not a SQL editor.
- **N-15.2–N-15.3** ⏭ (session expiry & offline need DevTools/terminal).
- **N-15.4** Insert a very large document (e.g. one field with ~50k chars of text) → either saves and renders, or rejects with a clear size message.
- **N-15.5** Insert doc `{ "name": "<script>alert(1)</script><img src=x onerror=alert(2)>" }` → renders as plain text in grid, detail panel, and query results; NO alert ever fires. Then delete it.

---

# PART 2 — Relational DB Test App

## §R-1 Entry & layout
- **R-1.1** Open "Relational DB Test App" → slug `relational_db_test_app`; badges Active + PostgreSQL/RELATIONAL.
- **R-1.2** Sidebar shows **SQL Editor** (not "Query") and includes **AI / Embeddings**.
- **R-1.3** Overview loads cleanly.

## §R-2 Table designer (DDL)
- **R-2.1** Create table `customers` with columns: `id` uuid PK default `uuid_generate_v4()`, `name` text not null, `email` text unique, `age` integer nullable, `is_active` boolean default `true`, `created_at` timestamp default `now()` → table created, constraints visible.
- **R-2.2** In Add Column, picking timestamp suggests `now()`; picking uuid suggests `uuid_generate_v4()`.
- **R-2.3** Invalid column names (empty, `my col`, `select`, non-ASCII) → rejected clearly.
- **R-2.4** Add column `score numeric` → appears immediately.
- **R-2.5** Edit column: rename `score` → `rating`, toggle nullable, change default → persists.
- **R-2.6** With data present (do after R-3.1 if needed), change `age` integer → text and back → clean conversion or a clear surfaced PostgreSQL error; never silent failure.
- **R-2.7** Delete column `rating` → confirm warning → removed.
- **R-2.8** Create table `orders` (`id` serial PK, `customer_id` uuid, `total` numeric, `status` text). Create FK `orders.customer_id → customers.id` → FK visible from both tables.
- **R-2.9** Insert an order with a random non-existent `customer_id` → clean FK violation error.
- **R-2.10** Insert two customers with the same email → clean unique violation error on the second.
- **R-2.11** Insert a customer without `name` → clean not-null error.
- **R-2.12** Rename `orders` → `orders2` and back (FK survives); duplicate `customers` then verify and delete the duplicate.

## §R-3 Rows & grid
- **R-3.1** Add ~10 customers via Add Row (nulls in `age`, unicode names, >120-char text, varied emails) → defaults auto-populate (`id`, `created_at`, `is_active`).
- **R-3.2** Inline edit: text cell edits; boolean cell gives a toggle/select; integer cell rejects `abc`; timestamp rejects garbage.
- **R-3.3** Delete a row (confirm dialog). Then try deleting a customer that has an order → FK restriction error or cascade (record which).
- **R-3.4** Search, sort `age` ASC/DESC (note NULL placement), page-size switch, hide columns + reload persistence.
- **R-3.5** Export CSV and JSON → unicode intact, NULLs consistent.
- **R-3.6** Import a small CSV into `customers` (create the CSV content via the import dialog if it accepts paste; otherwise ⏭ "needs local file" — but try a file upload with a 3-row CSV if you can produce one). A bad row (text in `age`) should produce a clear per-row error or rejection summary.
- **R-3.7** Run the Duplicate Cleaner after creating two rows identical except id → behavior matches its description.
- **R-3.8** Row count and table size readouts look correct.

## §R-4 SQL Editor
- **R-4.1** CodeMirror editor with highlighting; autocomplete suggests keywords and table names.
- **R-4.2** `SELECT * FROM customers ORDER BY created_at DESC;` → grid + duration + row count.
- **R-4.3** A JOIN across `customers`/`orders` → correct combined rows.
- **R-4.4** `SELECT is_active, count(*), avg(age) FROM customers GROUP BY is_active;` → matches grid data.
- **R-4.5** INSERT, UPDATE, DELETE one row via SQL → affected-rows feedback; Data grid reflects it.
- **R-4.6** `CREATE TABLE tmp_test (id serial primary key, note text);` then `DROP TABLE tmp_test;` → both succeed; table list updates.
- **R-4.7** `SELEC * FORM x` and a query on a missing table → readable PostgreSQL errors; editor content preserved.
- **R-4.8** "Run with limit" on `SELECT * FROM customers` → LIMIT applied automatically.
- **R-4.9** `SELECT * FROM generate_series(1, 20000);` → paginates, total shows as approximate/capped (e.g. "10,000+"), no freeze.
- **R-4.10** Type `DROP TABLE customers;` and run. **If a warning/confirmation appears: CANCEL and mark PASS.** If it drops with no guard: mark FAIL, recreate `customers` per R-2.1 and re-add a few rows before continuing.
- **R-4.11** Multiple SQL tabs hold independent content; save a query, reload, load it; delete it.
- **R-4.12** Export a SELECT result to CSV/JSON.
- **R-4.13** `INSERT INTO customers (name) VALUES ('Robert''); DROP TABLE orders;--');` → inserts as a plain text value; `orders` still exists.

## §R-5 REST API tab
- **R-5.1** Endpoints listed for `customers`/`orders` with filter params documented; body examples exclude the PK that has a default.
- **R-5.2–R-5.4** ⏭ "needs terminal" for live curl execution; verify copy-curl completeness and parameter docs instead.

## §R-6 AI / Embeddings
- **R-6.1** Enable pgvector → status Enabled with timestamp. Disable → Disabled. Re-enable and leave enabled.
- **R-6.2** Enter dummy key `sk-test-dummy`, save → shown masked. Test connection → fails gracefully with a clear error (no crash). Clear key.
- **R-6.3** Usage stats show 0 embeddings without errors.

## §R-7 Connection tab
- **R-7.1** Shows `DATABASE_URL` (pooled) AND `DIRECT_URL` (direct) — no NoSQL connstr. Copy works.
- **R-7.2** ⏭ "needs external client".
- **R-7.3** Presets reformat env; AI quick-connect prompt includes Postgres/Prisma guidance this time.
- **R-7.4** Password generator produces a 12+ char password with upper/lower/digit/symbol.

## §R-8 Backup & Export
- **R-8.1** Full export → ZIP downloads.
- **R-8.2** Restore as new project → tables, FK, and rows intact in the copy → then delete the copy permanently.
- **R-8.3** Edit a row, restore over the existing project → edit reverted; overwrite warning was clear.
- **R-8.4** ⏭ Supabase import (no test account) unless credentials are provided.

## §R-9 Shared-feature smoke (already deep-tested on NoSQL)
- **R-9.1** Storage: create bucket, upload + download one file, delete both.
- **R-9.2** Auth: create one user, then delete it.
- **R-9.3** Logs: today's DDL/DML/export actions appear; live update works.
- **R-9.4** Settings: rename round-trip; assign folder + tag; trash → restore; duplicate → delete copy.
- **R-9.5** Integrations: GitHub/Vercel sections load with correct not-connected status (full OAuth optional — ⏭ if it would link real accounts).

## §X-10 Cross-project & dashboard
- **X-10.1** Projects page: NoSQL badge on one card, PostgreSQL on the other; same in list view.
- **X-10.2** Dashboard search finds each by name; folder/tag filters work; sort by DB size orders them plausibly.
- **X-10.3** Switch between the two projects several times → each always loads its own editor type (Query vs SQL Editor); saved queries and grid state never bleed across projects.
- **X-10.4** Select both project checkboxes → bulk actions (if present) behave; deselect works.

---

## Final report format

Return one consolidated report:

1. **Summary line:** `PART 1: x✅ / y❌ / z⏭ — PART 2: x✅ / y❌ / z⏭`
2. **Failures:** for each ❌ — case ID, steps, expected, actual, exact error text, URL.
3. **Skips:** case ID + reason (one line each).
4. **Observations:** anything broken-feeling that no case covered (slow pages, layout glitches, inconsistent wording, mixed languages in UI text).
5. **Cleanup confirmation:** state explicitly that all duplicated/restored projects and temp artifacts were deleted, and both test projects are back to Active with their data intact.
