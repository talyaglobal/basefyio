---
date: 2026-06-12
slug: realtime-data-changes
title: "Realtime — Live INSERT/UPDATE/DELETE Events for Your App"
kind: feature
version: v2.4.0
summary: Realtime is here. Enable it per table or collection, then subscribe from your app with bf.realtime.subscribe() — every insert, update, and delete is pushed to connected clients instantly.
---

## Subscribe to data changes

Your app can now listen to live database changes:

```ts
const sub = bf.realtime.subscribe(
  { table: 'orders', event: 'INSERT' },
  (change) => console.log('new order:', change.new),
);
```

Works for relational **tables** and NoSQL **collections**, with optional filtering by change type (`INSERT`, `UPDATE`, `DELETE`, or `*`). The SDK reconnects automatically; plain `EventSource` works too if you're not using the SDK.

## Per-entity opt-in

Nothing broadcasts by default. Enable realtime per table/collection from **Settings → Realtime** in your project — the same explicit publication model Supabase uses. Change events carry full row data, so enabling an entity is your consent to broadcast its rows to API key holders.

## What triggers events

- REST API writes (`/api/rest/v1/{table}`)
- SDK writes (`bf.from(...)`, collections, documents)
- Dashboard table editor and collection edits

Raw SQL from the SQL editor doesn't broadcast in this version (events are produced at the API layer).

## Docs

Full guide: [basefyio.com/docs/realtime](https://basefyio.com/docs/realtime)
