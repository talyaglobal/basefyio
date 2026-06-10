# Sprint TODO — 2026-06-10

Kaynak: ADR-0001 yürütme sırası + `PLAN-ALIGNMENT-REVIEW.md` + `EXCEL-TO-APP-PLAN.md` fazları.
Varsayım: solo dev + AI agent, 2 haftalık sprintler (repo konvansiyonu).

**Tamamlanmış (kapsam dışı):** ADR-0001/0002, data-engine v0.1.0 (PostgresJsonbDataEngine + /data API + SDK), agent modülü (Module 1–4), data-structures explorer, provisioning Phase 1–9b.
**Bilinçli ertelenen:** Couchbase (D8 gate), content layer Sprint 1–6 (Doc 2), kanban/calendar renderer, eject-to-code.

---

## Sprint 1 (H1–2) — Provisioning kapanışı + Rebrand

- [ ] Provisioning Phase 10: update sonrası read-after-write ile gerçek state yakalama (`hetzner-provisioning.provider.ts:231`)
- [ ] Hetzner UPDATE/DELETE aksiyonlarının executor üzerinden uçtan uca çalışması (CREATE bitti)
- [ ] Operation failure/retry + reconciliation akışı; `GET /operations/:id` ile izlenebilirlik
- [ ] Provisioning e2e + dry-run testleri yeşil, README güncel
- [ ] Rebrand (Doc 2 §8 adım 1–4, 7): `BASEFYIO_*` env (+ `KOLAYBASE_*` fallback), CLI/SDK/string'ler, CI grep-gate
- [ ] `Project.modules` flag + `ModuleEnabledGuard` + proje ayarlarında modül toggle
- [ ] Sprint sonu: e2e yeşil, `graphify update .`, changelog

## Sprint 2 (H3–4) — Excel→App Phase 0 + 1

- [ ] Prisma: `Blueprint`, `ApplicationVersion`, `AppEntity`, `DomainTemplate` (append-only versiyonlama)
- [ ] `packages/blueprint`: zod şemaları + Nfyio Build Package kontratı (önce tasarla — ürünler arası API)
- [ ] Pure fonksiyonlar: `deriveApplicationModel`, `buildPackage`, `deriveUIModel` + unit testler
- [ ] Wildcard DNS + reverse proxy: `*.nfyio.app`
- [ ] `apps/excel-addin` (Office.js + React + Vite): auth handoff (cli-authorize deseni), sheet/header/örnek satır okuma, junk sheet hariç tutma
- [ ] `POST /blueprints/analyze` upload + Domain Intelligence onay ekranı (taskpane)

## Sprint 3 (H5–6) — Phase 2: AI understanding layer (ürünün kalbi)

- [ ] `modules/blueprint`: type-inferrer ile deterministik Data Model taslağı + FK çıkarımı
- [ ] Structured-output AI çağrısı → Domain Intelligence + Business Model (actor/object/process/metric)
- [ ] `deriveApplicationModel` ile Application Model v1 (`aiGenerated: true`)
- [ ] Doğrulama + deterministik generic-template fallback (analyze asla hata vermez)
- [ ] P0 template'ler: CRM, Inventory, Orders, Generic
- [ ] `POST /blueprints/:id/approve` + Application Model düzenleme → UI Model regen

## Sprint 4 (H7–8) — Phase 3 + Phase 4 başlangıcı

- [ ] `POST /blueprints/:id/generate` BullMQ job: ProjectsService.create → DDL → `app_entities` seed
- [ ] Realm rolleri + permission → RLS derleme (`md/RLS.md` desenleri)
- [ ] `DataImportProcessor` ile satır importu; SSE progress; Nfyio app URL dönüşü
- [ ] Build Package emit + Nfyio handoff
- [ ] `apps/nfyio-runtime` (Next.js): hostname → tenant → Build Package → render iskeleti
- [ ] İlk renderer'lar: list + form (paylaşılan data-grid çekirdeği)

## Sprint 5 (H9–10) — Phase 4 bitiş + Phase 5 + launch hazırlığı

- [ ] Kalan renderer'lar: detail, dashboard, chart; navigation + rol bazlı sayfalar
- [ ] Anon key ile veri erişimi, end-user login (`authRequirements`), paket cache + versiyon invalidation
- [ ] "Ask your data" chat: `/intelligence/ask` — NL → güvenli parametrik SQL (read-only rol) → tablo/chart
- [ ] "Save as dashboard widget" → yeni ApplicationVersion → Nfyio re-render
- [ ] Phase 6 başlangıcı: admin-ui'da Application Model editörü, Excel re-sync (upsert)
- [ ] Güvenlik geçişi: §10 tenant-isolation checklist; e2e + demo script

---

## Sprint 5 sonrası kuyruk

1. Phase 6 kalanı: invite akışı, billing hook, AppSource başvurusu
2. Content layer (Doc 2 Sprint 1–6): collections, `/items` API, RBAC policy compiler, files, flows, Supabase-compat alias
3. Couchbase go/no-go (D8 gate: mobile-sync müşterisi veya >10⁷ doküman)
4. Kolaybase compat alias'larının kaldırılması
