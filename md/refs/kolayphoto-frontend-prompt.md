# KolayPhoto — Frontend Sayfaları Prompt Dokümanı

> AI-Ready Stock Photos with KolayMiles Rewards
> Wikimedia Commons entegrasyonlu, x402 mikro-ödeme protokolü ile çalışan ücretsiz stok fotoğraf platformu.
> Backend: Directus (proje: kolayphoto / talyasmart). Frontend: https://www.kolayphoto.com

---

## Genel Tasarım Sistemi (Tüm Sayfalar İçin Ortak)

Modern, koyu temalı (dark mode) bir web uygulaması oluştur. Arka plan neredeyse siyah (#0a0a0f tonları), metinler beyaz/açık gri. Vurgu renkleri canlı mavi (#4d8dff) ve degrade mavi-mor başlıklar. Yuvarlatılmış köşeli kartlar, ince kenarlıklı paneller kullan.

**Üst Navigasyon Çubuğu (Header — her sayfada sabit):**
- Sol: Mavi kare logo ikonu + "KolayPhoto" marka adı (ana sayfaya link)
- Orta: Arama kutusu — placeholder "Search photos, categories, tags..."
- Sağ: "Browse" linki, "Upload" linki (yükleme ikonlu), kullanıcı/profil ikonu, ve mavi "Sign In" butonu

**Footer (her sayfada):**
- Sol sütun: "KolayPhoto" + açıklama "AI-ready stock photo platform with free Wikimedia Commons integration and KolayMiles rewards."
- "Explore" sütunu: Browse Photos, Logos & Identity, Nature & Landscapes, Technology & AI
- "Community" sütunu: Upload Photos, Your Profile, KolayMiles Wallet, Connect
- Alt: "Powered by x402 protocol" · "© 2025 KolayPhoto. All photos respect original licenses."

---

## 1. Ana Sayfa — `/`

Bir landing/ana sayfa oluştur:

- **Hero bölümü:** Büyük başlık "AI-Ready Stock Photos with KolayMiles Rewards" (KolayMiles Rewards kısmı mavi-mor degrade). Alt metin: "Browse free photos from Wikimedia Commons and user uploads. Earn rewards through AI micropayments powered by x402 protocol." İki CTA butonu: mavi "Browse Photos →" (/photos/search'e gider) ve outline "Upload & Earn" (/upload'a gider).
- **İstatistik bandı:** 4 büyük rakam kartı — "10,000+ Photos Available", "500+ Contributors", "$25,000 Miles Earned", "100% AI-Ready".
- **Özellik kartları (3 adet):**
  - "AI-Optimized" — All photos are tagged and ready for AI training and applications with proper licensing.
  - "Earn KolayMiles" — Contributors earn rewards every time their photos are used by AI systems.
  - "Transparent Licensing" — Clear attribution and licensing information for every photo with x402 micropayments.

---

## 2. Fotoğraf Tarama / Arama — `/photos/search`

Filtrelenebilir bir fotoğraf galerisi sayfası oluştur:

- Sayfa başlığı: "Browse Photos" + altında dinamik sayaç "N photos available".
- **Filtreler paneli** ("Filters" başlığı, huni ikonu ile):
  - **Source** (radio/checkbox): All Sources, User Uploads, Wikimedia Commons
  - **Category** dropdown: "All Categories" + dinamik kategoriler (ör. logos-identity, nature-landscapes, technology-ai)
  - **AI-safe only** checkbox
- **Fotoğraf grid'i:** Sorgu parametreleriyle filtrelenir (`?category=...`). Fotoğraf yoksa boş durum mesajı: "No photos found. Try adjusting your filters."
- Her fotoğraf kartı fotoğraf detay sayfasına (`/photos/[id]`) link verir.

---

## 3. Fotoğraf Detay — `/photos/[id]`

Tek bir fotoğrafın detay sayfası oluştur:

- Büyük fotoğraf önizlemesi.
- Fotoğraf meta verileri: başlık, açıklama, kategori, etiketler (tags).
- Lisans bilgisi ve atıf (attribution) detayları.
- Kaynak göstergesi (User Upload veya Wikimedia Commons).
- "AI-safe" rozeti (uygunsa).
- İndirme/kullanım aksiyonu ve x402 mikro-ödeme/KolayMiles bilgisi.

---

## 4. Fotoğraf Yükleme — `/upload`

Fotoğraf yükleme sayfası oluştur:

- Başlık: "Upload Photos" + alt metin "Share your photos and earn KolayMiles when they are used by AI systems."
- **Bilgi kutusu (Review Process):** "All uploaded photos go through a moderation process to ensure quality and appropriate licensing. You will be notified once your photos are approved."
- **Sürükle-bırak yükleme alanı:** yükleme ikonu, "Drop your images here", "or click to browse", "Select Files" butonu.
- **Photo Details formu:**
  - Title (metin)
  - Description (metin alanı)
  - Categories (seçim)
  - Tags (metin — "Separate tags with commas")
  - **License** seçenekleri: CC0 - Public Domain, CC BY 4.0 - Attribution, CC BY-SA 4.0 - Attribution ShareAlike, CC BY-NC 4.0 - Attribution NonCommercial
  - "This photo is AI-safe (suitable for AI training and applications)" checkbox
  - "Upload Photos" (gönder) ve "Cancel" butonları

---

## 5. Profil / KolayMiles Cüzdan — `/profile` (ve `/profile#wallet`)

Giriş gerektiren kullanıcı profil sayfası oluştur (giriş yapılmamışsa `/auth/login`'e yönlendirir):

- Kullanıcı profil bilgileri (ad, e-posta, avatar).
- Kullanıcının yüklediği fotoğraflar listesi.
- **KolayMiles Wallet bölümü** (`#wallet`): kazanılan KolayMiles bakiyesi, x402 mikro-ödeme geçmişi/kazançlar.
- "Connect" (cüzdan bağlama) aksiyonu.

---

## 6. Giriş — `/auth/login`

Ortalanmış bir giriş kartı oluştur:

- Başlık: "Sign in to KolayPhoto" + alt metin "Enter your credentials to access your account".
- Email alanı (placeholder "you@example.com"), Password alanı.
- Mavi "Sign in" butonu.
- "Send magic link" butonu (passwordless giriş).
- Alt link: "Don't have an account? Sign up" → `/auth/signup`.

---

## 7. Kayıt — `/auth/signup`

Ortalanmış bir kayıt kartı oluştur:

- Başlık: "Create an account" + alt metin "Sign up to start uploading and earning KolayMiles".
- Full Name, Email, Password alanları (şifre yardım metni: "Must be at least 6 characters").
- "Create account" butonu.
- Alt link: "Already have an account? Sign in" → `/auth/login`.

---

## Teknik Notlar

- **Backend:** Directus headless CMS (koleksiyonlar: fotoğraflar, kategoriler, kullanıcılar, lisanslar).
- **Kimlik doğrulama:** E-posta/şifre + magic link (passwordless).
- **Ödeme/Ödül:** x402 protokolü ile AI mikro-ödemeleri → KolayMiles ödül sistemi.
- **İçerik kaynakları:** Kullanıcı yüklemeleri + Wikimedia Commons entegrasyonu.
- **Tema:** Dark mode, mavi (#4d8dff) vurgu, degrade başlıklar.
