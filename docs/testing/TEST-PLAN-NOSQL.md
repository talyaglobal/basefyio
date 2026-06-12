# UI Test Plan — NoSQL DB Test App (`nosql_db_test_app`)

Manual end-to-end test plan for the NoSQL (MongoDB/Data Engine) project type.
Mark each case: ✅ Pass / ❌ Fail / ⏭ Skipped. Note bugs inline under the case.

> **Pre-conditions:** Logged in as Owner of `batuhansaygin's Team`, project "NoSQL DB Test App" exists and is Active. Browser console open (F12) to catch silent errors during all tests.

---

## 1. Project Entry & Layout

- [ ] **N-1.1 Open project** — From Projects grid, click "NoSQL DB Test App" card. Project workspace opens; header shows project name + slug `nosql_db_test_app`; status badge shows **Active**, type badge shows **NoSQL**.
- [ ] **N-1.2 Sidebar tabs (NoSQL set)** — Sidebar shows: Overview, Data, **Query** (NOT "SQL Editor"), Storage, Auth, REST API, Connection, Backup & Export, Integrations, Settings, Logs. Confirm no relational-only items (pgvector/Embeddings) appear, or they are correctly gated/disabled.
- [ ] **N-1.3 Sidebar Auto/Open modes** — Toggle Auto ↔ Open at the bottom. Auto: rail collapses, expands on hover. Open: persistent, drag right edge to resize (min 200px, max 440px). Reload page → mode and width persist.
- [ ] **N-1.4 Anon key quick-copy** — Click the anon API key copy button in the sidebar. Toast/confirmation appears; pasted value is a valid key.
- [ ] **N-1.5 Overview page** — Overview shows project summary (size, counts, recent activity) without errors and with sane values for a new project.

## 2. Data Tab — Collections

- [ ] **N-2.1 Empty state** — Open **Data**. New project shows an empty/onboarding state with a "Create collection" action (no crash, no skeleton stuck loading).
- [ ] **N-2.2 Create collection (valid)** — Create collection `customers`. Appears in collection list; document count = 0.
- [ ] **N-2.3 Create collection (invalid names)** — Try: empty name, `my collection` (space), `türkçe-isim` (dash/non-ASCII), `1abc`, very long name. Each is rejected with a clear validation message; nothing is created.
- [ ] **N-2.4 Create duplicate collection** — Try creating `customers` again. Rejected with a clear "already exists" error.
- [ ] **N-2.5 Create second collection** — Create `orders`. Both collections listed; switching between them updates the grid.

## 3. Data Tab — Documents (CRUD)

- [ ] **N-3.1 Insert document (simple)** — In `customers`, Insert document: `{ "name": "Alice", "email": "alice@test.com", "age": 31, "active": true }`. Document appears in grid; count = 1; system fields (`_createdAt`, `_id`, etc.) populated.
- [ ] **N-3.2 Insert document (nested + array)** — Insert: `{ "name": "Bob", "address": { "city": "Istanbul", "zip": "34000" }, "tags": ["vip", "beta"], "age": 45, "active": false }`. Nested object and array render correctly in the grid (JSON-formatted cell or expandable).
- [ ] **N-3.3 JSON editor helpers** — In the insert dialog: paste unformatted JSON → Prettify works; paste invalid JSON (`{name: 'x'`) → clear parse error, Insert blocked.
- [ ] **N-3.4 Insert ~10 more docs** — Add ~10 varied documents (different fields, missing fields, nulls, unicode `"name": "Ülkü Çağrı"`, long strings >120 chars). All save; grid renders truncation at 120 chars without layout break.
- [ ] **N-3.5 Edit document** — Open a document, change `age` and add a new field `score: 9.5`. Save → grid reflects changes; `_updatedAt` changes; `_version` increments (if shown).
- [ ] **N-3.6 Record detail panel** — Open the side detail panel for the nested doc (Bob). Full JSON visible and editable; save from panel works.
- [ ] **N-3.7 Delete document** — Delete one document. Confirm dialog appears; after confirm, doc disappears and count decrements.
- [ ] **N-3.8 Concurrent edit sanity** — Open same doc in two browser tabs, edit in both, save second one last. No silent data corruption; expect either last-write-wins or a version conflict error (note which).

## 4. Data Tab — Grid Features

- [ ] **N-4.1 Search** — Search `Alice` → only matching docs shown. Search nonsense string → empty result state (not an error). Clear search → all docs back.
- [ ] **N-4.2 Sort** — Click `age` column header: ASC, click again: DESC. Order correct including docs missing the field.
- [ ] **N-4.3 Column visibility** — Hide 2 columns, reload page → hidden state persists (localStorage). Re-show them.
- [ ] **N-4.4 Pagination** — Set page size 50; (optional bulk: insert >50 docs via REST API or repeat insert) → pager appears, next/prev work, page size switch 50→100 works.
- [ ] **N-4.5 Export CSV** — Export current collection as CSV. File downloads; nested objects/arrays serialized sensibly; Turkish/unicode chars intact (UTF-8).
- [ ] **N-4.6 Export JSON** — Export as JSON. Valid JSON array, nested structures preserved.
- [ ] **N-4.7 Collection ops** — Duplicate `orders` → copy appears with docs (if it had any). Delete the duplicate → confirm dialog, removed from list.

