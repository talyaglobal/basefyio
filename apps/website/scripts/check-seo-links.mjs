#!/usr/bin/env node
/**
 * SEO link and slug checker.
 *
 * Guards the three defects that shipped to production undetected, each of which
 * is invisible locally because nothing throws — the page just quietly 404s or
 * never exists:
 *
 *   1. A dead internal link. `/blog/rest-api-without-boilerplate` was linked
 *      from the glossary while the post lives at
 *      `/blog/rest-api-on-postgresql-without-boilerplate`. Renaming a post does
 *      not touch the registries that link to it.
 *   2. Two registry entries sharing one slug. Two glossary terms both claimed
 *      `rest-api`, so the sitemap emitted the URL twice and the second term
 *      ("Auto-generated REST API") had no reachable page at all.
 *   3. A `related` entry pointing at its own term, which renders a link back to
 *      the page you are already on.
 *
 * Non-page endpoints (feed.xml, llms.txt, robots.txt, sitemap.xml) are real
 * routes served by handlers, not missing pages — they are allowlisted so this
 * check never reports the false finding that they are broken.
 *
 * Usage:
 *   node scripts/check-seo-links.mjs
 *   npm run seo:check
 *
 * Exits 1 with a per-issue report when anything is broken.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");

/** Routes that exist but are not pages, so they have no slug to match. */
const NON_PAGE_ROUTES = ["/feed.xml", "/llms.txt", "/robots.txt", "/sitemap.xml"];

/** Routes with a hand-written page.tsx and no registry behind them. */
const STATIC_ROUTES = [
  "/",
  "/blog",
  "/compare",
  "/use-cases",
  "/learn",
  "/integrations",
  "/docs",
  "/privacy",
  "/terms",
  "/kvkk",
  "/cli-connect",
];

const issues = [];
const fail = (kind, detail) => issues.push({ kind, detail });

/**
 * Pulls `slug: "…"` and its following `related: [...]` out of a registry.
 * The registries are hand-edited object literals, so this reads them as text
 * rather than importing TypeScript at runtime.
 */
function readRegistry(file) {
  const text = fs.readFileSync(path.join(src, "lib/content", file), "utf8");
  const slugs = [...text.matchAll(/^\s*slug:\s*"([^"]+)"/gm)];
  return slugs.map((m, i) => {
    const start = m.index;
    const end = i + 1 < slugs.length ? slugs[i + 1].index : text.length;
    const block = text.slice(start, end);
    const related = block.match(/^\s*related:\s*\[([^\]]*)\]/m);
    return {
      slug: m[1],
      line: text.slice(0, start).split("\n").length,
      related: related ? [...related[1].matchAll(/"([^"]+)"/g)].map((r) => r[1]) : [],
    };
  });
}

const registries = {
  "glossary.ts": "/learn",
  "comparisons.ts": "/compare",
  "use-cases.ts": "/use-cases",
  "integrations.ts": "/integrations",
};

const valid = new Set([...STATIC_ROUTES, ...NON_PAGE_ROUTES]);

// Docs pages come from the nav registry that the sidebar and search also read.
const navText = fs.readFileSync(path.join(src, "app/docs/docs-nav-items.ts"), "utf8");
for (const m of navText.matchAll(/href:\s*"([^"]+)"/g)) valid.add(m[1]);

// Blog posts are files on disk.
for (const f of fs.readdirSync(path.join(src, "content/blog"))) {
  if (/\.mdx?$/.test(f)) valid.add(`/blog/${f.replace(/\.mdx?$/, "")}`);
}

// Registry-driven routes, checking slug uniqueness as we go.
const entriesByFile = {};
for (const [file, base] of Object.entries(registries)) {
  const entries = readRegistry(file);
  entriesByFile[file] = entries;
  const seen = new Map();
  for (const e of entries) {
    if (seen.has(e.slug)) {
      fail(
        "duplicate slug",
        `${file}: "${e.slug}" declared at line ${seen.get(e.slug)} and again at line ${e.line} — ` +
          `both claim ${base}/${e.slug}, so the sitemap repeats that URL and only the first entry gets a page`,
      );
    }
    seen.set(e.slug, e.line);
    valid.add(`${base}/${e.slug}`);
  }
}

// `related` must point at a real sibling term, never at itself.
for (const [file, entries] of Object.entries(entriesByFile)) {
  const slugs = new Set(entries.map((e) => e.slug));
  for (const e of entries) {
    for (const r of e.related) {
      if (r === e.slug) {
        fail("self-referential related", `${file}:${e.line} "${e.slug}" lists itself as a related term`);
      } else if (!slugs.has(r)) {
        fail("dangling related", `${file}:${e.line} "${e.slug}" → "${r}" does not exist`);
      }
    }
  }
}

// Every internal link in the source must resolve to a route we just proved exists.
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!/^(node_modules|\.next)$/.test(entry.name)) walk(full);
    } else if (/\.(ts|tsx|mdx|md)$/.test(entry.name)) {
      checkFile(full);
    }
  }
}

function checkFile(file) {
  const text = fs.readFileSync(file, "utf8");
  const rel = path.relative(root, file).replace(/\\/g, "/");
  const links = [
    ...text.matchAll(/href[:=]\s*"(\/[^"${}]*)"/g),
    ...text.matchAll(/\]\((\/[^)\s]+)\)/g),
  ];
  for (const m of links) {
    const href = (m[1].split("#")[0].split("?")[0].replace(/\/$/, "") || "/");
    if (href.startsWith("/api")) continue;
    if (!valid.has(href)) {
      const line = text.slice(0, m.index).split("\n").length;
      fail("dead link", `${rel}:${line} → ${href}`);
    }
  }
}

walk(src);

if (issues.length === 0) {
  console.log(`✓ SEO links OK — ${valid.size} routes, no dead links, no duplicate slugs.`);
  process.exit(0);
}

console.error(`✗ ${issues.length} SEO link issue${issues.length === 1 ? "" : "s"}:\n`);
for (const { kind, detail } of issues) console.error(`  [${kind}] ${detail}`);
console.error("");
process.exit(1);
