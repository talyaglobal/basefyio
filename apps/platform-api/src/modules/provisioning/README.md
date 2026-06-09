# Provisioning Module

API skeleton for infrastructure provisioning (Phase 3).

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/provisioning/projects` | Create a ProvisioningProject tied to a basefyio Project |
| POST | `/v1/provisioning/operations` | Create a provisioning operation (idempotent) |
| GET | `/v1/provisioning/operations/:id` | Get an operation by ID |
| GET | `/v1/provisioning/resources?provisioningProjectId=` | List resources (DB only) |

## Contract rules

- **No Hetzner calls in this phase.** All executor logic is deferred.
- **`dryRun` is required** at the API layer — no server default. `dryRun: true` immediately
  terminates the operation as `DRY_RUN` without queuing any executor.
- **Idempotency:** `POST /operations` with a previously-seen `(provisioningProjectId, idempotencyKey)`
  returns the existing operation with `idempotent: true`. No duplicate is created and no second
  audit event is written.
- **Audit events** are written for every operation creation and status transition.
  The `provisioning_audit_events` table is append-only — no row is ever updated or deleted.
- **Resources** are served from the DB only. Provider sync is a later phase.
- **No credential bytes in DB.** `ProvisioningCredentialRef.openbaoPath` is the only credential
  stored — a reference to a Vault/OpenBao secret, never the key itself.

## Schema note — Drizzle / Prisma ownership

A `src/db/drizzle/schema/provisioning.ts` file exists in the repo as a parallel schema
created by a concurrent agent. This is **temporary** and under review.

The authoritative schema for all provisioning models is **Prisma** (`schema.prisma`).
Drizzle ownership is strictly limited to the six RAG/agent tables:
`rag_documents`, `rag_chunks`, `rag_index_jobs`, `chat_threads`, `chat_messages`, `agent_memory`.

The Drizzle provisioning schema will be removed once the Prisma/Drizzle boundary is formally
reconciled. Until then, treat `drizzle/schema/provisioning.ts` as a non-authoritative artefact.

## Validation

Request bodies are validated with `class-validator` / `class-transformer` (the project-standard
NestJS validation library). The spec referenced "Zod schemas" — this module fulfils the same
intent (typed, validated request/response contracts) using the existing dependency rather than
introducing a new one.
