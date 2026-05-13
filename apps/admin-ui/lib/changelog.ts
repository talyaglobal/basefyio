import fs from 'node:fs';
import path from 'node:path';

/**
 * File-based changelog loader. Markdown files live under
 * `apps/admin-ui/content/changelog/*.md`. Each file has YAML-ish frontmatter:
 *
 *     ---
 *     date: 2026-05-12
 *     slug: realtime-notifications
 *     title: Realtime notifications shipped
 *     kind: feature
 *     summary: One-line lede shown on the list page.
 *     ---
 *
 * (any markdown body)
 *
 * Kept dependency-free — gray-matter / remark are powerful but for our
 * tightly-controlled changelog input we don't need them. If we ever want
 * tables / footnotes / syntax highlighting, swap in remark-html.
 */

export type ChangelogKind = 'feature' | 'bugfix' | 'improvement' | 'breaking';

export interface ChangelogEntry {
  slug: string;
  date: string; // ISO yyyy-mm-dd
  title: string;
  kind: ChangelogKind;
  summary: string;
  /** Markdown body, with frontmatter stripped. */
  body: string;
}

const CHANGELOG_DIR = path.join(process.cwd(), 'content', 'changelog');

function parseFrontmatter(raw: string): {
  data: Record<string, string>;
  body: string;
} {
  if (!raw.startsWith('---')) {
    return { data: {}, body: raw };
  }
  const end = raw.indexOf('\n---', 3);
  if (end === -1) {
    return { data: {}, body: raw };
  }
  const header = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\r?\n/, '');
  const data: Record<string, string> = {};
  for (const line of header.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (m) data[m[1]] = m[2].trim();
  }
  return { data, body };
}

function validateKind(value: string | undefined): ChangelogKind {
  if (value === 'feature' || value === 'bugfix' || value === 'improvement' || value === 'breaking') {
    return value;
  }
  return 'improvement';
}

/**
 * List every entry, newest first. Reads the filesystem synchronously — this
 * is fine inside Next.js Server Components / Route Handlers (Node.js
 * runtime), but DO NOT call from a Client Component.
 */
export function listChangelogEntries(): ChangelogEntry[] {
  if (!fs.existsSync(CHANGELOG_DIR)) return [];

  const files = fs.readdirSync(CHANGELOG_DIR).filter((f) => f.endsWith('.md'));
  const entries: ChangelogEntry[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(CHANGELOG_DIR, file), 'utf8');
      const { data, body } = parseFrontmatter(raw);
      if (!data.slug || !data.title || !data.date) continue;
      entries.push({
        slug: data.slug,
        date: data.date,
        title: data.title,
        kind: validateKind(data.kind),
        summary: data.summary || '',
        body,
      });
    } catch {
      // Skip malformed entries silently rather than crashing the page.
    }
  }
  // Newest first.
  return entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

export function getChangelogEntry(slug: string): ChangelogEntry | null {
  return listChangelogEntries().find((e) => e.slug === slug) ?? null;
}

/**
 * Tiny markdown → HTML converter. Supports:
 *  - # / ## / ### headings
 *  - **bold**, *italic*, `code`
 *  - paragraphs (blank-line separated)
 *  - unordered lists (- or *) and ordered lists (1.)
 *  - fenced code blocks ```
 *  - inline [text](url) links
 *  - tables (simple GitHub-flavoured pipes)
 *
 * Inputs are author-controlled — no XSS concern.
 */
export function renderMarkdown(md: string): string {
  const escapeHtml = (s: string): string =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  // Pull out fenced code blocks first so their contents don't get inline-formatted.
  const codeBlocks: string[] = [];
  md = md.replace(/```([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(escapeHtml(code.trim()));
    return `CODEBLOCK${codeBlocks.length - 1}`;
  });

  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;

  function inline(text: string): string {
    let s = escapeHtml(text);
    // inline code
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    // bold
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // italic
    s = s.replace(/(?<![*])\*([^*]+)\*(?![*])/g, '<em>$1</em>');
    // links
    s = s.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_, label, href) =>
        `<a href="${href.replace(/"/g, '&quot;')}" target="_blank" rel="noopener noreferrer">${label}</a>`,
    );
    return s;
  }

  while (i < lines.length) {
    const line = lines[i];

    // Tables: detect a header line followed by a separator |---|---|
    if (line.includes('|') && i + 1 < lines.length && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const headerCells = line
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => inline(c.trim()));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|')) {
        rows.push(
          lines[i]
            .replace(/^\||\|$/g, '')
            .split('|')
            .map((c) => inline(c.trim())),
        );
        i += 1;
      }
      out.push(
        `<table><thead><tr>${headerCells.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      );
      continue;
    }

    // Headings
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // Unordered list
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^[-*]\s+/, ''))}</li>`);
        i += 1;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\d+\.\s+/, ''))}</li>`);
        i += 1;
      }
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // Blank line → paragraph break (skip)
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // Paragraph: collect until blank or block boundary.
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^[-*]\s+/.test(lines[i]) &&
      !/^\d+\.\s+/.test(lines[i]) &&
      !lines[i].startsWith('CODEBLOCK')
    ) {
      paragraph.push(lines[i]);
      i += 1;
    }
    if (paragraph.length > 0) {
      out.push(`<p>${inline(paragraph.join(' '))}</p>`);
    }
  }

  // Re-insert fenced code blocks.
  let html = out.join('\n');
  html = html.replace(/CODEBLOCK(\d+)/g, (_, idx) => `<pre><code>${codeBlocks[Number(idx)]}</code></pre>`);
  return html;
}

/**
 * Tailwind classes for the kind badge. Keep small so it can be reused on
 * both the list page and the detail page header.
 */
export const KIND_BADGE_CLASS: Record<ChangelogKind, string> = {
  feature: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200',
  bugfix: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  improvement: 'bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-200',
  breaking: 'bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-200',
};

export const KIND_LABEL: Record<ChangelogKind, string> = {
  feature: 'New feature',
  bugfix: 'Bug fix',
  improvement: 'Improvement',
  breaking: 'Breaking change',
};
