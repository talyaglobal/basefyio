---
date: 2026-06-30
slug: app-builder-flows-migrations
title: "App Builder, Flows, schema migrations & encrypted credentials"
kind: feature
version: v2.8.0
summary: Turn a spreadsheet into real database tables with the new App Builder, automate work with Flows, evolve your schema with planned migrations, and rest easy with project database credentials now encrypted at rest.
---

## App Builder — from spreadsheet to a real backend

The new **App Builder** (left sidebar) turns an Excel/CSV file into a working data model:

- Upload a spreadsheet — sheets are analyzed into tables with inferred column types.
- A domain (CRM, inventory, orders, HR…) is detected and a default set of roles and navigation is proposed.
- Review and **approve** the model, then **generate** real relational tables (with row-level security and grants) into any project — they show up immediately in the project's **Data** views.

## Flows — automation on a queue

Each project now has a **Flows** tab: define a trigger (manual, webhook, schedule) and an ordered list of actions (`log`, outbound `http.request`) that run asynchronously on a background worker, with a full run history. Outbound requests are SSRF-guarded.

## Schema migrations

Changed your data model? **Sync from Excel**, then **plan** a migration — basefyio diffs the generated schema against the new one, classifies each change as safe / review / destructive, and **applies** it in a transaction (destructive changes require explicit confirmation).

## Security

- **Project database credentials are now encrypted at rest** (AES-256-GCM), transparently decrypted in use — no change to how you connect.
- SQL execution now reuses a pooled connection per project and ships a hardened statement denylist.
- If your session genuinely expires, you're taken straight to a clean sign-in instead of a stuck screen.

## Plan entitlements

Plans can now gate features per project, so packaging and limits are enforced consistently across the platform.
