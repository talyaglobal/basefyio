import fs from 'node:fs';
import path from 'node:path';

export type ChangelogKind = 'feature' | 'bugfix' | 'improvement' | 'breaking';

export interface ChangelogEntry {
  slug: string;
  date: string;
  title: string;
  kind: ChangelogKind;
  summary: string;
  body: string;
}

const CHANGELOG_DIR = path.join(process.cwd(), 'content', 'changelog');

function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  if (!raw.startsWith('---')) return { data: {}, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: raw };
  const header = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\r?\n/, '');
  const data: Record<string, string> = {};
  for (const line of header.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (m) data[m[1]] = m[2].trim();
  }
  return { data, body };
}

function vk(v: string | undefined): ChangelogKind {
  if (v === 'feature' || v === 'bugfix' || v === 'improvement' || v === 'breaking') return v;
  return 'improvement';
}

export function listChangelogEntries(): ChangelogEntry[] {
  if (!fs.existsSync(CHANGELOG_DIR)) return [];
  const files = fs.readdirSync(CHANGELOG_DIR).filter((x) => x.endsWith('.md'));
  const out: ChangelogEntry[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(CHANGELOG_DIR, file), 'utf8');
      const { data, body } = parseFrontmatter(raw);
      if (!data.slug || !data.title || !data.date) continue;
      out.push({ slug: data.slug, date: data.date, title: data.title, kind: vk(data.kind), summary: data.summary || '', body });
    } catch {}
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

export function getChangelogEntry(slug: string): ChangelogEntry | null {
  return listChangelogEntries().find((e) => e.slug === slug) || null;
}

/** Escape HTML entities */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Process inline markdown: bold, italic, inline code, links, strikethrough */
function inlineMarkdown(text: string): string {
  let s = esc(text);
  // inline code (before bold/italic so backticks inside are safe)
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  // bold + italic
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  // bold
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // italic
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // strikethrough
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
  // links [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s;
}

/**
 * Render markdown to HTML with support for:
 * - Headings (## h2, ### h3, #### h4)
 * - Bold (**text**), italic (*text*), bold+italic (***text***)
 * - Inline code (`code`)
 * - Strikethrough (~~text~~)
 * - Links [text](url)
 * - Unordered lists (- item, * item)
 * - Ordered lists (1. item)
 * - Code blocks (```lang ... ```)
 * - Blockquotes (> text)
 * - Horizontal rules (---, ***)
 * - Paragraphs
 */
export function renderMarkdown(md: string): string {
  const lines = md.split(/\r?\n/);
  const html: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines
    if (!line.trim()) { i++; continue; }

    // Code block (```)
    const codeMatch = line.match(/^```(\w*)$/);
    if (codeMatch) {
      const lang = codeMatch[1];
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(esc(lines[i]));
        i++;
      }
      i++; // skip closing ```
      html.push(`<pre><code${lang ? ` class="language-${lang}"` : ''}>${codeLines.join('\n')}</code></pre>`);
      continue;
    }

    // Horizontal rule
    if (/^([-*_])\1{2,}\s*$/.test(line.trim())) {
      html.push('<hr>');
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      html.push(`<h${level}>${inlineMarkdown(headingMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const quoteLines: string[] = [];
      while (i < lines.length && (lines[i].startsWith('> ') || lines[i].startsWith('>'))) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      html.push(`<blockquote>${quoteLines.map((l) => `<p>${inlineMarkdown(l)}</p>`).join('')}</blockquote>`);
      continue;
    }

    // Unordered list
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ''));
        i++;
      }
      html.push('<ul>' + items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join('') + '</ul>');
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''));
        i++;
      }
      html.push('<ol>' + items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join('') + '</ol>');
      continue;
    }

    // Paragraph: collect consecutive non-empty, non-special lines
    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|[-*]\s|>\s|\d+\.\s|```)/.test(lines[i]) && !/^([-*_])\1{2,}\s*$/.test(lines[i].trim())) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length) {
      html.push(`<p>${paraLines.map(inlineMarkdown).join('<br>')}</p>`);
    }
  }

  return html.join('\n');
}

const C_FEAT = 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300';
const C_BUG = 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300';
const C_IMP = 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300';
const C_BRK = 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300';

export const KIND_BADGE_CLASS: Record<ChangelogKind, string> = {
  feature: C_FEAT,
  bugfix: C_BUG,
  improvement: C_IMP,
  breaking: C_BRK,
};

const L_FEAT = 'New feature';
const L_BUG = 'Bug fix';
const L_IMP = 'Improvement';
const L_BRK = 'Breaking change';

export const KIND_LABEL: Record<ChangelogKind, string> = {
  feature: L_FEAT,
  bugfix: L_BUG,
  improvement: L_IMP,
  breaking: L_BRK,
};
