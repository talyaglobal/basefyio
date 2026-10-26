#!/usr/bin/env node
/**
 * The dashboard's route inventory, from the app directory:
 *
 *   node e2e/scripts/generate-routes.mjs        # writes e2e/routes.generated.json
 *   node e2e/scripts/generate-routes.mjs --check   # exits 1 when the file is stale
 *
 * The route test opens every entry, so a page added without regenerating the
 * file fails CI, and a page removed without a redirect fails the test. Console
 * routes (admin.<domain>) are listed under "console" and not opened by the
 * authenticated project: the e2e account is not ROOT.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const APP = resolve(here, '../../apps/admin-ui/app');
const OUT = resolve(here, '../routes.generated.json');

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    if (e.startsWith('.') || e === 'node_modules') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/^page\.tsx?$/.test(e)) acc.push(p);
  }
  return acc;
}

const routes = walk(APP)
  .map((f) => '/' + relative(APP, dirname(f)).split(sep).join('/'))
  .map((r) => (r === '/.' ? '/' : r.replace(/\/\([^)]+\)/g, '')))
  .map((r) => (r === '' ? '/' : r))
  .sort();

const inventory = {
  generatedAt: new Date().toISOString().slice(0, 10),
  dashboard: routes.filter((r) => !r.startsWith('/console')),
  console: routes.filter((r) => r.startsWith('/console')),
};
const json = JSON.stringify(inventory, null, 2) + '\n';

if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  const strip = (s) => s.replace(/"generatedAt": "[^"]*",?\n/, '');
  if (strip(current) !== strip(json)) {
    console.error('e2e/routes.generated.json is stale: run node e2e/scripts/generate-routes.mjs');
    process.exit(1);
  }
  console.log(`routes.generated.json is current (${inventory.dashboard.length} dashboard, ${inventory.console.length} console)`);
} else {
  writeFileSync(OUT, json);
  console.log(`wrote ${OUT}: ${inventory.dashboard.length} dashboard routes, ${inventory.console.length} console routes`);
}
