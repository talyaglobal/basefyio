# Task Log

## 2026-04-07 (root account recovery after accidental reset)
- **Issue diagnosed:** Root login failed because Keycloak user record for `016f202d-409d-4627-9cfc-77369b79bb22` had no email set, causing `user_not_found` during password-grant login with email.
- **Recovery applied:** Restored Keycloak email to `bsaygin@outlook.com`, ensured account enabled with empty `requiredActions`, and set a new temporary root password.
- **Security state cleanup:** Reset `login_security_states` counters and captcha/lock fields for `bsaygin@outlook.com`.
- **Verification:** Confirmed successful token issuance from Keycloak using the recovered root email + temporary password.

## 2026-04-07 (force-password-change enforcement hardening)
- **Root cause:** Force-password-change check depended on email lookup, which could miss cases where login succeeded via username fallback or user profile drift.
- **Backend hardening:** Login now decodes authenticated token `sub` and checks `kb_force_password_change` by Keycloak user id, with email lookup only as fallback.
- **Result:** `Force user to change password on next login` now consistently redirects users to change-password flow before normal dashboard access.

## 2026-04-07 (force password change login fix)
- **Root cause:** Keycloak `UPDATE_PASSWORD` required action blocks direct password-grant login, causing `LOGIN_ERROR resolve_required_actions` for users reset with force-change.
- **Backend fix:** Reworked force-change flow to use Keycloak user attribute `kb_force_password_change=true` during admin reset (without `temporary` password / required action), so login succeeds.
- **Login enforcement:** Login response now includes `forcePasswordChange`; admin UI stores a `kb_force_password_change` cookie and redirects users to `/dashboard/account?forcePasswordChange=1`.
- **Route guard behavior:** Dashboard layout now forces redirected users to account page until password is changed.
- **Completion behavior:** On successful password change, backend clears Keycloak force flag and frontend clears `kb_force_password_change` cookie, then allows normal dashboard access.
- **Follow-up fix:** Force flag read now uses full Keycloak user (`users.findOne`) instead of brief list response, ensuring `attributes.kb_force_password_change` is reliably detected at login.

## 2026-04-07 (feedback attachments modal preview)
- **Feedbacks media UX:** Added large modal preview for attachments on `/dashboard/feedbacks`.
- **Click-to-preview:** Both main feedback attachments and comment attachments now open in a dialog when clicked.
- **Media support:** Images open in large `object-contain` preview; videos open in large modal player with controls/autoplay.

## 2026-04-07 (feedback comment replies)
- **Feedback threads:** Added comment reply support in `/dashboard/feedbacks` so users can respond directly to a specific comment.
- **Backend support:** Added optional `parentCommentId` to feedback comments with validation and DB relation.
- **Permissions:** Feedback owner and ROOT can now comment/reply on accessible feedback records.
- **UI update:** Added `Reply` actions, reply target indicator, and nested rendering of replies under parent comments.

## 2026-04-07 (global realtime notifications)
- **Header notifications:** Added a notification bell next to the theme button in the dashboard header.
- **In-app notification center:** Implemented a centralized notifications provider with unread counts, mark-read, and clear actions.
- **Browser notifications:** Added permission flow and Web Notification support for Chrome/other modern browsers.
- **AI/import/feedback triggers:** Added notifications for AI replies (when assistant is not open), import completion (when import modal is not visible), and feedback status/comment updates via periodic realtime-like polling.

## 2026-04-07 (feedback paste screenshot attachments)
- **Feedback modal paste:** Added `Ctrl+V` support so pasted screenshots/media are attached directly while creating feedback.
- **Feedback comment paste:** Added `Ctrl+V` support in feedback comment textarea to attach pasted screenshots/media instantly.
- **Attachment UX:** Kept file-limit checks and added paste hint text for both create-feedback and comment flows.

## 2026-04-07 (selected comment files review before send)
- **Selected files toggle:** Made `N file(s) selected` clickable in feedback comment composer.
- **Pre-send review:** Added expandable selected-files list showing file names and sizes before submit.
- **Pre-send remove:** Added per-file remove action so attachments can be deleted before sending comment.

## 2026-04-07 (feedback reply target visibility)
- **Reply context clarity:** Added inline `Reply to <username>` text on rendered replies so it is clear who was replied to.
- **Thread readability:** Improved nested reply comprehension by showing reply target directly above reply content.

## 2026-04-07 (feedback delete confirmation)
- **Delete safety:** Added confirmation prompt before deleting feedback tasks on `/dashboard/feedbacks`.

