# Task Log

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

