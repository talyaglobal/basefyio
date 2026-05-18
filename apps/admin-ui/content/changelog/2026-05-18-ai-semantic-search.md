---
date: 2026-05-18
slug: ai-semantic-search
title: AI Destekli Arama, RAG ve Akıllı Öneriler
kind: feature
summary: Artık SQL geçmişinizi, tablo şemalarınızı ve proje aktivitelerinizi doğal dille arayabiliyorsunuz. AI asistan projenizi gerçekten anlıyor.
---

Bugüne kadar SQL geçmişinde bir şey aradığınızda tam olarak ne yazdığınızı hatırlamanız gerekiyordu. Tablo adını yanlış yazarsanız — hiçbir şey çıkmıyordu.

Artık öyle değil.

## Ne değişti?

Üç büyük özellik aynı anda devreye girdi. Hepsi birbirine bağlı, hepsi arka planda sessizce çalışıyor.

---

### 1. Semantik Arama

SQL sorgularınızı, tablo şemalarınızı ve proje aktivitelerinizi **anlamına göre** arayabilirsiniz artık.

"users tablosundaki son kayıtlar" yazın — `SELECT * FROM users ORDER BY created_at DESC` sorgusunu bulur. Kelime kelime eşleşmesi aramaz, neyi kastettiğinizi anlar.

**Ne aranıyor?**

- Çalıştırdığınız tüm SQL sorguları
- Projenizin tablo yapıları (her tablo bir chunk olarak indeksleniyor)
- Proje aktivite geçmişi
- Feedback ve issue geçmişi

Tüm bunlar arka planda otomatik olarak indeksleniyor. Siz sadece arayın.

---

### 2. RAG — AI Asistan Artık Projenizi Gerçekten Biliyor

AI Chat'e soru sorduğunuzda artık sistem, projenizle gerçekten ilgili bağlamı otomatik olarak buluyor ve AI'ya veriyor.

Eskiden AI asistan size şema hakkında genel sorular sorardı ya da generic örnekler verirdi. Şimdi şöyle bir şey söyleyebiliyor:

> "Projenizde daha önce `orders` tablosunda şu sorguyu çalıştırmışsınız: `SELECT status, COUNT(*) FROM orders GROUP BY status` — bu yapıyı baz alarak şunu öneririm..."

Siz hiçbir şey yapmıyorsunuz. AI, geçmişinizden ve şemanızdan otomatik olarak bağlam çekiyor.

**Nasıl çalışıyor?**

Sorunuzu yazıyorsunuz → sistem soruya en yakın içerikleri buluyor (tablo şemanız, son sorgularınız, hata desenleri) → bunları AI'ya bağlam olarak veriyor → AI o bağlamı kullanarak cevap veriyor.

Bütün bu süreç 300-500ms içinde tamamlanıyor. Fark etmeyeceksiniz ama cevapların kalitesi ciddi ölçüde arttı.

---

### 3. Akıllı Sorgu Önerileri

SQL editöründe bir sorgu çalıştırdıktan sonra "Benzer sorgular" görmeye başlayacaksınız.

- **Aynı projeden benzer sorgular** — Geçmişte benzer bir şey yazdıysanız karşınıza çıkıyor
- **Takımdaki diğer projelerden desenler** — Başka bir projede aynı yapıda bir tablo varsa ve benzer bir sorgu yazılmışsa, o deseni görebiliyorsunuz

Hepsi cosine similarity ile çalışıyor — "şuna benziyor" diye eşleştiriyor, kelime kelime aramıyor.

---

## Teknik detay merak edenler için

Tüm bu özellikler **pgvector** üzerine kurulu. PostgreSQL veritabanınızın içinde, ayrı bir servis veya ücretli üçüncü parti olmadan.

- Embedding modeli: `text-embedding-3-small` (OpenAI)
- Index tipi: HNSW (cosine distance, m=16)
- Arama stratejisi: Semantic + keyword (pg_trgm) hibrit, Reciprocal Rank Fusion ile birleştirme
- Günlük token limiti: Konfigüre edilebilir (varsayılan 1M token/gün)

Her şey OpenAI API key'inizi kullanıyor. Ayrı bir ücret yok.

---

## Şu an için

İndeksleme otomatik çalışıyor — bugünden itibaren çalıştırdığınız her SQL sorgusu, oluşturduğunuz her tablo otomatik olarak indekleniyor.

Eski veriler için backfill çalıştırabilirsiniz:

```bash
npm run embeddings:backfill:dry   # önce ne kadar veri var gör
npm run embeddings:backfill       # çalıştır
```

Kapatmak isterseniz tek bir env variable yeterli:

```
EMBEDDING_ENABLED=false
```

Her şey normal çalışmaya devam eder, sadece AI özellikleri devre dışı kalır.
