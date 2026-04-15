import { getSiteUrl } from "@/lib/site-url";

/** Organization + WebSite structured data for search engines. */
export function SiteJsonLd() {
  const url = getSiteUrl();
  const data = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${url}/#organization`,
        name: "Kolaybase",
        url,
        description:
          "Backend-as-a-service platform: PostgreSQL, authentication, storage, and auto-generated REST API.",
      },
      {
        "@type": "WebSite",
        "@id": `${url}/#website`,
        name: "Kolaybase",
        url,
        publisher: { "@id": `${url}/#organization` },
        inLanguage: "en",
      },
    ],
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
