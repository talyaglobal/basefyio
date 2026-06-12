# ADR-0003: Couchbase Go/No-Go Decision Gate

**Status:** Decision pending — evaluate at D8 gate  
**Date:** 2026-06-12  
**Deciders:** Engineering + Product

## Context

The basefyio platform stores tenant data in per-project PostgreSQL databases. The data layer supports relational tables via the `/items` API and NoSQL document collections via the existing `CollectionService`. A question exists about whether to add Couchbase as a third storage backend for mobile-sync scenarios and workloads exceeding 10⁷ documents.

## Decision Gate (D8)

Couchbase adoption is **conditional** on meeting at least one of:

| Gate | Criterion |
|------|-----------|
| D8-A | A paying customer requires offline mobile sync (Couchbase Mobile / Sync Gateway) |
| D8-B | A single tenant projects > 10,000,000 documents and PostgreSQL/JSONB performance is insufficient |

## Options Evaluated

### Option 1: Defer indefinitely (recommended for V1)
- PostgreSQL JSONB covers 90%+ of document workloads at basefyio scale
- No additional operational complexity
- Re-evaluate at D8 gate
- **Decision: DEFAULT CHOICE**

### Option 2: Add Couchbase Capella
- Pros: Built-in mobile sync, multi-master replication, N1QL query
- Cons: New infra layer, separate billing, learning curve for on-call
- **Decision: Adopt only if D8-A or D8-B is met**

### Option 3: Extend PostgreSQL with citus/Neon branching
- Pros: Familiar tooling, no new backend
- Cons: Sharding complexity, not a mobile-sync solution
- **Decision: Consider if D8-B met and D8-A not required**

## Consequence

- V1 ships with PostgreSQL + MinIO only
- `CollectionService` (existing) handles document workloads via JSONB
- D8 gate reviewed quarterly or upon first qualifying customer
- Implementation effort if D8-A triggered: ~1 sprint (Couchbase Capella + Sync Gateway)