## 2026-04-07 (feedback developer action modal history)
- **Clickable developer action:** Made `Developer action` area clickable in feedback cards.
- **History modal:** Added feedback activity modal that lists timeline entries with actor, date/time, action, and details.
- **Backend event log:** Added persistent feedback event tracking (`create`, `status change`, `edit`, `delete`, `comment/reply`) and exposed `GET /feedback/:id/history`.

## 2026-04-07 (feedback search)
- **Feedback search:** Added live search input on `/dashboard/feedbacks`.
- **Filter scope:** Search now matches title, description, username, email, page URL, status, and type.

## 2026-04-07 (notifications incoming-only filter)
- **Notification filtering:** Updated header notification logic to suppress self-originated notifications.
- **AI/import muted for self:** Disabled AI reply/import-complete notification feed entries from same user session.
- **Feedback incoming-only:** Feedback status/comment notifications now show only when action/comment comes from another user.

## 2026-04-07 (navbar dropdown outside-click close)
- **Global close behavior:** Added outside-click handling so open navbar dropdowns close when clicking anywhere else on the page.
- **Applied to nav menus:** Team switcher, projects menu, docs menu, and user menu now consistently close on external click.

## 2026-04-07 (notification deep-link to relevant feedback)
- **Targeted notification navigation:** Feedback notifications now link to exact feedback card anchors.
- **In-page jump:** Added per-feedback DOM anchor ids so clicking a notification scrolls directly to the related item.

## 2026-04-07 (project logs search and pagination)
- **Activity search:** Added live search input to Project Logs Activity timeline.
- **Activity pagination:** Added client-side pagination with previous/next controls and page indicator.
- **Result summary:** Added matching results counter to improve log browsing clarity.

## 2026-04-07 (project activity actor visibility)
- **Actor info in activity:** Added `by <user>` display for each Project Activity timeline item.
- **Backend enrichment:** Project activity list now resolves `userId` to readable actor names from users table; falls back to `System` for automated events.

## 2026-04-07 (table editor sidebar independent scroll)
- **Fixed-height table editor viewport:** Set Table Editor split layout to viewport-based height.
- **Independent left panel scroll:** Table list sidebar now scrolls within its own panel area instead of scrolling the whole page.

## 2026-04-07 (table editor columns panel persisted state)
- **Columns panel persistence:** Saved right-side Columns panel open/closed state to localStorage.
- **Cross-table consistency:** Switching tables no longer forces panel open; closed stays closed, open stays open.

## 2026-04-07 (non-root feedback close after done)
- **Status flow update:** Non-root users can now close their own feedback after it is marked done.
- **UI behavior:** For non-root owners, action button switches from `Mark done` to `Close` once status is `DONE`.
- **Backend rule:** Enforced status transition for non-root as `DONE` first, then `CLOSED`.

## 2026-04-07 (feedback nested replies infinite depth)
- **Thread rendering fix:** Updated feedback comment UI to render replies recursively instead of only one level.
- **Unlimited reply depth:** Users can now reply to replies indefinitely, and all nested levels are visible.
- **Reply context preserved:** Each nested reply still shows `Reply to <username>` where applicable.

## 2026-04-07 (feedback close button label)
- **UI label update:** Changed non-root owner status button text from `Close` to `Close Task` when feedback is in `DONE` state.

## 2026-04-07 (feedback close button label revised)
- **UI label revision:** Updated non-root owner status button text from `Close Task` to `Close Ticket` when feedback is in `DONE` state.

## 2026-04-07 (header dropdown global close hardening)
- **Centralized dropdown state:** Connected `Docs` and `User` menus to header-level controlled state.
- **Outside-click behavior:** Global outside click now closes Team, Projects, Docs, and User dropdowns consistently.
- **Mutual exclusivity:** Opening one header dropdown now closes other header dropdown menus.

## 2026-04-07 (root-only management area)
- **Root-only management routes:** Added backend endpoints for root users to list platform users, list teams, and update user roles.
- **Root-only dashboard page:** Added `/dashboard/management` with Users and Teams tables.
- **Role management:** Root users can change user roles (`USER`, `ADMIN`, `ROOT`) from the UI.
- **Navigation visibility:** `Management` navigation item is shown only for users with `ROOT` role.

## 2026-04-07 (dashboard sidebar auto/open mode)
- **Left menu behavior update:** Added `Auto / Open` mode to `/dashboard` left sidebar, similar to project detail sidebar behavior.
- **Auto mode:** Sidebar stays as a compact rail and expands on hover.
- **Open mode:** Sidebar remains fully expanded.
- **Persistence:** Sidebar mode is saved in localStorage and legacy collapsed state is migrated.

