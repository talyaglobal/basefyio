# basefyio — RAG + Agent Memory schema specification

Strict schema for the new Drizzle-owned tables. Prisma continues to own all
existing tables; Drizzle owns only the tables in this document. One Postgres
database, two ORMs during the transition. Branding is **basefyio** only; the cold
object-storage subsystem (the distributed file store, its REST gateway, and its
external resolver) is out of scope and is never referenced.

## Ownership boundary

| Concern | Owner |
| --- | --- |
| `projects`, `teams`, `embedding_records`, `embeddings_store`, all existing tables | Prisma |
| `rag_documents`, `rag_chunks`, `rag_index_jobs` | Drizzle |
| `chat_threads`, `chat_messages`, `agent_memory` | Drizzle |

Drizzle owns **exactly these six tables and no others**: `rag_documents`,
`rag_chunks`, `rag_index_jobs`, `chat_threads`, `chat_messages`, `agent_memory`.
Future agent tables (e.g. `agents`, `agent_versions`) are **not** included yet —
they are owned by the Agent Creation module and added when that schema lands.

`projects` and `embedding_records` appear in `schema/_refs.ts` only as foreign-key
anchors. drizzle-kit must never alter them (`tablesFilter` in `drizzle.config.ts`
scopes generation to the six new tables).

## Entity relations

```
projects (Prisma, TEXT id)
   │ 1:N (FK project_id, ON DELETE CASCADE)
   ├──< rag_documents
   │        │ 1:N (FK document_id, CASCADE)
   │        └──< rag_chunks ──> rag_chunks            (prev_chunk_id self-FK, SET NULL — chained overlap)
   │                 │
   │                 └──N:1──> embedding_records       (Prisma; vector twin in embeddings_store, SET NULL)
   │ 1:N
   ├──< rag_index_jobs ──N:1(optional)──> rag_documents (document_id nullable: null = project-wide job)
   │ 1:N
   ├──< chat_threads
   │        │ 1:N (FK thread_id, CASCADE)
   │        └──< chat_messages
   │ 1:N
   └──< agent_memory ──N:1(optional)──> chat_threads (SET NULL)
                      └──N:1(optional)──> embedding_records (SET NULL)
```

Every `project_id` is a real foreign key with `ON DELETE CASCADE`, so deleting a
project removes all of its RAG and chat data atomically. `rag_chunks` and
`chat_messages` carry a denormalized `project_id` (in addition to the parent FK)
so project-scoped isolation queries never need a join — this is the tenant
isolation boundary and is indexed on every table.

### Source-object link (no bucket FK by design)

Buckets are **not** database rows — they exist only in MinIO as `bf-{slug}-{name}`
and are managed by the existing `StorageService`. A document therefore points at
its source by `(project_id, bucket_name, object_key)`:

- `UNIQUE (project_id, bucket_name, object_key)` — one document per object (the
  invariant that replaces a bucket foreign key);
- ingest validates the object exists via `StorageService` before inserting;
- `source_hash` (SHA-256 of the bytes) detects when the source changed → status
  flips to `STALE` and the document becomes eligible for `reindex-incomplete`.

## Chunking strategy is stored, not assumed

`rag_documents` persists `granularity`, `chunk_size`, `chunk_overlap`, and
`chunker_version`. This is deliberate: the overlap-vs-size "sweet spot" is data
dependent (too little overlap → broken sentence linkage → the model loses the
thread; too large a chunk → degraded embedding precision → hallucination).
Because the strategy travels with the data, re-indexing to retune is a **re-run**,
never a database refactor.

Pipeline: source bytes → `normalizeToJson()` (canonical text) → `chunk()` (standard
bounded size, chained overlap so each chunk starts before the previous ended) →
embed every chunk through the existing `EmbeddingService` → vector lands in
`embeddings_store` → `rag_chunks.embedding_record_id` links back. Retrieval ranks
by cosine distance via `VectorStoreService`.

## Reindex semantics

- `reindex` (full): re-chunks and re-embeds the target document(s) regardless of
  status.
- `reindex-incomplete`: queues **only** documents whose status is `FAILED`,
  `PENDING`, or `STALE`. `INDEXED` documents are skipped unless the caller passes
  `force=true`.

