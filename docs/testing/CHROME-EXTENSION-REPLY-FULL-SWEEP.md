# Reply to the Chrome extension agent — paste everything below the line

---

Go with option 1: create the test projects yourself. A dedicated team has been created for you: **`basefyio for TESTING`**. Inside that team EVERYTHING is allowed — create, update, trash, restore, and permanently delete projects, run every destructive case, no restrictions. Outside that team, touch nothing. I'm also expanding your scope: after the project suites, sweep the ENTIRE admin UI — no page, tab, dialog, or control left unvisited. This is a **production environment with real customer data in the other teams**, so the safety rules at the bottom are absolute.

# PART 0 — Setup (do this first; these are test cases too)

- **S-0.1** Switch the active team to **`basefyio for TESTING`** (it currently has 0 projects, 1 member). ALL test artifacts — projects, folders, tags, buckets, users, invites — must be created inside this team only. Verify the Overview stats show 0 projects before you start.
- **S-0.2** Open the New Project dialog → it offers a database type selector (RELATIONAL / NOSQL), name, description. Create **"NoSQL DB Test App"** with type NOSQL. Verify it appears with a NoSQL badge, status Active.
- **S-0.3** Create **"Relational DB Test App"** with type RELATIONAL → PostgreSQL badge, Active.
- **S-0.4** Try creating a project with an empty name and a 200-char name → clear validation, nothing created.
- **S-0.5** Note provisioning time for each project (creation → usable). Flag anything over ~60s or any stuck "provisioning" state.

Then run **PART 1** (NoSQL suite) and **PART 2** (Relational suite) from the original instructions, unchanged, against these two projects.

# PART 3 — Full admin UI sweep (after Parts 1–2)

Visit everything. For each area record case results with the same ✅/❌/⏭ format.

## §P-1 Global chrome
- **P-1.1** Header: logo → home, Dashboard / Projects / Feedback / Docs nav links all work (Docs may open external — verify it loads).
- **P-1.2** Team switcher: switch to another team briefly → project list and counts update per team — VIEW ONLY, click nothing inside other teams; switch straight back to `basefyio for TESTING`.
- **P-1.3** Notifications bell: opens, lists notifications or a clean empty state; mark-as-read works if present.
- **P-1.4** Dark mode toggle: flips theme app-wide; persists after reload; check 3–4 different pages in dark mode for unreadable/broken styling.
- **P-1.5** User avatar menu: all entries navigate correctly. Do NOT click Logout.
- **P-1.6** Version footer (e.g. v2.3.0) and sidebar Auto/Open toggle on the dashboard sidebar.

## §P-2 Dashboard / Overview
- **P-2.1** Overview page renders stats consistent with reality (project counts, sizes, activity). No NaN/undefined/empty widgets.
- **P-2.2** Any quick actions/links on Overview navigate correctly.

## §P-3 Projects dashboard (beyond what Parts 1–2 covered)
- **P-3.1** Grid ↔ list view toggle; choice persists after reload.
- **P-3.2** All sort options (newest, oldest, name A-Z/Z-A, size) reorder correctly.
- **P-3.3** Folders: create, rename, recolor, move a TEST project in/out, delete an empty folder — all inside `basefyio for TESTING` only.
- **P-3.4** Tags: create, rename, recolor, assign/unassign on a TEST project, delete.
- **P-3.5** Trash page: shows trashed test project during the N-14.5 cycle; restore works; counts correct.
- **P-3.6** Search: partial matches, case-insensitivity, no-result empty state.
- **P-3.7** Drag & drop: drag a TEST project card onto a folder; onto trash (then restore). Only test projects.
- **P-3.8** Multi-select checkboxes + any bulk actions — on the two test projects only.
- **P-3.9** Refresh button refetches; "+ New Project" dialog cancel leaves no residue.

