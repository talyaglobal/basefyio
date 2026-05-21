/**
 * Dependency-free HTML extraction for the audit engine.
 *
 * The audit only needs a handful of signals (title, meta, headings, JSON-LD,
 * readable text length), so a few well-scoped regexes beat pulling in a DOM
 * parser. This is deliberately forgiving: malformed markup degrades to "not
 * found" rather than throwing.
 */

export interface ExtractedPage {
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  lang: string | null;
  h1: string[];
  headings: number;
  /** Parsed JSON-LD objects (each <script type="application/ld+json"> block). */
  jsonLd: unknown[];
  /** schema.org @type values found across all JSON-LD blocks. */
  schemaTypes: string[];
  /** Approximate count of visible words in <body>. */
  wordCount: number;
  /** Whether an OpenGraph title is present. */
  hasOpenGraph: boolean;
}

function firstMatch(html: string, re: RegExp): string | null {
  const m = re.exec(html);
  return m ? m[1].trim() : null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function collectSchemaTypes(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectSchemaTypes(item, out);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const t = obj['@type'];
    if (typeof t === 'string') out.add(t);
    else if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && out.add(x));
    for (const v of Object.values(obj)) collectSchemaTypes(v, out);
  }
}

export function extractPage(html: string): ExtractedPage {
  const title = firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);

  const metaDescription =
    firstMatch(
      html,
      /<meta[^>]+name=["']description["'][^>]*content=["']([\s\S]*?)["']/i,
    ) ??
    firstMatch(
      html,
      /<meta[^>]+content=["']([\s\S]*?)["'][^>]*name=["']description["']/i,
    );

  const canonical = firstMatch(
    html,
    /<link[^>]+rel=["']canonical["'][^>]*href=["']([\s\S]*?)["']/i,
  );

  const lang = firstMatch(html, /<html[^>]*\blang=["']([^"']+)["']/i);

  const h1 = Array.from(
    html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi),
    (m) => decodeEntities(m[1].replace(/<[^>]+>/g, '').trim()),
  ).filter(Boolean);

  const headings = (html.match(/<h[1-6][\s>]/gi) ?? []).length;

  const hasOpenGraph = /<meta[^>]+property=["']og:title["']/i.test(html);

  // JSON-LD blocks.
  const jsonLd: unknown[] = [];
  const schemaTypeSet = new Set<string>();
  for (const m of html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const parsed = JSON.parse(m[1].trim());
      jsonLd.push(parsed);
      collectSchemaTypes(parsed, schemaTypeSet);
    } catch {
      // Ignore malformed blocks — they simply don't count toward coverage.
    }
  }

  // Visible word count: strip script/style, then tags.
  const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  const body = bodyMatch ? bodyMatch[1] : html;
  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const wordCount = text ? text.split(' ').length : 0;

  return {
    title: title ? decodeEntities(title) : null,
    metaDescription: metaDescription ? decodeEntities(metaDescription) : null,
    canonical,
    lang,
    h1,
    headings,
    jsonLd,
    schemaTypes: Array.from(schemaTypeSet),
    wordCount,
    hasOpenGraph,
  };
}
