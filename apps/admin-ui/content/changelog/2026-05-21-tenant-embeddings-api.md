---
date: 2026-05-21
slug: tenant-embeddings-api
title: Embeddings API — Build Semantic Search & RAG Into Your Own App
kind: feature
version: v1.1.1
summary: Enable pgvector on your project database, store embeddings via a simple REST API, and add semantic search or RAG to your application in minutes.
---

Until now, the AI-powered semantic search we shipped was limited to Kolaybase's own admin dashboard — searching your SQL history, schemas, and activity logs. You couldn't use it to build AI features in **your** application.

That changes today.

## What's new?

Every Kolaybase project can now enable **pgvector** directly on its own database and use a new **Embeddings REST API** to store, search, and manage vector embeddings. This gives you everything you need to build:

- **Semantic search** — Find content by meaning, not exact keywords
- **RAG (Retrieval-Augmented Generation)** — Feed relevant context to an LLM before it answers
- **Recommendation engines** — Surface similar items, articles, or products
- **AI-powered FAQ / knowledge base** — Match user questions to the best answer

All of this runs on your project's own PostgreSQL database. No external vector database, no third-party service, no extra billing.

---

## How to enable it

1. Open your project in the dashboard
2. Click **AI / Embeddings** in the left sidebar
3. Turn on the **pgvector** toggle — this creates the `vector` extension and embedding tables in your database
4. (Optional) Enter a per-project **OpenAI API key**, or leave it blank to use the platform-level key

That's it. Your project is now ready to accept embeddings.

---

## Storing embeddings

Send your text content to the API. Kolaybase generates the embedding vector automatically using OpenAI's `text-embedding-3-small` model.

```bash
curl -X POST https://your-api.kolaybase.com/rest/v1/embeddings \
  -H "apikey: YOUR_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "How do I reset my password?",
    "namespace": "faq",
    "metadata": { "category": "auth", "priority": "high" }
  }'
```

**Key concepts:**

- **content** — The text to embed (max 8,000 characters). This is what gets converted to a vector.
- **namespace** — A logical grouping (e.g. `"faq"`, `"docs"`, `"products"`). Use it to partition your embeddings and search within a specific scope.
- **metadata** — Any JSON object. Stored alongside the embedding and returned in search results. Great for filtering, display, or linking back to your source data.

Duplicate content within the same namespace is automatically deduplicated — sending the same text twice won't create a second record.

### Batch storage

Store up to many items in a single call:

```bash
curl -X POST https://your-api.kolaybase.com/rest/v1/embeddings/batch \
  -H "apikey: YOUR_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "items": [
      { "content": "How do I reset my password?", "namespace": "faq" },
      { "content": "Where can I find my invoices?", "namespace": "faq" },
      { "content": "How to enable two-factor auth?", "namespace": "faq" }
    ]
  }'
```

---

## Searching embeddings

This is where it gets powerful. Search by **meaning**, not keywords:

```bash
curl -X POST https://your-api.kolaybase.com/rest/v1/embeddings/search \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "forgot my password",
    "namespace": "faq",
    "limit": 5,
    "threshold": 0.5
  }'
```

The query `"forgot my password"` matches `"How do I reset my password?"` even though they share no exact words. The system understands they mean the same thing.

**Response:**

```json
[
  {
    "id": "a1b2c3d4-...",
    "namespace": "faq",
    "content": "How do I reset my password?",
    "metadata": { "category": "auth", "priority": "high" },
    "distance": 0.18,
    "score": 0.82
  }
]
```

- **score** — 0 to 1, higher means more similar
- **distance** — Cosine distance, lower means more similar
- **threshold** — Only return results closer than this distance (default 0.5)

### Searching from the browser

Search is available with the **anon key**, so you can call it directly from your frontend — no server round-trip needed. Write access (store/delete) requires the **service key** or an authenticated user token.

---

## Building RAG with this API

A typical RAG (Retrieval-Augmented Generation) flow looks like this:

1. **User asks a question** in your app's chat or search box
2. **Your backend calls the search endpoint** with the user's question
3. **Top results come back** — these are the most relevant chunks of content
4. **You pass those results to an LLM** (e.g. GPT-4, Claude) as context alongside the question
5. **The LLM generates an answer** grounded in your actual data

```js
// Step 1: Search for relevant context
const searchRes = await fetch('/rest/v1/embeddings/search', {
  method: 'POST',
  headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: userQuestion, namespace: 'docs', limit: 5 }),
});
const results = await searchRes.json();

// Step 2: Build the prompt with context
const context = results.map(r => r.content).join('\n\n');
const prompt = `Answer the question based on the following context:

${context}

Question: ${userQuestion}`;

// Step 3: Send to your LLM of choice
const answer = await callYourLLM(prompt);
```

That's the entire RAG pipeline. Three API calls, no infrastructure to manage.

---

## Deleting embeddings

Remove specific embeddings by ID:

```bash
curl -X DELETE https://your-api.kolaybase.com/rest/v1/embeddings \
  -H "apikey: YOUR_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "ids": ["a1b2c3d4-...", "e5f6g7h8-..."] }'
```

Or wipe an entire namespace (requires service key):

```bash
curl -X DELETE https://your-api.kolaybase.com/rest/v1/embeddings/namespace \
  -H "apikey: YOUR_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "namespace": "old-docs" }'
```

---

## Authentication & access control

| Action | anon key | authenticated (JWT) | service key |
|--------|----------|-------------------|-------------|
| Search | Yes | Yes | Yes |
| Store | No | Yes | Yes |
| Delete by IDs | No | Yes | Yes |
| Delete namespace | No | No | Yes |
| Check status | Yes | Yes | Yes |

Use the **anon key** for read-only access from the browser. Use the **service key** for backend operations that write or delete data.

---

## Technical details

- **Embedding model:** `text-embedding-3-small` (OpenAI) — 1536 dimensions
- **Index type:** HNSW (cosine distance, m=16, ef_construction=64) — sub-10ms search
- **Storage:** Your project's own PostgreSQL database, no external service
- **Deduplication:** SHA-256 content hash per namespace — same text is never embedded twice
- **Namespaces:** Logical partitions within a single project. Use them to separate FAQ, docs, products, etc.
- **Metadata:** JSONB column with GIN index — queryable in future releases

---

## Per-project API key

Each project can optionally have its own OpenAI API key. If not set, the platform-level key is used. This is useful when:

- Different projects belong to different customers or billing entities
- You want to track OpenAI costs per project
- A project needs a higher-tier API key with better rate limits

Set it from the **AI / Embeddings** page in your project settings, or via the admin API:

```bash
curl -X POST https://your-api.kolaybase.com/projects/YOUR_PROJECT_ID/embeddings/api-key \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{ "apiKey": "sk-..." }'
```

---

## Disabling

If you need to turn off embeddings for a project, flip the toggle off on the **AI / Embeddings** page. The tables and data are preserved — nothing is deleted. API calls will return an error until you re-enable it.

No redeployment needed. No data loss.
