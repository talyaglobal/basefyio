# basefyio — Developer Data Access, Multi‑Engine Projects, DNS & Secure External Connectivity

**Status:** Spec / implementation prompt (design first — do NOT mix into RAG Commit 2/3)
**Scope:** New product area, planned as its own module(s) and spec.
**Hard boundary:** The existing **RAG / Agent‑Memory Drizzle ownership** (the six Drizzle tables `rag_documents`, `rag_chunks`, `rag_index_jobs`, `chat_threads`, `chat_messages`, `agent_memory`) **must not be broken or extended**. Everything new here is **control‑plane Prisma**, consistent with `Plan`, `Subscription`, `ProjectInfrastructure`, `AuditLog`. Drizzle is not touched.

**Version:** `v0.8` · **Last updated:** 2026-06-09 · **Maturity:** ~95% architecture‑complete, ADR‑lockable; the only open engineering decision is the Phase‑6 secure‑gateway tech (Envoy vs HAProxy vs custom TLS front, revocation‑cache interval, Postgres routing).

### Revision history

| Version | Summary |
| --- | --- |
| v0.1 | Initial Developer Access + DNS + mTLS + OpenBao spec. |
| v0.2 | Per‑structure data model (Relational/JSON, engine hidden), Unified Data Explorer. |
| v0.3 | Migration archive + AI assessment + resumable upload + consent; Decisions #6 (archive snapshot) / #7 (JSON engine rules); Phase 0–8 reorder. |
| v0.4 | Scrubbed project‑level‑engine leftovers; §11 Migration/Backup; Migration Wizard. |
| v0.5 | Consent/authorization, AI Due Diligence report, Migration Storage Policy, Archive Billing & Reporting, Backup product navigation. |
| v0.6 | Single‑invoice line items, content/metadata immutability, `jsonBackend String?`, App Generation Preview, Restore/Replay, certificate **bundle** (incl. private key), `QueryEditorMode`/`DataEditorMode` split, Mongo/Couchbase engines internal, Phase 5/7 split. |
| v0.7 | `ProjectEngineEndpoint` (per‑engine), endpoint+access‑level cert binding, `MigrationRestoreJob`, import‑credential OpenBao custody, data residency (`region`), expanded app preview, OpenBao **CRL + cache** revocation default. |
| **v0.8** | `DataStructureStorage` layer, archive **immutable at API level**, assessment **versioning** (`supersededById`), `GeneratedApplicationPreview` extraction note, **Assessment Confidence** headline, **subdomain** host shape (no path‑based routing). |

---

## 0. Guiding principle (the product north star)

basefyio must **not lock the developer into the platform**. A developer can reach their own data **without** the basefyio UI — from `pgAdmin`, `DBeaver`, `MongoDB Compass`, a Couchbase SDK, or any external client. basefyio is the **app builder + metadata + API + permission/entitlement layer**; data access is *not* required to go through the UI.

That openness is balanced by one non‑negotiable security rule: **external DB access is mutually‑authenticated (mTLS) and entitlement‑gated.** Username/password alone is never sufficient, and there is **no password‑only fallback**.

---

## 1. Repo grounding (what already exists)

The spec builds on existing `apps/platform-api` (NestJS, Prisma control‑plane) building blocks rather than inventing parallel ones:

| Concern | Existing asset | Role in this spec |
| --- | --- | --- |
| Engine abstraction | `DataEngineService` (`@basefyio/data-engine`, relational + nosql/couchbase, `provisionTenant`, entity defs, editor‑mode notion) | Extend into the formal `DataEngine` interface + per‑engine implementations |
| Per‑project DB | `ProjectInfrastructure` (pg container host/port/admin creds, `InfraStatus`) | Source of the raw connection target behind the secure endpoint |
| Per‑team object store | `TeamInfrastructure` (MinIO) | Unchanged |
| Plans / entitlements | `Plan` (`features Json?`, `dedicatedDb`, `maxDbSizeBytes`, …), `Subscription` (`Team → Plan`, status) | Entitlement source for external access / custom domain / cert lifecycle |
| Connection pooling | `pgbouncer` module | Basis for the relational secure gateway |
| Audit | `AuditLog` (trace, actor, action, before/after) + `ProjectActivityKind` | Cert/DNS/credential audit trail |
| Project identity | `Project.slug`, `dbName`, `dbHost/Port/User/Password`, `anonKey`, `serviceKey` | Identity + legacy connection fields |

> Note on Cloudflare: basefyio does **not** use Cloudflare for its own edge/infra. Cloudflare (and GoDaddy) appear here only as **customer DNS‑provider integrations** for *their* custom domain. First release shows manual DNS records; provider OAuth/API automation is a later phase.

---

## 2. Product specification

### 2.0 Data model creation UX — REVISION (supersedes the project‑level engine choice)

> **This revises §2.1–§2.3, §4.1 and §5.** The Relational‑vs‑NoSQL decision is **no longer made at the project level**. A single basefyio project may contain **both relational tables and hierarchical JSON collections at the same time**. The choice is made **when creating each data structure** — and the JSON engine (Mongo‑style vs Couchbase‑style) is an **internal** basefyio decision the user never sees.

**Why:** forcing "SQL or NoSQL?" at project creation is a database‑expert question most users can't answer, and it artificially splits one app's data into two projects. Deciding per structure lets relational and document data live together (e.g. `Orders [SQL]` next to `AgentMemory [JSON]`) and lets basefyio pick the right engine behind the scenes. This is a UX advantage Oracle APEX and similar tools can't match.

#### Create Data flow

When the user clicks **New Table**, **New Collection**, or **Add Data Structure**, basefyio asks:

> **What kind of data do you want to store?**

Options:

1. **Relational Database Table** — best for: orders, invoices, users, products, accounting, CRM, ERP.
2. **Hierarchical JSON Collection** — best for: AI memory, documents, knowledge bases, configuration, forms, nested objects, APIs, event payloads.
3. **I don't know** — most users don't understand databases; selecting this shows a plain‑language comparison.

#### "I don't know" → comparison table

| Feature | Relational Table | Hierarchical JSON |
| --- | --- | --- |
| SQL support | Yes | Yes |
| Nested / hierarchical data | No | Yes |
| Referential integrity | Yes | No |
| AI support / text embeddings | Yes | Yes |
| JavaScript‑friendly | No | Yes |
| Major programming‑language support | Yes | Yes |
| Excel connection | Yes | No (available via the **Excelfyio** plugin) |

Buttons: **Use Relational** · **Use JSON** · **Let AI Decide**.

#### "Let AI Decide" (preferred onboarding path)

Prompt: *"Upload your data. I'll figure it out."* Accepted inputs: **Excel, CSV, JSON, XML, YAML, PDF, Word, SQL dump, NDJSON**.

The AI analyzes **structure, nesting depth, relationships, cardinality, and usage patterns**, then recommends one with reasons, e.g.:

- **Recommended: Relational** — many relationships, tabular structure, reporting workloads, transactional consistency.
- **Recommended: Hierarchical JSON** — deeply nested data, document‑centric access, flexible schema, AI‑centric workloads.

The user may still **override** the recommendation.

#### Engine choice is hidden (the 7th rule)

basefyio **never** exposes "Couchbase vs Mongo" to the user. That is purely a technical decision. The user only ever sees **Relational Table**, **JSON Collection**, or **Let AI Decide**; basefyio decides which document engine backs a JSON collection. Engine selection is therefore an internal field on the data structure, not a user‑facing project setting.

#### Terminology & badges

