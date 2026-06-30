/**
 * Core types for the GEO (Generative Engine Optimization) engine.
 *
 * A {@link GeoProfile} is the single, framework-agnostic description of a site.
 * Every generator (llms.txt, JSON-LD, robots policy) consumes it, and the audit
 * engine produces a report scored against the same notion of "what a generative
 * engine needs to read and cite you".
 */

// ── Site profile ────────────────────────────────────────

export interface GeoProfile {
  /** Brand / product name, e.g. "basefyio". */
  name: string;
  /** Canonical origin, no trailing slash, e.g. "https://basefyio.com". */
  url: string;
  /**
   * One- or two-sentence summary. This is the single most-cited line of copy
   * in generative answers — keep it factual, specific, and self-contained.
   */
  summary: string;
  /** Longer description (a paragraph). Optional; falls back to {@link summary}. */
  description?: string;
  /** Legal entity name for structured data. Defaults to {@link name}. */
  legalName?: string;
  /** Absolute or root-relative logo path. Defaults to "/logo.svg". */
  logo?: string;
  /** BCP-47 language tag, e.g. "en". Defaults to "en". */
  lang?: string;
  /** Section groups linking to the most citable pages on the site. */
  sections?: GeoSection[];
  /** Frequently asked questions, in answer-first form. */
  faqs?: FaqItem[];
  /** Step-by-step guides surfaced as schema.org HowTo. */
  howtos?: HowTo[];
  /** Hard facts an engine can quote verbatim (pricing, limits, support). */
  facts?: GeoFact[];
  /** schema.org SoftwareApplication offer, when the product is software. */
  offer?: GeoOffer;
  /** Notes appended to the bottom of llms.txt (licensing, contact, etc.). */
  notes?: string[];
}

export interface GeoSection {
  /** Heading, e.g. "Documentation". */
  title: string;
  /** Optional one-line description of the section. */
  description?: string;
  links: GeoLink[];
}

export interface GeoLink {
  title: string;
  /** Absolute URL or path relative to the profile's `url`. */
  url: string;
  /** Short note shown after the link in llms.txt. */
  note?: string;
}

export interface FaqItem {
  question: string;
  /** Answer-first prose. Lead with the answer in the first sentence. */
  answer: string;
}

export interface HowTo {
  name: string;
  description?: string;
  steps: HowToStep[];
}

export interface HowToStep {
  name: string;
  text: string;
  url?: string;
}

export interface GeoFact {
  /** e.g. "Free tier", "Database", "Auth". */
  label: string;
  /** e.g. "1 project, 500MB Postgres, 1GB storage". */
  value: string;
}

export interface GeoOffer {
  price: string;
  priceCurrency: string;
  description?: string;
  /** schema.org applicationCategory, e.g. "DeveloperApplication". */
  applicationCategory?: string;
  /** e.g. "Web". */
  operatingSystem?: string;
  /** Bullet list of capabilities. */
  featureList?: string[];
}

// ── AI crawler registry ─────────────────────────────────

export type CrawlerPurpose =
  /** Trains foundation models on crawled content. */
  | 'training'
  /** Fetches pages live to answer a user's query (RAG / answer engines). */
  | 'search'
  /** Fetches a single URL on a user's explicit request (assistant browsing). */
  | 'user-action';

export interface AiCrawler {
  /** robots.txt User-agent token, e.g. "GPTBot". */
  token: string;
  /** Operating company, e.g. "OpenAI". */
  operator: string;
  /** Human label, e.g. "ChatGPT search". */
  label: string;
  purpose: CrawlerPurpose;
  /** Vendor documentation URL. */
  docs?: string;
}

// ── robots policy ───────────────────────────────────────

export interface RobotsRule {
  userAgent: string;
  allow?: string[];
  disallow?: string[];
}

export interface AiCrawlerPolicyOptions {
  /** Allow crawlers whose purpose is live search / answering. Default true. */
  allowSearch?: boolean;
  /** Allow crawlers that browse on explicit user action. Default true. */
  allowUserActions?: boolean;
  /** Allow crawlers that scrape for model training. Default true. */
  allowTraining?: boolean;
  /** Paths to disallow for the AI crawlers that are allowed. */
  disallow?: string[];
}

// ── Audit ───────────────────────────────────────────────

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface CheckResult {
  id: string;
  /** Human-readable check title. */
  title: string;
  status: CheckStatus;
  /** Points awarded by this check. */
  score: number;
  /** Maximum points the check can award. */
  max: number;
  /** What was found. */
  detail: string;
  /** Actionable fix when status is not "pass". */
  fix?: string;
}

export interface AuditCategory {
  id: string;
  title: string;
  score: number;
  max: number;
  checks: CheckResult[];
}

export type GeoGrade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface AuditReport {
  url: string;
  /** ISO timestamp of when the audit ran. */
  fetchedAt: string;
  /** 0–100. */
  score: number;
  grade: GeoGrade;
  categories: AuditCategory[];
  /** Highest-impact fixes, ordered by points recoverable. */
  recommendations: string[];
}

/** Raw inputs the audit operates on — lets callers supply pre-fetched data. */
export interface AuditInput {
  url: string;
  /** Page HTML. */
  html: string;
  /** Contents of /robots.txt, if fetched. */
  robotsTxt?: string | null;
  /** Whether /llms.txt resolved with 2xx. */
  hasLlmsTxt?: boolean;
  /** Contents of /llms.txt, if fetched. */
  llmsTxt?: string | null;
}
