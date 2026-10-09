# basefyio capability scoreboard

Measured from the tree on 2026-10-09 by `tools/scoreboard/run.mjs`.
Weights are the benchmark's; the rival column is the score it assigns Supabase.

**Total: 56.4 / 100** (rival 88.5)

| # | Category | Weight | basefyio | Rival | Gap |
|---|---|---|---|---|---|
| 1 | Security & tenant isolation | 12 | 76 | 90 | 14 |
| 2 | Postgres database | 8 | 73 | 95 | 22 |
| 3 | Auto REST API | 10 | 83 | 95 | 12 |
| 4 | Authentication | 10 | 68 | 92 | 24 |
| 5 | Storage | 6 | 53 | 88 | 35 |
| 6 | Realtime | 8 | 23 | 90 | 67 |
| 7 | Edge functions | 7 | 0 | 88 | 88 |
| 8 | SDKs & CLI | 7 | 53 | 95 | 42 |
| 9 | Dashboard & developer experience | 6 | 90 | 90 | 0 |
| 10 | Self-hosting & data ownership | 6 | 58 | 60 | 2 |
| 11 | Scalability & high availability | 6 | 10 | 90 | 80 |
| 12 | Backups, branching & operations | 4 | 53 | 85 | 32 |
| 13 | AI & vector search | 3 | 69 | 80 | 11 |
| 14 | Migration & onboarding | 2 | 84 | 70 | -14 |
| 15 | Testing & code quality | 2 | 62 | 85 | 23 |
| 16 | Docs, community & ecosystem | 3 | 38 | 95 | 58 |

## Checks

### Security & tenant isolation — 76/100

- **yes** API keys are bound to their own project — apps/platform-api/src/common/guards/api-key.guard.ts:78
- **yes** key-authed SQL runs under a Postgres role, never as owner — apps/platform-api/src/common/guards/api-key-scope.contract.spec.ts:155, apps/platform-api/src/modules/projects/collection.controller.ts:35 (+6 more); owner is not a fallback
- **yes** routes declare how much key authority they need — 14 declarations — apps/platform-api/src/common/guards/api-key-scope.contract.spec.ts:58, apps/platform-api/src/modules/agent/agent-creation.controller.ts:35 (+12 more)
- **yes** the scope check cannot be bypassed by forgetting a guard — enforced inside ApiKeyGuard itself
- **yes** connection strings are not reachable with the public key — ProjectDataController is service-key only
- **yes** key-authed requests reach the audit log — audit-log.interceptor.ts records the key and its tier
- **no** SECURITY DEFINER functions cannot be called to escape RLS — /rest/v1/rpc never checks prosecdef — a definer function runs as owner
- **yes** the realtime stream goes through the key guard — stream uses ApiKeyGuard
- **no** DDL and policy verbs are denied to non-owner callers — the SQL denylist omits DDL and policy statements
- **no** audit records can be shipped to a SIEM — audit stays in the platform database only
- **50%** the panel can require a second factor — apps/platform-api/src/modules/projects/project-auth.controller.ts:320 — per project user, not for panel sign-in

### Postgres database — 73/100

- **yes** a separate database per project — apps/platform-api/src/modules/projects/projects.service.ts:1661, apps/platform-api/src/modules/sql/sql-guard.ts:13
- **yes** pgvector available — docker/postgres/Dockerfile
- **yes** PostGIS available — docker/postgres/Dockerfile
- **no** extensions created on provisioning — created: none — apps/platform-api/src/modules/projects/project-database.service.ts:6, apps/platform-api/src/modules/sql/sql-guard.ts:22 (+1 more)
- **yes** connection pooling in front of Postgres — docker-compose.prod.yml:213, docker-compose.yml:77
- **30%** per-project roles beyond the owner — roles are created (apps/platform-api/src/modules/projects/supabase-import.service.ts:1511, apps/platform-api/src/modules/sql/sql-guard.spec.ts:12 (+1 more)) but only anon/authenticated/service, no least-privilege owner split
- **50%** per-project connection limits — apps/platform-api/src/modules/pgbouncer/pgbouncer.service.ts:90, docker-compose.prod.yml:297 — a global cap, not per project
- **yes** credentials encrypted at rest — apps/platform-api/src/common/crypto/field-crypto.spec.ts:2, apps/platform-api/src/common/crypto/field-crypto.ts:9 (+1 more)

### Auto REST API — 83/100

