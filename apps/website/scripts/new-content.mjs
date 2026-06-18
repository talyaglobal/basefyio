#!/usr/bin/env node
/**
 * SEO content generator.
 *
 * Scaffolds new SEO-targeted content for the website's SEO engine:
 *   - blog posts  → writes a ready-to-edit MDX file with frontmatter
 *   - comparisons → prints a typed entry to paste into the comparisons registry
 *   - use cases   → prints a typed entry to paste into the use-cases registry
 *
 * Blog posts are file-based, so they're created directly. Comparisons and use
 * cases live in TypeScript registries, so the generator emits a snippet rather
 * than risk corrupting those files.
 *
 * Usage:
 *   node scripts/new-content.mjs blog "How to model multi-tenant data"
 *   node scripts/new-content.mjs compare "PlanetScale"
 *   node scripts/new-content.mjs use-case "internal tools"
 *
 * npm:
 *   npm run seo:new -- blog "My title"
 *   npm run new:post -- "My title"
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BLOG_DIR = path.join(ROOT, "src/content/blog");

function slugify(input) {
  return input
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function die(msg) {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
}

function ok(msg) {
  console.log(`\x1b[32m✓ ${msg}\x1b[0m`);
}

function newBlogPost(title) {
  if (!title) die('Provide a title, e.g. seo:new -- blog "My post title"');
  const slug = slugify(title);
  if (!slug) die("Could not derive a slug from the title.");

  fs.mkdirSync(BLOG_DIR, { recursive: true });
  const file = path.join(BLOG_DIR, `${slug}.mdx`);
  if (fs.existsSync(file)) die(`Post already exists: ${path.relative(ROOT, file)}`);

  const body = `---
title: "${title.replace(/"/g, '\\"')}"
description: "TODO: 140–160 char meta description targeting the keyword for this post."
date: "${today()}"
author: "Basefyio Team"
tags: ["TODO"]
draft: true
---

Opening paragraph that states the problem and the promise of the post.

## First section

Write the post in Markdown. Code blocks, tables, and links all work:

\`\`\`ts
// example
\`\`\`

Link internally for SEO, e.g. the [REST API docs](/docs/api).

## Conclusion

Wrap up with a clear next step and an internal link.
`;

  fs.writeFileSync(file, body, "utf8");
  ok(`Created ${path.relative(ROOT, file)}`);
  console.log(`  Edit it, set draft: false, and it appears at /blog/${slug}`);
}

function newComparison(competitor) {
  if (!competitor) die('Provide a competitor, e.g. seo:new -- compare "PlanetScale"');
  const slug = `basefyio-vs-${slugify(competitor)}`;
  const snippet = `  {
    slug: "${slug}",
    competitor: "${competitor}",
    title: "Basefyio vs. ${competitor}: TODO headline",
    description:
      "TODO 140–160 char meta description comparing Basefyio and ${competitor}.",
    intro:
      "TODO one-paragraph framing of how the two platforms differ.",
    positioning:
      "TODO honest, specific statement of what Basefyio does differently.",
    rows: [
      { feature: "Database model", basefyio: "TODO", competitor: "TODO" },
      { feature: "Self-hosting", basefyio: "TODO", competitor: "TODO" },
      { feature: "Auto REST API", basefyio: "TODO", competitor: "TODO" },
      { feature: "Authentication", basefyio: "TODO", competitor: "TODO" },
      { feature: "Lock-in", basefyio: "TODO", competitor: "TODO" },
    ],
    faqs: [
      {
        question: "Is Basefyio a ${competitor} alternative?",
        answer: "TODO",
      },
      {
        question: "Can I migrate from ${competitor} to Basefyio?",
        answer: "TODO",
      },
    ],
  },`;
  ok(`Comparison entry for "${competitor}" (slug: ${slug})`);
  console.log(
    "\nPaste this object into the COMPARISONS array in",
    "src/lib/content/comparisons.ts:\n",
  );
  console.log(snippet);
  console.log("\nIt will then be live at /compare/" + slug);
}

function newUseCase(label) {
  if (!label) die('Provide a label, e.g. seo:new -- use-case "internal tools"');
  const slug = slugify(label);
  const snippet = `  {
    slug: "${slug}",
    label: "${label}",
    title: "The Backend for ${label} — TODO",
    description:
      "TODO 140–160 char meta description targeting 'backend for ${label}'.",
    intro: "TODO one-paragraph framing of this use case.",
    benefits: [
      { title: "TODO", body: "TODO" },
      { title: "TODO", body: "TODO" },
      { title: "TODO", body: "TODO" },
      { title: "TODO", body: "TODO" },
    ],
    codeTitle: "TODO snippet title",
    code: \`-- TODO illustrative SQL or SDK snippet\`,
    faqs: [
      { question: "TODO?", answer: "TODO" },
      { question: "TODO?", answer: "TODO" },
    ],
  },`;
  ok(`Use-case entry for "${label}" (slug: ${slug})`);
  console.log(
    "\nPaste this object into the USE_CASES array in",
    "src/lib/content/use-cases.ts:\n",
  );
  console.log(snippet);
  console.log("\nIt will then be live at /use-cases/" + slug);
}

function newTerm(term) {
  if (!term) die('Provide a term, e.g. seo:new -- term "connection pooling"');
  const slug = slugify(term);
  const snippet = `  {
    slug: "${slug}",
    term: "${term}",
    definition:
      "TODO one-sentence definition of ${term} (used as the meta description).",
    body: [
      "TODO paragraph 1 — what it is and why it matters.",
      "TODO paragraph 2 — how it works / common patterns.",
      "TODO paragraph 3 — practical note or how it relates to Basefyio.",
    ],
    related: ["TODO-slug", "TODO-slug"],
  },`;
  ok(`Glossary term for "${term}" (slug: ${slug})`);
  console.log(
    "\nPaste this object into the GLOSSARY array in",
    "src/lib/content/glossary.ts:\n",
  );
  console.log(snippet);
  console.log("\nIt will then be live at /learn/" + slug);
}

const [type, ...rest] = process.argv.slice(2);
const arg = rest.join(" ").trim();

switch (type) {
  case "blog":
  case "post":
    newBlogPost(arg);
    break;
  case "compare":
  case "comparison":
    newComparison(arg);
    break;
  case "use-case":
  case "usecase":
    newUseCase(arg);
    break;
  case "term":
  case "learn":
  case "glossary":
    newTerm(arg);
    break;
  default:
    console.log(`SEO content generator

Usage:
  node scripts/new-content.mjs blog "Post title"
  node scripts/new-content.mjs compare "Competitor"
  node scripts/new-content.mjs use-case "audience or label"
  node scripts/new-content.mjs term "connection pooling"`);
    process.exit(type ? 1 : 0);
}