## 2026-04-07 (management pricing and user package controls)
- **Root billing management APIs:** Added root-only billing endpoints for management plans and user package operations.
- **Pricing management UI:** Added pricing plan table in `/dashboard/management` to update monthly plan price.
- **User package management UI:** Added per-user package selector in `/dashboard/management` for changing user package via personal team subscription.

## 2026-04-07 (management users package column and password reset)
- **Users table package column:** Moved package management into Users table as a direct column per user.
- **Root password reset controls:** Added root-only password reset action for each user with custom password input.
- **Generate password button:** Added random strong password generation button in reset modal.
- **Force password change option:** Added checkbox to force users to update password at next login (`UPDATE_PASSWORD` required action).

## 2026-04-07 (pricing names and website sync)
- **Management pricing edits expanded:** Added editable plan display name and major quota fields in Management pricing table.
- **Website pricing data source:** Website `/#pricing` now reads plan names and limits dynamically from billing plans API.
- **Auto sync effect:** Updating plan name/limits in Management now reflects on website pricing cards after refresh/redeploy.

## 2026-04-07 (login refresh loop fix)
- **Root cause:** Global notifications provider was polling protected endpoints on public pages (including `/login`), triggering 401 redirect cycles.
- **Fix:** Notifications profile fetch and feedback polling now run only when an access token exists.
- **Result:** Login page no longer hard-refreshes repeatedly due notification polling.

## 2026-04-07 (management reset password copy icon)
- **UX enhancement:** Added copy icon inside the reset-password textbox on `/dashboard/management`.
- **One-click copy:** Root can copy generated/manual password directly to clipboard from the input field.

## 2026-04-07 (signup password requirements hover info)
- **Signup UX update:** Added an info (`i`) icon next to the password label on `/signup`.
- **Hover details:** Password policy now appears on hover (8+ chars, uppercase, lowercase, number, special character).
- **Input alignment:** Updated password placeholder and `minLength` to 8 to match server-side rules.

## 2026-04-07 (SQL Editor tab rename support)
- **Tab rename added:** Users can now rename SQL tabs in `apps/admin-ui/components/sql-editor.tsx`.
- **UX behavior:** Double-click a tab title to edit inline; `Enter` or blur saves, `Escape` cancels.
- **Persistence:** Renamed titles are persisted in existing localStorage tab state.
- **Validation:** Rebuilt/restarted Docker stack successfully.

## 2026-04-07 (root can view deleted feedbacks)
- **Soft delete added for feedbacks:** Introduced `deleted_at` on `feedbacks` (Prisma schema + migration file) so deleted items are retained instead of hard-deleted.
- **Service behavior updated:** `removeFeedback` now sets `deletedAt` timestamp. Normal users only query non-deleted feedbacks; `ROOT` users get full list including deleted items.
- **Access control tightened:** Non-root users cannot access deleted feedback by ID; root access remains allowed.
- **UI visibility:** `/dashboard/feedbacks` now marks deleted entries with a `Deleted` badge and disables edit/delete actions on deleted records.
- **DB/runtime apply:** Applied `ALTER TABLE ... ADD COLUMN deleted_at` + index directly on local DB and rebuilt Docker stack.

## 2026-04-07 (billing no-plan fix - seeded plans + auto-heal subscription)
- **Root cause found:** `plans` table was empty in local DB; free/pro/business plans were never seeded, causing billing page to show `No Plan` and project creation to fail with `Team has no subscription`.
- **Data fix applied:** Ran Prisma seed inside `platform-api` container (`npx prisma db seed`) to create `legacy/free/pro/business` plans and backfill subscriptions for teams without one.
- **Code hardening:** Updated `apps/platform-api/src/modules/billing/quota.service.ts` so missing team subscription auto-creates a `free` subscription + `team_usage` row (when free plan exists), instead of immediately throwing.
- **Validation:** Rebuilt/restarted Docker stack; platform-api is running with updated quota logic.

## 2026-04-07 (feedbacks crash fix - missing auth guards)
- **Root cause:** `apps/platform-api/src/modules/feedback/feedback.controller.ts` had missing `JwtAuthGuard` on `GET /feedback` and `PATCH /feedback/:id`; `@CurrentUser()` could be undefined, causing runtime `Cannot read properties of undefined (reading 'sub')`.
- **Fix:** Added `@UseGuards(JwtAuthGuard)` to both endpoints so `user.sub` is always available.
- **Validation:** Rebuilt/restarted Docker stack successfully.