**Source change (same object, new bytes).** When the same
`(project_id, bucket_name, object_key)` reappears with a different `source_hash`,
the system does **not** create a new `rag_documents` row — it reprocesses the
existing one. When the worker reindexes an already-`INDEXED` document it keeps the
status `INDEXED` and swaps the chunks inside a single transaction, so search keeps
serving the current chunks with no gap and then atomically sees the new set.
Flipping a document to `STALE` is a separate, explicit signal ("known out of date,
reindex queued") and, per the search-visibility rule below, removes it from
default search until it is reprocessed.

**STALE detection owner.** Source-change (STALE) detection is owned by
`RagService.notifyObjectChanged()`, the single entry point a storage-event hook
calls when an object is overwritten. It marks the document `STALE` and enqueues a
REINDEX; the **worker** then performs the authoritative `source_hash` comparison
(unchanged → skipped and returned to `INDEXED`, changed → re-indexed).
Registration/ingest deliberately does **not** auto-detect changes — that would
break duplicate-ingest idempotency — so there is exactly one owner.

**Search visibility.** Search hydration returns chunks from `INDEXED` documents
**only** by default; `STALE`, `FAILED`, and `PROCESSING` documents are excluded so
retrieval never surfaces stale or partial content. Callers may opt in to
non-indexed documents explicitly (`includeNonIndexed`).

## Metadata strategy

Strict by default: anything queried, filtered, or enforced is a typed column. A
single typed `jsonb metadata` column per table holds only extensible, non-indexed
extras, each with a TypeScript contract — never a loose untyped blob.

| Table | Typed columns (enforced) | `metadata` jsonb (extras only) |
| --- | --- | --- |
| `rag_documents` | status, granularity, chunk_size, chunk_overlap, chunker_version, source_hash, chunk_count, token_count, indexed_at | `RagDocumentMetadata` (filename, labels, source) |
| `rag_chunks` | chunk_index, start/end_offset, overlap_chars, token_count, content_hash, prev_chunk_id, embedding_record_id | none (all structured) |
| `rag_index_jobs` | kind, status, dedupe_key, attempts, total/processed_docs, total_chunks | none |
| `chat_messages` | role, token_count | `ChatMessageMetadata` (toolName, toolCallId) |
| `agent_memory` | kind, importance, embedding_record_id, expires_at | `Record<string, unknown>` |

Enums are real Postgres enums (`rag_document_status`, `rag_granularity`,
`rag_index_job_status`, `rag_index_job_kind`, `chat_role`, `agent_memory_kind`).

## Idempotency & invariants (tested)

- `rag_index_jobs (project_id, dedupe_key)` is `UNIQUE`. Dedupe-key lifetime is
  **Option A**: a key is globally unique within a project and is **never reused**,
  even after completion. INDEX keys are content/document-addressed and carry no
  nonce, so re-ingesting the same object collides on the key and is an idempotent
  no-op. REINDEX and REINDEX_INCOMPLETE keys carry a nonce (timestamp), so an
  explicit reindex always gets a fresh key and runs again — a completed reindex
  never becomes one-shot.
- `rag_chunks (document_id, chunk_index)` is `UNIQUE` — reindex replaces chunks
  deterministically.
- `rag_documents (project_id, bucket_name, object_key)` is `UNIQUE` — the
  source-object invariant.
- Chunk chain: `chunk[i].start_offset < chunk[i-1].end_offset` whenever overlap
  > 0 (verified by the chunker unit checks).

## Agent / chat memory

`chat_threads` → `chat_messages` capture the conversation; `agent_memory` holds
short-term, long-term, and summary entries. Long-term memory links to
`embedding_records`, so it is retrievable by the same cosine search as RAG chunks.
`agent_id` is currently a loose `text` column (no FK): the agent table is owned by
the Agent Creation module and each agent gets its own spec — the FK is added when
that schema lands, rather than pre-committing to a shape this module does not own.

> Open item (resolved): the cold object-storage gateway will **not** be
> reopened. Chat memory lives in these Postgres Drizzle tables in v1 — there is no
> gateway. If a separate data-plane database is introduced later, its migration
> path is designed separately; it does not change the v1 boundary.

## Repository-enforced invariants (not expressible as single-column FKs)

These cross-row consistency rules are enforced in the repository and covered by
tests (a composite FK would be the stronger DB-level guarantee, noted for later):

- `rag_chunks.project_id` must equal its parent `rag_documents.project_id` — a
  chunk cannot be inserted under a different project than its document.
- `chat_messages.project_id` must equal its parent `chat_threads.project_id`.
- `agent_memory.thread_id`, when set, must belong to the same project as the
  memory row (a Project A thread cannot anchor a Project B memory).
- `rag_documents.source_hash` must be non-null once status reaches `INDEXED` —
  enforced in `RagRepository.patchDocument`, which checks the final row state
  (allowed if the patch carries a hash or the existing row already has one).
- `updated_at` is refreshed on every update both via Drizzle `$onUpdate` and by
  the repository setting it explicitly, so title/metadata-only edits still bump it.
- `agent_memory.importance` is constrained to 0–100 (DB check + repository
  validation).
