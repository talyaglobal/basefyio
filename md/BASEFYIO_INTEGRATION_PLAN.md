# basefyio — app-provider-backend Entegrasyon Planı

> **Amaç:** `app-provider-backend` (APB) içindeki değerli platform özelliklerini **basefyio**'ya taşımak.
> **Marka:** Tüm yeni/taşınan kodda marka adı **yalnızca `basefyio`** olacak. `kolaybase`, `nfyio`, `app-provider`, `Hetzner-branded` isimleri yeni kodda kullanılmayacak (Hetzner yalnızca provider adı olarak kalır).
> **Tarih:** 2026-06-08

---

## 0. Yönetici Özeti

basefyio hedefi şu denkleme genişliyor:

```
basefyio =
    app/database metadata
  + bucket/pro-bucket            (MEVCUT — korunacak)
  + RAG storage                  (kısmen mevcut — tamamlanacak)
  + agent creation/runtime       (YENİ)
  + private infra provisioning   (kısmen mevcut — genişletilecek)
  + private network/data plane   (YENİ)
  + local/private LLM runtime    (YENİ)
  + k3s runtime environment      (YENİ)

nfyio =
    public app deployment + domain + hosting + delivery   (basefyio'nun KAPSAMINDA DEĞİL)
```

**Kritik tespit:** basefyio zaten NestJS + Prisma + PostgreSQL(+pgvector) + MinIO + BullMQ + Keycloak üzerine kurulu ve aşağıdaki temellere **zaten sahip**. Bu nedenle taşıma "sıfırdan inşa" değil, "mevcut modüllere yapışma" işidir.

| İhtiyaç | basefyio'da mevcut olan | Durum |
|---|---|---|
| Bucket / pro-bucket | `storage` modülü + MinIO + `Project.dedicatedStorage`, `maxStorageBytes`, `storageBytes` | ✅ Var — **taşınmayacak** |
| Vektör altyapısı | `embedding` + `tenant-embedding` modülleri, `EmbeddingRecord`, `embeddings_store` raw tablosu, `pgvector` | ✅ Var — RAG bunun üstüne |
| RAG iskeleti | `ai/rag.service.ts`, `Project.pgvectorEnabled`, `embeddingApiKey` | 🟡 Kısmen — tamamlanacak |
| Infra provisioning | `infrastructure` modülü, `ProjectInfrastructure`, `InfraStatus` enum | 🟡 Sadece PG container — genişletilecek |
| İş kuyruğu | `queue` modülü (BullMQ + ioredis) | ✅ Var — job'lar buna |
| Audit/log | `ProjectActivityLog`, `AuditLog`, `observability` modülü | ✅ Var — yeni kind'lar eklenecek |
| Auth/tenant scoping | Keycloak + `projects`/`teams` + RLS (`scripts/backfill-rls.ts`) | ✅ Var — yeni tablolar buna bağlanır |

---

## 1. Sınırlar ve İlkeler

### 1.1 Taşınmayacak — Cold Storage
- Cold storage / S3 / SeaweedFS / object-storage **yeniden taşınmayacak.**
- basefyio'daki mevcut **bucket / pro-bucket** modeli (MinIO tabanlı `storage` modülü) korunur.
- RAG ve agent özellikleri **mevcut bucket modeline bağlanır**, paralel bir storage katmanı kurulmaz.
- APB'deki `storage/seaweed`, `storage/proxy-api`, `backend/srv/object-storage/*`, `backend/lib/storage-resolver.ts` → **kopyalanmaz.** Yalnızca RAG ile kesişen sözleşmeler (embedding arama API şekli) referans alınır.

### 1.2 Mimari ilkeler
- **Control plane / Data plane ayrımı:** `platform-api` (control plane) provisioning, metadata, policy yönetir; veri düzlemi (DB, vektör, bucket, agent memory, LLM) tenant'ın private network'ünde kalır.
- **Default deny:** Yeni firewall/network kaynakları varsayılan olarak her şeyi reddeder; public exposure **explicit** olur.
- **Tenant isolation zorunlu:** Her yeni tablo `projectId` (ve gerektiğinde `teamId`) ile scope'lanır, RLS backfill akışına dahil edilir.
- **Internal-by-default:** Database, vector DB, bucket/pro-bucket, RAG store ve agent memory mümkün olduğunca private network içinde; public endpoint yalnızca API gateway / dashboard / explicit published app için.

