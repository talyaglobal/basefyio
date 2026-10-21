# Retrieval API (`/api/projects/:projectId/rag`)

Retrieval over a project's own documents: register files that already live in the project's
storage buckets, have them chunked and embedded in the background, then search the corpus.
Indexing and searching call the embedding provider, so both are metered against the
embedding budget; the vector store has no row-level policy, so a search reads the whole
corpus — that is why every route needs the service key or a dashboard session.

## Routes

| Method | Path | Tier | Purpose |
|---|---|---|---|
| POST | `/api/projects/:projectId/rag/documents` | service | register a storage object as a document and queue its indexing |
| GET | `/api/projects/:projectId/rag/documents` | service | list documents (`status`, `limit` 1–100 default 50, `offset`) |
| GET | `/api/projects/:projectId/rag/index/status` | service | counts per status for the project |
| POST | `/api/projects/:projectId/rag/index/reindex` | service | `{ documentId?, force? }` — one document, or the whole project |
| POST | `/api/projects/:projectId/rag/index/reindex-incomplete` | service | queue every document that is not `INDEXED` |
| GET | `/api/projects/:projectId/rag/search` | service | `?q=…&limit=8&threshold=0.45` |
| GET | `/api/projects/:projectId/rag/usage` | service | embedding usage attributed to this project |

## Registering a document

```json
POST /api/projects/:projectId/rag/documents
{
  "bucketName": "handbooks",          // the project's bucket name (3-63 chars, letters, digits, hyphens)
  "objectKey": "hr/leave-policy.pdf", // the object inside it
  "title": "Leave policy",            // optional, ≤ 512 chars
  "granularity": "context",           // optional: word | sentence | context
  "chunkSize": 1200,                  // optional, 100–8000
  "chunkOverlap": 200                 // optional, 0–4000
}
```

No file is uploaded here: the object must already exist in the bucket (404 otherwise). The
response is `{ document, created }` — `created: false` when the same object was already
registered. Documents move through `PENDING → PROCESSING → INDEXED`, or `FAILED`; a document
whose source object changed becomes `STALE` until re-indexed.

## Searching

```bash
curl -s "$API/projects/$PROJECT_ID/rag/search?q=how+many+days+of+leave&limit=5" -H "apikey: $SERVICE_KEY"
```

`q` is required (≤ 2000 chars); `limit` 1–25 (default 8); `threshold` 0–1 is the maximum
cosine distance (default 0.45). Each hit is
`{ documentId, chunkIndex, title, text, score, distance, bucketName, objectKey }`, so an
application can cite the source. An empty array is returned when the embedding provider is
unavailable.

`GET index/status` → `{ documents: { "INDEXED": 12, "PENDING": 1, … }, activeJobs }`.
`GET usage` → `{ documents, chunks, tokens, byStatus }` — `tokens` is the embedding tokens
spent on this project's corpus.

## Errors

| Status | When |
|---|---|
| 400 | validation on the body or query (`bucketName must be 3-63 chars…`, `limit must not be greater than 25`, …) |
| 403 | anon key; caller not a member of the project's team |
| 404 | `Project not found`; the storage object does not exist; `Document not found` |

Source: `apps/platform-api/src/modules/rag/rag.controller.ts`, `rag.service.ts`,
`rag-indexer.service.ts`, `dto/register-rag-document.dto.ts`, `dto/reindex.dto.ts`,
`dto/rag-search.query.ts`, `dto/list-rag-documents.query.ts`.
