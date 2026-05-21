/**
 * schema.org JSON-LD builders driven by a {@link GeoProfile}.
 *
 * Generative engines lean heavily on structured data to extract entities,
 * facts, and Q&A pairs. Each builder returns a plain serialisable object;
 * {@link geoGraph} bundles the site-wide ones into a single `@graph` block you
 * can drop into one `<script type="application/ld+json">`.
 */
import type { GeoProfile } from './types.js';

type Thing = Record<string, unknown>;

function origin(profile: GeoProfile): string {
  return profile.url.replace(/\/$/, '');
}

function abs(profile: GeoProfile, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${origin(profile)}${path.startsWith('/') ? path : `/${path}`}`;
}

export function organizationSchema(profile: GeoProfile): Thing {
  const url = origin(profile);
  return {
    '@type': 'Organization',
    '@id': `${url}/#organization`,
    name: profile.name,
    legalName: profile.legalName ?? profile.name,
    url,
    logo: abs(profile, profile.logo ?? '/logo.svg'),
    description: profile.description ?? profile.summary,
  };
}

export function webSiteSchema(profile: GeoProfile): Thing {
  const url = origin(profile);
  return {
    '@type': 'WebSite',
    '@id': `${url}/#website`,
    name: profile.name,
    url,
    publisher: { '@id': `${url}/#organization` },
    inLanguage: profile.lang ?? 'en',
    description: profile.summary,
  };
}

export function softwareApplicationSchema(profile: GeoProfile): Thing | null {
  if (!profile.offer) return null;
  const url = origin(profile);
  const { offer } = profile;
  return {
    '@type': 'SoftwareApplication',
    '@id': `${url}/#product`,
    name: profile.name,
    applicationCategory: offer.applicationCategory ?? 'DeveloperApplication',
    operatingSystem: offer.operatingSystem ?? 'Web',
    url,
    description: profile.description ?? profile.summary,
    offers: {
      '@type': 'Offer',
      price: offer.price,
      priceCurrency: offer.priceCurrency,
      ...(offer.description ? { description: offer.description } : {}),
    },
    ...(offer.featureList ? { featureList: offer.featureList } : {}),
    provider: { '@id': `${url}/#organization` },
  };
}

export function faqSchema(profile: GeoProfile): Thing | null {
  if (!profile.faqs?.length) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: profile.faqs.map((f) => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: { '@type': 'Answer', text: f.answer },
    })),
  };
}

export function howToSchemas(profile: GeoProfile): Thing[] {
  return (profile.howtos ?? []).map((howto) => ({
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name: howto.name,
    ...(howto.description ? { description: howto.description } : {}),
    step: howto.steps.map((step, i) => ({
      '@type': 'HowToStep',
      position: i + 1,
      name: step.name,
      text: step.text,
      ...(step.url ? { url: abs(profile, step.url) } : {}),
    })),
  }));
}

/**
 * Site-wide brand graph: Organization + WebSite + (SoftwareApplication).
 * Render once, in the document head/layout.
 */
export function geoGraph(profile: GeoProfile): Thing {
  const graph: Thing[] = [organizationSchema(profile), webSiteSchema(profile)];
  const app = softwareApplicationSchema(profile);
  if (app) graph.push(app);
  return { '@context': 'https://schema.org', '@graph': graph };
}
