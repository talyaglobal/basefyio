import Link from "next/link";
import {
  Database,
  Shield,
  Zap,
  Table2,
  Mail,
  Key,
  ArrowRight,
} from "lucide-react";

export default function Home() {
  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-50 border-b border-slate-800/50 bg-[#0a0f1a]/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Link href="/" className="text-xl font-bold text-cyan-400">
            Kolaybase
          </Link>
          <nav className="flex items-center gap-6">
            <Link
              href="https://app.kolaybase.com"
              className="text-sm text-slate-400 hover:text-white transition-colors"
            >
              Giriş Yap
            </Link>
            <Link
              href="https://app.kolaybase.com/signup"
              className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-cyan-400 transition-colors"
            >
              Ücretsiz Başla
            </Link>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden pt-32 pb-24 px-6">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(34,211,238,0.15),transparent)]" />
        <div className="relative mx-auto max-w-4xl text-center">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl">
            Backend&apos;i{" "}
            <span className="text-cyan-400">dakikalar içinde</span> kurun
          </h1>
          <p className="mt-6 text-lg text-slate-400 max-w-2xl mx-auto">
            Veritabanı, kimlik doğrulama ve REST API. No-code ile projenizi
            hızlıca hayata geçirin.
          </p>
          <div className="mt-10 flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              href="https://app.kolaybase.com/signup"
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-cyan-500 px-6 py-3.5 text-base font-semibold text-slate-900 hover:bg-cyan-400 transition-colors"
            >
              Ücretsiz Başla
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="https://app.kolaybase.com"
              className="inline-flex items-center justify-center rounded-xl border border-slate-600 px-6 py-3.5 text-base font-medium text-slate-300 hover:border-slate-500 hover:bg-slate-800/50 transition-colors"
            >
              Demo Görüntüle
            </Link>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="py-24 px-6">
        <div className="mx-auto max-w-6xl">
          <h2 className="text-center text-3xl font-bold sm:text-4xl">
            Her şey tek platformda
          </h2>
          <p className="mt-4 text-center text-slate-400 max-w-xl mx-auto">
            Görsel tablo editörü, OAuth, e-posta ve hazır REST API ile backend
            geliştirmeyi basitleştirin.
          </p>
          <div className="mt-16 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                icon: Database,
                title: "Görsel Veritabanı",
                desc: "Tablo ve kolonları sürükle-bırak ile oluşturun. Foreign key ilişkilerini kolayca tanımlayın.",
              },
              {
                icon: Shield,
                title: "Kimlik Doğrulama",
                desc: "E-posta/şifre, Google ve GitHub OAuth. Proje bazlı OAuth ayarları.",
              },
              {
                icon: Zap,
                title: "Otomatik REST API",
                desc: "Her tablo için CRUD endpoint'leri otomatik oluşturulur. SDK ile entegre edin.",
              },
              {
                icon: Table2,
                title: "Tablo Editörü",
                desc: "İlişkiler, indeksler ve validasyonlar tek ekrandan yönetin.",
              },
              {
                icon: Mail,
                title: "E-posta Entegrasyonu",
                desc: "Resend, SendGrid, SES veya özel SMTP ile doğrulama ve bildirim e-postaları.",
              },
              {
                icon: Key,
                title: "API Anahtarları",
                desc: "Proje bazlı API anahtarları ile güvenli erişim kontrolü.",
              },
            ].map(({ icon: Icon, title, desc }) => (
              <div
                key={title}
                className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6 hover:border-slate-700 transition-colors"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-400">
                  <Icon className="h-6 w-6" />
                </div>
                <h3 className="mt-4 text-lg font-semibold">{title}</h3>
                <p className="mt-2 text-sm text-slate-400">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-24 px-6">
        <div className="mx-auto max-w-4xl rounded-3xl border border-slate-800 bg-gradient-to-br from-slate-900/80 to-slate-900/40 p-12 text-center">
          <h2 className="text-2xl font-bold sm:text-3xl">
            Hemen başlayın, ücretsiz
          </h2>
          <p className="mt-4 text-slate-400">
            Hesap oluşturun, ilk projenizi kurun ve API&apos;nizi dakikalar
            içinde kullanmaya başlayın.
          </p>
          <Link
            href="https://app.kolaybase.com/signup"
            className="mt-8 inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-8 py-4 text-base font-semibold text-slate-900 hover:bg-cyan-400 transition-colors"
          >
            Ücretsiz Başla
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-800 py-12 px-6">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 sm:flex-row">
          <span className="text-sm text-slate-500">© {new Date().getFullYear()} Kolaybase</span>
          <div className="flex gap-8">
            <Link
              href="https://app.kolaybase.com"
              className="text-sm text-slate-400 hover:text-white transition-colors"
            >
              Uygulama
            </Link>
            <Link
              href="https://app.kolaybase.com/signup"
              className="text-sm text-slate-400 hover:text-white transition-colors"
            >
              Kayıt Ol
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
