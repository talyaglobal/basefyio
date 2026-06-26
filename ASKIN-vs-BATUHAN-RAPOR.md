# Askın vs Batuhan Branch Karşılaştırma Raporu

**Tarih:** 26 Haziran 2026
**Hazırlayan:** Claude (Cowork)
**Repo:** kolaybase-new

---

## Özet (TL;DR)

İki branch **ciddi şekilde ayrışmış** ve **tamamen farklı yönlere** gidiyor:

- **`batuhan`** = üretim/stabilizasyon branch'i. Çoğunlukla küçük, hedefli bug fix'ler (auth, storage, dashboard, SQL). Senin "çok stabil çalışıyor" dediğin branch.
- **`origin/askin`** = büyük mimari genişleme branch'i. 11+ "Sprint" boyunca tamamen yeni bir sistem inşa etmiş (provisioning, blueprint/Excel→App, agent orchestration, secure-gateway, yeni storage provider'lar, bot-controller).

**Önemli:** Senin lokal `askin` branch'in eski (11 Haziran). Asıl iş **`origin/askin`** üzerinde (15 Haziran). Bu rapor `origin/askin`'i baz alır.

**Merge önerisi:** **Şu an direkt merge ETME.** 13 hassas çekirdek dosyada çakışma çıkıyor (auth, storage, DB şeması dahil) — yani batuhan'ın stabilize ettiği tam da o alanlar. Aşağıda güvenli yol anlatıldı.

---

## Sayısal Tablo

| Ölçüt | Değer |
|---|---|
| Ortak ata (merge-base) | `adfdb67` — 11 Haz 2026 |
| `origin/askin`'in batuhan'da olmayan commit'i | **52 commit** |
| `batuhan`'ın askin'de olmayan commit'i | **106 commit** |
| Toplam değişen dosya (tip-to-tip) | ~2066 dosya |
| Merge'de çakışacak dosya | **13 dosya** |
| Sadece askin'de olan büyük modül | `bot-controller/` (Go projesi, ~250k satır) |

---

## Askın Neler Yapmış? (52 commit)

Askın branch'i, ürünü **"Excel/doğal dil → çalışan uygulama" platformuna** dönüştürmeye yönelik çok kapsamlı, sprint-bazlı bir geliştirme yapmış. Ana başlıklar:

**1. Provisioning Sistemi (Sprint 1–7)**
Altyapı sağlama (provisioning) motoru: ProviderRegistry + discovery API, Docker/Hetzner provider'ları, operation retry/cancellation, kaynak gözlemlenebilirliği (resource observability), cursor-bazlı sayfalama, sağlık kontrolleri. SDK ve CLI tarafında `ProvisioningClient`, `waitForCompletion`, `operations watch`. Kapsamlı test paketi (provider conformance — 70 test, Docker e2e smoke, vb.).

**2. Blueprint — Excel→App (Sprint 2–6)**
Excel'den uygulama üretme hattı: AI anlama katmanı (Sprint 3), üretim pipeline'ı + `nfyio-runtime` iskeleti (Sprint 4), NL→SQL + dashboard widget'ları + nfyio renderer'ları (Sprint 5), AppModel editor + re-sync + invite + kota (Sprint 6). Yeni `packages/blueprint` paketi.

**3. İçerik Katmanı / Items & Data Structures (Sprint 7–8)**
`/items` CRUD API + SDK + CLI, RBAC politika uygulaması, dosya upload/download, structure-items CRUD, data-storage provider'ları, CLI/SDK item API'lerinin DataStructure modeline hizalanması.

**4. Flows + Supabase Uyumluluk (Sprint 9)**
Flows motoru + Supabase-compat katmanı + dokümantasyon.

**5. Güvenlik & Tenant İzolasyonu (Sprint 10)**
Tenant isolation denetimi, rebrand gate, ADR'ler, launch checklist. `secure-gateway` için sertifika PKI + CRL senkronizasyonu + gateway CLI.

**6. Agent Orchestration**
Agent route'ları (v1 api prefix), built-in tool katalog seed'i, agent mutation'larında admin rol zorunluluğu, status geçiş doğrulaması, agent-flows ile veri kaynağı bağlama, thread'lerin agent'a scope'lanması. Yapı öğesi (structure-item) versiyonlama, MongoDB storage.

**7. Storage Provider'ları (Sprint 11)**
CouchbaseProvider + `STORAGE_PROVIDER` seçimi, entegrasyon testi, startup guard, env dokümanları.

**8. Eject-to-Code (Sprint 11b)**
Çalıştırılabilir Next.js iskeleti üreten "eject-to-code". Renderer'a kanban board + takvim görünümü.

**9. Developer Access**
Developer access API yüzeyi, developer connection info endpoint.

