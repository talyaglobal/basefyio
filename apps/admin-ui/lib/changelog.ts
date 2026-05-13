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

function validateKind(value: string | undefined): ChangelogKind {
  if (value === 'feature' || value === 'bugfix' || value === 'improvement' || value === 'breaking') return value;
  return 'improvement';
}

export function listChangelogEntries(): ChangelogEntry[] {
  if (!fs.existsSync(CHANGELOG_DIR)) return [];
  const files = fs.readdirSync(CHANGELOG_DIR).filter((f) => f.endsWith('.md'));
  const entries: ChangelogEntry[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(CHANGELOG_DIR, file), 'utf8');
      const { data, body } = parseFrontmatter(raw);
      if (!data.slug || !data.title || !data.date) continue;
      entries.push({ slug: data.slug, date: data.date, title: data.title, kind: validateKind(data.kind), summary: data.summary || '', body });
    } catch {}
  }
  return entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

export function getChangelogEntry(slug: string): ChangelogEntry | null {
  return listChangelogEntries().find((e) => e.slug === slug) || null;
}

export function renderMarkdown(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { out.push('<h' + h[1].length + '>' + esc(h[2]) + '</h' + h[1].length + '>'); i++; continue; }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) { items.push('<li>' + esc(lines[i].replace(/^[-*]\s+/, '')) + '</li>'); i++; }
      out.push('<ul>' + items.join('') + '</ul>');
      continue;
    }
    if (line.trim() === '') { i++; continue; }
    const p: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,4})\s+/.test(lines[i]) && !/^[-*]\s+/.test(lines[i])) { p.push(lines[i]); i++; }
    if (p.length > 0) out.push('<p>' + esc(p.join(' ')) + '</p>');
  }
  return out.join('\n');
}

const EMERALD = 'bg-emerald-100 text-emerald-800';
const AMBER = 'bg-amber-100 text-amber-800';
const BLUE = 'bg-blue-100 text-blue-800';
const RED = 'bg-red-100 text-red-800';

export const KIND_BADGE_CLASS: Record<ChangelogKind, string> = {
  feature: EMERALD,
  bugfix: AMBER,
  improvement: BLUE,
  breaking: RED,
};

export const KIND_LABEL: Record<ChangelogKind, string> = {
  feature: 'New feature',
  bugfix: 'Bug fix',
  improvement: 'Improvement',
  breaking: 'Breaking change',
};
