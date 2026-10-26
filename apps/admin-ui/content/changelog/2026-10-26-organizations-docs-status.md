---
date: 2026-10-26
slug: organizations-docs-status
title: Organizations, a documentation site of its own, and a status page with monthly history
kind: feature
version: v2.10.0
summary: Teams become organizations with their own pages and per-role permissions, the documentation moves to docs.basefyio.com, and status.basefyio.com shows every component with its checks, a month-by-month record and incident mail you can subscribe to.
---

## Organizations

Your team is now an **organization**: it has a public address under `/dashboard/org/…`, a kind (company, startup, agency, education, non-profit, open source, personal), a description, website and logo, and its own Overview, Projects, Members, Billing and Settings pages. The old Team and Billing links still work and forward there. Admins and members get **per-role permissions** (create, delete, restore and move projects; invite and remove members; integrations; billing; reset the database password) that the owner sets on the Members page. **Any member can activate a deactivated project** again, not only its creator.

## Documentation

The docs now live at **https://docs.basefyio.com** with the same guides (Data Engine, Connect, Realtime, Authentication, Storage, API, SDK, CLI, Security & RLS, Self-hosting). Every old `basefyio.com/docs/…` address forwards permanently, and the Docs menu in the dashboard points at the new site.

## Status page

**https://status.basefyio.com** is the status page itself now. It shows the six probed components (API, dashboard, auth, database endpoint, storage, realtime) with what each check exercises, a square per day you can hover, the availability of the month against its target, and a month navigator: every month is recorded when it ends and stays. Project provisioning, backups, billing, the website and e-mail delivery appear too, with the state an open incident gives them. **Subscribe to updates** sends you one mail when an incident opens, changes or resolves (confirm the address first; every mail has an unsubscribe link), and **Report a problem** reaches support directly. Your billing page shows the month's availability of the covered indicators.

## Also

- API responses now carry `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers so clients can pace themselves; limits are observed, not enforced, for now.
- Read-only database roles that were missing on projects created after 2026-10-20 were put back automatically.
- The platform version is reported on `GET /api/health` and shown at the bottom of the dashboard sidebar.
