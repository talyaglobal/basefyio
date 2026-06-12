# Sprint TODO — 10 Sprint Planı (2026-06-11)

Kaynak: ADR-0001 yürütme sırası + `PLAN-ALIGNMENT-REVIEW.md` + `EXCEL-TO-APP-PLAN.md` fazları + eski TODO kuyruğu.
Varsayım: solo dev + AI agent, 2 haftalık sprintler (repo konvansiyonu) → ~20 hafta.

**Tamamlanmış (kapsam dışı):** ADR-0001/0002, data-engine v0.1.0, agent modülü (Module 1–4), data-structures explorer, provisioning Phase 1–9b + iç sprint 1–7c (provider conformance, Docker provider, events/resources API, SDK/CLI pagination).
**Bilinçli ertelenen:** kanban/calendar renderer, eject-to-code.

Her sprint sonu ortak kapanış: e2e yeşil, `graphify update .`, changelog.

---

## Sprint 1 (H1–2) — Provisioning kapanışı + Rebrand

- [x] Provisioning Phase 10: update sonrası read-after-write ile gerçek state yakalama (Hetzner provider)
- [x] Hetzner UPDATE/DELETE aksiyonlarının executor üzerinden uçtan uca çalışması (CREATE bitti)
- [x] Operation failure/retry + reconciliation akışı; `GET /operations/:id` ile izlenebilirlik
- [x] Provisioning e2e + dry-run testleri yeşil, README güncel
- [x] Rebrand (Doc 2 §8 adım 1–4, 7): `BASEFYIO_*` env (+ `KOLAYBASE_*` fallback), CLI/SDK/string'ler, CI grep-gate
- [x] `Project.modules` flag + `ModuleEnabledGuard` + proje ayarlarında modül toggle

## Sprint 2 (H3–4) — Excel→App Phase 0 + 1

- [x] Prisma: `Blueprint`, `ApplicationVersion`, `AppEntity`, `DomainTemplate` (append-only versiyonlama)
- [x] `packages/blueprint`: zod şemaları + Nfyio Build Package kontratı (önce tasarla — ürünler arası API)
- [x] Pure fonksiyonlar: `deriveApplicationModel`, `buildPackage`, `deriveUIModel` + unit testler
- [x] Wildcard DNS + reverse proxy: `*.nfyio.app`
- [x] `apps/excel-addin` (Office.js + React + Vite): auth handoff (cli-authorize deseni), sheet/header/örnek satır okuma, junk sheet hariç tutma
- [x] `POST /blueprints/analyze` upload + Domain Intelligence onay ekranı (taskpane)

## Sprint 3 (H5–6) — Phase 2: AI understanding layer (ürünün kalbi)

- [x] `modules/blueprint`: type-inferrer ile deterministik Data Model taslağı + FK çıkarımı
- [x] Structured-output AI çağrısı → Domain Intelligence + Business Model (actor/object/process/metric)
- [x] `deriveApplicationModel` ile Application Model v1 (`aiGenerated: true`)
- [x] Doğrulama + deterministik generic-template fallback (analyze asla hata vermez)
- [x] P0 template'ler: CRM, Inventory, Orders, Generic
- [x] `POST /blueprints/:id/approve` + Application Model düzenleme → UI Model regen

## Sprint 4 (H7–8) — Phase 3 + Phase 4 başlangıcı

- [x] `POST /blueprints/:id/generate` BullMQ job: ProjectsService.create → DDL → `app_entities` seed
- [x] Realm rolleri + permission → RLS derleme (`md/RLS.md` desenleri)
- [x] `DataImportProcessor` ile satır importu; SSE progress; Nfyio app URL dönüşü
- [x] Build Package emit + Nfyio handoff
- [x] `apps/nfyio-runtime` (Next.js): hostname → tenant → Build Package → render iskeleti
- [x] İlk renderer'lar: list + form (paylaşılan data-grid çekirdeği)

## Sprint 5 (H9–10) — Phase 4 bitiş + Phase 5

- [x] Kalan renderer'lar: detail, dashboard, chart; navigation + rol bazlı sayfalar
- [x] Anon key ile veri erişimi, end-user login (`authRequirements`), paket cache + versiyon invalidation
- [x] "Ask your data" chat: `/intelligence/ask` — NL → güvenli parametrik SQL (read-only rol) → tablo/chart
- [x] "Save as dashboard widget" → yeni ApplicationVersion → Nfyio re-render
- [x] Güvenlik geçişi: §10 tenant-isolation checklist; e2e + demo script

## Sprint 6 (H11–12) — Phase 6: iterasyon + go-to-market altyapısı

- [x] admin-ui'da Application Model editörü
- [x] Excel re-sync (upsert) akışı
- [x] Invite akışı (end-user davet + rol atama)
- [x] Billing hook (plan limitleri + usage ölçümü)
- [x] AppSource başvuru hazırlığı: manifest, validation, store metadata
- [x] Excel→App uçtan uca demo senaryosu + dokümantasyon

## Sprint 7 (H13–14) — Content layer 1/3: collections + /items API

- [x] Doc 2 Sprint 1–2 kapsamı: collection tanımları (schema + Prisma)
- [x] `/items` CRUD API (data-engine üzerinde), filtering/sorting/pagination
- [x] SDK + CLI item komutları
- [x] Unit + e2e testler

## Sprint 8 (H15–16) — Content layer 2/3: RBAC + files

- [x] Doc 2 Sprint 3–4 kapsamı: RBAC policy compiler (permission → RLS/policy)
- [x] Files: storage entegrasyonu, upload/download, item ilişkilendirme
- [x] Policy testleri (tenant-isolation dahil)

## Sprint 9 (H17–18) — Content layer 3/3: flows + Supabase-compat

- [x] Doc 2 Sprint 5–6 kapsamı: flows (trigger → action)
- [x] Supabase-compat alias katmanı (`/rest/v1` yüzeyi)
- [x] Content layer dokümantasyonu + migration rehberi
- [x] Compat e2e: mevcut Supabase client'larıyla smoke test

## Sprint 10 (H19–20) — Karar gate'leri + temizlik + sertleştirme

- [x] Couchbase go/no-go değerlendirmesi (D8 gate: mobile-sync müşterisi veya >10⁷ doküman) → ADR-0003
- [x] Tenant isolation re-audit → ADR-0004; known gaps captured for Sprint 11
- [x] CI grep-gate sıkılaştırma: check-rebrand.sh yeniden yazıldı (pass/fail count + KOLAYBASE_ env check)
- [ ] Kolaybase compat alias'larının kaldırılması (kaynak dosyalardaki ihlaller giderildikten sonra)
- [ ] Performans/yük testi: analyze + generate + runtime render yolları
- [ ] Launch checklist: monitoring, backup, runbook, changelog konsolidasyonu

---

## 10 sprint sonrası kuyruk

1. Kanban/calendar renderer
2. Eject-to-code
3. Couchbase implementasyonu (gate "go" derse)
