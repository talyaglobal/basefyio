# Kolaybase marketing sitesi (`kolaybase.com`)

Anti-Gravity Astro şablonu temelli kurumsal vitrin. Statik çıktı, `@astrojs/sitemap`, Open Graph ve JSON-LD ile SEO odaklı yapılandırma.

## Geliştirme

```bash
cd apps/website
cp .env.example .env
npm install
npm run dev
```

Varsayılan port: **3002** (`http://localhost:3002`).

## Ortam değişkenleri

| Değişken | Açıklama |
|----------|----------|
| `PUBLIC_SITE_URL` | Canonical URL (varsayılan `https://kolaybase.com`) — sitemap ve meta |
| `PUBLIC_ADMIN_URL` | Footer’daki “Yönetim girişi” |
| `PUBLIC_APP_URL` | Kayıt CTA kökü (`.../signup?plan=`) — local: `http://localhost:3000` |
| `PUBLIC_PLATFORM_API_URL` | API kökü (`/api/billing/plans`) — local: `http://localhost:8000` |

Üretimde bu üç adresi domain’lerinize göre ayarlayıp **imajı yeniden derleyin** (statik bundle’a gömülür).

## Üretim derlemesi

```bash
npm run build
```

Çıktı: `dist/`. Docker imajı `nginx` ile statik dosyaları sunar (`Dockerfile`).

Kaynak arşiv: projede `Anti-Gravity.zip` (referans tasarım).
