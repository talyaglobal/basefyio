/**
 * Pure JSON-LD (schema.org) builders.
 *
 * Each function returns a plain serialisable object. Render it with the
 * `<JsonLd />` component. Keeping these pure (no React, no `headers()`) makes
 * them trivial to compose and unit-test, and lets callers pass the resolved
 * request origin in.
 */
import { SITE } from "./site";

type Thing = Record<string, unknown>;

export function organizationSchema(url: string): Thing {
  return {
    "@type": "Organization",
    "@id": `${url}/#organization`,
    name: SITE.name,
    legalName: SITE.legalName,
    url,
    logo: `${url}/logo.svg`,
    description:
      "Backend-as-a-service platform for developers: PostgreSQL, authentication, storage, and auto-generated REST API.",
  };
}

export function webSiteSchema(url: string): Thing {
  return {
    "@type": "WebSite",
    "@id": `${url}/#website`,
    name: SITE.name,
    url,
    publisher: { "@id": `${url}/#organization` },
    inLanguage: SITE.lang,
    description:
      "Hosted PostgreSQL, auth, REST API, SDK and CLI for building production backends quickly.",
  };
}

export function softwareApplicationSchema(url: string): Thing {
  return {
    "@type": "SoftwareApplication",
    "@id": `${url}/#product`,
    name: SITE.name,
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
      "REST API and PostgREST-style queries",
      "OAuth and email authentication",
      "Object storage",
      "basefyio-js SDK",
      "basefyio CLI",
    ],
    provider: { "@id": `${url}/#organization` },
  };
}

/** Brand graph injected on every page (Organization + WebSite + Product). */
export function siteGraph(url: string): Thing {
  return {
    "@context": "https://schema.org",
    "@graph": [
      organizationSchema(url),
      webSiteSchema(url),
      softwareApplicationSchema(url),
    ],
  };
}

export type ArticleSchemaInput = {
  url: string;
  title: string;
  description: string;
  /** ISO date string. */
  datePublished: string;
  /** ISO date string; defaults to datePublished. */
  dateModified?: string;
  authorName: string;
  /** Absolute image URL. */
  image?: string;
  /** Origin, for resolving publisher @id. */
  siteUrl: string;
};

export function articleSchema(input: ArticleSchemaInput): Thing {
  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: input.title,
    description: input.description,
    datePublished: input.datePublished,
    dateModified: input.dateModified ?? input.datePublished,
    author: { "@type": "Person", name: input.authorName },
    publisher: { "@id": `${input.siteUrl}/#organization` },
    mainEntityOfPage: { "@type": "WebPage", "@id": input.url },
    ...(input.image ? { image: input.image } : {}),
    inLanguage: SITE.lang,
  };
}

export type BreadcrumbItem = { name: string; url: string };

export function breadcrumbSchema(items: BreadcrumbItem[]): Thing {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

export type FaqItem = { question: string; answer: string };

export function faqSchema(items: FaqItem[]): Thing {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
    })),
  };
}

export type DefinedTermInput = {
  name: string;
  description: string;
  url: string;
  /** Origin, for the DefinedTermSet @id. */
  siteUrl: string;
};

/** Schema for a single glossary/learn term page. */
export function definedTermSchema(input: DefinedTermInput): Thing {
  return {
    "@context": "https://schema.org",
    "@type": "DefinedTerm",
    name: input.name,
    description: input.description,
    url: input.url,
    inDefinedTermSet: {
      "@type": "DefinedTermSet",
      "@id": `${input.siteUrl}/learn#glossary`,
      name: `${SITE.name} Glossary`,
      url: `${input.siteUrl}/learn`,
    },
  };
}

export type ItemListEntry = { name: string; url: string; description?: string };

/** Used on index pages (blog list, comparison list) for richer SERP results. */
export function itemListSchema(name: string, items: ItemListEntry[]): Thing {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name,
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      url: item.url,
      ...(item.description ? { description: item.description } : {}),
    })),
  };
}
