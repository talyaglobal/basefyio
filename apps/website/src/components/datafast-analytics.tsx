import Script from "next/script";

/**
 * DataFast analytics. Loaded with `afterInteractive` (DataFast's documented
 * strategy) so it never blocks first paint — the script only needs to run once
 * the page is live, unlike GA's tag-assistant requirement.
 *
 * The website id and domain are issued by DataFast and are public values, so
 * they live in the source rather than an env var: a missing build-time
 * NEXT_PUBLIC_* is the usual cause of "tag not detected" (see the note in
 * google-analytics.tsx), and there is nothing here worth that risk.
 */
export function DataFastAnalytics() {
  return (
    <Script
      src="https://datafa.st/js/script.js"
      data-website-id="dfid_mmcHrFafI9K0Iya4U9lXo"
      data-domain="basefyio.com"
      strategy="afterInteractive"
    />
  );
}