- **yes** reads: embedded resources through foreign keys — postgrest/schema-cache.ts resolves relationships
- **yes** reads: boolean trees (or / and / not) — apps/platform-api/src/modules/projects/postgrest/builder.ts:5, apps/platform-api/src/modules/projects/postgrest/parser.ts:8 (+1 more)
- **yes** reads: full-text search operators — apps/platform-api/src/modules/projects/postgrest/builder.ts:347, apps/platform-api/src/modules/projects/postgrest/parser.ts:142 (+2 more)
- **yes** reads: JSON path traversal — apps/platform-api/src/modules/projects/postgrest/builder.ts:100, apps/platform-api/src/modules/projects/postgrest/parser.ts:45 (+2 more)
- **yes** values are bound, never interpolated into SQL — apps/platform-api/src/modules/projects/postgrest/builder.ts:64
- **no** writes use the same parser as reads — update and delete still use the old flat filter parser — no or/and/not on writes
- **yes** schemas other than public are reachable — apps/platform-api/src/modules/projects/supabase-import.service.ts:2084
- **yes** rows can be counted exactly alongside a page — apps/platform-api/src/modules/data-query/data-query.service.ts:323, apps/platform-api/src/modules/projects/postgrest/builder.ts:46 (+2 more)

### Authentication — 68/100

- **yes** email and password sign-in — apps/platform-api/src/modules/projects/project-sdk-auth.controller.ts:40
- **yes** social identity providers — apps/platform-api/src/modules/projects/project-auth.controller.ts:507, apps/platform-api/src/modules/projects/project-sdk-auth.controller.ts:241
- **yes** passwordless sign-in links — apps/platform-api/src/modules/email/email.service.ts:14, apps/platform-api/src/modules/email/templates/project-magic-link.template.ts:6 (+3 more)
- **40%** a second factor the SDK can complete — admins can require it (apps/platform-api/src/modules/projects/project-auth.controller.ts:321) but the SDK has no sign-in flow for it
- **no** phone or SMS sign-in — no phone channel
- **no** anonymous users that can be upgraded later — not supported
- **no** SAML for enterprise tenants — not supported
- **yes** an isolated realm per project — apps/platform-api/src/common/guards/api-key.guard.spec.ts:18, apps/platform-api/src/common/guards/api-key.guard.ts:62 (+9 more)
- **yes** end-user tokens are verified, not merely decoded — apps/platform-api/src/common/guards/api-key.guard.spec.ts:52, apps/platform-api/src/common/guards/api-key.guard.ts:102
- **yes** transactional email works without a third-party account — apps/platform-api/src/modules/projects/project-sdk-auth.service.ts:15

### Storage — 53/100

- **yes** buckets, upload, download, signed URLs — apps/platform-api/src/common/guards/api-key-scope.contract.spec.ts:100, apps/platform-api/src/modules/storage/storage.controller.ts:270 (+1 more)
- **yes** public and private buckets — apps/platform-api/src/common/guards/api-key-scope.contract.spec.ts:114, apps/platform-api/src/modules/storage/storage.controller.ts:103
- **yes** bucket administration is not reachable with the public key — service-key default on StorageController
- **no** per-object access policies — access is per bucket; a private object is readable by any key holder
- **yes** resumable uploads for large files — apps/platform-api/src/modules/billing/academic-domains.ts:6
- **no** image transformation on read — no transforms
- **10%** the file limit is above a few tens of megabytes — 50 MB ceiling
- **no** storage can be pointed at the customer's own object store — MinIO is wired in directly

### Realtime — 23/100

- **yes** clients can subscribe to changes — apps/platform-api/src/modules/realtime-data/realtime-data.controller.ts:69
- **no** changes are read from the database log, not only from API writes — only writes that pass through the API broadcast; direct SQL is invisible
- **no** row-level policies are applied per subscriber — every subscriber sees every change in the project
- **no** presence — who else is here — not supported
- **40%** broadcast between clients without a database round trip — apps/platform-api/src/modules/realtime-data/realtime-data.controller.ts:41, apps/platform-api/src/modules/realtime-data/realtime-data.service.ts:4 — server-to-client only, not client-to-client
- **no** more than one server can serve subscriptions — subscribers live in a process-local Map — apps/platform-api/src/modules/realtime-data/realtime-data.service.ts:50

### Edge functions — 0/100

- **no** customer code can be deployed and run — not built — no runtime for customer code
- **no** runs sandboxed — not built
- **no** triggered by HTTP, schedule and database events — not built
- **no** logs and metrics per invocation — not built

### SDKs & CLI — 53/100

- **yes** a JavaScript client — packages/sdk
- **yes** generated types from the live schema — packages/cli/src/commands/gen.ts:13, packages/cli/src/index.ts:200
- **yes** a CLI covering projects, schema and secrets — 13 commands
- **no** the CLI can take a backup and restore one — no backup or restore command
- **no** a Python client — missing
- **no** a Dart or Flutter client — missing
- **no** a Swift or Kotlin client — missing

### Dashboard & developer experience — 90/100