## 2026-04-07 (header cleanup - removed My Feedbacks shortcut)
- **Desktop header:** Removed `My Feedbacks` button from `apps/admin-ui/components/header.tsx` top navigation actions.
- **Mobile menu:** Removed `My Feedbacks` entry from the mobile dropdown menu in the same header component.
- **Icon cleanup:** Removed now-unused `ListChecks` import.
- **Validation:** Rebuilt/restarted Docker stack and verified admin UI build passes.

## 2026-04-07 (local login 401 - account lock reset)
- **Root cause found:** Local login `401` was caused by login security lock in `login_security_states` for `bsaygin@outlook.com.tr` (`failed_attempts=10`, `consecutive_failed=10`, `locked_until` set).
- **Immediate fix applied:** Reset lock/captcha counters in DB (`failed_attempts=0`, `consecutive_failed=0`, `locked_until=NULL`, captcha fields cleared) for the affected email.
- **Verification:** Confirmed row now shows zero counters and no lock timestamp.

## 2026-04-07 (login UX - clear toast messaging for lock/captcha/invalid credentials)
- **Lock feedback:** `apps/admin-ui/app/login/page.tsx` now detects backend lock messages and shows explicit toast: account is temporarily locked for 30 minutes.
- **Captcha feedback:** Added clearer toast mapping for `CAPTCHA_REQUIRED` and invalid captcha answer.
- **Credential feedback:** Added specific toast for invalid email/password instead of generic error.
- **Validation:** Rebuilt Docker stack and confirmed admin UI starts with updated login error handling.

## 2026-03-30 (pricing policy made more aggressive)
- **Website pricing updated (`/#pricing`):** Free plan changed to `5 projects`, `2 GB storage`, `1 GB database`, `3 team members`.
- **Pro plan scaled up:** Updated to `20 projects`, `200 GB storage`, `16 GB database`, `10 team members`, with higher API/bandwidth quotas.
- **Business plan scaled up:** Updated to `50 projects`, `1 TB storage`, `64 GB database`, `30 team members`, with higher API/bandwidth quotas.
- **Backend seed alignment:** Updated `apps/platform-api/prisma/seed.ts` plan limits so dashboard billing and enforced quotas stay consistent with website pricing.

## 2026-03-30 (sql result export actions)
- **SQL result actions added:** Implemented `Copy as Markdown`, `Copy as JSON`, and `Download CSV` in `SqlEditor` result toolbar.
- **Markdown export:** Converts current tabular result into markdown table format with header/separator rows and escaped cell values.
- **JSON export:** Copies current result rows as pretty-printed JSON.
- **CSV download:** Generates CSV from current result rows and triggers browser download with timestamped filename.

## 2026-03-30 (connection env keys renamed to KolayBase)
- **Raw Editor env/json outputs updated:** Replaced Supabase-prefixed environment key names with KolayBase names in `ConnectionStringsView`.
- **Next.js preset:** `NEXT_PUBLIC_KOLAYBASE_URL`, `NEXT_PUBLIC_KOLAYBASE_ANON_KEY`, `KOLAYBASE_SERVICE_ROLE_KEY`.
- **Vite / Expo / Node presets:** Renamed all `SUPABASE_*`/`VITE_SUPABASE_*`/`EXPO_PUBLIC_SUPABASE_*` keys to KolayBase equivalents while preserving values.
- **Project identifier retained:** `PROJECT_ID` remains unchanged and included in every preset.

## 2026-03-30 (export stream + download proxy fix)
- **Root cause:** Export progress stream used generic proxy route, which did not map EventSource `?token=` query into `Authorization` header. Backend SSE auth failed, so UI stayed at "Export started" without completion state.
- **Fix:** Added dedicated export SSE proxy route at `app/api/proxy/projects/[projectId]/export/jobs/[jobId]/events/route.ts`, mirroring import stream behavior and forwarding bearer token correctly.
- **Client resilience:** Updated export stream client in `lib/api.ts` to parse named `error` SSE events with payload and surface them via `onFailed`.
- **Download proxy binary handling:** Updated generic proxy to treat `application/zip` as binary passthrough, preventing ZIP corruption when downloading export archives.

## 2026-03-30 (sql editor multi-tab + query persistence)
- **Multi-SQL tabs:** Updated `SqlEditor` to support multiple query screens at once with tab strip, add-tab, switch-tab, and close-tab actions.
- **Per-tab state isolation:** Each SQL tab now preserves its own query text, last result, and last error independently.
- **No query loss across tabs:** Switching between tabs no longer resets editor content; each tab keeps its query intact.
- **Local persistence:** SQL tabs and active tab are stored in `localStorage` per project (`kb_sql_editor_tabs_<projectId>`), so tab content survives refresh/reopen.

