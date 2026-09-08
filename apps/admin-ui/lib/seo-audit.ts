/**
 * Live SEO audit of the public website.
 *
 * Fetches the site's own crawl surface — robots.txt, sitemap.xml, llms.txt —
 * and then a sample of the pages the sitemap advertises, and reports what a
 * search engine would find wrong. Everything here reads the public internet
 * with no credentials, so the audit works whether or not Search Console,
 * SerpAPI or any paid research tool is connected.
 *
 * Findings follow the KolaySEO audit contract: issue, impact, evidence, fix.
 * Two rules from that skill are deliberately encoded here, because both produce
 * confident-looking false findings otherwise:
 *
 *   - Non-HTML routes (feed.xml, llms.txt, robots.txt) have no <title> or <h1>
 *     and must never be reported as missing them.
 *   - A fetch failure is not a finding. Our own timeout is not evidence that a
 *     page is broken, and a panel that turns red on network noise stops being
 *     read. Failed fetches are counted and surfaced as run health instead.
 */

export type Severity = 'high' | 'medium' | 'low';

export interface SeoFinding {
  /** Stable id so the same defect keeps one row across runs. */
  id: string;
  category: 'crawlability' | 'on-page' | 'geo' | 'performance';
  severity: Severity;
  issue: string;
  evidence: string;
  fix: string;
  /** The URL the finding is about, when it is page-specific. */
  url?: string;
}

export interface SeoAuditResult {
  siteUrl: string;
  checkedAt: string;
  /** False when too little was fetched to trust the findings. */
  healthy: boolean;
  runNotes: string[];
  endpoints: {
    robots: { ok: boolean; status: number; referencesSitemap: boolean; aiCrawlers: string[] };
    sitemap: { ok: boolean; status: number; urlCount: number; duplicates: string[] };
    llms: { ok: boolean; status: number };
  };
  pages: {
    sampled: number;
    failed: number;
    slowestMs: number;
  };
  findings: SeoFinding[];
}

const TIMEOUT_MS = 10_000;
const SAMPLE_SIZE = 20;
const CONCURRENCY = 5;

/** AI crawlers the GEO layer expects to see named in robots.txt. */
const AI_CRAWLERS = ['GPTBot', 'OAI-SearchBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended'];

async function fetchText(url: string): Promise<{ status: number; body: string; ms: number }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'basefyio-seo-manager/1.0' },
      cache: 'no-store',
    });
    const body = await res.text();
    return { status: res.status, body, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs `worker` over `items` with a bounded number in flight. */
async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return out;
}