### 1.3 Rebrand kuralları
- Yeni kodda marka **sadece `basefyio`**.
- Paket adı deseni: `@basefyio/*` (mevcut `@basefyio/platform-api` ile uyumlu).
- Tablo adları snake_case, Prisma model adları PascalCase (mevcut konvansiyon).
- `kolaybase` kalıntıları (platform-api/src'de ~7 referans) yeni dosyalara taşınmaz; dokunulan dosyada görülürse `basefyio`'ya çevrilir.

---

## 2. Modül Modül Entegrasyon Planı

Her modül için: **Kaynak (APB)** → **Hedef (basefyio)** → **Şema** → **API** → **İş sırası**.

> Genel kural: APB Deno + raw-SQL + Drizzle; basefyio NestJS + Prisma + raw `pg`. Taşımada **mantık ve şema** alınır, **runtime/ORM** basefyio konvansiyonuna çevrilir. Drizzle tabloları Prisma modeline, Oak route'ları NestJS controller+service'e dönüştürülür.

---

### Modül 1 — RAG Storage  *(tamamlama)*

**Kaynak (APB):** `backend/srv/object-storage/search-embeddings.ts`, `get-embedding-status.ts`, `reindex-embeddings.ts`, `reindex-embeddings-incomplete.ts`, `get-embedding-usage.ts`; route `backend/routes/object-storage.routes.ts`; embedding modelleri `enumEmbedingModels` (`text-embedding-3-small/large`, `voyage-3.5-lite`).

**Hedef (basefyio):** mevcut `modules/embedding`, `modules/tenant-embedding`, `modules/ai/rag.service.ts` üzerine inşa. **Yeni storage katmanı kurma** — chunk/embedding metadata mevcut `EmbeddingRecord` + `embeddings_store` ile aynı hat üzerinden gider.

**Yeni/genişletilen Prisma modelleri** (control-plane metadata; gerçek vektör `embeddings_store` raw tabloda kalır):
- `RagDocument` — `id, projectId, bucketId (mevcut bucket'a FK/ref), objectKey, fileType, title, status(enum), checksum, sizeBytes, createdAt`. **Doküman bucket'a bağlanır** (pro-bucket dahil), ayrı dosya deposu yok.
- `RagChunk` — `id, documentId, projectId, chunkIndex, tokenCount, embeddingRecordId(→ EmbeddingRecord), metadata Json`.
- `RagIndexJob` — `id, projectId, documentId, status, model, chunksTotal, chunksDone, error, startedAt, finishedAt` (reindex/incomplete-recover için).
- `Project` alanları zaten var: `pgvectorEnabled`, `pgvectorEnabledAt`, `embeddingApiKey` → yeniden kullan.

**Workspace/project ayrımı:** `projectId` zorunlu; doküman → bucket → project zinciri. RLS'e dahil et.

**API (NestJS, `RagController`):**
```
POST   /projects/:projectId/rag/documents              (bucket'a yüklenmiş objeden ingest başlat)
GET    /projects/:projectId/rag/documents
GET    /projects/:projectId/rag/index/status
POST   /projects/:projectId/rag/index/reindex
POST   /projects/:projectId/rag/index/reindex-incomplete
GET    /projects/:projectId/rag/search?query=&limit=&threshold=
GET    /projects/:projectId/rag/usage
```
Arama sözleşmesi APB ile aynı: `query, limit(1-25, def 8), threshold(0-1, def 0.3), objectKey?, fileType?` → skorlu chunk + kaynak metadata döner.

**İş sırası:** chunking + embedding job'ları `modules/queue` (BullMQ) içinde bir `rag-index` queue olarak. Embedding çağrısı `ai`/`embedding` servisindeki OpenAI client'ı kullanır (per-project `embeddingApiKey`, fallback platform key).

---

### Modül 2 — Agentic Storage  *(yeni)*

**Kaynak (APB):** `agent-service/lib/db.ts` (tablo bootstrap), `services/thread-repository.ts`, `services/audit-repository.ts`. Tablolar: `agent_threads`, `agent_messages`, `agent_runs`, `agent_tool_calls`, `agent_policy_events`.

**Hedef (basefyio):** yeni `modules/agent` (control-plane metadata) + agent memory/log verisi tenant DB'sinde. Tenant tuple APB'de `(userUid, workspaceUid, projectUid)`; basefyio'da **`(projectId, teamId, userId)`** olarak normalize edilir.

**Yeni Prisma modelleri:**
- `AgentThread` — `id, projectId, teamId, userId, title, status(active|archived), createdAt, updatedAt`. Index: `(projectId, teamId, userId)`.
- `AgentMessage` — `id, threadId, role(system|user|assistant|tool), content, metadata Json, createdAt`. Index: `(threadId, createdAt)`.
- `AgentToolCall` — `id, runId, threadId, toolId, input Json, output Json, status(allowed|denied|success|failed), latencyMs, deniedReason, createdAt`.
- `AgentPolicyEvent` — `id, runId, toolCallId?, decision(allow|deny), reasonCode, matchedRule, createdAt`.
- `AgentMemory` — `id, agentId, projectId, key, value Json, kind(fact|retrieval_log|source_ref), createdAt` (agent okunabilir/yazılabilir kalıcı bellek + retrieval log + kaynak belge referansları).

**İzin modeli:** her sorgu `projectId` (+ gerektiğinde `teamId/userId`) ile filtrelenir; cross-tenant sızıntı yok. Mevcut Keycloak guard + RLS akışına bağlanır. Mutating tool'lar default-deny (bkz. Modül 3 policy).

**API (`AgentMemoryController` / thread kısmı):**
```
POST   /projects/:projectId/agent/threads
GET    /projects/:projectId/agent/threads
GET    /projects/:projectId/agent/threads/:threadId
GET    /projects/:projectId/agent/threads/:threadId/messages
POST   /projects/:projectId/agent/threads/:threadId/messages
```

---

### Modül 3 — Agent Creation  *(yeni)*

**Kaynak (APB):** `agent-service/agent/runner.ts` (sistem promptu + döngü), `lib/config.ts` (model/provider config), `tools/registry.ts` + `tools/builtin.ts` + `tools/types.ts` (tool seçimi, Zod şema, risk/mutating), `lib/policy-gateway.ts` (policy). APB'de agent **thread-tabanlı / entity'siz** — basefyio'da **birinci sınıf entity** olarak modelliyoruz (versiyonlama kullanıcı talebi).

**Hedef (basefyio):** `modules/agent`, mevcut `modules/ai` (OpenAI client) ve `modules/queue` ile entegre. LangChain bağımlılığı opsiyonel; basefyio mevcut `openai` SDK'sı ile başlanabilir.

**Yeni Prisma modelleri:**
- `Agent` — `id, projectId, teamId, name, slug, description, status, currentVersionId, createdAt, updatedAt`. Agent → project/app/database ilişkisi `projectId` üzerinden.
- `AgentVersion` — `id, agentId, version(int), systemPrompt, model, provider(default openai|nebius-private), temperature, maxTokens, maxSteps, toolsConfig Json, modelConfig Json, createdBy, createdAt`. (**versioning** — agent tanımı immutable snapshot'lar.)
- `AgentRun` — `id, agentId, agentVersionId, threadId, projectId, status(running|completed|failed|cancelled), stepCount, latencyMs, errorCode, createdAt, finishedAt`. (Modül 2/4 ile paylaşılır.)
- `AgentTool` — kayıtlı tool kataloğu: `id, toolId, description, inputSchema Json, risk(low|medium|high), mutating Bool, enabled`.

**Tool registry:** APB'nin `semantic_search`, `get_bucket_metadata`, `get_thread_memory`, `analytics_*`, `rag_pipeline_*`, `external_http_fetch` tool'ları basefyio servislerine bağlanacak şekilde portlanır (`semantic_search` → Modül 1 RAG search; bucket metadata → mevcut `storage` modülü).

**Policy gateway (default-deny):** APB `policy-gateway.ts` mantığı bir NestJS guard/service'e taşınır:
1. tenant context zorunlu, 2. tool kayıtlı olmalı, 3. mutating tool'lar `AGENT_ALLOW_MUTATING_TOOLS` olmadan reddedilir, 4. `external_http_fetch` allowlist'e sınırlı, 5. analiz satır/gün limitleri. Her karar `AgentPolicyEvent`'e yazılır.

**Model/provider config:** `provider` alanı `openai` veya **private Nebius LLM** (Modül 8) olabilir; API key gerektirmeden private inference desteklenir.

**API (`AgentController`):**
```
POST   /projects/:projectId/agents
GET    /projects/:projectId/agents
GET    /projects/:projectId/agents/:agentId
PATCH  /projects/:projectId/agents/:agentId
POST   /projects/:projectId/agents/:agentId/versions
GET    /projects/:projectId/agents/:agentId/versions
POST   /projects/:projectId/agents/:agentId/run        (stream=true → SSE)
POST   /projects/:projectId/agents/:agentId/runs/:runId/cancel
```

---

### Modül 4 — Agent'e Bağlı Özellikler  *(yeni — Modül 2/3 ile birlikte)*

**Kaynak (APB):** `agent-service/routes/agent.routes.ts`, `lib/analysis.ts` (citation/grounding), `lib/types.ts` (`Citation`, `GroundingMeta`, SSE event'leri), `backend/routes/agent.routes.ts` (gateway), `backend/routes/chat.routes.ts`.

**Hedef özellikler:**
- **Run/session kayıtları** → `AgentRun` (Modül 3).
- **Conversation/thread** → `AgentThread` + `AgentMessage` (Modül 2).
- **Tool execution records** → `AgentToolCall` (Modül 2).
- **Knowledge base bağlantısı** → run isteğinde `bucketId`/`ragScope`; `semantic_search` tool'u Modül 1'e gider. Mevcut bucket + RAG store knowledge base'i oluşturur.
- **File/document attachment ilişkileri** → `AgentRun`/`AgentThread` ↔ `RagDocument` arası `AgentAttachment` (id, threadId/agentId, documentId, projectId).
- **Audit/logging** → `AgentToolCall` + `AgentPolicyEvent` + mevcut `ProjectActivityLog`/`AuditLog`'a yeni kind'lar (`AGENT_CREATED`, `AGENT_RUN_EXECUTED`, `AGENT_TOOL_DENIED`, `RAG_DOC_INGESTED`).
- **Permission boundaries** → policy gateway (Modül 3) + tenant scope (Modül 2).
- **Citation & grounding** → run yanıtında `citations[]` (`sourceType, sourceId, title, locator, excerpt, score`) + `grounding{toolBacked, evidenceQuality}`. SSE event şeması APB ile aynı: `run_start, step, tool_start, tool_end, final, [DONE]`.

---

### Modül 5 — Hetzner Server Provisioning  *(yeni — infrastructure genişletme)*

**Kaynak (APB):** `backend/srv/hetzner/*` (`hetzner-client.ts`, `repository.ts`, `lifecycle.ts`, `action.ts`, `request.ts`, `cloud-init.ts`, `decommission.ts`, `status.ts`, `metrics.ts`, `encryption.ts`, `env.ts`), `backend/routes/hetzner.routes.ts`, jenerik provider abstraction `backend/srv/cloud/{provider-registry,types,routes}.ts` + `providers/hetzner.ts`. Tablolar: `T110_DedicatedServers`, `T111_DedicatedServerSshKeys`, `T112_DedicatedServerEvents`, enum `enum_dedicated_server_statuses`.

**Hedef (basefyio):** mevcut `modules/infrastructure`'ı genişlet. **Provider abstraction** (`CloudProvider` arabirimi) port edilir; Hetzner ilk implementasyon, Nebius (Modül 8) ikinci. SSH anahtarı / secret'lar APB'deki `encryption.ts` deseniyle şifreli saklanır.

**Yeni Prisma modelleri:**
- `CloudServer` (≈ T110) — `id, projectId, teamId, provider(hetzner|nebius), providerServerId, name, location, serverType, image, status(enum: requested|provisioning|installing|ready|failed|decommissioning|decommissioned), internalIp, publicIp, networkId?, sshKeyId?, provisioningMeta Json, createdAt, updatedAt`.
- `CloudSshKey` (≈ T111) — `id, projectId, name, publicKey, encryptedPrivateKey?, providerSshKeyId, createdAt`.
- `CloudServerEvent` (≈ T112) — `id, serverId, projectId, type, payload Json, createdAt` (provisioning audit).

**FSM:** APB'nin 7 durumlu state machine'i (`requested → provisioning → installing → ready / failed → decommissioning → decommissioned`) `modules/queue` job'ları olarak (provision → poll → install-watch → decommission). Idempotent.

**Operasyonlar:** create / destroy(decommission) / rebuild / resize → controller action'ları + job'lar. Org/project scoped kayıt (`projectId`/`teamId`).

**API (`CloudServerController`):**
```
POST   /projects/:projectId/servers
GET    /projects/:projectId/servers
GET    /projects/:projectId/servers/:serverId
POST   /projects/:projectId/servers/:serverId/actions   (rebuild|resize|reboot|destroy)
POST   /projects/:projectId/ssh-keys
GET    /projects/:projectId/ssh-keys
```

---

### Modül 6 — Virtual Private Network  *(yeni)*

**Kaynak (APB):** `backend/srv/networkings/*`, tablo `T710_Networkings`. ⚠️ APB'de bu **çoğunlukla placeholder/kayıt** seviyesinde (gerçek Hetzner private-network API provisioning'i tam değil). basefyio'da bunu **gerçek provisioning'e** tamamlıyoruz.

**Hedef (basefyio):** `modules/infrastructure` altında network alt-domaini. Hetzner Cloud **Networks/Subnets API** ile gerçek private network + subnet oluşturma; sunucular bu network'e bağlanır; internal IP assignment.

**Yeni Prisma modelleri:**
- `PrivateNetwork` — `id, projectId, teamId, provider, providerNetworkId, name, cidr, region, status, createdAt`.
- `NetworkMembership` — `id, networkId, memberType(server|project|runtime|agent), memberId, internalIp, createdAt`. (Üyelik modeli: **server↔network, project↔network, agent/runtime↔network**.)

**İlke:** servisler public internet yerine internal network üzerinden haberleşir; **data internal kalır, public exposure explicit** (Modül 7 firewall ile zorlanır).

**API:**
```
POST   /projects/:projectId/networks
GET    /projects/:projectId/networks
POST   /projects/:projectId/networks/:networkId/members
DELETE /projects/:projectId/networks/:networkId/members/:memberId
```

---

### Modül 7 — Internal Data Boundary  *(yeni — politika + firewall)*

**Kaynak (APB):** `backend/srv/firewall/*`, tablo `T045_Firewall`, enumlar `enum_firewall_types` (`ipv4|ipv6|hostname`), `enum_firewall_actions` (`allow|deny|block|challenge|...|bypass`). (APB'de Cloudflare WAF'a da bağlı; basefyio'da **network-level firewall**'a odaklanılır, WAF opsiyonel.)

**Hedef:** Modül 5/6 üstünde bir **default-deny** firewall katmanı + control/data plane ayrımını zorlayan policy.

**Yeni Prisma modelleri:**
- `FirewallRule` — `id, projectId, networkId?, serverId?, direction(in|out), type(ipv4|ipv6|hostname), action(allow|deny), port?, protocol?, source, priority, enabled, createdAt`.
- Varsayılan rule set: **tüm inbound deny**, yalnızca API gateway / dashboard / explicit published app için açık kurallar.

**Data boundary politikası (kod + dokümante edilmiş invariant):**
- Database, vector DB (pgvector), bucket/pro-bucket (MinIO), RAG store, agent memory → private network içinde, public IP'siz.
- Public endpoint **yalnızca**: API gateway, dashboard, explicit published app.
- Control plane (`platform-api`) ↔ data plane ayrımı: control plane internal network'e management arayüzünden erişir; tenant verisi control plane'e taşınmaz.
- Her yeni tablo `projectId` ile tenant-scoped + RLS.

**API:**
```
POST   /projects/:projectId/firewall/rules
GET    /projects/:projectId/firewall/rules
PATCH  /projects/:projectId/firewall/rules/:ruleId
DELETE /projects/:projectId/firewall/rules/:ruleId
```

---

### Modül 8 — Nebius / Local-Private LLM Runtime  *(yeni)*

**Kaynak (APB):** Nebius **kodda yok** (doğrulandı). Mevcut `backend/srv/models/*` + `backend/srv/providers/*` model/provider registry'si var — yeni bir GPU/LLM provider bunun ve `cloud/provider-registry.ts` abstraction'ının üstüne oturur.

**Hedef (basefyio):** `modules/ai` + yeni provider abstraction. İki katman:
1. **GPU provisioning** — Nebius GPU instance oluşturma, Modül 5'teki `CloudProvider` abstraction'ına `nebius` provider'ı eklenerek (location/type/image yerine GPU SKU/region).
2. **LLM runtime** — provisioned instance üzerinde **Ollama / vLLM / TGI** benzeri runtime deploy; model seçimi, deployment config, health check, lifecycle.

**Yeni Prisma modelleri:**
- `LlmProvider` — `id, projectId?, kind(openai|nebius|ollama|vllm|tgi), name, endpoint, region, credentialsRef(encrypted), status, createdAt`. (Platform veya project scoped.)
- `LlmDeployment` — `id, providerId, projectId, serverId?(→ CloudServer), model, deployConfig Json, status(provisioning|ready|failed|stopped), healthState, lastHealthAt, createdAt`.
- `LlmCallLog` — `id, projectId, deploymentId?, agentRunId?, model, promptTokens, completionTokens, latencyMs, costEstimate, createdAt`. (Metering/logging basefyio kayıtlarına bağlı; mevcut `UsageRecord`/billing ile ilişkilendir.)

**Agent entegrasyonu:** `AgentVersion.provider = nebius-private` seçilince agent, public API key gerektirmeden private Nebius inference endpoint'ine bağlanır. LLM çağrı metering'i `LlmCallLog` + `AgentRun`'a bağlanır.

**API:**
```
POST   /projects/:projectId/llm/providers
GET    /projects/:projectId/llm/providers
POST   /projects/:projectId/llm/deployments
GET    /projects/:projectId/llm/deployments/:id/health
POST   /projects/:projectId/llm/deployments/:id/actions   (start|stop|redeploy)
```

---

### Modül 9 — K3s Kubernetes Environment  *(yeni)*

**Kaynak (APB):** `backend/srv/regional/*` (`k3s-client.ts`, `pod-manifest.ts`, `lifecycle.ts`, `fsm.ts`, `repository.ts`, `env.ts`), `backend/drizzle/0019_regional_pods.sql`. Pod manifest builder (postgres, redis, seaweed, proxy-api), K3s API client (Server-Side Apply + bearer token), 6 durumlu FSM (`requested → provisioning → ready / failed → decommissioning → decommissioned`), per-region nodeSelector + wildcard TLS. Tablolar: regional pods/events/buckets (`T113/T114/T115`).

**Hedef (basefyio):** `modules/infrastructure` altında `k3s` alt-domaini. APB'nin regional-pod mantığı **per-project runtime namespace** modeline genelleştirilir. Hetzner veya Nebius (Modül 5/8) üzerinde k3s cluster; internal network (Modül 6) üzerinden cluster iletişimi.

> **Cold-storage notu:** APB pod manifest'i SeaweedFS + proxy-api deploy ediyor. basefyio'da bucket/pro-bucket **mevcut MinIO `storage` modülüyle** karşılanır → manifest'ten **Seaweed/proxy-api çıkarılır**, yerine basefyio data-plane servisleri (postgres, redis, pgvector, agent runtime, local LLM gateway) konur.

**Yeni Prisma modelleri:**
- `K3sCluster` — `id, projectId, teamId, provider, controlPlaneServerId(→ CloudServer), networkId(→ PrivateNetwork), region, status(FSM), kubeconfigRef(encrypted), createdAt`.
- `K3sNode` — `id, clusterId, serverId(→ CloudServer), role(control-plane|worker), status, lastHeartbeatAt`.
- `K3sDeployment` — `id, clusterId, projectId, namespace, kind(rag|vector-db|agent-runtime|llm-gateway), manifest Json, status, healthState, createdAt`. (Pod/service health kayıtları.)
- `K3sEvent` — `id, clusterId, type, payload Json, createdAt` (destroy/upgrade/reconcile audit'e alınır).

**Deploy edilebilir servisler:** RAG services, vector DB, agent runtime, local LLM gateway → her biri per-project namespace'e.

**FSM/operasyonlar:** create / destroy / upgrade / reconcile → `modules/queue` job'ları + `K3sEvent` audit. Cluster/node/pod health periyodik (`@nestjs/schedule`) toplanır.

**API:**
```
POST   /projects/:projectId/k3s/clusters
GET    /projects/:projectId/k3s/clusters/:id
GET    /projects/:projectId/k3s/clusters/:id/nodes
POST   /projects/:projectId/k3s/clusters/:id/deployments
POST   /projects/:projectId/k3s/clusters/:id/actions   (upgrade|reconcile|destroy)
```

---

## 3. Uygulama Sırası (Fazlar)

Bağımlılıkları gözeten önerilen sıra:

**Faz A — Veri/Agent katmanı (infra'sız değer):**
1. **Modül 1 (RAG Storage)** — mevcut embedding/bucket üstüne; en hızlı değer, infra gerektirmez.
2. **Modül 2 (Agentic Storage)** — thread/message/run/tool/memory tabloları.
3. **Modül 3 (Agent Creation)** + **Modül 4 (Agent-bağlı özellikler)** — birlikte; Modül 1'i knowledge base olarak kullanır.

**Faz B — Private infra çekirdeği:**
4. **Modül 5 (Hetzner Provisioning)** — `CloudProvider` abstraction + `infrastructure` genişletme.
5. **Modül 6 (Private Network)** — Modül 5'e bağımlı.
6. **Modül 7 (Data Boundary / Firewall)** — Modül 5+6 üstünde default-deny.

**Faz C — Runtime:**
7. **Modül 8 (Nebius / Local LLM)** — Modül 5 abstraction'ını GPU'ya genişletir; Modül 3 agent'ına private provider olarak bağlanır.
8. **Modül 9 (K3s)** — Modül 5+6+8 üstünde; data-plane servislerini namespace'lere deploy eder.

Bağımlılık zinciri: `5 → 6 → 7`, `5 → 8`, `5+6+8 → 9`. Faz A ile Faz B paralel ilerleyebilir (farklı modüller).

---

## 4. Prisma Migration & Teknik Checklist

- [ ] Yeni modeller `apps/platform-api/prisma/schema.prisma`'ya eklenir (mevcut `@map` snake_case konvansiyonu).
- [ ] `prisma migrate dev` ile migration üretilir (`apps/platform-api/prisma/migrations`).
- [ ] Yeni tenant-scoped tablolar `scripts/backfill-rls.ts` akışına eklenir (RLS).
- [ ] Vektör verisi Prisma'ya konmaz — `embeddings_store` raw tablo + `VectorStoreService.$queryRawUnsafe` deseni korunur.
- [ ] Job'lar `modules/queue` (BullMQ) altında yeni queue'lar: `rag-index`, `agent-run`, `server-provision`, `k3s-reconcile`.
- [ ] Secret'lar (SSH key, kubeconfig, LLM credentials) APB `encryption.ts` deseniyle şifreli (`*Ref` alanları).
- [ ] Yeni `ProjectActivityKind` / audit kind'ları eklenir.
- [ ] SDK (`packages/sdk`) — yeni modüller için `modules/` altına client eklenir (`BasefyioClient`).
- [ ] Tüm yeni isimler `basefyio` markası; `kolaybase`/`nfyio`/`app-provider` sızıntısı yok.

---

## 5. Doğrulama Adımları

1. **Şema doğrulama:** `prisma validate` + migration dry-run; her yeni tablo `projectId` FK + index içeriyor mu?
2. **Tenant isolation testi:** Proje A'nın agent/RAG/server kaynaklarına Proje B token'ıyla erişim **reddedilmeli** (e2e test).
3. **Default-deny testi:** Yeni network/firewall kaynağı oluşturulduğunda inbound varsayılan kapalı; public exposure yalnızca explicit kuralla.
4. **Cold-storage sınır kontrolü:** Yeni kodda SeaweedFS/proxy-api/`storage-resolver` referansı **yok**; RAG dokümanları mevcut bucket modeline bağlı.
5. **Rebrand grep:** Yeni/dokunulan dosyalarda `grep -ri "kolaybase\|nfyio\|app-provider"` → boş.
6. **Policy gateway testi:** mutating tool `AGENT_ALLOW_MUTATING_TOOLS=false` iken reddediliyor ve `AgentPolicyEvent`'e yazılıyor mu?
7. **FSM idempotency:** provisioning job'ları tekrar çalıştırıldığında durum bozulmuyor.

---

## 6. Kaynak → Hedef Hızlı Referans Tablosu

| # | Özellik | APB Kaynak | basefyio Hedef Modül | Yeni Prisma Modelleri |
|---|---|---|---|---|
| 1 | RAG Storage | `srv/object-storage/*embedding*`, `routes/object-storage.routes.ts` | `embedding`, `tenant-embedding`, `ai/rag.service.ts` | `RagDocument, RagChunk, RagIndexJob` |
| 2 | Agentic Storage | `agent-service/services/{thread,audit}-repository.ts` | `modules/agent` (yeni) | `AgentThread, AgentMessage, AgentToolCall, AgentPolicyEvent, AgentMemory` |
| 3 | Agent Creation | `agent-service/agent/runner.ts`, `tools/*`, `lib/policy-gateway.ts` | `modules/agent` + `modules/ai` | `Agent, AgentVersion, AgentTool` |
| 4 | Agent-bağlı | `agent-service/routes`, `lib/analysis.ts` | `modules/agent` + `observability` | `AgentRun, AgentAttachment` |
| 5 | Hetzner Provisioning | `srv/hetzner/*`, `srv/cloud/*` | `modules/infrastructure` | `CloudServer, CloudSshKey, CloudServerEvent` |
| 6 | Private Network | `srv/networkings/*` (T710) | `modules/infrastructure` | `PrivateNetwork, NetworkMembership` |
| 7 | Data Boundary | `srv/firewall/*` (T045) | `modules/infrastructure` + policy | `FirewallRule` |
| 8 | Nebius / Local LLM | `srv/models/*`, `srv/providers/*`, `cloud/provider-registry.ts` (Nebius yeni) | `modules/ai` + provider abstraction | `LlmProvider, LlmDeployment, LlmCallLog` |
| 9 | K3s | `srv/regional/*`, `drizzle/0019_regional_pods.sql` | `modules/infrastructure` | `K3sCluster, K3sNode, K3sDeployment, K3sEvent` |

---

*basefyio — entegrasyon planı. Cold storage taşınmaz; mevcut bucket/pro-bucket modeli korunur. nfyio (public deployment/domain/hosting) bu planın kapsamı dışındadır.*
