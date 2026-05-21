---
date: 2026-05-18
slug: ai-semantic-search
title: AI-Powered Search, RAG, and Smart Suggestions
kind: feature
summary: You can now search your SQL history, table schemas, and project activities using natural language. The AI assistant truly understands your project.
---

Until now, when searching your SQL history, you had to remember exactly what you wrote. If you misspelled a table name — nothing came up.

Not anymore.

## What changed?

Three major features launched simultaneously. They're all interconnected and work silently in the background.

---

### 1. Semantic Search

You can now search your SQL queries, table schemas, and project activities **by meaning**.

Type "recent records in users table" — it finds `SELECT * FROM users ORDER BY created_at DESC`. It doesn't look for an exact word match; it understands what you meant.

**What's searchable?**

- All SQL queries you've run
- Your project's table structures (each table is indexed as a chunk)
- Project activity history
- Feedback and issue history

Everything is indexed automatically in the background. You just search.

---

### 2. RAG — The AI Assistant Now Truly Knows Your Project

When you ask a question in AI Chat, the system now automatically finds relevant context from your project and feeds it to the AI.

Previously, the AI assistant would ask you generic questions about your schema or give generic examples. Now it can say things like:

> "You previously ran this query on the `orders` table: `SELECT status, COUNT(*) FROM orders GROUP BY status` — based on this pattern, I'd suggest..."

You don't have to do anything. The AI automatically pulls context from your history and schema.

**How does it work?**

You type your question → the system finds the most relevant content (your table schema, recent queries, error patterns) → feeds them to the AI as context → the AI uses that context to respond.

This entire process completes in 300-500ms. You won't notice it, but the quality of responses has improved significantly.

---

### 3. Smart Query Suggestions

After running a query in the SQL editor, you'll start seeing "Similar queries".

- **Similar queries from the same project** — If you wrote something similar before, it shows up
- **Patterns from other projects in your team** — If another project has a similar table structure and a similar query was written, you can see that pattern

Everything runs on cosine similarity — it matches by "this looks similar", not by exact word matching.

---

## For the technically curious

All these features are built on **pgvector**. Inside your PostgreSQL database, with no separate service or paid third-party dependency.

- Embedding model: `text-embedding-3-small` (OpenAI)
- Index type: HNSW (cosine distance, m=16)
- Search strategy: Semantic + keyword (pg_trgm) hybrid, combined with Reciprocal Rank Fusion
- Daily token limit: Configurable (default 1M tokens/day)

Everything uses your OpenAI API key. No additional cost.

---

## For now

Indexing runs automatically — from today onward, every SQL query you run and every table you create is automatically indexed.

For existing data, you can run a backfill:

```bash
npm run embeddings:backfill:dry   # preview how much data exists first
npm run embeddings:backfill       # run it
```

To disable, a single env variable is enough:

```
EMBEDDING_ENABLED=false
```

Everything continues to work normally, only the AI features are disabled.
