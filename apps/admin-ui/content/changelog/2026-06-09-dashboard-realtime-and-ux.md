---
date: 2026-06-09
slug: dashboard-realtime-and-ux
title: "Real-time Dashboard, Table Editor Redesign & UX Improvements"
kind: improvement
version: v2.1.0
summary: All dashboard pages now update in real-time without page refresh. Table Editor has a cleaner layout with more screen space for data. Plus new changelog notifications, smarter import modals, and quality-of-life fixes.
---

## Real-time everywhere

The entire dashboard now reflects changes instantly without needing to refresh the page.

- **Folders & Tags** are now broadcast via real-time events. Creating, renaming, or deleting a folder or tag is immediately visible to all team members.
- **Main Dashboard** auto-refreshes project counts, member lists, and statistics when any team activity happens.
- **Billing, Team Settings, and all other pages** stay in sync through the shared real-time event system.

---

## Table Editor redesign

The Table Editor received a layout overhaul to maximize the data area:

- Removed the standalone "Table Editor" heading to reclaim vertical space.
- Action buttons (Import Data, Clean Duplicates, New Table) are now integrated into the tab bar, sitting compactly alongside your open table tabs.
- The data grid area is now taller and more prominent.

---

## Changelog notification popup

A new "What's New" popup appears in the bottom-right corner of any dashboard page when a new changelog entry is published.

- Click the popup to read the full changelog entry.
- Dismiss it with the X button and it won't reappear for that entry.
- The popup hides automatically while an import is in progress to avoid overlap.

---

## Import modal stability

The Supabase import modal can no longer be accidentally closed during an active import:

- Clicking outside the modal or pressing Escape while importing no longer dismisses it.
- The minimize button (−) remains available for intentionally backgrounding the import.

---

## NoSQL Collections

basefyio now includes a full NoSQL document store built on top of PostgreSQL JSONB — no external database needed.

- **Collections Editor**: A new dedicated UI under each project lets you create collections, insert JSON documents, query with filters, and manage indexes — all from the dashboard.
- **CRUD operations**: Insert single or bulk documents, partial update (merge) or full replace, delete by ID or by filter.
- **Querying**: Filter documents with JSON syntax (e.g. `{"status":"active"}`), sort by any field, project specific fields, and paginate results.
- **Index management**: Create indexes on document fields directly from the UI for faster queries.
- **Public REST API**: Every collection operation is available through the public REST API at `/rest/v1/collections/...` with API key authentication and Row-Level Security support.
- **Activity logging**: All collection operations (create, drop, insert, update, delete) are logged to the project activity stream.

---

## Other improvements

- **Default team protection**: Your personal (default) team can no longer be deleted from the UI. Renaming still works.
- **Delete confirmation shortcut**: Clicking the bold project name in the delete confirmation dialog now auto-fills the input field instead of copying to clipboard.
- **Trash counter**: The sidebar Trash section always shows the item count, even when empty.
- **All Teams trash**: Viewing deleted projects now works correctly when "All Teams" is selected.
