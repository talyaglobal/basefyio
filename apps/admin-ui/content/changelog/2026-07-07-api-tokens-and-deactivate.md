---
date: 2026-07-07
slug: api-tokens-and-deactivate
title: "API Tokens, project Deactivate, a dedicated Realtime page & tougher Auth"
kind: feature
version: v2.9.0
summary: Mint scoped, Cloudflare-style API tokens so your agents and scripts can drive your account over the API, deactivate projects to free a plan slot without losing data, manage realtime from its own page, and recover a broken auth realm with one click.
---

## API Tokens — let your agents drive your account

**Account → API Tokens** is a new page for minting **scoped, Cloudflare-style
tokens** (`bf_pat_…`) that let an agent or script act on your behalf over the
REST API — no dashboard login required.

- **Fine-grained scopes.** Grant only what the token needs: `projects:read`,
  `sql:run`, `storage:write`, `realtime:write`, `auth:read`, and more, grouped
  by resource with one-click *select all*.
- **Shown once.** The secret is displayed a single time on creation, then only
  its prefix is ever stored — we keep a SHA-256 hash, never the token itself.
- **Full lifecycle.** Roll a token to rotate its secret, or revoke it to cut off
  an agent immediately. Set an optional expiry date for short-lived automation.

The first surface wired for tokens is **realtime bindings** — an agent holding a
token with `realtime:write` can turn realtime on or off for any table in your
projects. More endpoints accept tokens over time.

A full usage guide lives in the docs under **API Tokens**.

## Deactivate a project — free a slot without deleting data

Need room for a new project but not ready to delete an old one? **Deactivate** it.

- **Frozen, not gone.** A deactivated project is closed to use but its data,
  auth, and storage are preserved intact.
- **Off your plan quota.** Deactivated projects **don't count** toward your
  plan's project limit, so the freed slot is immediately available for a new
  project.
- **One-click reactivate.** Bring it back anytime — reactivating just needs a
  free project slot. If you're at your limit, we tell you to upgrade, or to
  delete or deactivate another project first.
- **14-day retention.** Left deactivated, a project is permanently removed after
  14 days. Find deactivated projects under **Deactivated** in the projects
  sidebar, right below Trash.

Active projects now wear a fresh **teal** status badge; deactivated ones show a
neutral **gray** badge so you can tell them apart at a glance.

## A dedicated Realtime page

Realtime moved out of Settings into its **own project page**, so managing which
tables and collections broadcast change events is front-and-center — and it's
now scriptable via API tokens and project service keys.

## Tougher authentication

- **One-click realm repair.** If a project's auth backend gets into a bad state,
  the Auth page now shows a clear error with a **Repair authentication** button
  that provisions a fresh realm and re-points the project — no support ticket
  needed.
- **Graceful errors.** Auth calls that hit an unreachable backend now return a
  clean 502 instead of a confusing 500, so the dashboard stays responsive.