## 2026-03-30 (table editor multi-tab support)
- **Multi-table tabs:** Updated `TableEditor` to allow opening and keeping multiple tables at once via `openTabs` state, with a tab strip in the editor content area.
- **Tab interactions:** Added tab activate/switch and close actions; when an active tab is closed, editor automatically switches to the previous open tab.
- **Sidebar integration:** Clicking a table from sidebar now opens it as a tab (if not already open) and focuses it.
- **Create table flow:** Updated `CreateTableDialog` callback to return created table name and auto-open that table as a new tab after creation.

## 2026-04-07 (login redirect loop hardening - auth marker cookie)
- **Likely root cause addressed:** Added localStorage-backed token persistence in `apps/admin-ui/lib/auth.ts` to avoid JWT cookie size limits causing missing auth state.
- **Middleware-safe marker:** Added lightweight `kb_logged_in=1` cookie on login and removed it on logout/clear; middleware now allows dashboard routes when either `kb_access_token` or `kb_logged_in` exists.
- **Navigation reliability:** Login flow uses hard redirect (`window.location.assign('/dashboard')`) after successful sign-in to ensure cookie visibility on the next request cycle.
- **Validation:** Rebuilt and restarted admin UI container after the auth-state updates.

## 2026-04-07 (login submit hardening - prevent form refresh fallback)
- **Submit path hardened:** Refactored login submit logic in `apps/admin-ui/app/login/page.tsx` into shared `submitLogin()` and wired both form `onSubmit` and button click to it.
- **Refresh fallback removed:** Changed sign-in button to `type="button"` with explicit click handler to avoid native form-post refresh when submit event is not captured.
- **Validation:** Rebuilt and restarted admin UI container with updated login flow.

## 2026-04-07 (login loops on /login after 200 sign-in)
- **Auth cookie scope fix:** Updated `apps/admin-ui/lib/auth.ts` token cookies to always set/remove with `path: '/'` so middleware can read `kb_access_token` on `/dashboard/*`.
- **Post-login navigation:** Updated `apps/admin-ui/app/login/page.tsx` to use `router.replace('/dashboard')` after successful email/password and OAuth hash token login.
- **Team cookie consistency:** Updated `apps/admin-ui/app/dashboard/layout.tsx` to set `kb_active_team` with `path: '/'` for consistent route access.
- **Validation:** Rebuilt and restarted containers with `docker compose up -d --build`; admin UI/service startup completed successfully.

## 2026-03-30 (project activity expansion + import summary empty-state removal)
- **Project activity coverage expanded:** Added new activity kinds and logging for database CRUD operations in project data endpoints: table create/drop, row insert/update/delete, column add/edit/delete, and foreign key add/remove.
- **Storage operations now tracked:** Added activity logs for storage bucket create/update/delete and object upload/delete, including path/count metadata where relevant.
- **Auth user management tracked:** Added activity logs for project auth user create/update/password reset/delete actions.
- **Timeline category mapping updated:** New activity kinds are now grouped under `Database`, `Storage`, and `Auth` on the project logs timeline.
- **Import summary empty state removed:** Deleted the `No import summary yet` placeholder block from project logs page for non-import projects created from scratch.

## 2026-04-07 (docker sign-in fix: frontend 3000 + backend 8000)
- **Port alignment:** Local app ports were pinned in `.env` as `ADMIN_UI_PORT=3000` and `PLATFORM_API_PORT=8000`; public API URLs were aligned to `http://localhost:8000`.
- **Port conflict handling:** Checked and force-cleaned listeners for ports `3000` and `8000` (no external listeners found after compose shutdown).
- **Backend reachability fix:** Resolved `platform-api` restart loop by aligning local credentials for existing Docker volumes (`POSTGRES_PASSWORD` and `KEYCLOAK_ADMIN_PASSWORD` values used by running local stack).
- **Startup ordering hardening:** Added `keycloak` healthcheck and changed `platform-api` dependency from `service_started` to `service_healthy` to prevent early boot `fetch failed / ECONNREFUSED`.
- **Validation:** Rebuilt/restarted stack with Docker; final mappings confirmed: admin UI `localhost:3000`, platform API `localhost:8000`, keycloak `localhost:18080`.

