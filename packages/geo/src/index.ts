/**
 * @kolaybase/geo — Generative Engine Optimization toolkit.
 *
 * Build the assets AI answer engines need from a single {@link GeoProfile}
 * (llms.txt, JSON-LD, robots policy) and audit any URL for how well those
 * engines can read and cite it.
 */

// Generators
export { generateLlmsTxt, generateLlmsFullTxt } from './llms-txt.js';
export {
  organizationSchema,
  webSiteSchema,
  softwareApplicationSchema,
  faqSchema,
  howToSchemas,
  geoGraph,
} from './structured-data.js';
export { aiCrawlerRules, renderRobotsRules } from './robots.js';

// AI crawler registry
export { AI_CRAWLERS, findCrawler, crawlersByPurpose } from './crawlers.js';

// Audit engine
export { auditUrl, auditInput, runChecks, extractPage } from './audit/index.js';

// Types
export type {
  GeoProfile,
  GeoSection,
  GeoLink,
  FaqItem,
  HowTo,
  HowToStep,
  GeoFact,
  GeoOffer,
  AiCrawler,
  CrawlerPurpose,
  RobotsRule,
  AiCrawlerPolicyOptions,
  CheckStatus,
  CheckResult,
  AuditCategory,
  GeoGrade,
  AuditReport,
  AuditInput,
} from './types.js';
