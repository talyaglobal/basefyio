---
date: 2026-06-12
slug: database-management
title: "Database Management — Indexes, Triggers, Functions, Extensions & RPC"
kind: feature
version: v2.5.0
summary: A new Database tab brings Supabase-style database management. Create indexes for fast queries on millions of rows, manage triggers, enable extensions like pg_trgm and vector, and write Postgres functions that are instantly callable as APIs via /rpc.
---

## New Database tab

Every project now has a **Database** section in the sidebar with four managers:

### Indexes
Speed up queries on large tables without writing DDL. Pick a table, choose columns, select the method (btree, hash, GIN, GiST, BRIN), optionally unique — done. Existing indexes show their size and full definition; drop with one click.

### Triggers
Create `BEFORE`/`AFTER` triggers on `INSERT`/`UPDATE`/`DELETE`, wired to your database functions. Enable/disable with a toggle — no SQL required.

### Functions → instant APIs (RPC)
Write a Postgres function and it's immediately callable as an HTTP endpoint:

```sql
CREATE FUNCTION top_customers(min_total numeric)
RETURNS SETOF customers LANGUAGE sql AS $$
  SELECT * FROM customers WHERE total >= min_total ORDER BY total DESC LIMIT 10;
$$;
```

```ts
const rows = await bf.rpc('top_customers', { min_total: 1000 });
// or: POST /api/rest/v1/rpc/top_customers  { "min_total": 1000 }
```

RPC calls run under the caller's row-level-security role, exactly like the rest of the data API — your small custom APIs, no server to deploy.

### Extensions
Enable curated PostgreSQL extensions with a toggle: `pg_trgm` (fast fuzzy text search), `vector` (embeddings), `uuid-ossp`, `pgcrypto`, `citext`, `unaccent`, `ltree`, and more. Perfect for making million-row searches fast without restructuring your data.

All operations are recorded in the project activity log.