## 2026-03-30 (auth hardening: password policy + lock + captcha)
- **Password policy:** Platform auth now enforces password rules in signup/reset/change: minimum 8 chars, at least 1 uppercase, 1 lowercase, 1 number, and 1 punctuation. Updated DTO validators (`signup`, `reset-password`, `change-password`) and backend guard in `AuthService`.
- **Failed-login protection:** Added Prisma model/table `login_security_states` (migration `20260330191500_add_login_security_state`) to track failed attempts by email.
- **Account lock:** After 10 failed login attempts, account login is blocked with lock window (`30 minutes` server-side) and returns lock error.
- **Captcha after 4 consecutive failures:** Added `GET /auth/captcha?email=` and login flow support. After 4 consecutive failed attempts, backend requires captcha (`CAPTCHA_REQUIRED`), and login page now shows captcha question + answer input before retry.
- **UI/API wiring:** `LoginDto` accepts optional `captchaAnswer`, `AuthController` forwards captcha to service, `admin-ui` API client supports `auth.getCaptcha` and sends `captchaAnswer` during login.

## 2026-04-07 (feedback roles: edit/delete/done/comments/media)
- **Permissions:** `GET /feedback` is now role-aware: `ROOT` users see all feedback tasks, normal users see only their own tasks.
- **Task actions:** both `ROOT` and task owner can edit/delete task; normal users can only set status to `DONE` (completed), while `ROOT` can set any status.
- **Comments:** added `feedback_comments` table and relation; `ROOT` users can comment on tasks and include image/video attachments in comments.
- **API additions:** `PUT /feedback/:id`, `DELETE /feedback/:id`, `GET /feedback/:id/comments`, `POST /feedback/:id/comments`; existing list now returns comments with each feedback.
- **UI updates:** `/dashboard/feedbacks` now works for both root and normal users with role-based actions, inline edit/delete, mark-done for owners, and root comment composer with media upload.

## 2026-04-07 (supabase import stuck at first step fix)
- **Root cause:** when import SSE status stream encountered missing job/poll error, backend emitted `error` event and frontend did not map that to a terminal failed state. UI remained on first step (`Queued, waiting for worker...`) indefinitely.
- **Backend fix:** in `projects.controller` import SSE stream, converted terminal stream errors (`job not found`, poll exceptions) to `failed` events and closed the stream.
- **Frontend fix:** in `admin-ui/lib/api.ts` import SSE client, named `error` payloads with a `message` are now treated as failure via `onFailed(...)`, then stream is closed.

## 2026-04-07 (feedback tracking for normal users)
- **Navigation access:** `/dashboard/feedbacks` is now visible for all authenticated users (not root-only). Updated dashboard sidebar and dashboard layout wiring.
- **Header shortcuts:** added `My Feedbacks` quick access in desktop header and mobile menu so users can always reach the tracking screen.
- **Tracking clarity:** feedback list subtitle and per-item `Developer action` status helper text now communicate current dev state (`OPEN/IN_PROGRESS/DONE/CLOSED`) for normal users.
- **Result:** normal users can track all feedback they created and see developer actions/comments from the same list screen.

## 2026-03-29 (feedback attachments + ROOT-only list)
- **DB:** `UserRole` + `ROOT`; `feedbacks.attachments` JSONB (migration `20260329180000_feedback_attachments_and_root_role`).
- **API:** `POST /feedback/attachments` (multipart `file`, image ≤5MB / video ≤20MB) → MinIO bucket `kb-platform-feedback`; `POST /feedback` optional `attachments[]`; `GET`/`PATCH /feedback/:id` guarded by `RootRoleGuard` (Prisma `user.role === ROOT`).
- **Admin UI:** `FeedbackModal` multi-file upload; `/dashboard/feedbacks` + sidebar link only if `profile.role === 'ROOT'`. Set `ROOT` in DB: `UPDATE users SET role = 'ROOT' WHERE email = '...';`

## 2026-03-28 (project activity log — full audit trail)
- **DB:** Prisma model `ProjectActivityLog` → table `project_activity_logs` (migration `20260328120000_project_activity_logs`). Cascade delete with project.
- **API:** `ProjectActivityService.append` / `listForProject`; `GET /projects/:id/activity?limit=` (registered before `GET :id`). Logs: Supabase import completed/failed/cancelled (job carries `userId`), project create/update/soft-delete/restore/move team, SQL executed/failed, GitHub/Vercel connect/disconnect, auth config updates (no secret field names in metadata).
- **Admin UI:** `api.projects.listActivity`, types `ProjectActivityItem`, `ProjectActivityTimeline` on `/dashboard/projects/[id]/logs` above **Supabase import detail** when present.