**Sadece askin'de bulunan büyük yapılar:**
`bot-controller/` (komple Go projesi — CI, debian/rpm paketleme, cmd/pkg/test), `apps/nfyio-runtime`, `packages/blueprint`, kapsamlı `docs/` (RUNBOOK, LAUNCH-CHECKLIST, ADR'ler, supabase-migration), `scripts/pki`, `scripts/loadtest`, `infra/grafana`.

---

## Batuhan Neler Yapmış? (106 commit)

Batuhan branch'i **üretim stabilizasyonuna** odaklanmış — çoğunlukla küçük, cerrahi bug fix'ler:

- **Auth:** orphan signup self-heal, reset sonrası otomatik giriş, şifre uzunluğu birleştirme (8), kayıtlı e-posta'yı OTP öncesi reddetme, duplicate-email guard, Keycloak brute-force kilidini sıfırlama, ROOT şifre reset'inin login blocker'larını temizlemesi, middleware'in canlı oturumları /login'e atmaması.
- **Storage:** klasörler, yerel klasör yükleme, public link'ler, klasöre taşıma + sürükle-bırak, ad çakışması rename/skip modalı, folder marker gizleme.
- **Dashboard:** backend erişilemezken sonsuz spinner yerine retry, refetch döngülerini durdurma, React #310 hooks-order crash fix.
- **SQL/Database:** çok-ifadeli script'lerde her ifadenin sonucunu gösterme, responsive Database toolbar.
- **Diğer:** docs arama + dashboard Docs menüsü, marketing/website düzeltmeleri, takım davet izinleri, proje switcher, rebrand (kullanıcıya görünen "Kolaybase" string'lerini temizleme), AI database advisor wizard, CLI auto-update.

Yani batuhan = **mevcut ürünü sağlamlaştırma**, askın = **yeni nesil platform inşası**.

---

## Merge Risk Analizi

Çakışacak 13 dosya (her iki branch'te de değişmiş — git merge-tree dry-run sonucu):

| Dosya | Neden riskli |
|---|---|
| `apps/platform-api/prisma/schema.prisma` | **DB şeması** — en kritik. İki branch farklı modeller eklemiş. |
| `apps/platform-api/src/modules/auth/auth.service.ts` | Auth çekirdeği — batuhan burada çok fix yaptı. |
| `apps/platform-api/src/modules/auth/keycloak-admin.service.ts` | Keycloak yönetimi — batuhan'ın brute-force/reset fix'leri burada. |
| `apps/platform-api/src/modules/storage/storage.service.ts` | Storage — her iki branch de yoğun değiştirmiş. |
| `apps/platform-api/src/modules/data-engine/data-engine.service.ts` | SQL/data-engine — batuhan'ın multi-statement fix'i burada. |
| `apps/platform-api/src/modules/projects/project-activity.service.ts` | Dashboard refetch döngüsü fix'i burada. |
| `apps/platform-api/src/app.module.ts` | Modül kayıtları — askın çok yeni modül ekledi. |
| `apps/platform-api/package.json` | Bağımlılıklar — çakışması kolay çözülür. |
| `apps/admin-ui/lib/api.ts` | Admin UI API katmanı. |
| `packages/cli/package.json`, `packages/cli/src/index.ts` | CLI giriş noktası ve bağımlılıklar. |
| `packages/sdk/src/BasefyioClient.ts`, `packages/sdk/src/index.ts` | SDK giriş noktası — askın yeni modüller export etti. |

**Risk değerlendirmesi:** Çakışmalar sayıca az (13) ama **niteliği yüksek**. `schema.prisma`, `auth.service`, `storage.service` gibi dosyalardaki çakışmaları yanlış çözmek batuhan'ın stabilitesini direkt bozar.

---

## Öneri — Güvenli Yol

**Direkt `git merge askin` yapma.** Bunun yerine:

1. **Önce karar ver:** askın'in yönü (yeni platform) ile batuhan'ın yönü (mevcut ürün stabilizasyonu) gerçekten birleştirilecek mi, yoksa askın ayrı bir ürün hattı mı? 250k satırlık bot-controller dahil bu kadar büyük bir entegrasyon stratejik bir karar.

2. **Eğer birleştirilecekse**, batuhan'ı bozmadan deneme yap:
   ```
   git checkout -b merge-test batuhan
   git merge origin/askin
   ```
   `merge-test` ayrı bir dal; batuhan'a dokunmaz. Çakışmaları burada, özellikle yukarıdaki 13 dosyada (öncelik: schema.prisma, auth, storage), dikkatle çöz ve test et.

3. **Çakışma çözümünde yön:** auth/storage/data-engine/dashboard dosyalarında **batuhan tarafındaki fix'leri koru** (çünkü stabil olan o), askın'in yeni modül eklemelerini bunların üzerine ekle.

4. **DB şeması için ayrı dikkat:** `schema.prisma` çakışmasını çözdükten sonra mutlaka migration durumunu kontrol et — iki branch'in migration'ları çakışabilir.

5. Test geçtikten sonra `merge-test`'i batuhan'a getir.

---

## Sonuç

Askın boşa çalışmamış — aksine, sprint-bazlı çok büyük ve organize bir platform geliştirmesi yapmış (provisioning, Excel→App blueprint, agent orchestration, secure-gateway, yeni storage'lar, bot-controller). Ama bu iş batuhan'ın stabilizasyon çizgisinden tamamen ayrı bir yöne gidiyor ve çekirdek dosyalarda (auth, storage, DB şeması) çakışıyor. Korkun yersiz değil: **kör merge batuhan'ı bozar.** Yukarıdaki ayrı `merge-test` dalı yaklaşımı, batuhan'a hiç dokunmadan riski görmeni sağlar.
