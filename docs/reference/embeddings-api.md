# Embeddings API

Store text as vectors in the project's own database (pgvector) and search it semantically.
Vectors are produced by an embedding provider — OpenAI by default, or Ollama (self-hosted) or
Cohere — chosen for the platform by the operator and overridable per project. Everything a
customer needs to know about where their text goes is exposed by the disclosure routes.

## Which API?

- **Relational projects** (tables in the project's PostgreSQL database): this API. The platform
  embeds your text with the project's embedding provider and stores the vectors with pgvector.
- **Document data in the Data Engine** (MongoDB): the Data Engine vector routes, which store a
  vector alongside each record — one you computed, or one the platform computes from the record's
  text — and search an entity by similarity. See
  [Data Engine API — Vectors](./data-engine-api.md#vectors).

## Plans and the daily limit

These rules apply to every request that computes an embedding for a project: store, batch,
search (the query is embedded too) and re-embed here, and the platform-computed vectors of the
Data Engine (record jobs, text search, re-embed).

- **Own key: unlimited on every plan.** A project that set its own provider key
  (`POST .../embeddings/api-key`), or its own endpoint, is never gated and never limited here; its
  provider bills it directly.
- **Platform key: Pro plan and above.** Computing embeddings with the platform's key is included
  from the Pro plan (Business, Enterprise and Legacy teams included). Below it the request answers
  `403 { "code": "EMBEDDING_PLAN_REQUIRED" }` before the provider is called.
- **Platform key: 1 000 000 tokens per project per day.** The day is the UTC day. Above it the
  request answers `429`:

```json
{ "statusCode": 429, "code": "EMBEDDING_DAILY_LIMIT",
  "message": "This project has used 1,000,000 of its 1,000,000 daily embedding tokens on the platform key. No tokens are left for today. The limit resets at 2026-11-29T00:00:00.000Z (00:00 UTC). Set the project's own provider key to embed without this limit.",
  "limit": 1000000, "used": 1000000, "remaining": 0, "resetsAt": "2026-11-29T00:00:00.000Z" }
```

  A request that would go past what is left (estimated at about four characters per token) is
  refused the same way, with `remaining` telling how much is left. Tokens are counted as the
  provider reports them. The operator sets the limit with `EMBEDDING_PROJECT_MAX_DAILY_TOKENS`
  (0 = unlimited); the platform-wide `EMBEDDING_MAX_DAILY_TOKENS` cap is separate.
- `GET status` reports `platformKeyAllowed` (this project may compute embeddings now) and
  `dailyTokens: { limit, used, resetsAt }` while the platform's key is in use (`null` on the
  project's own key).

## Public routes (`/api/rest/v1/embeddings`)

`apikey` header. Writes need the **service key**; search needs the anon key together with a
signed-in user's token (or the service key); status and disclosure accept the anon key.

| Method | Path | Tier | Purpose |
|---|---|---|---|
| POST | `/api/rest/v1/embeddings` | service | embed and store one text |
| POST | `/api/rest/v1/embeddings/batch` | service | embed and store many texts |
| POST | `/api/rest/v1/embeddings/search` | anon + user | semantic search |
| DELETE | `/api/rest/v1/embeddings` | service | delete by ids |
| DELETE | `/api/rest/v1/embeddings/namespace` | service | delete a whole namespace |
| GET | `/api/rest/v1/embeddings/status` | anon | is pgvector enabled, how many vectors |
| GET | `/api/rest/v1/embeddings/disclosure` | anon | provider, model, vector width, country, retention |

### Store

```json
POST /api/rest/v1/embeddings          { "content": "…", "namespace": "docs", "metadata": { "source": "faq" } }
POST /api/rest/v1/embeddings/batch    { "items": [ { "content": "…", "namespace": "docs", "metadata": {…} }, … ] }
```

Each item is embedded once per `(content, namespace)`: storing the same text again returns the
existing record instead of a new vector. The response is the stored record (an array of them
for `batch`, in input order): `{ id, namespace, content, metadata, … }`. 400 when `items` is
missing or an item has an empty `content`.

### Search

```json
POST /api/rest/v1/embeddings/search   { "query": "how do I reset my password", "namespace": "docs", "threshold": 0.5, "limit": 10, "filter": { "source": "faq" } }
```

`threshold` is the maximum cosine distance, a number from 0 to 2 (default 0.5; anything else is a
400). `limit` defaults to 10 and is capped at 100. `filter` is an object of at most 10 metadata
keys; a result must have every one of them with an equal value (`metadata` contains `filter`:
nested objects match by containment, arrays must contain the listed items). An empty filter
matches everything. Results:

```json
[ { "id": "…", "namespace": "docs", "content": "…", "metadata": {…}, "distance": 0.18, "score": 0.82 } ]
```

### Delete, status, disclosure

`DELETE /api/rest/v1/embeddings` `{ "ids": ["…"] }` (1 to 1000 embedding ids, each a UUID; else 400) and
`DELETE /api/rest/v1/embeddings/namespace` `{ "namespace": "docs" }` answer `{ "deleted": n }`.

`GET status` → `{ pgvectorEnabled, pgvectorEnabledAt, hasApiKey, embeddingCount, …,
platformKeyAllowed, dailyTokens }` (see [Plans and the daily limit](#plans-and-the-daily-limit)).

`GET disclosure` → the provider and model in use for this project, the vector width, the
country the text is sent to (the provider's region for hosted providers; for Ollama the host's
`PLATFORM_REGION`, or "not specified"), and the provider's retention statement — the same
object the dashboard shows, so an application can display it to its own users.

## Project routes (dashboard session)

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/projects/:projectId/embeddings/status` | session | same as the public status |
| POST | `/api/projects/:projectId/embeddings/enable` | session | create the pgvector extension and the embedding tables in the project database |
| DELETE | `/api/projects/:projectId/embeddings/enable` | session | disable (tables are kept) |
| POST | `/api/projects/:projectId/embeddings/api-key` | session | `{ "apiKey": "sk-…" }` or `{ "apiKey": null }` — a per-project key for the selected provider |
| GET | `/api/projects/:projectId/embeddings/providers` | session | the providers a project may choose from, their default models, and which platform keys exist |
| PUT | `/api/projects/:projectId/embeddings/provider` | session | `{ provider?, model?, baseUrl?, reembed? }` — switch the project's provider/model/endpoint |
| POST | `/api/projects/:projectId/embeddings/reembed` | session | re-embed every stored vector with the current provider; returns the job `{ status, done, total, model, updatedAt, finishedAt, error }` |
| GET | `/api/projects/:projectId/ai/disclosure` | session | the disclosure object |

Vectors are stored at a fixed width of 1536 dimensions. A model that produces narrower
vectors is stored zero-padded (cosine distance is unchanged); a wider model is refused.
Switching a project to a different model re-embeds its existing vectors (`reembed: true`, or
the `reembed` route) up to `EMBEDDING_REEMBED_MAX_ROWS`.

Platform-wide settings: `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_BASE_URL`,
`EMBEDDING_DIMENSIONS`, `EMBEDDING_FALLBACK_*` (a second provider used when the first fails
with an auth, quota or connectivity error), `OPENAI_API_KEY`, `OLLAMA_BASE_URL`,
`COHERE_API_KEY`, `PLATFORM_REGION`, `EMBEDDING_MAX_DAILY_TOKENS`,
`EMBEDDING_PROJECT_MAX_DAILY_TOKENS` — see
[configuration.md](./configuration.md).

## Errors

| Status | When |
|---|---|
| 400 | `Body must be { items: [{ content, namespace?, metadata? }] }`; `items[i].content must be a non-empty string`; `query must be a non-empty string`; `threshold` not a number from 0 to 2; a `filter` that is not an object or names more than 10 keys; `ids` empty, longer than 1000 or not UUIDs; `No OpenAI API key available` (no platform or project key for the provider); a model wider than the store; `pgvector is not enabled for this project` (on a document project the message also points to the Data Engine vector routes) |
| 403 | anon key on a write; `Namespace deletion requires service_role key`; `AI_DISABLED` when the installation runs with `AI_ENABLED=false`; `EMBEDDING_PLAN_REQUIRED` on the platform's key below the Pro plan |
| 404 | `Project not found` |
| 429 | `EMBEDDING_DAILY_LIMIT` — the project's daily platform-key tokens are used up (`limit`, `used`, `remaining`, `resetsAt` in the body); a provider's own rate limit or quota |
| 502 | the provider rejected the key, or could not be reached |

Source: `apps/platform-api/src/modules/tenant-embedding/tenant-embedding-public.controller.ts`,
`tenant-embedding.controller.ts`, `ai-disclosure.controller.ts`, `tenant-embedding.service.ts`,
`dto/set-embedding-provider.dto.ts`, `apps/platform-api/src/modules/embedding/embedding.service.ts`,
`project-embedding.service.ts`, `embedding-budget.service.ts`,
`apps/platform-api/src/modules/entitlement/entitlement.service.ts`.