## 2026-03-28 (project logs page — no page scroll + spacing)
- **Layout chain:** `dashboard/layout` main is `flex flex-col`; project `[id]/layout` on `/logs` uses `main` `flex flex-col overflow-hidden` (other routes keep `overflow-y-auto`). Logs page root `flex-1 min-h-0 overflow-hidden`; `ProjectImportLogCard` gains `fillParentHeight` + `className` so the card fills remaining height and scrolls **inside** (warnings list).
- **Spacing:** Import log card uses vertical `gap-4` (16px), header/actions `gap-4`, issue panel `p-4` + `gap-3`; logs page `gap-5` (20px) header; overview `ProjectDetail` `space-y-5` / grid `gap-5` to align with logs.

## 2026-03-28 (project import log layout)
- **Logs page** (`/dashboard/projects/[id]/logs`): removed `-mx-6` horizontal bleed; page wrapper `min-w-0 max-w-full overflow-x-hidden`. `ProjectImportLogCard` `expandedLayout`: dropped tall `min-h` (52vh); added `max-h-[min(calc(100dvh-12rem),56rem)]`, `min-w-0 max-w-full overflow-x-hidden`, issues panel `flex-1` + list `flex-1 overflow-y-auto`; long lines use `break-words` / `[overflow-wrap:anywhere]`, failed table names `break-all`.
- **Overview** (`ProjectDetail`): import log moved to **bottom** of the stats grid as `md:col-span-3`; same chrome as other tiles (`rounded-lg border bg-card p-5`, no `expandedLayout`, `shadow-none` when embedded).

## 2026-03-28 (dashboard collapsible org sidebar)
- `dashboard/layout.tsx`: left **DashboardSidebar** (`components/dashboard-sidebar.tsx`) — Supabase-style org rail: home + team name (Owner badge), links Overview / Projects / Team / Account / Profile / Feedbacks, **collapse** toggle (persisted `localStorage` `kb_dashboard_nav_collapsed`). Width animates 220px ↔ 52px. **Hidden** on `/dashboard/projects/[id]/*` so project layout keeps a single sidebar. Visible from `md` breakpoint (`hidden md:flex`).

## 2026-03-28 (folder/tag modal color row)
- Projects page: **New/Edit Folder** and **New/Edit Tag** modals use `Modal` `size="md"` (`max-w-md`) so the color swatch row fits without horizontal scroll; `ColorPicker` row no longer uses `overflow-x-auto`.

## 2026-03-28 (projects: drag to trash + drop target highlight)
- `/dashboard/projects`: **Trash** is a `useDroppable` (`droppable-trash`, `DND_TRASH`). Dropping a project card moves it to trash; if the dragged card is in the multi-selection and more than one is selected, all selected projects are deleted (same rule as folder/tag bulk DnD). Reuses `moveProjectsToTrash` with bulk-delete modal.
- Folder **All**, folder rows, and tag rows: while dragging over them, `isOver` uses the same **selected** look as the active filter (`bg-primary/10 text-primary font-medium ring-2 ring-primary/50`). Trash row uses **destructive** ring/fill when `isOver`.

## 2026-03-29 (folder/tag color picker layout)
- Projects page `ColorPicker`: preset swatches + custom (`+`) stay on **one row** (`flex-nowrap`, `overflow-x-auto`, `shrink-0`) so custom sits after the last preset instead of wrapping below.

## 2026-03-29 (Create Project → overview)
- `CreateProjectDialog` `handleCreate`: after successful `api.projects.create`, close dialog and `router.push` to `/dashboard/projects/{id}` (project overview).

## 2026-03-29 (import log layout + AI fixes)
- **Project import log** (overview + logs page): full main-column width (`-mx-6` wrapper), taller card (`min-h` ~52vh cap), warning list scroll `min-h`/`max-h` up to ~70vh. **Potential fixes (AI)** button on each warning line, each failed table row, and auth-skipped note; dispatches `kb-ai-send` to open AI panel in **Ask** mode with structured prompt (`lib/kb-ai-events.ts`). `AiAssistant` listens for that event; `sendMessage` uses history captured **before** appending the user turn.
- AI context: `/logs` path mapped for assistant; platform `AiService` page map includes `logs`.

## 2026-03-29 (overview Integrations card)
- Project overview stats: **Integrations** tile shows GitHub + Vercel rows with icons and linked **repo** (`owner/repo`) / **Vercel project** name; each row is an `<a target="_blank">` to repo URL, constructed GitHub URL, or Vercel project/dashboard URL, with fallback to project Integrations page if URL missing. Passes merged `gh`/`vc` from `ProjectDetail` into `ProjectAdvisorSection`.

## 2026-03-29 (GitHub integrations — branch after repo)
- Project Integrations: **Branch** picker and **Connect Repository** only render after a **repository** is selected (no branch field or connect button while repo is empty). Connect disabled while branches are loading.

