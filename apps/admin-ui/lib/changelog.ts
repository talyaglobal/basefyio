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

export function renderMarkdown(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return md
    .split(/\r?\n\r?\n/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => {
      const h = para.match(/^(#{1,4})\s+(.*)$/);
      if (h) return '<h' + h[1].length + '>' + esc(h[2]) + '</h' + h[1].length + '>';
      if (/^[-*]\s+/.test(para)) {
        const items = para.split(/\r?\n/).map((l) => '<li>' + esc(l.replace(/^[-*]\s+/, '')) + '</li>').join('');
        return '<ul>' + items + '</ul>';
      }
      return '<p>' + esc(para) + '</p>';
    })
    .join('\n');
}

const C_FEAT = 'bg-emerald-100 text-emerald-800';
const C_BUG = 'bg-amber-100 text-amber-800';
const C_IMP = 'bg-blue-100 text-blue-800';
const C_BRK = 'bg-red-100 text-red-800';

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
