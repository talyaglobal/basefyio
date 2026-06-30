---
date: 2026-06-12
slug: daily-auto-backups
title: "Daily Auto-Backups with 7-Day Retention"
kind: feature
version: v2.3.1
summary: Every active project is now backed up automatically once a day. The last 7 days of backups are kept; older ones are cleaned up automatically so storage never bloats.
---

## Automatic daily backups

Every active project now gets a **daily backup at 03:00 UTC** — no setup required:

- **Database** — full SQL dump of your project database
- **Auth** — realm configuration and users
- **Project config** — metadata and settings

Storage files are not duplicated into backups: they already live in object storage, and the critical loss vector a backup protects against is the database.

## 7-day retention

Auto-backups are kept for **7 days**, then removed automatically. Manual exports keep their existing 24-hour lifetime. Your storage stays bounded — roughly 7 backups per project at any time.

## Restore from the dashboard

Auto-backups appear in **Backup & Export → Cloud Backups** alongside manual exports, marked with an **Auto** badge. Restore works the same way:

- Restore **into the existing project** (overwrite), or
- Restore **as a new project**

Every backup and cleanup run is recorded in the project activity log.