## 2026-03-29 (English UI + multilingual AI)
- Admin UI: translated all Turkish strings in `ai-assistant.tsx` (labels, toasts, placeholders, suggestions, agent trace) to English.
- `platform-api` `AiService`: system prompts and error copy in English; explicit rule to **reply in the same language as the user’s latest message** (any language), default English if ambiguous.

## 2026-03-29 (project logs + Advisor View log)
- Advisor **View log** linked to overview only (no navigation). Added route `/dashboard/projects/[id]/logs` with full Supabase import log UI; Advisor CTA now points to `/logs`.
- Extracted `ProjectImportLogCard` for reuse on overview and logs page.
- Project layout sidebar: **Project logs** (`ScrollText` icon) above **Documentation** (expanded + collapsed rail).

## 2026-03-29 (theme + header chrome)
- `next-themes` + `ThemeProvider` in root layout; `ThemeToggle` (moon/sun) in dashboard header for night mode. Team / Projects header triggers: removed outer `border`/`bg-background`, use hover `bg-muted/80` only.
- Project sidebar: **Sidebar** label beside Auto/Open segmented when **expanded**; collapsed Auto rail shows **Auto** only (see entry below).

## 2026-03-29 (sidebar collapsed auto label)
- When sidebar mode is **Auto** and the rail is **collapsed** (pointer not over aside), footer shows **only** the word **Auto** under Documentation (no vertical segmented); hover expands sidebar to use full **Sidebar** + Auto/Open control at bottom.

## 2026-03-29 (overview + header)
- Header: when URL is `/dashboard/projects/[id]`, fetch project and **align active team** with `project.teamId` (if different); Projects menu label and dropdown use route project even before team list refresh; current project injected into menu if missing from list.
- Overview: new `ProjectAdvisorSection` — Supabase-style **quick stats** (status, last import, integrations, data snapshot) + horizontal **Advisor** cards (SECURITY / DATABASE / AUTH / INTEGRATIONS / PERFORMANCE) from import log, failed tables, auth skipped, GitHub/Vercel hints; empty state “No issues detected”.

## 2026-03-29 (later)
- Added `.cursor/rules/post-task-docker.mdc` (`alwaysApply: true`): after tasks that touch app code or Docker-related files, agent runs `docker compose up -d --build` from repo root unless user opts out.

## 2026-03-29
- Project detail layout (`dashboard/projects/[id]/layout.tsx`): sidebar Auto/Open is an **iOS-style segmented control** (muted track + white selected pill) placed **under Documentation** when expanded; removed the external Mode rail. Collapsed Auto rail shows **Auto** text only under docs (see 2026-03-29 sidebar collapsed auto label).
- Header (`components/header.tsx`): **Projects** dropdown next to the team switcher — lists `ACTIVE` projects for the selected team, highlights current project when URL is `/dashboard/projects/[id]`, navigates on row click; footer link **All projects** → `/dashboard/projects`. Team/project menus close each other when opening the other.

## 2026-03-28
- Re-import minimize/maximize: keep dialog internal view as `importing` when closing during a running job (removed erroneous `setView('create')`). Re-import open effect now skips resetting the credential form when `activeImport` is `running` for the same `projectId`, so reopening from the toast shows import steps and progress instead of the setup screen.
- Storage UI “duplicate” bucket names like `docs` + `2-docs`: MinIO bucket `kb-{slug}-2-docs` starts with prefix `kb-{slug}-`, so it was incorrectly listed under the shorter slug (shown as `2-docs`). `listBuckets` now assigns each physical bucket to the **longest** matching project slug among all `ACTIVE` projects. Supabase import uses one logical bucket name (`name` or `id`) consistently for create/upload.
- Same-project ghost `2-docs`: listing alone cannot drop `kb-{slug}-2-docs` when only one project matches both `…-docs` and `…-2-docs`. After each Supabase storage import, `pruneProjectStorageBuckets` deletes project buckets whose logical names are **not** in the Supabase bucket API list (so only `docs` remains when source has only `docs`). Logical names normalized to lowercase for Kolaybase.

## 2026-03-27
- Added table name `Search tables...` input to `TableEditor` sidebar, and filter table list by name (no effect on row filter).
- Fixed Supabase import warnings flow so tables with `0 rows imported` are also appended to import `warnings` (shown in result dialog + overview import log).
- Import complete modal: primary action navigates to `/dashboard/projects/[id]` for the imported project; persist `projectId` in import progress context/localStorage for resume.
- Overview import log: merge `project.supabaseImportLog` with per-browser `localStorage` backup saved when import completes (`import-log-storage.ts`) so warnings show even if API DB field is empty; hint when only browser copy exists.

