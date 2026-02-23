# Getting Started with Kolaybase CLI

Bu rehber, Kolaybase CLI'yi kurup ilk projenizi oluşturmanız için adım adım talimatlar içerir.

## Ön Gereksinimler

- ✅ Node.js 20 veya üzeri
- ✅ npm veya pnpm
- ✅ Docker Desktop (lokal geliştirme için)
- ✅ Git

## Kurulum

### Adım 1: CLI'yi Kur

Kolaybase repository'sini klonlayın ve CLI'yi build edin:

```bash
# Repository'yi klonla
git clone <your-repo-url>
cd v0-kolaybase

# CLI dizinine git
cd packages/cli

# Bağımlılıkları yükle
npm install

# Build et
npm run build

# Global olarak link et
npm link
```

### Adım 2: Kurulumu Doğrula

```bash
# CLI'nin kurulu olduğunu kontrol et
kb --version

# Yardımı görüntüle
kb --help
```

Çıktı şöyle görünmeli:
```
kb/0.1.0

Usage: kb [options] [command]

Kolaybase CLI - Manage your backend projects
...
```

## İlk Kullanım

### Adım 1: Platform'u Başlat

Eğer lokal Kolaybase platformu çalışmıyorsa, önce başlatın:

```bash
# Ana repository dizinine geri dön
cd ../..

# Docker servislerini başlat
docker compose up -d

# Platform API'yi başlat
cd apps/platform-api
npm install
npx prisma migrate dev --name init
npm run start:dev

# Başka bir terminalde Admin UI'yi başlat
cd apps/admin-ui
npm install
npm run dev
```

**VEYA** CLI ile tek komutta başlat:

```bash
kb start
```

### Adım 2: Giriş Yap

```bash
kb login
```

Sizden kullanıcı adı ve şifre istenecek:
- **Username**: `admin`
- **Password**: `admin`

Başarılı giriş mesajını göreceksiniz:
```
✓ Authentication successful
✓ Welcome back, admin!
```

### Adım 3: İlk Projenizi Oluşturun

Yeni bir dizin oluşturup proje başlatın:

```bash
# Yeni proje dizini
mkdir my-first-project
cd my-first-project

# Projeyi initialize et
kb init --name "My First Project"
```

CLI şunları yapacak:
1. Team seçmenizi isteyecek
2. Proje adını onaylayacak
3. API üzerinden proje oluşturacak
4. `.env` dosyası oluşturacak
5. `.kolaybase/config.json` oluşturacak
6. `KOLAYBASE.md` dosyası oluşturacak

### Adım 4: Database İşlemleri

#### Schema Oluştur

`schema.prisma` dosyası oluşturun:

```prisma
// prisma/schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id        String   @id @default(uuid())
  email     String   @unique
  name      String?
  createdAt DateTime @default(now())
}

model Post {
  id        String   @id @default(uuid())
  title     String
  content   String?
  published Boolean  @default(false)
  authorId  String
  createdAt DateTime @default(now())
}
```

#### Schema'yı Push Et

```bash
kb db push
```

### Adım 5: TypeScript Tipleri Oluştur

```bash
kb gen types --output ./types
```

Bu komut `types/database.ts` dosyası oluşturacak:

```typescript
export interface Database {
  users: User;
  posts: Post;
}

export interface User {
  id: string;
  email: string;
  name?: string;
  createdAt: string;
}

export interface Post {
  id: string;
  title: string;
  content?: string;
  published: boolean;
  authorId: string;
  createdAt: string;
}
```

### Adım 6: API Client Oluştur

```bash
kb gen client --lang typescript --output ./lib
```

Bu komut `lib/kolaybase.ts` dosyası oluşturacak.

### Adım 7: Client'ı Kullan

Projenizde client'ı kullanın:

```typescript
import { createClient } from './lib/kolaybase';

const client = createClient({
  url: process.env.NEXT_PUBLIC_API_URL,
  anonKey: process.env.ANON_KEY,
});

// Kullanıcıları getir
const users = await client.table('users').select();

// Yeni kullanıcı ekle
await client.table('users').insert({
  email: 'user@example.com',
  name: 'John Doe',
});

// Kullanıcıyı güncelle
await client.table('users').update(
  { name: 'Jane Doe' },
  { email: 'user@example.com' }
);
```

## Günlük Kullanım

### Lokal Geliştirme Başlat

```bash
kb start
```

Bu komut:
- ✅ PostgreSQL başlatır
- ✅ Keycloak başlatır
- ✅ MinIO başlatır
- ✅ Platform API başlatır
- ✅ Admin UI başlatır

### Durum Kontrol Et

```bash
kb status
```

### Logları İzle

```bash
# Container loglarını izle
kb logs --follow

# SQL query loglarını izle
kb logs --sql --follow
```

### Database İşlemleri

```bash
# Schema değişikliklerini push et
kb db push

# Remote schema'yı pull et
kb db pull

# Database'i resetle
kb db reset

# Seed data ekle
kb db seed
```

### Projelerinizi Görüntüle

```bash
kb projects
```

## Sık Kullanılan Komutlar

| Komut | Açıklama |
|-------|----------|
| `kb start` | Lokal ortamı başlat |
| `kb stop` | Ortamı durdur |
| `kb status` | Durum göster |
| `kb db push` | Schema push et |
| `kb gen types` | Tipler oluştur |
| `kb logs` | Logları görüntüle |
| `kb projects` | Projeleri listele |

## Sorun Giderme

### "Docker is not running"

Docker Desktop'ı başlatın:
```bash
# Windows
# Docker Desktop'ı başlat

# macOS
open -a Docker

# Linux
sudo systemctl start docker
```

### "Not in a Kolaybase project"

Proje initialize edin veya bir projeye link edin:
```bash
kb init
# veya
kb link
```

### "Authentication failed"

Tekrar giriş yapın:
```bash
kb login
```

### Port zaten kullanımda

`.env` dosyasında portları değiştirin:
```bash
kb secrets set POSTGRES_PORT 5433
kb secrets set PLATFORM_API_PORT 4001
```

## Sonraki Adımlar

1. **Daha Fazla Örnek**: [EXAMPLES.md](./EXAMPLES.md) dosyasına bakın
2. **Tüm Komutlar**: [README.md](./README.md) için tam dokümantasyon
3. **Hızlı Referans**: [QUICK_REFERENCE.md](./QUICK_REFERENCE.md) için komut listesi
4. **Katkıda Bulunun**: [CONTRIBUTING.md](./CONTRIBUTING.md) rehberine bakın

## Yardım

Herhangi bir sorunuz varsa:
- GitHub Issues'da soru açın
- Dokümantasyonu kontrol edin
- Demo'yu çalıştırın: `./demo.sh`

**Mutlu kodlamalar! 🚀**
