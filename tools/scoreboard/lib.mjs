import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

export const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const SKIP = new Set(['node_modules', '.git', 'dist', '.next', 'coverage', 'graphify-out', '.turbo']);

/** Every source file under the given roots, as absolute paths. */
export function sources(roots, exts = ['.ts', '.tsx', '.mjs', '.yml', '.yaml', '.json', '.prisma']) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
    }
  };
  for (const r of roots) {
    const abs = join(ROOT, r);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isFile()) out.push(abs);
    else walk(abs);
  }
  return out;
}

/**
 * Files matching a pattern, with the first hit's location.
 *
 * Returns locations rather than a bare count so a check can cite where its
 * verdict came from. A score with no citation is an opinion.
 */
export function hits(pattern, roots, exts) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  const found = [];
  for (const file of sources(roots, exts)) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        found.push({ file: relative(ROOT, file).split(sep).join('/'), line: i + 1, text: lines[i].trim() });
        break;
      }
    }
  }
  return found;
}

export function cite(found, limit = 2) {
  if (!found.length) return 'not found in the tree';
  const head = found.slice(0, limit).map((h) => `${h.file}:${h.line}`);
  const more = found.length > limit ? ` (+${found.length - limit} more)` : '';
  return head.join(', ') + more;
}

export function fileHas(rel, pattern) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return false;
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  return re.test(readFileSync(p, 'utf8'));
}

export function exists(rel) {
  return existsSync(join(ROOT, rel));
}

/**
 * A check whose verdict is a fraction rather than a yes/no, so a partly built
 * capability is not rounded to either zero or done.
 */
export const check = (name, weight, verdict) => ({ name, weight, verdict });

export const yes = (evidence) => ({ score: 1, evidence });
export const no = (evidence) => ({ score: 0, evidence });
export const part = (score, evidence) => ({ score, evidence });
