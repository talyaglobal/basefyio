# basefyio kurulum kılavuzu (Türkçe)

Bu kılavuz, basefyio'yu kendi sunucunuza kurmanın kısa yolunu anlatır. Tüm ayrıntılar
(çevrimdışı kurulum, imaj paketleme, kendi TLS sertifikanız) için İngilizce tam kılavuza
bakın: [SELF_HOSTING_OFFLINE.md](self-hosting-offline.md).

basefyio tamamen konteynerlerden oluşur. `scripts/install.sh` kurulumu, yeniden
yapılandırmayı, yükseltmeyi ve geri almayı yönetir: hangi sürümü ve hangi bileşenleri
çalıştıracağınızı sorar, env dosyasını yazar ve her şeyi başlatır.

---

## 1. Gereksinimler

| Nerede | Ne gerekir |
|---|---|
| Sunucu | Docker Engine, Compose **2.24 veya üstü**, git, bash 4+ |
| Disk | İmajlar için birkaç GB, verileriniz için yer ve her yükseltmeden önce bir veritabanı yedeği için boş alan |
| Ağ | Sunucudan imaj kayıt defterine (registry) erişim; erişim yoksa bkz. "Çevrimdışı sunucu" |

İki compose dosyası desteklenir:

- **`docker-compose.yml` — kendi sunucunuz (varsayılan).** API, panel ve web sitesini kaynaktan
  derler; PostgreSQL, Keycloak, Redis, MinIO ve PgBouncer'ı çeker. Yerel portlarda düz HTTP;
  isteğe bağlı olarak kendi sertifikanızla TLS vekili.
- **`docker-compose.prod.yml` — üretim düzeni.** basefyio bulutunun çalıştığı yerleşim: Traefik
  ve Let's Encrypt, imajlar basefyio kayıt defterinden çekilir.

---

## 2. Kurulum

```bash
git clone https://github.com/talyaglobal/basefyio.git basefyio && cd basefyio
scripts/install.sh
```

Kurulum sihirbazı her seferinde tek soru sorar. Her sorunun bir varsayılanı vardır; hepsinde
Enter'a basmak makul bir kurulum üretir. Önemli sorular:

| Soru | Seçenekler (varsayılan ilk) | Ne değiştirir |
|---|---|---|
| Compose dosyası | `selfhost`, `prod` | yığının hangi dosyadan çalışacağı |
| Sürüm | en yeni sürüm etiketi, `v2.9.8` ve sonrası herhangi bir etiket, `current` | kurulacak sürüm |
| Platform imajları | `build`, `pull`, `bundle` | kaynaktan derle, kayıt defterinden çek veya paketten yükle |
| Keycloak | `24`, `26`, `external` | dahili Keycloak sürümü ya da harici Keycloak |
| Doküman deposu | `yes`, `no` | `no`: doküman deposu başlamaz, Data Engine belgeleri PostgreSQL'de tutar |
| Yapay zekâ özellikleri | `on`, `off` | `off`: hiçbir istek dış yapay zekâ servislerine gitmez |
| E-posta | `resend`, `smtp` | `smtp`: kendi posta sunucunuzu girersiniz |
| Çevrimdışı sunucu | `no`, `yes` | isteğe bağlı dış çağrıları kapatır |

Kurulum bittiğinde `./basefyio` adlı bir yardımcı yazılır; bu, bu kuruluma ait proje adı, env
dosyası ve compose dosyalarıyla `docker compose` çalıştırır:

```bash
./basefyio ps
./basefyio logs -f platform-api
```

### Soru sormadan kurulum

Tüm cevaplar ortamdan veya bir dosyadan verilebilir:

```bash
cat > answers.env <<'EOF'
BASEFYIO_VERSION=v2.9.8
BASEFYIO_KEYCLOAK=26
BASEFYIO_DOCSTORE=no
BASEFYIO_AI=off
BASEFYIO_MAIL=smtp
SMTP_HOST=mail.ornek.local
SMTP_PORT=587
SMTP_SECURE=starttls
SMTP_USER=basefyio
SMTP_PASSWORD=degistirin
MAIL_FROM='basefyio <noreply@ornek.local>'
EOF
scripts/install.sh --yes --answers answers.env
```

