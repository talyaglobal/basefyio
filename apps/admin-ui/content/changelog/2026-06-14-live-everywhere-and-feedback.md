---
date: 2026-06-14
slug: live-everywhere-and-feedback
title: "Live updates everywhere, editable feedback comments, and a cleaner CLI login"
kind: feature
version: v2.6.0
summary: The whole dashboard now updates in real time without a manual refresh, feedback comments and replies can be edited or deleted, and the basefyio CLI login page got a clean redesign.
---

## Live updates across the whole dashboard

Realtime is no longer just for the data grid. Every project screen now refreshes itself the moment something changes — in any open tab, on any device:

- **Tables** — rows and the table list update on insert/update/delete and schema changes
- **Storage** — buckets and file lists update on upload, delete, and bucket changes
- **Auth** — the user list updates as users are created, edited, or removed
- **Backup & Export** — cloud backups appear as soon as they finish
- **Feedback** — new comments, edits, status changes, and deletions show up instantly

Open two tabs, change something in one, and watch the other keep up — no refresh button required.

## Edit and delete feedback comments

Comments and replies can now be **edited** and **deleted**:

- Authors can edit their own comments (an "edited" marker is shown) and delete them
- Deleting a comment keeps its replies — the thread stays intact
- Every edit and delete is recorded in the feedback activity history

## A cleaner CLI login

After `basefyio login`, the browser confirmation page got a clean redesign showing your machine, CLI, Node, and platform details. The confusing auto-close countdown is gone — the page simply tells you it's safe to close the tab.

## Reliability fixes

- Project **export and restore** no longer break a project's authentication — restored projects keep working logins, and exports complete reliably
- Restore lands on the first try, with no misleading "already exists" warning
