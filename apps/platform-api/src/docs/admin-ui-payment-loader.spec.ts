import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * Feedback #151: the third-party payment script (~1 MB) was loaded on every
 * dashboard page. `@stripe/stripe-js` injects it as a side effect of being
 * imported; the `/pure` entry only loads it when loadStripe() is called, and
 * only the billing page may call it. The publishable key must keep coming from
 * the same build argument.
 */
const UI_ROOT = join(__dirname, '../../../admin-ui');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.next', 'out'].includes(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

describe('admin-ui payment script loader', () => {
  const files = ['app', 'components', 'lib'].flatMap((d) => sourceFiles(join(UI_ROOT, d)));
  const importers = files.filter((f) => /from\s+['"]@stripe\/stripe-js(\/pure)?['"]/.test(readFileSync(f, 'utf8')));

  it('is imported only by the billing page', () => {
    expect(importers.map((f) => relative(UI_ROOT, f))).toEqual(['app/dashboard/billing/page.tsx']);
  });

  it('uses the pure entry, so importing never injects the script', () => {
    for (const f of importers) {
      const src = readFileSync(f, 'utf8');
      expect(src).toMatch(/from\s+['"]@stripe\/stripe-js\/pure['"]/);
      expect(src).not.toMatch(/from\s+['"]@stripe\/stripe-js['"]/);
    }
  });

  it('production compose compresses API and UI responses but never the event stream', () => {
    const compose = readFileSync(join(UI_ROOT, '../../docker-compose.prod.yml'), 'utf8');
    for (const router of ['api', 'ui', 'ui-admin']) {
      expect(compose).toContain(`traefik.http.routers.${router}.middlewares=bf-compress`);
    }
    const excluded = /compress\.excludedcontenttypes=(\S+)/.exec(compose)?.[1] ?? '';
    expect(excluded.split(',')).toContain('text/event-stream');
  });

  it('loads lazily, not at module level, and still reads the same publishable key', () => {
    const src = readFileSync(join(UI_ROOT, 'app/dashboard/billing/page.tsx'), 'utf8');
    expect(src).toContain('process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY');
    // No top-level `= loadStripe(` / `? loadStripe(` outside a function body.
    const topLevelCalls = src.split('\n').filter((l) => /^(const|let|var)\s.*loadStripe\(/.test(l));
    expect(topLevelCalls).toEqual([]);
  });
});
