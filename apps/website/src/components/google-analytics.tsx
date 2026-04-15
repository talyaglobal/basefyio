import Script from "next/script";

/**
 * Google Analytics 4 (gtag). Set `NEXT_PUBLIC_GA_MEASUREMENT_ID=""` to disable.
 * When unset, defaults to the project measurement ID (baked at build time).
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
        strategy="afterInteractive"
      />
      <Script id="google-analytics" strategy="afterInteractive">
        {`
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${measurementId}');
        `.trim()}
      </Script>
    </>
  );
}