## 5. Query Tab — JS Dialect

- [ ] **N-5.1 Tab label & default** — Sidebar tab reads **Query** (not SQL Editor). Opens with JS mode selected and default template `collection('my_collection').find({}).limit(50)`.
- [ ] **N-5.2 Basic find** — Run `collection('customers').find({}).limit(50)`. Results show in table view; row count and duration metadata displayed.
- [ ] **N-5.3 Filtered find** — Run `collection('customers').find({ active: true })`. Only active docs returned.
- [ ] **N-5.4 Chained query** — Run `collection('customers').find({}).sort('age').skip(1).limit(3)`. Result respects sort/skip/limit.
- [ ] **N-5.5 Syntax error handling** — Run `collection('customers').fimd({})` and `collection(customers).find()`. Parser rejects with a readable error pointing at the problem; no request sent / no crash.
- [ ] **N-5.6 Unknown collection** — Run `collection('does_not_exist').find({})`. Clear error or empty result (note behavior), no crash.
- [ ] **N-5.7 Injection attempt** — Run a query containing JS like `collection('customers').find({}); alert(1)` or `require('fs')`. Must be rejected by the closed-grammar parser (never evaluated).
- [ ] **N-5.8 Result views** — Toggle Table ↔ JSON view on the same result. JSON view shows raw documents; table view paginates.
- [ ] **N-5.9 Export results** — Export query results as CSV and JSON (and XLSX if offered). Files valid.

## 6. Query Tab — Aggregation Mode

- [ ] **N-6.1 Mode availability** — Aggregation mode/tab is visible (requires `capabilities.aggregationPipeline`). If hidden, check `/v1/projects/{id}/data-query/capabilities` response and note `engineAvailable` + `queryModes` — **if engine is CouchDB without aggregation, this section is expected-gated; record that.**
- [ ] **N-6.2 Entity selector** — Switching to Aggregation mode requires picking a target entity/collection from a dropdown listing `customers`, `orders`.
- [ ] **N-6.3 Default template runs** — Default pipeline `[{ "$match": ... }, { "$sort": { "_createdAt": -1 } }, { "$limit": 50 }]` adjusted to `{ "$match": {} }` runs against `customers` and returns docs.
- [ ] **N-6.4 $group pipeline** — Run `[{ "$group": { "_id": "$active", "count": { "$sum": 1 }, "avgAge": { "$avg": "$age" } } }]`. Grouped result correct vs. grid data.
- [ ] **N-6.5 $project + $unwind** — Run a pipeline with `$project` (subset of fields) and `$unwind` on `tags`. Output shape correct.
- [ ] **N-6.6 Invalid pipeline** — Run non-array JSON `{ "$match": {} }` and an unsupported operator `[{ "$merge": {} }]`. Clear validation errors, no crash.

## 7. Query Tab — Tabs & Saved Queries

- [ ] **N-7.1 Multi-tab** — Create a 2nd and 3rd query tab; rename one; each tab keeps its own source and mode. Delete a tab → remaining tabs intact.
- [ ] **N-7.2 Save query (JS)** — Save the filtered find as `active-customers`. Appears in saved list grouped under JS mode.
- [ ] **N-7.3 Save query (aggregation)** — Save the $group pipeline as `customers-by-status`. Appears grouped under Aggregation, with its entity remembered.
- [ ] **N-7.4 Load saved query** — Reload the page, load both saved queries. Each restores the correct dialect, source, and (for aggregation) target entity.
- [ ] **N-7.5 Delete saved query** — Delete one saved query; it disappears and survives a reload.

## 8. REST API Tab

- [ ] **N-8.1 Endpoint listing** — REST API page lists auto-generated endpoints for `customers` and `orders` with method badges (GET/POST/PATCH/DELETE).
- [ ] **N-8.2 Curl copy** — Copy the curl for `GET /rest/v1/customers`; run it in a terminal with the anon key. Returns the documents inserted in §3.
- [ ] **N-8.3 POST via API** — POST a new document via curl/REST. It appears in the Data grid after refresh.
- [ ] **N-8.4 Auth enforcement** — Call the endpoint with no key / wrong key → 401/403. With anon vs service key → permissions behave as documented.
- [ ] **N-8.5 PATCH + DELETE via API** — Update then delete the doc created in N-8.3; grid reflects both.

## 9. Auth Tab

