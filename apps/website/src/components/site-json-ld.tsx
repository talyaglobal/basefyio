import { getSiteUrl } from "@/lib/site-url";

/**
 * Organization, WebSite, and SoftwareApplication structured data for search engines
 * (brand + product signals for developer/BaaS queries).
 */
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
          "Backend-as-a-service platform for developers: PostgreSQL, authentication, storage, and auto-generated REST API.",
      },
      {
        "@type": "WebSite",
        "@id": `${url}/#website`,
        name: "Kolaybase",
        url,
        publisher: { "@id": `${url}/#organization` },
        inLanguage: "en",
        description:
          "Hosted PostgreSQL, auth, REST API, SDK and CLI for building production backends quickly.",
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${url}/#product`,
        name: "Kolaybase",
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Web",
        url,
        description:
          "Cloud backend platform with PostgreSQL, Keycloak auth, S3-compatible storage, REST API, JavaScript SDK, and CLI.",
        offers: {
          "@type": "Offer",
          price: "0",
          priceCurrency: "USD",
          description: "Free tier and paid plans available",
        },
        featureList: [
          "PostgreSQL database per project",
          "REST API and Supabase-compatible queries",
          "OAuth and email authentication",
          "Object storage",
          "kolaybase-js SDK",
          "kolaybase CLI",
        ],
        provider: { "@id": `${url}/#organization` },
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
