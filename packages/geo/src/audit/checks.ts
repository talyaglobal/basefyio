/**
 * The GEO audit rubric: a set of checks grouped into the four things a
 * generative engine needs from a page, each awarding points toward a 0–100
 * score. The grading reflects real citability levers, not generic SEO.
 */
import type {
  AuditCategory,
  AuditInput,
  CheckResult,
  CheckStatus,
} from '../types.js';
import { AI_CRAWLERS, crawlersByPurpose } from '../crawlers.js';
import { extractPage } from './html.js';
import { evaluateRoot, hasExplicitGroup } from './robots.js';

function check(
  id: string,
  title: string,
  status: CheckStatus,
  score: number,
  max: number,
  detail: string,
  fix?: string,
): CheckResult {
  return { id, title, status, score, max, detail, ...(fix ? { fix } : {}) };
}

function category(
  id: string,
  title: string,
  checks: CheckResult[],
): AuditCategory {
  return {
    id,
    title,
    checks,
    score: checks.reduce((s, c) => s + c.score, 0),
    max: checks.reduce((s, c) => s + c.max, 0),
  };
}

/** Run every check and return the categories. */
export function runChecks(input: AuditInput): AuditCategory[] {
  const page = extractPage(input.html);

  // ── 1. Crawler access ─────────────────────────────────
  const searchBots = crawlersByPurpose('search', 'user-action');
  const blockedSearch = searchBots.filter(
    (c) => evaluateRoot(input.robotsTxt, c.token) === 'disallowed',
  );
  const explicitCount = AI_CRAWLERS.filter((c) =>
    hasExplicitGroup(input.robotsTxt, c.token),
  ).length;

  const access = category('access', 'AI crawler access', [
    blockedSearch.length === 0
      ? check(
          'search-bots-allowed',
          'Answer-engine crawlers can fetch the page',
          'pass',
          20,
          20,
          `None of the ${searchBots.length} live answer-engine crawlers are blocked by robots.txt.`,
        )
      : check(
          'search-bots-allowed',
          'Answer-engine crawlers can fetch the page',
          'fail',
          0,
          20,
          `Blocked: ${blockedSearch.map((c) => c.token).join(', ')}.`,
          'Remove the Disallow rules for these tokens in robots.txt — blocking them removes you from those engines’ answers.',
        ),
    explicitCount > 0
      ? check(
          'explicit-policy',
          'Explicit AI-crawler policy present',
          'pass',
          10,
          10,
          `${explicitCount} AI crawlers have an explicit robots.txt group.`,
        )
      : check(
          'explicit-policy',
          'Explicit AI-crawler policy present',
          'warn',
          3,
          10,
          'AI crawlers are only covered by the wildcard rule.',
          'Add explicit User-agent groups (GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot, Google-Extended…) to state intent and future-proof access.',
        ),
  ]);

  // ── 2. Machine-readable map (llms.txt) ────────────────
  const llms = category('llms', 'llms.txt manifest', [
    input.hasLlmsTxt
      ? check(
          'llms-txt',
          '/llms.txt is published',
          'pass',
          15,
          15,
          'An llms.txt manifest is served at the site root.',
        )
      : check(
          'llms-txt',
          '/llms.txt is published',
          'fail',
          0,
          15,
          'No /llms.txt found.',
          'Publish an llms.txt (see llmstxt.org): name, one-line summary, and curated links to your most citable pages.',
        ),
    input.llmsTxt && /^>\s.+/m.test(input.llmsTxt)
      ? check(
          'llms-summary',
          'llms.txt has a summary blockquote',
          'pass',
          5,
          5,
          'The manifest leads with a "> summary" line engines can quote.',
        )
      : check(
          'llms-summary',
          'llms.txt has a summary blockquote',
          input.hasLlmsTxt ? 'warn' : 'fail',
          0,
          5,
          input.hasLlmsTxt
            ? 'llms.txt is missing the leading "> summary" blockquote.'
            : 'No llms.txt to summarise.',
          'Add a one-line "> ..." blockquote right after the H1 — it is the most-quoted line.',
        ),
  ]);

  // ── 3. Structured data ────────────────────────────────
  const types = page.schemaTypes;
  const has = (t: string) =>
    types.some((x) => x.toLowerCase() === t.toLowerCase());
  const valuable = ['Organization', 'WebSite', 'SoftwareApplication', 'Product', 'Article', 'BlogPosting'];
  const valuableFound = valuable.filter(has);

  const structured = category('structured', 'Structured data', [
    page.jsonLd.length > 0
      ? check(
          'json-ld',
          'JSON-LD structured data present',
          'pass',
          12,
          12,
          `${page.jsonLd.length} JSON-LD block(s); types: ${types.join(', ') || 'none typed'}.`,
        )
      : check(
          'json-ld',
          'JSON-LD structured data present',
          'fail',
          0,
          12,
          'No parseable JSON-LD found.',
          'Add schema.org JSON-LD (Organization + WebSite at minimum) so engines can extract entities.',
        ),
    valuableFound.length > 0
      ? check(
          'entity-schema',
          'Entity / product schema present',
          'pass',
          8,
          8,
          `Found: ${valuableFound.join(', ')}.`,
        )
      : check(
          'entity-schema',
          'Entity / product schema present',
          'warn',
          0,
          8,
          'No Organization / Product / Article schema detected.',
          'Describe what you are with Organization and (if applicable) SoftwareApplication or Product schema.',
        ),
    has('FAQPage')
      ? check(
          'faq-schema',
          'FAQ schema present (Q&A pairs)',
          'pass',
          8,
          8,
          'FAQPage schema gives engines ready-to-cite answers.',
        )
      : check(
          'faq-schema',
          'FAQ schema present (Q&A pairs)',
          'warn',
          0,
          8,
          'No FAQPage schema found.',
          'Add a FAQ section with FAQPage schema — answer-first Q&A is the format engines cite most.',
        ),
  ]);

  // ── 4. Content legibility ─────────────────────────────
  const titleLen = page.title?.length ?? 0;
  const descLen = page.metaDescription?.length ?? 0;

  const content = category('content', 'Content legibility', [
    titleLen > 0
      ? check(
          'title',
          'Descriptive <title>',
          titleLen >= 15 && titleLen <= 70 ? 'pass' : 'warn',
          titleLen >= 15 && titleLen <= 70 ? 4 : 2,
          4,
          `Title is ${titleLen} chars.`,
          titleLen < 15 || titleLen > 70
            ? 'Aim for ~15–70 chars: specific, front-loaded with the entity name.'
            : undefined,
        )
      : check('title', 'Descriptive <title>', 'fail', 0, 4, 'No <title>.', 'Add a descriptive page title.'),
    descLen > 0
      ? check(
          'meta-description',
          'Meta description',
          descLen >= 50 && descLen <= 200 ? 'pass' : 'warn',
          descLen >= 50 && descLen <= 200 ? 4 : 2,
          4,
          `Meta description is ${descLen} chars.`,
          descLen < 50 || descLen > 200 ? 'Aim for ~50–200 chars summarising the page.' : undefined,
        )
      : check(
          'meta-description',
          'Meta description',
          'fail',
          0,
          4,
          'No meta description.',
          'Add a concise, factual meta description — engines reuse it as a snippet.',
        ),
    page.h1.length === 1
      ? check('h1', 'Exactly one H1', 'pass', 4, 4, `H1: "${page.h1[0]}".`)
      : check(
          'h1',
          'Exactly one H1',
          'warn',
          1,
          4,
          page.h1.length === 0 ? 'No H1 found.' : `${page.h1.length} H1s found.`,
          'Use a single, descriptive H1 stating the main entity/topic.',
        ),
    page.wordCount >= 250
      ? check(
          'substance',
          'Substantive, quotable content',
          'pass',
          4,
          4,
          `~${page.wordCount} words of readable text.`,
        )
      : check(
          'substance',
          'Substantive, quotable content',
          'warn',
          1,
          4,
          `Only ~${page.wordCount} words of readable text.`,
          'Add self-contained, factual prose. Engines cite specific claims, not thin or JS-only pages.',
        ),
  ]);

  return [access, llms, structured, content];
}
