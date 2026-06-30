import type { Metadata } from "next";
import { SiteShell } from "@/components/site-shell";
import { buildMetadata } from "@/lib/seo/metadata";

const TITLE = "KVKK Aydınlatma Metni";
const DESCRIPTION =
  "6698 sayılı Kişisel Verilerin Korunması Kanunu kapsamında basefyio tarafından işlenen kişisel verilere ilişkin aydınlatma metni.";
const UPDATED = "26 Haziran 2026";

export async function generateMetadata(): Promise<Metadata> {
  return buildMetadata({ path: "/kvkk", title: TITLE, description: DESCRIPTION });
}

export default function KvkkPage() {
  return (
    <SiteShell>
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <h1 className="text-4xl font-bold tracking-tight">{TITLE}</h1>
        <p className="mt-3 text-sm text-muted-foreground">Son güncelleme: {UPDATED}</p>

        <div className="mt-10 space-y-8 text-sm leading-relaxed text-muted-foreground [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-foreground [&_a]:text-primary [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1">
          <p>
            İşbu aydınlatma metni, 6698 sayılı Kişisel Verilerin Korunması Kanunu
            (&quot;KVKK&quot;) uyarınca, veri sorumlusu sıfatıyla Talya Smart (&quot;basefyio&quot;)
            tarafından kişisel verilerinizin işlenmesine ilişkin olarak hazırlanmıştır.
          </p>

          <h2>1. Veri Sorumlusu</h2>
          <p>
            Kişisel verileriniz, veri sorumlusu olarak Talya Smart tarafından aşağıda
            açıklanan kapsamda işlenmektedir. İletişim: <a href="mailto:support@talyasmart.com">support@talyasmart.com</a>.
          </p>

          <h2>2. İşlenen Kişisel Veriler</h2>
          <ul>
            <li><strong>Kimlik ve iletişim:</strong> ad-soyad, e-posta adresi.</li>
            <li><strong>Hesap verileri:</strong> şifre (kimlik sağlayıcımızda özetlenmiş/şifreli olarak), takım ve üyelik bilgileri.</li>
            <li><strong>Ödeme verileri:</strong> abonelik ve fatura bilgileri. Kart bilgileri yalnızca ödeme kuruluşu (Stripe) tarafından işlenir; sunucularımızda saklanmaz.</li>
            <li><strong>İşlem güvenliği verileri:</strong> IP adresi, log kayıtları, cihaz/tarayıcı bilgisi ve denetim kayıtları.</li>
            <li><strong>Proje verileri:</strong> projelerinizde oluşturduğunuz veritabanı, dosya ve kullanıcı içerikleri.</li>
          </ul>

          <h2>3. İşleme Amaçları</h2>
          <ul>
            <li>Hizmetin sunulması, sürdürülmesi ve güvenliğinin sağlanması.</li>
            <li>Ödeme ve abonelik süreçlerinin yürütülmesi.</li>
            <li>Hizmet, güvenlik ve hesap bildirimlerinin iletilmesi.</li>
            <li>Hukuki yükümlülüklerin yerine getirilmesi ve kötüye kullanımın önlenmesi.</li>
          </ul>

          <h2>4. Hukuki Sebepler</h2>
          <p>
            Kişisel verileriniz; sözleşmenin kurulması/ifası, hukuki yükümlülüklerimizin
            yerine getirilmesi, meşru menfaatlerimiz ve gerekli hallerde açık rızanıza
            dayanılarak (KVKK m.5) işlenmektedir.
          </p>

          <h2>5. Aktarım</h2>
          <p>
            Verileriniz, hizmetin sağlanması amacıyla sınırlı olarak altyapı ve hizmet
            sağlayıcılarımızla (ödeme kuruluşu, kimlik sağlayıcı ve barındırma sağlayıcısı)
            ve yasal olarak yetkili kamu kurum/kuruluşlarıyla, KVKK m.8 ve m.9&apos;a uygun
            şekilde paylaşılabilir.
          </p>

          <h2>6. Saklama Süresi</h2>
          <p>
            Kişisel verileriniz, ilgili mevzuatta öngörülen veya işleme amacının gerektirdiği
            süre boyunca saklanır; sürenin sonunda silinir, yok edilir veya anonim hale
            getirilir.
          </p>

          <h2>7. İlgili Kişinin Hakları (KVKK m.11)</h2>
          <p>
            Kişisel verilerinizin işlenip işlenmediğini öğrenme, bilgi talep etme, işleme
            amacını öğrenme, düzeltilmesini/silinmesini isteme, işleme itiraz etme ve
            zararın giderilmesini talep etme haklarına sahipsiniz. Taleplerinizi
            <a href="mailto:support@talyasmart.com"> support@talyasmart.com</a> adresine
            iletebilirsiniz.
          </p>

          <h2>8. Değişiklikler</h2>
          <p>
            Bu aydınlatma metni zaman zaman güncellenebilir; önemli değişiklikler yukarıdaki
            &quot;Son güncelleme&quot; tarihine yansıtılır.
          </p>

          <p className="text-xs italic">
            Bu metin şeffaflık amacıyla sunulmuştur ve hukuki incelemeyle güncellenebilir.
          </p>
        </div>
      </div>
    </SiteShell>
  );
}
