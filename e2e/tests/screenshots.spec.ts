import { test } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const inventory = JSON.parse(readFileSync(join(__dirname, '..', 'routes.generated.json'), 'utf8')) as { dashboard: string[]; console: string[] };

/**
 * A screenshot of every dashboard route at 1024 and 1280 px, light and dark,
 * into e2e/screenshots/<date>/ — the "before" set Phase 1 compares against.
 * Opt in with SCREENSHOTS=1 (@screenshots, @gated): it takes a few minutes.
 */
test.skip(() => process.env.SCREENSHOTS !== '1' || process.env.E2E_NO_AUTH === '1', 'SCREENSHOTS=1 and credentials needed');

const DIR = join(__dirname, '..', 'screenshots', new Date().toISOString().slice(0, 10));
const WIDTHS = [1024, 1280];
const THEMES: Array<'light' | 'dark'> = ['light', 'dark'];

function fill(route: string): string | null {
  let out = route;
  if (out.includes('[id]')) {
    if (route.startsWith('/dashboard/projects/') && process.env.E2E_PROJECT_ID) out = out.replace('[id]', process.env.E2E_PROJECT_ID);
    else return null;
  }
  if (out.includes('[publicId]')) {
    if (!process.env.E2E_ORG_ID) return null;
    out = out.replace('[publicId]', process.env.E2E_ORG_ID);
  }
  if (/\[[^\]]+\]/.test(out)) return null;
  return out;
}

test('@screenshots @gated capture every dashboard route', async ({ page }) => {
  test.setTimeout(20 * 60_000);
  mkdirSync(DIR, { recursive: true });
  for (const route of inventory.dashboard) {
    const target = fill(route);
    if (!target || ['/', '/login', '/signup', '/auth/handoff', '/cli-authorize'].includes(route)) continue;
    for (const theme of THEMES) {
      await page.emulateMedia({ colorScheme: theme });
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(target, { waitUntil: 'networkidle' }).catch(() => {});
        const name = `${route.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'root'}-${width}-${theme}.png`;
        await page.screenshot({ path: join(DIR, name), fullPage: true }).catch(() => {});
        // Horizontal scroll is one of Phase 1's acceptance criteria: record it alongside the image.
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth).catch(() => 0);
        if (overflow > 0) console.log(`horizontal overflow ${overflow}px: ${route} @ ${width}px ${theme}`);
      }
    }
  }
});
