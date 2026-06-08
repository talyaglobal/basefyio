---
date: 2026-06-02
slug: performance-and-observability
title: Faster CLI, Resilient Provisioning & Full Observability Dashboard
kind: improvement
version: v1.2.1
summary: CLI startup is near-instant with code splitting, Keycloak realm creation retries automatically, and the Management panel now includes Google Search Console, Google Analytics, Stripe revenue, and configurable email reports.
---

## CLI Performance

Every `bf` command now starts in under 80ms thanks to lazy module loading and code splitting. The browser opens in parallel with module imports during `bf login`, so you see output faster.

## Keycloak Resilience

Project creation now pre-checks Keycloak health before provisioning databases. If Keycloak has a transient hiccup, realm creation retries up to 3 times with exponential backoff. Error messages now include the actual root cause instead of the generic "Failed to provision authentication realm".

## Management Observability

The Management panel gained four new tabs:

- **Search Console** — clicks, impressions, CTR, avg position, top queries, top pages, device & country breakdown
- **Analytics (GA4)** — sessions, users, page views, bounce rate, avg duration, top pages, traffic sources, device & country charts
- **Stripe** — revenue (net/gross/fees), MRR, active subscriptions, recent charges, invoices with PDF links
- **Email Reports** — configure daily/weekly/monthly/yearly automated summaries with selectable content (users, projects, teams, search console, analytics, stripe)

## Dashboard

- "All Teams" view across header and all pages
- Per-member project count badges on the Team page
- Glassmorphism stat cards across all dashboards
