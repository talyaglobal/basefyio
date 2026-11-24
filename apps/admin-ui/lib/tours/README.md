# Guided tours

Short driver.js tours for the dashboard. A tour starts by itself the first time a user opens a
page (behind the `guided_tours` flag); the header Tour button replays it at any time.

## Files

| File | Loaded | Purpose |
|---|---|---|
| `types.ts` | types | `TourRoute`, `TourStep`, `TourDef`, id and anchor patterns, limits |
| `match.ts` | eager | route matching (static before dynamic segments) |
| `dom.ts` | eager | anchor lookup, visibility, blockers, waits, driver cleanup |
| `routes/<area>.ts` | eager | which pages a tour belongs to (no copy) |
| `definitions/<area>.ts` | lazy | steps and copy |
| `runner.ts`, `tour.css` | lazy | driver.js, its CSS, the theme; loaded only when a tour runs |
| `../tour-prefs.tsx` | eager | the user's preferences (server, with a retry outbox) |
| `../../components/tour/*` | eager | provider (auto-start, Tour button logic) and the button |
| `../../scripts/check-tours.js` | build | the guard |

## Areas

Every tour lives in exactly one area, with one routes file and one definitions file. Add tours
only to your area's two files; the `index.ts` files already import all four areas.

| Area | Pages |
|---|---|
| `chrome` | `shell` (workspace header and sidebar), `project-shell` (project sidebar) |
| `workspace` | dashboard pages outside a project (overview, projects, account, API tokens, team, billing, org pages, blueprints, feedbacks) |
| `project-data` | project overview, data, queries, database, REST API, logs, realtime, embeddings |
| `project-services` | auth, storage, connect, integrations, flows, branches, backup and export, settings |

## Adding a tour

1. Add a route to `routes/<area>.ts`:
   `{ id: 'project-sql', kind: 'page', routes: ['/dashboard/projects/[id]/sql'] }`.
   - The id is saved in the user's "seen" list: lowercase, `a-z0-9` with `-` or `.`, at most 64
     characters. **Never rename an id that has shipped.**
   - `[x]` matches one path segment. Page tours use exact routes; `/**` is for chrome tours.
   - Alias routes share one id (`routes: ['/dashboard/team', '/dashboard/org/[publicId]/members']`).
   - Use `when: { flagOn: 'organizations_ui' }` for flag-only tours.
2. Add the definition with the same id to `definitions/<area>.ts`:
   `{ id, ready: '<anchor>', steps: [{ anchor, title, text, side?, align? }] }`.
   - `ready` is an anchor that exists only once the page shows real content (not on a spinner,
     skeleton or error view). Put it on a wrapper that is rendered only when loading is false.
   - 2 to 12 steps may be listed; at most 9 are shown in one run.
3. Put the anchors in the JSX (see below), then run the guard.

Route and definition files may only `import type` (the guard evaluates them on their own).

## Anchors

- `data-tour="<tour-id>-<control>"` as a string literal, e.g. `data-tour="project-sql-run"`.
- Conditional: `data-tour={first ? 'projects-card' : undefined}` (the guard reads the literals that can be the value: both branches of `? :`, both sides of
  `||` and `??`, the right side of `&&`; literals inside the condition are ignored).
- Items rendered from an array: add a literal `tourAnchor: 'project-shell-nav-sql'` field to the
  item and render `data-tour={item.tourAnchor}`. Never build an anchor with a template string.
- An anchor value may appear in one file only. Twins in that file (expanded and rail sidebar,
  grid card and list row) are fine: the first visible one is used.
- Mark only the first item of a list (first card, first active row), never every item.
- Anchor the wrapper, not an input that opens a dropdown on focus.
- `data-tour-autofocus` on a field the app focuses by itself (the AI panel input) keeps that
  focus from cancelling an automatic start; real clicks and key presses still cancel it.
- `data-tour-block` on an element stops an automatic start while it is visible (spinners, error
  and not-found views, open menus). Dialogs, menus and listboxes (`role=...`) block by themselves.

Existing anchors other tours can reuse: `project-shell-nav-<slug>` on every project nav link
(`slug` = `href.slice(1) || 'overview'`), `project-shell-nav-logs`, `project-shell-api-keys`.

## The visibility filter

When a tour starts, steps whose anchor is not visible right now are dropped, once. There is no
automatic tab switching. So:

- A step for a control that exists only in some states (another tab, a sub-view, an empty state,
  a breakpoint, a role) appears only when the tour is started while that state is on screen.
  List variants that are never visible together side by side; the filter picks the right one.
- An automatic start needs at least 2 visible steps; the Tour button needs 1.
- Steps never go inside a dialog. The step on the button that opens a dialog says what it does.

## Copy rules

- English only. Title: the control's visible label, or 1 to 3 words, at most 40 characters.
- Text: one sentence, at most 16 words and 140 characters, saying what the control does.
- Write "basefyio" in lowercase. No comparison with other products. No prices or limits.
- Wording must be right whether the UI says Team or Organization.
- No `<`, `>` or `&` (driver.js inserts copy as HTML). Never put user or project names in copy.

## The guard

```
node scripts/check-tours.js     # also runs in `npm run build` (prebuild) and in CI
```

It fails when a `ready` or step anchor is missing from `app/` or `components/`, an id or anchor
is malformed or duplicated, routes and definitions do not pair up, two page tours tie on a path,
a tour has fewer than 2 or more than 12 steps, or copy breaks the rules above. Unused anchors are
a warning only.

To see it fail: delete one attribute the tours use, e.g. `data-tour="projects-new"` in
`app/dashboard/projects/page.tsx`, run the command (it names the missing anchor and exits 1),
then put the attribute back.

## Runtime notes

- Layouts that change under a tour can hold still with `useTourActive('<tour-id>')` (the project
  sidebar stays expanded in Auto mode during `project-shell`).
- `document.body.dataset.tourAuto` becomes `shown` or `skipped` once the automatic start has been
  decided for the current pathname (only with the flag on); tests can wait for it.
- `localStorage.basefyio_tours_auto = 'off'` turns automatic tours off in one browser.
- Closing or finishing a tour marks it seen; an interrupted tour (route change, dialog opened,
  anchor gone) saves nothing and is not offered again until the next reload.