`--yes` cevaplanmamış her şey için varsayılanı alır; `--dry-run` hiçbir şeyi değiştirmeden planı
yazdırır. Yeni bir kurulum `.env.example` dosyasından başlar ve tüm parola ve anahtarlar
otomatik üretilir.

---

## 3. İlk yönetici

Yeni kurulumda platform yöneticisi yoktur. Panelde herhangi bir kullanıcı gibi kaydolun
(doğrulama kodu e-postayla gelir), sonra bu hesabı ROOT yapın:

```bash
scripts/install.sh root siz@ornek.com
```

ROOT hesabı; kullanıcıları, planları ve limitleri yönettiğiniz konsolu açar. İlk açılışta
varsayılan planlar (Free, Pro, Business) oluşturulur; yeni organizasyonlar Free planında başlar.

---

## 4. Çalıştığını doğrulama

```bash
./basefyio exec platform-api node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>r.text()).then(console.log)"
```

Çıktıda `"status":"ok"` ve kurduğunuz sürüm (`release.version`) görünmelidir. Ardından
`http://localhost:3000` (veya TLS vekiliyle `https://app.<ALAN_ADINIZ>/login`) adresinden env
dosyasındaki Keycloak yönetici hesabıyla giriş yapın. `email.state: not-configured`, postanın
kapalı olduğu anlamına gelir; API'nin bozuk olduğu anlamına gelmez.

---

## 5. Yükseltme ve geri alma

```bash
scripts/install.sh upgrade
```

Yükseltme: kurulu sürümü okur, her veritabanını `backups/<zaman>-<sürüm>/` altına yedekler,
yeni sürümü indirir, imajları hazırlar, yığını başlatır ve API'nin ayağa kalkmasını bekler.
API ayağa kalkmazsa kendiliğinden önceki sürüme döner. Elle geri almak için:

```bash
scripts/install.sh rollback               # son yükseltmeden önceki sürüme dön
scripts/install.sh restore backups/<dizin> # veritabanı yedeğini geri yükle (mevcut verinin yerine geçer)
scripts/install.sh status                 # sürüm, önceki sürüm, son yedek, çalışanlar
```

Nesne depolama (MinIO) veritabanı yedeğine dahil değildir; dosyaların da anlık kopyası
gerekiyorsa MinIO birimini ayrıca kopyalayın.

---

## 6. İnternetsiz sunucu

İnternete çıkamayan bir sunucuda imajlar, bağlı bir makinede paketlenir ve taşınır:

```bash
# Bağlı makinede
git clone https://github.com/talyaglobal/basefyio.git basefyio && cd basefyio
git checkout v2.9.8
./scripts/bundle-images.sh --profile tls -o /tmp/basefyio-images.tar.gz
```

Tarball, `.images.txt` ve `.sha256` dosyalarını depo kopyasıyla birlikte sunucuya taşıyın ve:

```bash
BASEFYIO_IMAGES=bundle BASEFYIO_BUNDLE=/media/transfer/basefyio-images.tar.gz \
BASEFYIO_OFFLINE=yes BASEFYIO_VERSION=current \
scripts/install.sh
```

Kurulum sağlama toplamını doğrular, imajları yükler ve `--pull never` ile başlar. Kendi TLS
sertifikanız için `TLS_CERT_FILE` ve `TLS_KEY_FILE` değişkenlerini kullanın; ayrıntılar
[SELF_HOSTING_OFFLINE.md](self-hosting-offline.md) içindeki "TLS with your own certificate"
bölümündedir.

---

## Sorun giderme

- `docker compose` sürümü 2.24'ten eskiyse kurulum durur: Docker'ı güncelleyin.
- API açılmıyorsa: `./basefyio logs platform-api`.
- Disk dolarsa yükseltme yedeği alamaz ve durur; eski `backups/` dizinlerini temizleyin.
- Sorularınız için: <https://github.com/talyaglobal/basefyio/issues>