- [ ] **N-9.1 Realm status** — Auth page shows realm name, Enabled status, user count 0.
- [ ] **N-9.2 Create user** — Add user `testuser@test.com` with password. Appears in list as enabled.
- [ ] **N-9.3 Signup/signin endpoints** — Using the documented `POST /rest/v1/auth/signin` with that user → token returned. Wrong password → clean 401.
- [ ] **N-9.4 Settings toggles** — Toggle "Allow signup" and "Require email verification"; save; reload → values persisted.
- [ ] **N-9.5 Edit/disable/delete user** — Change password, disable user (signin then fails), delete user (count back to 0).

## 10. Storage Tab

- [ ] **N-10.1 Create bucket** — Create bucket `test-bucket`. Appears in tree.
- [ ] **N-10.2 Upload/download** — Upload a small image + a file with unicode filename. Both listed with correct size/date; download returns identical files.
- [ ] **N-10.3 URL copy** — Copy file URL / pre-signed URL; opens in incognito (public) or within expiry (pre-signed).
- [ ] **N-10.4 Rename/move/delete file** — Each operation works with confirm dialogs where destructive.
- [ ] **N-10.5 Delete bucket** — Deleting non-empty bucket is blocked or clearly warned; after emptying, delete succeeds.

## 11. Connection Tab

- [ ] **N-11.1 NoSQL connection string** — Page shows `NOSQL_CONNSTR` (MongoDB/CouchDB) — NOT a PostgreSQL `DATABASE_URL` as the primary — plus PROJECT_ID, API_URL, ANON_KEY, SERVICE_KEY. Copy buttons work.
- [ ] **N-11.2 Framework presets** — Switch presets (Next.js / Vite / Expo / Node). Env block reformats correctly for each.
- [ ] **N-11.3 Raw editor formats** — Toggle .env ↔ JSON format; copy-all works.
- [ ] **N-11.4 AI Quick Connect** — Generate AI context prompt; it contains the env block and NoSQL-appropriate instructions (no Prisma/Postgres-only assumptions).

## 12. Backup & Export Tab

- [ ] **N-12.1 Export ZIP** — Start export with all sections checked (DB, Auth, Storage, Config). Progress runs to completion; ZIP downloads as `project-{name}-{timestamp}.zip` and contains the collections' data.
- [ ] **N-12.2 Section toggles** — Export with only Database checked → ZIP excludes auth/storage.
- [ ] **N-12.3 Cloud backup list & restore as new** — Backup listed with metadata. "Restore as new project" → new project created containing `customers`/`orders` data. (Delete the restored project afterwards.)
- [ ] **N-12.4 Restore overwrite** — Modify a doc, then restore the earlier backup **to existing project** → modification reverted. Confirm dialog clearly warns about overwrite.
- [ ] **N-12.5 Cancel export** — Start an export and cancel mid-flight → job ends as canceled, no stuck "running" job.

## 13. Logs Tab

- [ ] **N-13.1 Activity recorded** — Logs show entries for the actions performed above (collection created, documents inserted, export job, auth changes) with actor + timestamp.
- [ ] **N-13.2 Live update** — Keep Logs open in one tab, insert a doc in another → new activity prepends without refresh.
- [ ] **N-13.3 Filters** — Text search, type filter, and date range each narrow the feed correctly; pagination works at 50/page.

## 14. Settings Tab & Project Lifecycle

- [ ] **N-14.1 Rename + description** — Change name to `NoSQL DB Test App v2` and add a description; save; dashboard card reflects it. Rename back.
- [ ] **N-14.2 Folder & tags** — Create a folder + a tag from Projects page; assign both to this project via Settings; project card shows folder/tag; sidebar folder filter finds it.
- [ ] **N-14.3 Pause/Resume** — Pause project → status badge PAUSED; data/API access behaves as defined for paused (note behavior). Resume → Active again.
- [ ] **N-14.4 Duplicate project** — Duplicate (with data) → copy contains collections + docs. Delete the copy.
- [ ] **N-14.5 Trash & restore** — Move project to trash → appears under Trash (count badge 1), card gone from All Projects. Restore within window → fully functional again (open it, run a query).
- [ ] **N-14.6 Size display** — Project size on the card updates (eventually) after the data inserted; value formatted sanely (KB/MB).

## 15. Negative / Edge Sweeps

- [ ] **N-15.1 Direct URL access** — Hit a deep link (e.g. `/dashboard/projects/{id}/sql`) directly after fresh login; loads correct NoSQL "Query" experience, not relational SQL editor.
- [ ] **N-15.2 Stale session** — Let session expire (or clear token), then perform an action → **must silently re-login, never show a "session expired" error** (per product rule).
- [ ] **N-15.3 Network failure** — DevTools → Offline, then run a query / save a doc → graceful error toast, recovers when back online.
- [ ] **N-15.4 Large document** — Insert a doc near the size limit (e.g. a few hundred KB of JSON). Either saves and renders, or rejects with a clear limit message.
- [ ] **N-15.5 XSS probe** — Insert doc with `"name": "<script>alert(1)</script><img src=x onerror=alert(2)>"`. Renders as text everywhere (grid, detail panel, query results, logs) — no script execution.

---

**Result summary:** ___ / ___ passed · Bugs filed: ___