- **yes** a table editor — apps/admin-ui/app/dashboard/projects/[id]/tables/page.tsx:5, apps/admin-ui/components/table-editor.tsx:65 (+1 more)
- **yes** a SQL editor — apps/admin-ui/app/dashboard/projects/[id]/sql/page.tsx:5, apps/admin-ui/components/sql-editor.tsx:11 (+1 more)
- **yes** an API browser with copyable snippets — apps/admin-ui/app/dashboard/projects/[id]/embeddings/page.tsx:384, apps/admin-ui/components/query-editor.tsx:388
- **yes** logs visible from the panel — apps/admin-ui/app/dashboard/projects/[id]/database/page.tsx:247, apps/admin-ui/app/dashboard/projects/[id]/layout.tsx:332 (+1 more)
- **yes** per-project cost and usage — apps/admin-ui/app/dashboard/admin/page.tsx:301, apps/admin-ui/app/dashboard/admin/seo/page.tsx:137 (+3 more)
- **50%** a policy editor for row-level security — apps/admin-ui/components/project-activity-timeline.tsx:48, apps/admin-ui/components/project-advisor-section.tsx:69 (+1 more) — listed, not edited

### Self-hosting & data ownership — 58/100

- **yes** the whole platform runs from one compose file — docker-compose.prod.yml
- **yes** many projects on one self-hosted install — realm per project, so one install serves many
- **yes** services can be left out of the install — docker-compose.yml:100
- **40%** every image is pinned to a version — 6 of 10 on :latest — ghcr.io/${GHCR_OWNER}/basefyio-postgres:latest, minio/minio:latest, edoburu/pgbouncer:latest, ghcr.io/${GHCR_OWNER}/basefyio-api:latest, ghcr.io/${GHCR_OWNER}/basefyio-ui:latest, ghcr.io/${GHCR_OWNER}/basefyio-website:latest
- **no** an air-gapped install is possible — no offline image bundle
- **no** images are signed and ship an SBOM — neither
- **no** the customer can bring their own TLS certificate — Traefik with Let's Encrypt is the only path

### Scalability & high availability — 10/100

- **no** the API runs as more than one replica — one container
- **no** a Postgres standby exists — a single Postgres instance holds every project
- **no** failover is automatic — manual recovery only
- **no** read traffic can be sent to a replica — all reads hit the primary
- **no** metrics are exported for monitoring — no Prometheus endpoint
- **yes** a health endpoint exists — apps/platform-api/src/modules/health/health.controller.ts:8

### Backups, branching & operations — 53/100

- **yes** point-in-time recovery actually works — apps/platform-api/src/modules/projects/project-pitr.service.ts:99
- **50%** backups are automated on a schedule — .github/workflows/build-and-push.yml:86 — present but not scheduled
- **no** backups are encrypted and kept off the server — local, unencrypted
- **yes** the platform schema moves by versioned migration — versioned migrations
- **no** preview or branch environments per change — not supported
- **no** a restore has been exercised end to end — untested

### AI & vector search — 69/100

- **yes** a vector column type — pgvector in the image
- **yes** embeddings can be stored and searched through the API — tenant-embedding module
- **yes** retrieval over the project's own documents — rag module
- **no** more than one embedding provider — one provider; its key going cold stops retrieval
- **no** the model and the country data goes to are visible to the customer — not surfaced

### Migration & onboarding — 84/100

- **yes** an importer for an existing hosted project — supabase-import.service.ts
- **yes** schema, rows, users and files all come across — apps/platform-api/src/modules/projects/supabase-import.service.ts:795, apps/platform-api/src/modules/queue/import.processor.ts:192
- **yes** a second pass can fill in what a first run missed — apps/platform-api/src/modules/projects/supabase-import.service.ts:750, apps/platform-api/src/modules/queue/import.processor.ts:174
- **yes** existing client code keeps working after the move — PostgREST-compatible query parsing
- **no** an imported table keeps its primary key, so a later sync can match rows — tables arrive without keys, so the sync pass cannot match rows and a full re-import is the only repair
- **yes** the import reports a row count per table against the source — apps/platform-api/src/modules/provisioning/provisioning-executor.service.spec.ts:564

### Testing & code quality — 62/100

- **66%** a unit test suite of real size — 529 cases
- **yes** the security guards are covered — api-key.guard.spec.ts
- **yes** a tripwire on what the public key may reach — api-key-scope.contract.spec.ts
- **no** storage, realtime and auth admin are covered — 0 of 3 areas have a spec
- **20%** an end-to-end suite exercises the real stack — 2 files — smoke level
- **yes** this scoreboard is measured rather than asserted — tools/scoreboard

### Docs, community & ecosystem — 38/100

- **yes** a quickstart a developer can follow alone — README.md
- **yes** self-hosting documented — docs/seo/audit-pages.json:123, README.md:3
- **25%** API reference per module — 5 documents
- **no** installation documented in the customer's language — English only
- **no** component licences published per release — not published
- **no** more than one regular contributor — effectively one contributor
- **no** an example application — none

