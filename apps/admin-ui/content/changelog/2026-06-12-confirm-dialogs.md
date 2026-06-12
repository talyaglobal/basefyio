---
date: 2026-06-12
slug: in-app-confirm-dialogs
title: "Polished Confirmation Dialogs Across the Dashboard"
kind: improvement
version: v2.4.1
summary: Native browser confirm() popups are gone. Every destructive action — deleting buckets, rows, documents, projects, saved queries, users — now asks with a styled in-app dialog that matches your theme.
---

## In-app confirmations everywhere

All destructive actions across the dashboard now use a consistent, theme-aware confirmation dialog instead of the browser's native popup:

- **Storage** — deleting buckets and files
- **Table Editor** — deleting rows, dropping tables, duplicate cleanup
- **Collections** — deleting documents and collections
- **Query editor** — deleting saved queries
- **Auth** — removing project users
- **Projects** — trash, restore, and permanent delete flows
- **Team** — removing members, cancelling invites, disconnecting integrations
- **Management & Feedback** — moderation actions

Destructive confirmations are visually distinct (red accent), support keyboard dismissal, and render correctly in dark mode — no more jarring OS-styled popups interrupting the flow.