function textContent(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function runSeoAudit(siteUrl: string): Promise<SeoAuditResult> {
  const base = siteUrl.replace(/\/$/, '');
  const findings: SeoFinding[] = [];
  const runNotes: string[] = [];
  const add = (f: SeoFinding) => findings.push(f);

  // ---- robots.txt -------------------------------------------------------
  let robots = { ok: false, status: 0, referencesSitemap: false, aiCrawlers: [] as string[] };
  try {
    const r = await fetchText(`${base}/robots.txt`);
    const missingAi = AI_CRAWLERS.filter((c) => !new RegExp(c, 'i').test(r.body));
    robots = {
      ok: r.status === 200,
      status: r.status,
      referencesSitemap: /sitemap:/i.test(r.body),
      aiCrawlers: AI_CRAWLERS.filter((c) => new RegExp(c, 'i').test(r.body)),
    };
    if (r.status !== 200) {
      add({
        id: 'robots-missing',
        category: 'crawlability',
        severity: 'high',
        issue: 'robots.txt does not return 200',
        evidence: `GET ${base}/robots.txt returned ${r.status}`,
        fix: 'Restore app/robots.ts (KolaySEO Layer 1) so crawlers get an explicit policy.',
      });
    } else if (!robots.referencesSitemap) {
      add({
        id: 'robots-no-sitemap',
        category: 'crawlability',
        severity: 'medium',
        issue: 'robots.txt does not reference the sitemap',
        evidence: 'No "Sitemap:" line in robots.txt',
        fix: 'Add the sitemap URL to app/robots.ts — it is the cheapest discovery path there is.',
      });
    }
    if (r.status === 200 && missingAi.length > 0) {
      add({
        id: 'robots-ai-crawlers',
        category: 'geo',
        severity: 'low',
        issue: 'Some AI crawlers are not named in robots.txt',
        evidence: `Not mentioned: ${missingAi.join(', ')}`,
        fix: 'Extend the AI allow-list (KolaySEO Layer 3). Naming each crawler states intent even when the wildcard rule already allows it.',
      });
    }
  } catch {
    runNotes.push('robots.txt could not be fetched — not reported as a finding.');
  }

  // ---- sitemap.xml ------------------------------------------------------
  let sitemap = { ok: false, status: 0, urlCount: 0, duplicates: [] as string[] };
  let sitemapUrls: string[] = [];
  try {
    const s = await fetchText(`${base}/sitemap.xml`);
    const locs = [...s.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const u of locs) {
      if (seen.has(u)) dupes.add(u);
      seen.add(u);
    }
    sitemapUrls = [...seen];
    sitemap = { ok: s.status === 200, status: s.status, urlCount: locs.length, duplicates: [...dupes] };

    if (s.status !== 200) {
      add({
        id: 'sitemap-missing',
        category: 'crawlability',
        severity: 'high',
        issue: 'sitemap.xml does not return 200',
        evidence: `GET ${base}/sitemap.xml returned ${s.status}`,
        fix: 'Restore app/sitemap.ts (KolaySEO Layer 1).',
      });
    }
    if (dupes.size > 0) {
      add({
        id: 'sitemap-duplicates',
        category: 'crawlability',
        severity: 'medium',
        issue: 'The sitemap lists the same URL more than once',
        evidence: `${dupes.size} repeated: ${[...dupes].slice(0, 3).join(', ')}`,
        fix: 'Two content-registry entries are sharing a slug. Run `npm run seo:check` in apps/website — it names the colliding entries.',
      });
    }
  } catch {
    runNotes.push('sitemap.xml could not be fetched — not reported as a finding.');
  }

  // ---- llms.txt (GEO channel, recommended not required) -----------------
  let llms = { ok: false, status: 0 };
  try {
    const l = await fetchText(`${base}/llms.txt`);
    llms = { ok: l.status === 200, status: l.status };
    if (l.status !== 200) {
      add({
        id: 'llms-missing',
        category: 'geo',
        severity: 'low',
        issue: 'llms.txt is not served',
        evidence: `GET ${base}/llms.txt returned ${l.status}`,
        fix: 'Add the llms.txt route (KolaySEO Layer 3). This is an AI-distribution channel — it has no effect on Google ranking, so treat it as recommended, not critical.',
      });
    }
  } catch {
    runNotes.push('llms.txt could not be fetched — not reported as a finding.');
  }

  // ---- page sample ------------------------------------------------------
  // Only HTML routes: non-page endpoints have no title/h1 by design.
  const htmlUrls = sitemapUrls.filter((u) => !/\.(xml|txt|json|rss)$/i.test(u)).slice(0, SAMPLE_SIZE);
  let failed = 0;
  let slowestMs = 0;
  const titles = new Map<string, string[]>();

  const results = await mapLimit(htmlUrls, CONCURRENCY, async (url) => {
    try {
      const p = await fetchText(url);
      return { url, ...p };
    } catch {
      failed++;
      return null;
    }
  });

  for (const page of results) {
    if (!page) continue;
    slowestMs = Math.max(slowestMs, page.ms);

    if (page.status >= 400) {
      add({
        id: `page-${page.status}-${page.url}`,
        category: 'crawlability',
        severity: 'high',
        issue: `A sitemap URL returns ${page.status}`,
        evidence: `GET ${page.url} → ${page.status}`,
        fix: 'Either restore the page or stop listing it in the sitemap — advertising a dead URL wastes crawl budget and looks like neglect.',
        url: page.url,
      });
      continue;
    }
    if (page.status !== 200) continue;

    const title = page.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '';
    const h1Count = (page.body.match(/<h1[\s>]/gi) ?? []).length;
    const words = textContent(page.body).split(' ').filter(Boolean).length;
    const hasCanonical = /<link[^>]+rel=["']canonical["']/i.test(page.body);
    const noindex = /<meta[^>]+name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(page.body);
    const hasJsonLd = /application\/ld\+json/i.test(page.body);

    if (title) {
      const list = titles.get(title) ?? [];
      list.push(page.url);
      titles.set(title, list);
    }

    if (noindex) {
      add({
        id: `noindex-${page.url}`,
        category: 'crawlability',
        severity: 'high',
        issue: 'A page in the sitemap is marked noindex',
        evidence: `${page.url} carries <meta name="robots" content="noindex">`,
        fix: 'A sitemap says "index this" while the page says "do not" — decide which is right and make them agree.',
        url: page.url,
      });
    }
    if (!hasCanonical) {
      add({
        id: `canonical-${page.url}`,
        category: 'on-page',
        severity: 'low',
        issue: 'No canonical link',
        evidence: `${page.url} has no <link rel="canonical">`,
        fix: 'Set alternates.canonical in the route metadata so duplicates cannot split ranking signals.',
        url: page.url,
      });
    }
    if (h1Count === 0) {
      add({
        id: `h1-missing-${page.url}`,
        category: 'on-page',
        severity: 'medium',
        issue: 'Page has no H1',
        evidence: `${page.url} renders no <h1>`,
        fix: 'Give the page exactly one H1 carrying its primary term.',
        url: page.url,
      });
    } else if (h1Count > 1) {
      add({
        id: `h1-many-${page.url}`,
        category: 'on-page',
        severity: 'low',
        issue: `Page has ${h1Count} H1 headings`,
        evidence: page.url,
        fix: 'Keep one H1 and demote the rest to H2 so the heading outline stays unambiguous.',
        url: page.url,
      });
    }
    if (title.length > 60) {
      add({
        id: `title-long-${page.url}`,
        category: 'on-page',
        severity: 'low',
        issue: `Title is ${title.length} characters and will be truncated in results`,
        evidence: title,
        fix: 'Trim to about 60 characters including the brand suffix. This costs click-through, not ranking.',
        url: page.url,
      });
    }
    if (words < 150) {
      add({
        id: `thin-${page.url}`,
        category: 'on-page',
        severity: 'medium',
        issue: `Thin content — about ${words} words`,
        evidence: page.url,
        fix: 'Programmatic pages this short risk being treated as doorway pages, which can affect the whole site rather than just this page. Give each one genuinely distinct substance.',
        url: page.url,
      });
    }
    if (!hasJsonLd) {
      add({
        id: `jsonld-${page.url}`,
        category: 'on-page',
        severity: 'low',
        issue: 'No JSON-LD structured data in the HTML',
        evidence: `${page.url} has no application/ld+json block in the served source`,
        fix: 'Render schema with dangerouslySetInnerHTML (KolaySEO Layer 2). Note this check reads the served HTML, so client-injected schema would not be seen here.',
        url: page.url,
      });
    }
  }

  for (const [title, urls] of titles) {
    if (urls.length > 1) {
      add({
        id: `dup-title-${title}`,
        category: 'on-page',
        severity: 'medium',
        issue: 'Several pages share one title',
        evidence: `"${title}" on ${urls.length} pages: ${urls.slice(0, 3).join(', ')}`,
        fix: 'Duplicate titles make pages compete for the same query. Vary them in the content registry.',
      });
    }
  }

  // A run that captured almost nothing is unhealthy, never "clean".
  const captured = htmlUrls.length - failed;
  const healthy = sitemap.ok && (htmlUrls.length === 0 || captured >= htmlUrls.length * 0.8);
  if (!healthy) {
    runNotes.push(
      `Only ${captured}/${htmlUrls.length} sampled pages were reached. Treat this run as incomplete rather than clean.`,
    );
  }

  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);

  return {
    siteUrl: base,
    checkedAt: new Date().toISOString(),
    healthy,
    runNotes,
    endpoints: { robots, sitemap, llms },
    pages: { sampled: htmlUrls.length, failed, slowestMs },
    findings,
  };
}
