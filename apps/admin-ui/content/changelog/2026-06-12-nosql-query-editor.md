---
date: 2026-06-12
slug: nosql-query-editor
title: "Query Editor for NoSQL Projects — JS Queries & Aggregation Pipelines"
kind: feature
version: v2.3.0
summary: NoSQL projects get a full query editor. Write SDK-style JS queries against entities and collections, and run MongoDB-style aggregation pipelines on engines that support them — all from the dashboard.
---

## JS query mode

NoSQL projects now show a **Query** editor in place of the SQL editor. Write queries exactly like you would with the SDK:

```js
collection('orders')
  .find({ status: 'paid', total: { $gte: 100 } })
  .sort({ _createdAt: -1 })
  .limit(50)
```

- Works against both **Data Engine entities** and **NoSQL collections** — the editor resolves the target automatically
- Full filter operators: `$eq $ne $gt $gte $lt $lte $in $nin $contains $containsAny $exists $regex $iregex $like $ilike` plus `$and / $or / $not`
- `.sort()`, `.limit()`, `.skip()`, `.select()`, `.count()` chain methods
- Queries are **parsed, never evaluated** — a closed grammar with precise line/column errors, no code execution
- Multi-tab editor with rename, saved queries, table/JSON result views, Markdown/JSON copy, and Excel export

## Aggregation mode

On data engines that support pipelines, the editor gains an **Aggregation** mode toggle:

```json
[
  { "$match": { "status": "active" } },
  { "$group": { "_id": "customer.city", "orders": { "$count": null }, "revenue": { "$sum": "total" } } },
  { "$sort": { "revenue": -1 } },
  { "$limit": 10 }
]
```

- Stages: `$match $project $unwind $group $sort $limit $skip`
- Accumulators: `$count $sum $avg $min $max`
- Pipelines are validated server-side; dangerous stages (`$lookup`, `$out`, `$merge`, `$function`, `$where`) are blocked
- Every pipeline is automatically scoped to your project — tenant isolation is enforced server-side

The mode toggle appears automatically when the project's data engine reports pipeline support — no configuration needed.

## MongoDB engine support

The Data Engine gains a **MongoDB provider** (`DATA_ENGINE_PROVIDER=mongodb`):

- Native aggregation pipeline execution — the first engine with full Aggregation mode support
- Same document envelope and tenant isolation model as the other engines
- The `mongodb` driver is an optional dependency — deployments not using it need nothing new

## Saved queries

Saved queries now remember their dialect — reopening an aggregation restores Aggregation mode with the target entity preselected.