- Developer view: **Table** / **Collection**. Non‑technical view: **Data Structure**. Avoid DB jargon where possible.
- A storage‑model badge — **SQL** or **JSON** — is shown **everywhere**: sidebar, schema browser, data editor, API explorer.

#### Unified Data Explorer

Both structures appear in **one** explorer, e.g.:

```
Customers      [SQL]
Orders         [SQL]
Products       [SQL]
KnowledgeBase  [JSON]
AgentMemory    [JSON]
Configurations [JSON]
```

The user must not feel they are managing two databases. **basefyio is one platform with multiple storage models.**

---

### 2.0.A Migration Archive, Resumable Upload, Consent & AI Assessment (the core onboarding value)

"Let AI Decide" is **not** a one‑shot file read — it is an **archive‑first migration pipeline**, and the single most valuable onboarding screen: *"Upload your data. I'll tell you how long it takes, how risky it is, how much it costs, and what app I'll build for you."* This value must exist before DNS/cert/gateway features (which are platform operations) — hence the revised phase order in §8.

#### Archive‑first (mandatory)

- Before any upload starts, basefyio creates a **migration archive bucket** for the project on the existing MinIO bucket system (`bf-{slug}-...`; **not** the out‑of‑scope cold object‑storage subsystem).
- **All uploads land in the archive bucket first.** Nothing is analyzed or migrated directly from a live source.
- **AI analysis runs against the archive snapshot, never the live source** (Decision #6 = B). This makes support, rollback, re‑analysis, and legal audit safe and repeatable.
- A migration is **replayable** from the archive.
- The archive is **retained until the customer deletes it** — never auto‑deleted after migration.
- Archive storage is **billed separately** (see Monthly Archive Billing).

#### Resumable upload (Dropbox / OneDrive‑style)

Migrations are routinely **100 GB / 500 GB / 2 TB**, so upload must be robust and is **mandatory**:

- chunked upload;
- resumable upload (resume after interruption);
- browser‑refresh recovery;
- network‑reconnect recovery.

Per‑file upload state (offset, chunk map, checksum) is persisted so a refresh or dropped connection **resumes** instead of restarting.

#### Consent / privacy workflow (before migration starts)

Migration cannot begin until **all** of these are acknowledged, each written to **`AuditLog`** with actor + timestamp:

- Privacy Statement
- Data Ownership
- AI Analysis Consent
- Migration Risk Acceptance
- Database Access Authorization

#### AI Migration Assessment (the headline screen)

After upload, basefyio analyzes the **archive snapshot** and produces an assessment report, e.g.:

```
I found:        47 tables · 2.3M records · 14 GB
Detected:       Customers, Orders, Invoices
Recommended:    SQL  → Customers, Orders, Invoices
                JSON → AuditLogs, ProductMetadata
Estimated duration:        3 days
Human involvement:         15%
Estimated migration cost:  $1,600
Estimated data loss risk:  2.4%
```

- The report is **exportable as PDF**.
- Its recommendations feed the per‑structure SQL/JSON decision (§2.0) and the hidden JSON‑engine choice (Decision #7).

#### Monthly Archive Billing

```
Archive exists
  ↓
Monthly storage invoice repeats
  ↓
Customer deletes archive
  ↓
Billing stops
```

The archive is **not** auto‑deleted after the migration completes; while it exists, a **monthly** storage invoice recurs. Deleting the archive stops the billing.

---

### 2.1 New Project Wizard

> **Revised by §2.0.** The wizard no longer forces a project‑level Relational/NoSQL choice — a project holds **both**. It creates the project and then drops the user into the **Create Data** flow for their first structure.

Pressing **New Project** opens a developer wizard. Steps:

- **Step 1 — Project basics:** name, purpose/description, team.
- **Step 2 — Resources** (only if entitlement allows a dedicated DB): size/region.
- **Step 3 — Connection / access summary:** preview of the assigned private domain, the secure endpoint, and the entitlement state (whether external access is enabled by the current plan). Certificate is issued on creation only if entitled.
- **Step 4 — Create project**, then offer "**Add your first data structure**" → the §2.0 Create Data flow.

The per‑structure choice (and its hidden engine) is **immutable per structure** (changing kind = new structure); it is not a project‑level setting.

### 2.2 Editor mode per **structure** (engine hidden)

Editor mode follows the **storage model of the data structure**, not a project setting, and never the (hidden) engine name:

| Storage model | Primary query editor | Data editor unit | Badge |
| --- | --- | --- | --- |
| Relational table | **SQL Editor** | **New Row** (column form) | `SQL` |
| JSON collection | **JS Query Editor** (unified, engine‑agnostic) | **New Document** (JSON) | `JSON` |

- **Relational:** column/row semantics; schema, columns, types, constraints; SQL editor; external connection via the Postgres secure endpoint.
- **JSON collection:** developer writes **pure‑JS‑style** document queries — `collection.find(...)`, `collection.filter(doc => ...)`, `collection.map(...)`, `collection.reduce(...)` — regardless of whether a Mongo‑ or Couchbase‑style engine backs it. The platform runs these through a **secure sandboxed query adapter** (isolated JS runtime — e.g. `isolated-vm`/QuickJS — never `eval`; strict time/memory/IO limits, no network, no `require`).
- The aggregation‑pipeline capability may exist under the hood (and could be offered later as an **advanced** mode), but it is **never surfaced as an engine‑named editor**. External connection examples are shown for the resolved engine's client (Compass / SDK) without advertising the engine as a user choice.
- Optional **N1QL** can be a separate later mode; the first‑class JSON UX is "query like JS".

### 2.3 Table / Data Editor behaviour

The **New** button is **structure‑aware** (not project‑aware) from the same place:

- **Relational structure →** "New Row": column‑based form; `SQL` badge; schema, columns, types, constraints visible.
- **JSON structure →** "New Document": JSON editor/form; `JSON` badge; collection, document id, JSON body visible.

The UI must **always** make the storage model explicit (`SQL` vs `JSON`). It never shows the underlying JSON engine.

### 2.4 Developer Access tab (per project)

Shows everything a developer needs to connect from outside, gated by entitlement:

- Secure endpoint **domain** + **port**, **username**, **password / connection string** (private domain), **database/collection**, **SSL/mTLS** info.
- **Download certificate bundle:** connection string, username/password, **client certificate**, **private key**, and **CA certificate**. The private key is **streamed from OpenBao according to policy and never stored in the app DB** (see §3.4) — it is required for mTLS client auth.
- **Connection examples** for pgAdmin / DBeaver / Mongo Compass / Couchbase SDK — **including client‑certificate usage**.
- Credential lifecycle controls: **rotate credentials**, **rotate certificate**, **renew certificate**, **revoke certificate**, **test secure connection**.
- Placeholders for **IP allowlist**, **read‑only vs admin** credential distinction, **credentials rotation** policy.
- "**Copy connection string**" and "**Test connection**" buttons.

### 2.5 DNS screen (replaces "Domains")

The left‑menu item is named **DNS** (never "Domains"). Two sections:

**(A) basefyio private domain (top, read‑only)**
- Every project gets an **immutable** basefyio‑assigned private domain, e.g. `p_xxxxx.basefyio.com` or `project-slug.private.basefyio.com`. User cannot change it.
- Shows the **secure external DB connection string** built on the private domain. The string requires username/password **and** the client certificate; the certificate is **entitlement‑bound**.

**(B) Custom DNS settings (bottom)**
- Prompt: "**What is your domain?**" (e.g. `db.talyasmart.com`).
- On submit, the system generates **two CNAME records** (Vercel‑style):
  - **connection CNAME** — `db.talyasmart.com → p_xxxxx.basefyio.com`
  - **validation CNAME** — `_basefyio-verify.db.talyasmart.com → verify-xxxxx.basefyio.com`
- User adds these at Cloudflare / GoDaddy / any provider. First release shows **manual** records; selecting a provider shows provider‑specific instructions. Provider OAuth/API automation is a later phase.
- Flow: enter domain → system generates CNAMEs → user adds them → **Refresh / Test DNS** → system checks propagation + validation → on success the custom domain becomes **active**; on failure the missing/wrong records are shown.
- Statuses shown: private domain `active`; custom domain `pending / verified / failed`; validation CNAME status; connection CNAME status; certificate status; SSL/mTLS status.
- **Custom domain is paid.** Until verified+active, the endpoint is not "production‑ready".

---

## 3. Security model (the hard rules)

### 3.1 Mutual TLS, always

External DB access requires **all** of: `username` + `password` + `domain/endpoint` + **client certificate**. Each project gets its **own** client certificate. Without a valid certificate the connection is **refused**. There is **no** "allow password‑only access" option and **no** fallback.

This is enforced at the **secure access gateway** in front of each engine (TLS terminating/validating proxy) — not merely advertised in the connection string:

- **Postgres:** native `sslmode=verify-full` with `sslcert`/`sslkey`/`sslrootcert`; the gateway (built on the existing `pgbouncer` layer + a TLS front) validates the client cert chain and maps cert → project.
- **MongoDB‑style:** TLS with `tlsCertificateKeyFile` + `tlsCAFile` client auth.
- **Couchbase‑style:** TLS client‑certificate auth on the data/query port.

The gateway, on every new connection, checks: valid chain to basefyio CA → not expired → **not revoked** → cert's project == target project → **entitlement active** for external access. Any failure ⇒ reject.

### 3.2 Per‑project isolation

Each project has its **own** credentials, **own** client certificate, **own** endpoint/subdomain, and **own** rotation lifecycle. **A certificate issued for project A must never authenticate to project B**, another domain, or another entitlement. Cert subject/extensions bind `projectId` + the **specific `ProjectEngineEndpoint`** + **access level** (read vs read/write) + entitlement id; a cert is valid **only for the endpoint it was issued for** — so a relational endpoint (`sql.crm.basefyio.com`) and a JSON endpoint (`json.crm.basefyio.com`) get **separate certs**. The gateway enforces every part of the binding.

### 3.3 Entitlement‑gated (commercial rule)

The certificate is an **entitlement artifact** of whatever access package is sold:

- A **free** project may have a private subdomain, but **external DB access activates only if the plan/product grants it**.
- Plan‑gated capabilities: external DB access, custom domain, dedicated endpoint, read vs read/write access.
- If the **certificate is revoked**, the connection is cut **immediately**.
- If the **plan is downgraded**, the relevant certificate is **revoked or forced read‑only**.
- Without entitlement: the certificate **cannot be downloaded** and the connection endpoint **does not appear active**.
- No certificate ⇒ no connection. No bypass.

Entitlement source: `Plan.features` (JSON flags) + `Subscription.status`/plan for the project's team. A small **EntitlementService** resolves effective capabilities per project.

### 3.4 Certificate / key custody (OpenBao)

The client‑certificate package has two parts:

- **public certificate / public key** — downloadable, may be stored in the app DB / shown in UI.
- **secret private key** — **never** stored in the app/control‑plane database.

The **private key is held in OpenBao** (open‑source, Vault‑compatible — aligns with the "everything open source" rule). OpenBao is the issuing PKI + secret custody:

- basefyio runs an **OpenBao PKI** (root + intermediate CA per environment); per‑project leaf certs are issued by the intermediate.
- Private keys are generated/stored in OpenBao; the app DB stores only **references** (issuer, serial, fingerprint, OpenBao path, status, validity, projectId, entitlementId) — never the key bytes.
- Download flow: when entitled, the developer downloads the cert bundle; the private key is **streamed once** from OpenBao through the API to the client and **not persisted** server‑side outside OpenBao (and is re‑downloadable only per OpenBao policy / re‑issue).
- Revocation maintained via OpenBao PKI (CRL/OCSP) consumed by the secure gateway for fast checks.

> The original note's OpenBao detail was truncated ("Read more"); this section states the standard, safe model. Confirm any additional OpenBao policy specifics before implementation.

### 3.5 Certificate renewal / rotation / revocation

- **Manual "Renew Certificate"** button in Developer Access (and/or DNS). On click, show an explicit warning: *"This will re‑issue the certificate and revoke the previous certificate."*
- On confirm: issue **new** cert + private key (key in OpenBao) → **revoke** old cert → old connections rejected (terminate active sessions where possible) → prepare new download bundle → move old key/cert to **revoked/archived** state.
- Renewal is **project‑scoped**, passes the **entitlement** check (button disabled when not entitled), and writes a **rotation/reissue audit log** entry.
- Same flow applies to scheduled rotation and downgrade‑driven revoke/read‑only.

---

## 4. Architecture

### 4.1 `DataEngine` abstraction (formalize the existing service)

Extend `DataEngineService`/`@basefyio/data-engine` into an explicit interface backed by three implementations:

```ts
// Internal engine type — never user-facing. The user only ever chooses kind = relational | json.
type EngineType = 'relational' | 'mongodb' | 'couchbase';
// Query editor (the primary surfaced editor): relational -> 'sql', json -> 'js-query'.
type QueryEditorMode = 'sql' | 'js-query';
// Data editor unit, kept separate from the query editor.
type DataEditorMode = 'row' | 'document';
// 'aggregation' is an internal/advanced JSON capability only — never a surfaced editor.

interface DataEngine {
  readonly type: EngineType;
  createProjectDatabase(projectId: string, opts): Promise<void>;
  createCollectionOrTable(projectId: string, def): Promise<void>;
  insertRecord(projectId, target, record): Promise<Result>;
  updateRecord(projectId, target, id, patch): Promise<Result>;
  deleteRecord(projectId, target, id): Promise<Result>;
  query(projectId, query): Promise<Result>;
  getExternalConnectionInfo(projectId): Promise<ExternalConnectionInfo>; // endpoint, port, db, username, ssl/mTLS, examples — NO private key
  getQueryEditorMode(): QueryEditorMode; // 'sql' | 'js-query'
  getDataEditorMode(): DataEditorMode;   // 'row' | 'document'
}
```

- **RelationalDataEngine** — Postgres, SQL editor, table/row semantics (reuses `ProjectInfrastructure` + pgbouncer).
- **MongoDataEngine** — internal JSON engine; document collections + JSON document editor; **primary UI is still the JS Query Editor through the adapter** (aggregation stays internal, never surfaced).
- **CouchbaseDataEngine** — internal JSON engine; document collections + JSON document editor; **primary UI is the JS Query Editor through the sandboxed adapter**.

A factory resolves the engine **per data structure**, not per project: the user‑facing kind is `relational | json`; for a `json` structure basefyio internally picks the backend (`DataStructure.jsonBackend String?`, values like `mongodb`/`couchbase`; enum deferred) — never exposed in the UI. One project can therefore mix a `RelationalDataEngine` and document engines simultaneously. `getExternalConnectionInfo()` returns connection metadata + the resolved engine's client examples **with mTLS**, never secret key material and never as a user‑selectable engine.

### 4.2 Secure access gateway (per engine)

A TLS‑validating front layer that terminates/validates client certs and maps cert → project → target container, enforcing entitlement + revocation on connect. Postgres path builds on the existing **pgbouncer** module; Mongo/Couchbase use their native TLS client‑auth plus a thin policy check. The gateway is the **only** ingress to project DBs from outside.

### 4.3 PKI / Certificate service + OpenBao

- `CertificateService` wraps OpenBao PKI: `issueProjectCert`, `renewProjectCert`, `revokeProjectCert`, `getDownloadBundle`, `getStatus`. Stores only references in Prisma; keys live in OpenBao; revocation via OpenBao CRL/OCSP.

### 4.4 DNS service + provider integrations

- `DnsService`: assign immutable private domain on project creation; generate connection + validation CNAMEs for custom domains; `verifyDns` (propagation + validation check); track status; (later) Cloudflare/GoDaddy OAuth/API automation. SSL/mTLS provisioning for the endpoint (cert for the private/custom domain) tied to verification.

### 4.5 Entitlement service

- `EntitlementService.resolve(projectId)` → `{ externalDbAccess, customDomain, dedicatedEndpoint, accessLevel: 'read' | 'read-write' }` from `Plan.features` + `Subscription`. Gates cert issuance/download, endpoint activation, renew button, and gateway admission.

---

## 5. Schema additions (Prisma control‑plane — Drizzle untouched)

New Prisma models/enums (names indicative). All `project_id` FKs `ON DELETE CASCADE`.

- `enum DataStructureKind { RELATIONAL JSON }` — the **only** user‑facing choice.
- JSON backend is stored as a free‑form internal **`jsonBackend String?`** for now (values like `"mongodb"` / `"couchbase"`), **deferred to an enum later** once the engine set is final — this avoids an early migration lock while it is still unsettled whether the platform standardizes on one engine. Never shown to users.
- `model DataStructure` — `projectId`, `name`, `kind (RELATIONAL|JSON)`, `jsonBackend String?` (set internally only when `kind=JSON`), `editorMode` (derivable: `sql` for relational, `js-query` for json), `aiRecommended Boolean`, `aiReasons Json?` (from "Let AI Decide"), timestamps. A project has **many** DataStructures of **mixed** kinds; per‑structure kind is immutable. This replaces the earlier project‑level `engineType` (no engine field on `Project`).
- `model DataStructureStorage` — decouples the **logical** structure from its **physical** storage, so a JSON collection can move Mongo→Couchbase, split hot/cold, or relocate tenants/clusters **without** rewriting the `DataStructure`: `id`, `dataStructureId`, `engineType`, `endpointId` (→ `ProjectEngineEndpoint`), `version`, `active`. (Not strictly required for day‑1, but added before the first migration lands to avoid a 5‑year lock‑in; `DataStructure` keeps `jsonBackend` as the current convenience hint.)
- (For external connectivity the engine surface stays `relational | mongodb | couchbase` internally; the gateway/cert/endpoint models in §5 key off the resolved engine of each structure's backing store.)
- `model ProjectDomain` — `projectId`, `kind (PRIVATE|CUSTOM)`, `domain`, `connectionCname`, `validationCname`, `status (ACTIVE|PENDING|VERIFIED|FAILED)`, `sslStatus`, `dnsProvider?`, `verifiedAt?`, timestamps. Unique private domain per project.
- `model ProjectClientCertificate` — `projectId`, `entitlementRef`, `serial`, `fingerprint`, `subject`, `openbaoKeyPath` (reference only — **no key bytes**), `caCertRef`, `status (ACTIVE|REVOKED|ARCHIVED|EXPIRED)`, `accessLevel (READ|READ_WRITE)`, `notBefore`, `notAfter`, `issuedAt`, `revokedAt?`. Indexed by `(projectId, status)`; serial/fingerprint unique.
- `model ProjectEngineEndpoint` (renamed from `ExternalAccessEndpoint`) — a **per‑engine** endpoint with `UNIQUE(projectId, engineType)`: `projectId`, `engineType (relational|mongodb|couchbase)`, `host` (a **per‑engine subdomain**, e.g. `sql.crm.basefyio.com` for Postgres vs `json.crm.basefyio.com` for Mongo/Couchbase — **host+port, never path‑based routing**, since DB clients, mTLS and DNS all expect host+port), `port`, `username`, `credentialRef` (OpenBao — never the secret itself), `requiresClientCert (=true, enforced)`, `accessLevel (READ|READ_WRITE)`, `active`. A mixed‑storage project has **one endpoint per engine** — pgAdmin/DBeaver connect to the **relational** endpoint, Compass/SDK to the **JSON** endpoint — so there is never an ambiguous project‑wide endpoint.
- `model CertificateEvent` (or reuse `AuditLog`) — issue/renew/revoke/rotate/download audit, `projectId`, `actorUserId`, `action`, `serial`, timestamps.
- Entitlement flags live in `Plan.features` (JSON): `externalDbAccess`, `customDomain`, `dedicatedEndpoint`, `accessLevel`.
- New `ProjectActivityKind` values: `DATAENGINE_PROJECT_CREATED`, `CERT_ISSUED`, `CERT_RENEWED`, `CERT_REVOKED`, `CREDENTIALS_ROTATED`, `DOMAIN_ADDED`, `DOMAIN_VERIFIED`, `DOMAIN_FAILED`, `EXTERNAL_ACCESS_ENABLED`, `EXTERNAL_ACCESS_DISABLED`.

**Migration / Backup / Archive models (Prisma):**

- `enum MigrationArchiveStatus { CREATING ACTIVE DELETING DELETED }`
- `enum MigrationFileUploadStatus { PENDING UPLOADING COMPLETE FAILED }`
- `enum MigrationSource { USER_UPLOAD WE_IMPORT }`
- `enum MigrationRetention { TEMPORARY_30D STANDARD_1Y LONG_TERM }`
- `enum MigrationRiskLevel { LOW MEDIUM HIGH CRITICAL }`
- `model MigrationArchive` — `projectId`, `bucketName` (MinIO archive bucket), `status`, `source (USER_UPLOAD|WE_IMPORT)`, `retention MigrationRetention @default(STANDARD_1Y)`, `region` (data residency — US/EU/TR; the assessment region **must equal** the archive region so regulated data never leaves its region), `encryptedAtRest (=true)`, `consentCompletedAt?` (gate), `totalBytes`, `createdAt`, `deletedAt?`. The archive is the **authoritative migration snapshot**, isolated per customer. **Archive content is immutable** (the stored files never change); **archive metadata is mutable** (e.g. retention can be extended, status changes). Migration cannot start until `consentCompletedAt` is set and the archive is ACTIVE.
- `model MigrationArchiveFile` — `archiveId`, `filename`, `objectKey`, `sizeBytes`, `contentType`, `uploadStatus`, `uploadedBytes`, `chunkSize`, `checksum`, `resumeToken` (for resumable/chunked upload + refresh/reconnect recovery), timestamps.
- `enum MigrationRestoreMode { SAME_PROJECT NEW_PROJECT EXPORT_BUNDLE }`
- `model MigrationRestoreJob` — **first‑class** (Backup is a product): `archiveId`, `sourceProjectId`, `targetProjectId?` (null for export bundle), `mode MigrationRestoreMode`, `status`, `requestedBy`, `startedAt?`, `completedAt?`, `resultObjectKey?` (export bundle), `error?`. Every restore is auditable, not a hidden background process.
- `model MigrationImportCredential` — for **"We import"**: the source connection string (`jdbc:` / `postgres://` / `mongodb://`) is **stored in OpenBao**, never in Prisma — exactly like certificate private keys. Prisma holds only `archiveId`, `projectId`, `openbaoPath` (reference), `engineKind`, `metadataScannedAt?`, `dataReadConsentAt?`, `revokedAt?`. Credentials should be **revoked after migration completion**.
- `model MigrationAssessment` — `archiveId`, `projectId`, `tablesFound`, `recordsFound`, `sizeBytes`, `relationships`, `nestedJsonStructures`, `legacyFiles Json` (e.g. XML count), `shape (TABULAR|JSON|MIXED)`, `detectedEntities Json`, `recommendation Json` (SQL vs JSON split + hidden engine hints), `complexity (LOW|MEDIUM|HIGH)`, `confidencePct`, `fullyAutomatable Boolean`, `humanInvolvementPct`, `estimatedPeopleHours`, `estimatedManualReviewHours`, `estimatedEngineeringHours`, `estimatedDurationDays`, `hourlyRateCents` (**customer/plan‑specific** — self‑service / partner / enterprise / managed migration price differently; $100/hr is only a demo default), `estimatedCostCents`, `dataLossRiskPct`, `riskLevel MigrationRiskLevel`, `riskDrivers Json`, `mitigations Json`, `businessImpact String`, `finalRecommendation Json` (recommended/alternative/not‑recommended paths), `estimatedArchiveSizeBytes`, `estimatedMonthlyArchiveCostCents` (shown **before** purchase to avoid surprise bills), `appPreview Json` (the App Generation Preview, §11.4: estimated modules, **entities**, screens, APIs, roles, **workflows**, **automations**, **AI agents**, build minutes), `confidencePct` (**headline** in the report — see §11.4), `assessmentVersion`, `modelVersion`, `supersededById?`, `reportPdfObjectKey?`, `createdAt`. A `MigrationArchive` has **many** `MigrationAssessment`s — re‑uploading files or running a newer AI model creates a **new version** that supersedes the prior one (never overwrite). *(The `appPreview` JSON is fine for Phase 0; extract to a `GeneratedApplicationPreview` model later, once screen diagrams / role matrix / API catalog / workflow graph / AI agents become queryable objects.)*
- **Billing is single‑invoice — no separate archive billing system.** Archive storage charges are **`InvoiceLineItem`** rows of `type = MIGRATION_ARCHIVE_STORAGE` on the **existing platform `Invoice`** (one invoice: e.g. `BASEFYIO_PRO` + `AI_TOKENS` + `MIGRATION_ARCHIVE_STORAGE`). Add `enum InvoiceLineItemType { ... MIGRATION_ARCHIVE_STORAGE }` and `model InvoiceLineItem` (`invoiceId`, `type`, `description`, `quantity`, `unitPriceCents`, `amountCents`, `archiveId?`). A `MigrationArchiveLedger` (projection: `storedBytes`, `growthBytes`, `accumulatedCents`) may back the monthly statement, but it is **not** a second billing source of truth — the platform `Invoice` is authoritative. (No standalone `MigrationInvoice` model.)
- `model MigrationConsent` — **versioned + immutable** acceptance record: `archiveId`, `projectId`, `userId`, `organizationId`/`teamId`, `acceptedAt`, `ipAddress`, `privacyStatementVersion`, `riskStatementVersion`, `archivePolicyVersion`, `acceptedItems Json` (which checkboxes), `sensitiveDataFlags Json`, `dbAccessAuthorized Boolean` (for "We import"). No updates allowed — the row is immutable audit history; a re‑consent creates a **new** row. Mirrored into `AuditLog`. `MigrationArchive.consentCompletedAt` is the gate flag.

> Rationale: these are platform/control‑plane concerns (like `Plan`, `Subscription`, `ProjectInfrastructure`, `AuditLog`) → **Prisma**. Keeping them in Prisma preserves the rule that **Drizzle owns only the six RAG/agent tables**.

---

## 6. API route plan (`apps/platform-api`)

Project‑scoped, guarded by the existing `JwtOrApiKeyGuard` + team‑membership; entitlement‑checked where noted.

**Project / engine**
- `POST /projects` (wizard create) — `name`, `purpose` only. **No `engineType`, no NoSQL sub‑engine.** A project is engine‑less; structures choose their kind.
- `GET  /projects/:projectId/structures` — list DataStructures with `kind` (`relational | json`) + badge + editorMode. (No project‑level engine endpoint.)

**Data editor (structure‑aware)**
- `POST /projects/:projectId/structures` — create a structure; body `{ kind: 'relational' | 'json', name }`. The internal `jsonBackend` is chosen by basefyio (Decision #7), never accepted from the client.
- `POST /projects/:projectId/structures/:id/records` — new row (relational) / new document (json).
- `PATCH`/`DELETE /projects/:projectId/structures/:id/records/:recordId`.
- `POST /projects/:projectId/structures/:id/query` — SQL (relational) or JS query (json, sandboxed). Aggregation is an internal/advanced path, not a user‑selected engine mode.

**Developer Access**
- `GET  /projects/:projectId/access` — connection info + examples (no key). *(entitlement‑gated visibility)*
- `GET  /projects/:projectId/access/certificate/bundle` — download the **certificate bundle**: client certificate, **private key** (streamed from OpenBao per policy, never stored in app DB), CA certificate, and client examples. ***(entitlement‑gated + audited)***
- `POST /projects/:projectId/access/certificate/issue` *(entitlement‑gated)*
- `POST /projects/:projectId/access/certificate/renew` — re‑issue + revoke old. *(entitlement‑gated)*
- `POST /projects/:projectId/access/certificate/revoke`
- `POST /projects/:projectId/access/credentials/rotate`
- `POST /projects/:projectId/access/test` — server‑side secure connection test.

**DNS**
- `GET  /projects/:projectId/dns` — private domain + custom domain(s) + statuses.
- `POST /projects/:projectId/dns/custom` — submit custom domain → returns 2 CNAMEs. *(entitlement‑gated: customDomain)*
- `POST /projects/:projectId/dns/custom/verify` — Refresh/Test DNS.
- `GET  /projects/:projectId/dns/providers/:provider/instructions` — Cloudflare/GoDaddy/manual.

**Migration / Backup / Archive** — archive **content is immutable at the API level**:
- `POST /projects/:projectId/migration/archives` — create the archive bucket (before any upload).
- `POST /projects/:projectId/migration/archives/:id/files` — **allowed** (chunked/resumable upload).
- `GET  /projects/:projectId/migration/archives/:id/files` — **allowed**.
- `PUT` / `PATCH` / `DELETE` on `…/files` — **forbidden** (no individual‑file edits). Files only disappear when the **whole archive is deleted** or **retention expires**, preserving legal/audit guarantees.
- `POST /projects/:projectId/migration/archives/:id/assessments` — run/re‑run assessment (creates a new version). `GET …/assessments` lists versions.
- `POST /projects/:projectId/migration/archives/:id/restore` — body `{ mode: 'same_project'|'new_project'|'export_bundle', targetProjectId? }` → creates a `MigrationRestoreJob`.
- `DELETE /projects/:projectId/migration/archives/:id` — delete archive (confirmation required; stops billing).

---

## 7. UI component plan (`apps/admin-ui`)

**New Project Wizard:** Step1 name/purpose → (Step2 resources only if dedicated‑DB entitlement) → Step3 connection/access summary (+entitlement state) → Step4 create → "Add your first data structure" (§2.0 Create Data flow). **No "Relational vs NoSQL" step, no Mongo/Couchbase step.**

**Project left menu (final):** `Data` · `API` · `AI` · `SQL Editor / JS Query Editor` (per‑structure) · `Developer Access` · `DNS` · `Settings` — then, **separated** and at the very bottom, **`Backup`** (bold, prominent; positioned like a paid managed‑storage product, not a settings page — see §11.7).

**Project dashboard:** **Storage‑model badge** (`SQL` / `JSON`) per structure, Developer Access card, editor‑mode shortcut (SQL / JS Query / Table‑Data editor). **No engine badge** (engine is hidden).

**Developer Access screen:** endpoint domain, port, username, password, download client certificate, download CA certificate, rotate credentials, rotate certificate, **renew certificate** (with the explicit re‑issue/revoke warning), revoke certificate, test secure connection; pgAdmin/DBeaver/Compass/SDK examples showing client‑cert usage; entitlement‑aware enable/disable states.

**DNS screen:** (A) read‑only private domain + secure connection string; (B) custom domain input → generated connection + validation CNAMEs → manual provider instructions (Cloudflare/GoDaddy/manual) → Refresh/Test DNS → statuses (private active; custom pending/verified/failed; validation CNAME; connection CNAME; certificate; SSL/mTLS).

---

## 8. Implementation phases (safe commits)

Each phase = its own commit(s); each ends with a gate (prisma validate, typecheck, tests, isolation/entitlement e2e, branding/scope grep). **Nothing here touches RAG Commit 2/3 or the Drizzle tables.**

Order is **value‑first**: the user's real value is "upload your data, I'll tell you cost/risk/duration and build your app" — so migration/assessment come before platform‑operations features (DNS/cert/gateway).

- **Phase 0 — Migration Archive + Assessment spec & schema** — Prisma models for archive/file/assessment/invoice + enums + migration `ProjectActivityKind`/audit kinds; consent gating; **no** `Project.engineType` (Project has no engine field). *(prisma validate + migration dry‑run)*
- **Phase 1 — DataStructure + Unified Explorer** — `DataStructure` model (`kind` + internal `jsonBackend String?`); per‑structure CRUD (row vs document); SQL/JSON badges; Unified Data Explorer. DataEngine factory resolves per structure.
- **Phase 2 — AI Decide + Upload Engine** — archive‑first resumable/chunked upload (refresh + reconnect recovery), consent workflow, accepted formats; "Relational Table / JSON Collection / Let AI Decide" picker + comparison table.
- **Phase 3 — Migration Assessment Report** — analyze the archive snapshot → tables/records/GB, detected entities, SQL/JSON recommendation, duration, human‑involvement %, $/hour cost, data‑loss‑risk %; **PDF export**; migration log/report email with secure archive link.
- **Phase 4 — Developer Access + Entitlements** — `EntitlementService`; connection info + examples (read‑only), entitlement‑gated visibility. No certs yet.
- **Phase 5 — OpenBao + Certificates (backend lifecycle)** — PKI **issue / renew / revoke** + **bundle download** (client cert + private key from OpenBao + CA); references‑only in Prisma; entitlement + audit. **No UI yet.**
- **Phase 6 — Secure Gateway (mTLS)** — per engine (Postgres on pgbouncer first, then Mongo, then Couchbase); enforce chain + revocation + project binding + entitlement; **reject password‑only / wrong‑project / expired / revoked.**
- **Phase 7 — DNS + certificate UI polish** — private domain, custom‑domain CNAME generation, `verifyDns`, statuses, SSL/mTLS, manual provider instructions; **certificate renewal/rotation UI** (over the Phase‑5 backend) with DNS/cert **status integration** + downgrade→revoke/read‑only. (The cert *lifecycle* is Phase 5; this is UI polish + integration.)
- **Phase 8 — Provider Automation** — Cloudflare/GoDaddy OAuth/API; optional N1QL mode.

Each phase = its own commit(s) ending with a gate (prisma validate, typecheck, tests, isolation/entitlement e2e, branding/scope grep). **Nothing here touches RAG Commit 2/3 or the Drizzle tables.**

---

## 9. Acceptance criteria (merged)

**Data model / wizard / editor (revised per §2.0)**
- A single project can contain **both** relational tables and JSON collections at once.
- Creating a structure asks **Relational Table / JSON Collection / Let AI Decide** and **never** "Mongo vs Couchbase".
- "I don't know" shows the plain‑language comparison table.
- "Let AI Decide" accepts Excel/CSV/JSON/XML/YAML/PDF/Word/SQL‑dump/NDJSON, recommends Relational or JSON with reasons, and the user can override.
- Relational structure → SQL Editor + **New Row**; JSON structure → JS Query Editor + **New Document**.
- The storage‑model badge (**SQL** / **JSON**) is visible in sidebar, schema browser, data editor, and API explorer.
- Both structures appear in one **Unified Data Explorer**; the user never feels they manage two databases.
- Developer can connect to a relational structure from pgAdmin/DBeaver (and a JSON structure from the resolved engine's client) — basefyio does **not** hide or lock raw DB access from developers.

**DNS**
- Left‑menu item is **"DNS"** (never "Domains").
- Each project shows a top, **immutable** basefyio private domain; the connection string uses it.
- Bottom section accepts a custom domain and generates **two CNAMEs**; user adds them manually; **Refresh/Test DNS** validates; provider‑specific instructions shown.
- Custom domain is not "production‑ready" until verified+active.

**Security / certificates / entitlement**
- External DB access **fails** without username/password **and** client certificate; **no password‑only** path.
- Each project has its **own** client certificate; a wrong‑project cert is rejected; expired/revoked certs rejected.
- Without entitlement, the certificate **can't be downloaded** and the endpoint **isn't active**.
- Manual **Renew Certificate** works (old stops working, new works), is project‑scoped, entitlement‑checked, and **writes an audit log**.
- Private keys live in **OpenBao**, never in the app DB.
- pgAdmin/DBeaver/Compass examples show **client‑certificate** usage.
- A mixed‑storage project exposes **one endpoint per engine** (`ProjectEngineEndpoint`, unique per `projectId`+`engineType`) — relational and JSON endpoints are distinct, never an ambiguous project‑wide endpoint.
- A certificate is bound to a **specific endpoint + access level**; it is rejected on any other endpoint (e.g. a `sql.<project>.basefyio.com` cert cannot connect to `json.<project>.basefyio.com`).

**Migration / Backup / Archive**
- A migration **archive bucket** is created before any upload; all data lands in the archive first.
- AI analysis runs on the **archive snapshot**, never the live source (Decision #6 = B).
- Upload is **resumable/chunked** and survives browser refresh + network reconnect (works for 100 GB–2 TB).
- Migration **cannot start** until all five consents are recorded in `AuditLog`.
- The **AI Migration Assessment** produces tables/records/GB, tabular‑vs‑JSON‑vs‑mixed, data‑loss‑risk %, human involvement, people/hours, a **$/hour cost** estimate, and is **PDF‑exportable**.
- Archive is **retained until the customer deletes it**; a **monthly** invoice recurs while it exists and **stops** on deletion.
- **Consent gate:** the user cannot proceed without consent; **every consent is versioned** (privacy/risk/archive‑policy versions) and **audit logged**; the acceptance record is **immutable**.
- **"We import" requires additional authorization:** a metadata‑only scan runs first, and a **second explicit consent** is required before any real data is read.
- Risk disclosures are **mandatory**; **sensitive‑data warnings** are shown when applicable (and recommend assisted migration).
- The assessment report also shows the **estimated future archive size and monthly archive cost** *before* purchase (no surprise bills).
- The assessment includes a **Generated Application Preview** (modules, estimated screens/APIs/roles, build time) — the primary conversion screen.
- **Restore** is supported via a first‑class, audited **`MigrationRestoreJob`**: restore to **same project**, **new project**, or **export bundle**.
- **"We import" credentials** (connection strings) live in **OpenBao**, never in Prisma, and are revoked after completion.
- **Data residency:** an archive has a `region`; the assessment region **must equal** the archive region (US/EU/TR) — regulated data never leaves its region.
- Archive storage is billed as an **`InvoiceLineItem` (`MIGRATION_ARCHIVE_STORAGE`)** on the single platform `Invoice` — **not** a separate billing system.
- Migration rate (`hourlyRateCents`) is **customer/plan‑specific**, not a hard‑coded $100/hr.
- An archive‑created **email** (migration id, size, file count, retention, est. monthly cost, assessment summary, **secure archive link**) is sent, plus an **automatic monthly archive statement** (size, growth, monthly + accumulated cost, link, retention status).
- **Deleting an archive requires confirmation**; **all archive operations** (created/accessed/downloaded/retention‑changed/deleted) are **audit logged**.
- **Backup** appears **bold and separated at the bottom** of the left menu, positioned as a **paid managed‑storage** product; archive links and migration logs are reachable from it. (UI name is **Backup**; "KolayBackup" is never shown — internal codename only.)

**Boundaries**
- Existing **RAG/Agent‑Memory Drizzle ownership** is unchanged; all new data is Prisma.
- This work is a **new module/spec**, not mixed into RAG Commit 2/3 or the agent commits.

---

## 10. Decisions

### Resolved

**#6 — Migration source‑of‑truth → B (archive snapshot).** AI analysis, migration, support, rollback, re‑analysis and legal audit always run against the **archive snapshot**, never the live source. (Option A "live source database" is rejected.)

**#7 — JSON engine selection (internal rule set; never shown to the user).** When a structure is `JSON`, basefyio picks the backing engine by:

- small / medium documents → **Mongo‑style**
- large AI / document workloads → **Couchbase‑style**
- need offline sync → **Couchbase‑style**
- need flexible developer onboarding → **Mongo‑style**

This is encoded as `DataStructure.jsonBackend` (free‑form for now; enum later) and driven by the assessment signals (size, nesting, workload) — the user only ever sees "JSON Collection".

### Open (confirm before build)

1. **OpenBao policy specifics** (the truncated "Read more"): key re‑download policy, CA hierarchy depth, rotation cadence. **Revocation recommendation (default):** start with **OpenBao PKI CRL + a gateway cache that refreshes every N minutes** — not live OCSP. Add OCSP later only if real‑time revocation is required; the product does not need real‑time PKI complexity on day one.
2. **Secure gateway tech** per engine (pgbouncer+TLS front vs Envoy/HAProxy mTLS; Mongo/Couchbase native client‑auth) and where revocation is enforced (gateway cache vs live OCSP).
3. **Couchbase JS sandbox** runtime (`isolated-vm` vs QuickJS) and its resource/IO limits.
4. **Entitlement flag shape** in `Plan.features` (exact keys) and downgrade behavior (revoke vs read‑only) per capability.
5. **`@basefyio/data-engine`** package surface — how much of the `DataEngine` interface already exists vs needs adding.

---

## 11. Migration, Backup & Archive Product

**Backup** is the former **KolayBackup** product, brought inside basefyio. It is a first‑class product surface, distinct from (but built on) the migration archive pipeline.

### 11.1 Rules

- **Backup** appears **bold at the very bottom** of the left menu.
- A **migration archive bucket** is created **before** any upload/import begins.
- **All data goes to the archive bucket first.**
- **AI analysis runs on the archive snapshot, not the live source** (Decision #6).
- The archive is **retained until the customer deletes it** — never auto‑deleted after migration.
- Archive storage is **billed monthly**, and the monthly invoice **repeats until the customer deletes the archive**; deletion **stops billing**.
- When an archive is created, a **migration log/report email** is sent containing a **secure storage/archive link**.
- The **migration service does not start until the archive is created**.
- A customer who does **not accept the archive policy** cannot run a migration.

### 11.2 Migration Wizard

**Step 1 — Who moves the data?**
> *"Will you upload it, or should we import it for you?"*

- **You upload** — single or multiple files; **resumable/chunked** upload (refresh + reconnect recovery); lands in the archive bucket.
- **We import** — developer provides a **connection string**; basefyio first does a **metadata‑only scan** (no row data), then requires a **second, explicit consent** before reading any actual data. All read data still lands in the archive first.

**Step 2 — Consent** — Privacy Statement, Data Ownership, AI Analysis Consent, Migration Risk Acceptance, Database Access Authorization (and, for "We import", the second data‑read consent). All written to `AuditLog`.

**Step 3 — AI Migration Assessment** (from the archive snapshot), shown on screen and **PDF‑exportable**:

- how many **tables**
- how many **records**
- how many **GB**
- **tabular vs JSON vs mixed**
- **data‑loss risk %**
- whether **human involvement** is needed
- estimated **people / hours**
- **$100/hour cost calculator** → estimated migration cost
- recommended **SQL vs JSON** split (feeding §2.0 + Decision #7)

**Step 4 — Decision & build** — user accepts/overrides recommendations; structures are created per §2.0; migration replays from the archive.

> The migration archive is the durable source‑of‑truth for the whole flow; everything downstream (assessment, structure creation, support, rollback, re‑analysis, legal audit) references the snapshot, never the customer's live system.

### 11.3 Privacy, Risk & Migration Authorization (expands §11.2 Step 2 — mandatory)

Because the user may hand over Excel, customer data, financial data, or even production database access, **before any upload, scan, import, migration, or database connection is accepted**, the user must explicitly approve legal and operational disclosures. The wizard **cannot continue** until approval is complete.

**Required acknowledgements (each a checkbox):**

- **Privacy Statement** — uploaded files may contain sensitive business information; will be processed by basefyio; AI may analyze structure, metadata and content; files may be temporarily stored during migration; processed only for migration, analysis, and application generation. → ☐ *I have read and accept the Privacy Statement*
- **Data Ownership** — I own the data **or** I have legal authorization to upload/process it. → ☐ *I am authorized to provide this data*
- **Migration Risk** — automated migration may not be 100% accurate; source systems may have inconsistencies; mappings may need review; generated apps should be validated before production. → ☐ *I understand and accept migration risks*
- **AI Analysis Disclosure** — AI will inspect data; recommendations are advisory and may differ from expectations; final decisions are mine. → ☐ *I consent to AI‑assisted analysis*
- **External Database Access Authorization** *(only when "You import it for me" is selected)* — basefyio may temporarily access my DB; only supplied credentials are used; access may be read‑only or read/write per plan; access should be revoked after completion. → ☐ *I authorize temporary database access*

**Sensitive Data Declaration (optional warning):** "Does your data contain?" — Financial records · Medical information · Government data · Employee records · Customer personal information · Payment information · Regulated data. If any selected → show enhanced warning and **recommend assisted migration**.

**Risk Level Summary (after AI analysis):** Low / Medium / High / Critical, from data volume, legacy formats, schema complexity, missing documentation, sensitive information.

**Final Authorization** — *I authorize basefyio to: analyze my data, estimate migration effort, generate schemas, generate applications, perform approved migration operations.* → ☐ *I authorize migration planning*. The **Continue** button is **disabled until all required acknowledgements are accepted**.

**"We import" data‑read gate (product decision):** after the connection string is entered, AI first performs a **metadata‑only scan** (schema, table names, row counts). basefyio does **not** read actual row data until the user gives a **second** explicit consent. This builds trust and lifts enterprise sales conversion.

**Import credential custody:** the source connection string is **sensitive** and is stored in **OpenBao**, never in Prisma — the same custody rule as certificate private keys (`MigrationImportCredential.openbaoPath` holds only a reference). The credential is **revoked after migration completion**.

**Audit requirements:** store `user id`, `organization id`, `timestamp`, `IP address`, `privacy statement version`, `risk statement version`, accepted checkboxes — as **immutable** audit history (`MigrationConsent` + `AuditLog`).

### 11.4 AI Migration Assessment Report (the AI Due Diligence sales screen)

After upload or discovery scan — **before** migration starts — basefyio generates an **executive** migration report in **plain business language**: what was found, and estimates of effort, risk, cost, duration, and required human involvement. (This is the strongest sales screen: the customer sees a due‑diligence report **before** committing.)

Representative output:

- **Assessment Confidence: 92%** *(headline — communicates estimate quality at a glance: `$1,600 ± 10%` is very different from `$1,600 ± 200%`).* Elevated from the internal `confidencePct`.
- **What We Found:** 47 tables · 2.8M records · 14 GB · 126 relationships · 8 nested JSON structures · 4 legacy XML files. Primary workload: relational business data. Detected domains: Customers, Orders, Invoices, Products, Inventory, User Accounts.
- **Recommended Architecture:** SQL → Customers, Orders, Invoices, Products, Inventory · JSON → Product Metadata, Audit Events, Configuration, AI Memory.
- **Migration Assessment:** Medium Complexity · Confidence 89%.
- **Human Involvement:** Fully automated? **No** — several XML files require transformation. Manual review ≈ 12h · engineering ≈ 4h · AI‑assisted automation 85% · human intervention 15%.
- **Data Loss Risk:** 2.4% — drivers: inconsistent XML schemas, duplicate customer records, missing FK references. Mitigation: automated validation, reconciliation reports, rollback checkpoints.
- **Timeline:** 3 business days · 1 migration engineer · AI‑assisted approach.
- **Migration Cost:** 16 hours × **$100/hour** = **$1,600** · Confidence 84%.
- **Business Impact:** good candidate; no major blockers; low operational risk.
- **Estimated future archive:** size and monthly archive cost shown here too (no surprise bills).
- **Risk Levels reference:** Low (modern SQL, CSV, Excel, JSON) · Medium (mixed/inconsistent schemas) · High (legacy ERP exports, old XML, undocumented systems) · Critical (unsupported formats, corrupted data, missing schema).
- **Final Recommendation:** ✓ Import Automatically · ✓ Assisted Migration · ✗ Fully Automatic Production Cutover (manual validation advised before go‑live).
- **Export (before purchasing any migration service):** PDF Report · Executive Summary · Technical Analysis · Migration Plan · Cost Estimate.

**Generated Application Preview (the highest‑converting screen — "what app can I build from this?").** The assessment does not stop at cost/risk/duration; it previews the **actual product** basefyio will generate from the data:

- **Modules:** ✓ Customers ✓ Orders ✓ Invoices ✓ Inventory
- **Estimated Entities:** 23
- **Estimated Screens:** 18
- **Estimated APIs:** 73
- **Estimated Roles:** 4
- **Estimated Workflows:** 12
- **Estimated Automations:** 3
- **Estimated AI Agents:** 1 (e.g. an AI support agent)
- **Estimated Build Time:** 12 minutes

Entities / workflows / automations / AI‑agents map directly to basefyio's value proposition — this is much closer to the thing the customer is actually buying. It lifts conversion more than the migration‑cost screen alone — the customer sees the app they will receive, not just the bill. Stored in `MigrationAssessment.appPreview`.

**CTA:** *"We estimate this migration would take your team approximately 3 days and cost $1,600. Let basefyio handle it for you."* — the customer is now buying risk/time/cost certainty **and a previewed application**, not just an app builder.

### 11.5 Migration Storage Policy (Secure Migration Archive)

Corporate framing: not "we don't work with those who refuse," but **"migration service requires secure archive storage."**

All migration projects require a **secure archive copy** of the source data. Before analysis begins, basefyio creates a dedicated migration archive bucket. Purpose: disaster recovery, migration rollback, validation, reconciliation, auditability, and reprocessing without another customer export. **This archive is the authoritative migration snapshot.**

**Workflow:** create archive bucket → upload/import source → store **immutable** archive copy → analyze archived data → generate assessment → generate target schemas → execute migration.

**Why required:** without an archive snapshot, imports can't be reproduced, results can't be verified, rollback is hard, auditability drops, and support investigations become impossible.

**Data handling:** encrypted at rest · versioned · access‑controlled · isolated per customer · retained per the customer's retention policy · **not publicly accessible**.

**Customer acknowledgement (required before start):** *"I understand that a secure migration archive copy of the source data will be created and retained according to the selected retention policy."* → ☑ **Accept Migration Archive Policy**. Migration cannot begin until accepted.

**Retention options:** Temporary (30 days — small migrations) · Standard (1 year — business systems) · Long‑Term (customer‑defined — regulated industries).

**Architecture (consistent with the RAG decisions):** Customer Data → Migration Bucket (immutable snapshot) → AI Analysis → Migration Report → Target SQL/JSON Structures → Application Generation. AI never runs on the customer's live system.

### 11.6 Migration Archive Billing & Reporting

Productized: the migration archive is a **separate recurring revenue line** (managed storage).

**Completion report email** (sent automatically when an archive is created): migration id, archive creation date, source type, archive size, file count, retention policy, estimated monthly storage cost, migration assessment summary, **secure archive access link**. *(e.g. Archive ID `MIG‑2026‑001284` · 14.2 GB · 27 files · Retention: Active Until Deleted · Est. monthly storage $4.96/month · [Secure Archive Access].)*

**Storage subscription:** archives are managed storage billed **monthly**; **no automatic deletion**; the customer controls retention; billing continues until the customer deletes the archive.

**Archive lifecycle:** Created → Active → Monthly Billing → Customer Deletes Archive → Billing Stops.

**Monthly statement** (auto): archive id, current size, growth since last month, monthly storage cost, accumulated cost, archive link, retention status.

**Customer controls (Archive screen):** View · Download · **Restore / Replay** · Extend Retention · Delete · Export Migration Report.

**Restore / replay (KolayBackup heritage).** From the immutable archive snapshot the customer can **Restore to**: the **same project**, a **new project**, or an **export bundle** (download). Each restore is a first‑class, audited **`MigrationRestoreJob`** (`mode = SAME_PROJECT | NEW_PROJECT | EXPORT_BUNDLE`, with status + timestamps) — never a hidden background process. Because restore replays the immutable snapshot, results are reproducible.

**Delete archive** shows a confirmation warning: deleting permanently removes the source snapshot, rollback capability, audit trail, and recovery copy — user must confirm.

**Billing formula:** `Storage Cost = Stored Size × Monthly Storage Rate` (example values only, actual pricing configurable): 10 GB → $3/mo · 100 GB → $15/mo · 1 TB → $90/mo.

**Compliance:** every archive action (created/accessed/downloaded/retention‑changed/deleted) is audit logged; logs retained per platform policy.

### 11.7 Backup — product navigation & positioning

The former standalone **KolayBackup** is folded into basefyio as **Backup / Migration Archive**. In the left sidebar it is a **visually prominent item at the very bottom**:

```
Data
API
AI
Developer Access
DNS
Settings

Backup        ← bold, separated, prominent
```

- **Bold**, **separated** from normal project navigation, and feels like an **important paid infrastructure product**, not a small settings page.
- Links to: migration archive buckets, uploaded source snapshots, monthly storage billing, archive reports, restore/replay migration, delete archive, retention policy, audit logs.
- **Naming:** user‑facing product name is **Backup**; **"KolayBackup" is never shown in the UI**; internal codename may remain `backup` / `migrationArchive`.
- Treated as **paid managed storage**; monthly billing continues until the customer deletes the archive.
