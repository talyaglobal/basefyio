---
date: 2026-06-11
slug: external-database-access
title: "External Database Access — Connect with pgAdmin, DBeaver & More"
kind: feature
version: v2.2.0
summary: Your project database is now accessible from any external SQL client. Use pgAdmin, DBeaver, DataGrip, TablePlus, or psql to browse, query, and manage your data directly.
---

## Connect from anywhere

Every basefyio project now exposes its database through an external connection pooler endpoint. This means you can use your favorite database tool — no need to go through the basefyio dashboard for every query.

**Supported tools:**

- **pgAdmin** — full visual admin for your database
- **DBeaver** — universal database tool (free & open-source)
- **DataGrip** — JetBrains database IDE
- **TablePlus** — modern, lightweight database client
- **psql** — connect from your terminal
- **Any SQL client** that speaks the PostgreSQL wire protocol

---

## How to connect

1. Open your project in the basefyio dashboard
2. Go to **Connection** in the sidebar
3. Copy the **Host**, **Port**, **Database**, **User**, and **Password** fields
4. Paste them into your database client

Or copy the full **Connection URI** and paste it directly — most tools support URI import.

---

## Connection page improvements

The Connection page now includes:

- **External Tools** quick-connect guide with step-by-step instructions for pgAdmin and DBeaver
- **Correct external hostname** — connection strings now show the public endpoint instead of internal addresses
- **Password management** — generate or set a custom database password directly from the dashboard

---

## New documentation

A dedicated **[External Database Access](/docs/connect)** guide is now available in the docs, covering:

- Finding your credentials
- Connecting from pgAdmin, DBeaver, DataGrip, TablePlus, and the terminal
- Using connection strings with Prisma and Drizzle ORMs
- Connection pooling behavior
- Security best practices