## §P-4 Team pages (inside `basefyio for TESTING` ONLY)
- **P-4.1** Members list renders (email, role, joined date, avatar).
- **P-4.2** Invite flow: invite `qa-invite-test@example.com` as MEMBER → appears in pending invites → then CANCEL the invite. Verify resend/cancel controls.
- **P-4.3** Role dropdown shows OWNER/ADMIN/MEMBER options (don't change anyone's real role; if you created a test member, exercise role change on them only).
- **P-4.4** Team settings: rename team and rename back; avatar/slug fields behave.

## §P-5 Billing (READ-ONLY — no changes whatsoever)
- **P-5.1** Current plan, price, and limits render.
- **P-5.2** Usage bars (projects, storage, API requests, members) show plausible values, no overflow/NaN.
- **P-5.3** Invoices list renders; if a download link exists, verify one downloads.
- **P-5.4** Upgrade/downgrade and payment-method dialogs: OPEN them, verify they render, then CANCEL. Never submit.

## §P-6 Account profile
- **P-6.1** Profile info renders (name, email, avatar).
- **P-6.2** Edit first/last name → save → revert to original.
- **P-6.3** Notification preference toggles: flip one, save, reload (persisted), flip back.
- **P-6.4** Linked sign-in providers display correctly. Do NOT connect/disconnect anything. Do NOT change the password.

## §P-7 Feedback
- **P-7.1** Submit a feedback titled exactly `QA TEST — ignore` with category selected → appears in previous-feedback list with status.
- **P-7.2** Screenshot-upload control accepts a file (if present).

## §P-8 Management (root-only pages — STRICTLY READ-ONLY)
- **P-8.1** Users: list loads, search works, pagination works, user detail view opens. Do NOT edit, disable, or delete any user.
- **P-8.2** Teams: list loads; open a team's detail (members, projects render). No modifications.
- **P-8.3** Plans: plan definitions and limits render. Do NOT edit.
- **P-8.4** Audit logs: feed loads; role/severity/date filters narrow results; pagination works.
- **P-8.5** Root alerts: page loads with alerts or a clean empty state.
- **P-8.6** Feedbacks admin view (if present): the `QA TEST — ignore` entry from P-7.1 is visible.

## §P-9 Catch-all sweep
- **P-9.1** Walk EVERY remaining sidebar item, header link, settings subsection, and route you haven't visited yet — including inside one test project: every tab revisited once after all the data churn (Overview, Data, Query/SQL, Storage, Auth, REST API, Connection, Backup, Integrations, Settings, Logs).
- **P-9.2** Open every dialog/menu you encounter and CANCEL destructive ones — verify cancel never mutates anything.
- **P-9.3** Record on every page: error toasts, infinite spinners, 404s, dead links, layout breaks, mixed-language text (everything must be English), raw error dumps, `[object Object]`/`undefined`/`NaN`.
- **P-9.4** Resize the window to a narrow width on 3 key pages (Projects, Data grid, Query editor) → no unusable overlap.
- **P-9.5** List any admin UI area you could NOT test and why — the goal is zero unexamined surface.

# ABSOLUTE SAFETY RULES (production environment)

1. **Everything outside `basefyio for TESTING` is off-limits.** Never open, edit, trash, pause, rename, duplicate, export, restore, or otherwise mutate any project, team, folder, tag, or user belonging to any other team. Briefly viewing another team's project LIST (for the team-switcher test) is the only permitted contact.
2. **Inside `basefyio for TESTING` everything is allowed** — full create/update/delete freedom, including the destructive test cases. All created artifacts (projects, folders, tags, buckets, users, invites) live only in this team and must be cleaned up per the original rules — EXCEPT the two test projects themselves: leave them in place with their data for future regression runs.
3. Management section: navigation and filters only. Zero writes.
4. Billing: zero writes. Cancel every dialog.
5. Never log out, never change the root password, never connect/disconnect OAuth providers on the root account.
6. If any action's blast radius is unclear, skip it with a note instead of guessing.

# Report format (extended)

`PART 0: …  PART 1: x✅/y❌/z⏭  PART 2: …  PART 3: …` then Failures (ID, steps, expected, actual, error text, URL), Skips with reasons, Observations, and Cleanup confirmation (extras deleted; both test projects Active with data, living in `basefyio for TESTING`; nothing outside that team touched).
