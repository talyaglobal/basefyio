import Script from "next/script";

/**
 * GA4 Google tag (gtag.js). Injected in <head> with `beforeInteractive` so the
 * snippet appears in the initial HTML — required for GA’s “Test your website” /
 * tag assistant and for early page_view capture.
 *
 * Set `NEXT_PUBLIC_GA_MEASUREMENT_ID=""` to disable. Do not set it to empty in
 * production `.env` unless you intend to turn GA off (empty overrides Dockerfile defaults).
 */
function getMeasurementId(): string | null {
  const v = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
  if (v === "") return null;
  const trimmed = (v ?? "G-9HTNF4CR06").trim();
  return trimmed || null;
}

export function GoogleAnalytics() {
  const measurementId = getMeasurementId();
  if (!measurementId) return null;

  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${measurementId}`}
        strategy="beforeInteractive"
      />
      <Script id="google-analytics" strategy="beforeInteractive">
        {`
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${measurementId}', { send_page_view: true });
        `.trim()}
      </Script>
    </>
  );
}
