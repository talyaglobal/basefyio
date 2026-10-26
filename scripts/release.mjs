#!/usr/bin/env node
/**
 * Bump the platform version and scaffold its changelog entry.
 *
 *   node scripts/release.mjs <patch|minor|major|X.Y.Z> [--title "…"] [--summary "…"] [--kind feature|improvement|bugfix|breaking] [--dry]
 *
 * One version covers the three deployable apps (apps/admin-ui, apps/platform-api,
 * apps/website): their package.json and package-lock.json roots move together.
 * The dashboard shows the version of the newest changelog entry and the API
 * reports it on /api/health, so a release is a bump plus an entry under
 * apps/admin-ui/content/changelog/. The deploy workflow refuses a push whose
 * version already has a tag on another commit and tags + releases the version
 * after a successful deploy — bump before every push to production:
 * feature → minor, fix or chore → patch, breaking → major.
 *
 * The published packages (packages/sdk, cli, geo, sdk-python) keep their own
 * versions; bump them when their code changes.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const APPS = ['apps/admin-ui', 'apps/platform-api', 'apps/website'];
const CHANGELOG_DIR = 'apps/admin-ui/content/changelog';

const args = process.argv.slice(2);
const level = args.find((a) => !a.startsWith('--'));
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
};
const dry = args.includes('--dry');
if (!level) {
  console.error('usage: node scripts/release.mjs <patch|minor|major|X.Y.Z> [--title …] [--summary …] [--kind …] [--dry]');
  process.exit(2);
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const current = readJson(join(APPS[0], 'package.json')).version;
function bump(v, how) {
  if (/^\d+\.\d+\.\d+$/.test(how)) return how;
  const [a, b, c] = v.split('.').map(Number);
  if (how === 'major') return `${a + 1}.0.0`;
  if (how === 'minor') return `${a}.${b + 1}.0`;
  if (how === 'patch') return `${a}.${b}.${c + 1}`;
  throw new Error(`unknown level ${how}`);
}
const next = bump(current, level);
const tag = `v${next}`;
console.log(`${current} → ${next}`);

// 1. package.json + package-lock.json of every app
for (const app of APPS) {
  for (const file of ['package.json', 'package-lock.json']) {
    const p = join(app, file);
    if (!existsSync(p)) continue;
    const raw = readFileSync(p, 'utf8');
    const json = JSON.parse(raw);
    json.version = next;
    if (json.packages && json.packages['']) json.packages[''].version = next;
    const out = JSON.stringify(json, null, 2) + (raw.endsWith('\n') ? '\n' : '');
    if (!dry) writeFileSync(p, out);
    console.log(`  ${p}`);
  }
}

// 2. changelog entry, unless one with this version exists
const existing = readdirSync(CHANGELOG_DIR).find((f) => readFileSync(join(CHANGELOG_DIR, f), 'utf8').includes(`version: ${tag}`));
if (existing) {
  console.log(`  changelog: ${existing} already carries ${tag}`);
} else {
  const today = new Date().toISOString().slice(0, 10);
  let lastTag = '';
  try {
    lastTag = execSync('git describe --tags --abbrev=0', { encoding: 'utf8' }).trim();
  } catch {
    /* no tag yet */
  }
  const subjects = execSync(`git log --format=%s ${lastTag ? lastTag + '..HEAD' : ''}`, { encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => /^(feat|fix|perf)(\(|:)/.test(s))
    .map((s) => s.replace(/^(feat|fix|perf)(\([^)]*\))?:\s*/, ''))
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1));
  const title = opt('--title') || `Release ${tag}`;
  const summary = opt('--summary') || subjects[0] || `Release ${tag}.`;
  const kind = opt('--kind') || (level === 'patch' ? 'bugfix' : 'feature');
  const slug = `release-${next.replace(/\./g, '-')}`;
  const file = join(CHANGELOG_DIR, `${today}-${slug}.md`);
  const body =
    `---\ndate: ${today}\nslug: ${slug}\ntitle: "${title.replace(/"/g, '\\"')}"\nkind: ${kind}\nversion: ${tag}\nsummary: ${summary}\n---\n\n` +
    `## What's new\n\n` +
    (subjects.length ? subjects.map((s) => `- ${s}`).join('\n') : '- …') +
    `\n`;
  if (!dry) writeFileSync(file, body);
  console.log(`  changelog: ${file} (edit it before committing)`);
}

console.log(dry ? 'dry run, nothing written' : `done: commit as "chore(release): ${tag}"; the deploy tags ${tag} after it succeeds`);
