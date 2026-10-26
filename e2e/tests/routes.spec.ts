import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const inventory = JSON.parse(readFileSync(join(__dirname, '..', 'routes.generated.json'), 'utf8')) as { dashboard: string[]; console: string[] };

/**
 * Every dashboard route opens for a signed-in user: no 404, no error
 * boundary, no bounce to /login. The list comes from the app directory
 * (e2e/scripts/generate-routes.mjs), so a page added without regenerating
 * it fails CI, and a page removed without a redirect fails here. Phase 1 of
 * the simplification moves pages behind redirects; this is the net that
 * catches a broken one.
 *
 * Dynamic segments are filled from the fixture the global setup prepared:
 * [id] = the e2e project, [publicId] = the account's organization, [slug] =
 * the newest changelog entry. Routes whose parameters cannot be filled are
 * skipped and listed.
 */
test.skip(() => process.env.E2E_NO_AUTH === '1', 'no e2e credentials');

const ERROR_MARKERS = [
  'Application error',
  'This page could not be found',
  'Something went wrong',
  'Internal Server Error',
];

function fill(route: string): string | null {
  let out = route;
  const project = process.env.E2E_PROJECT_ID;
  const org = process.env.E2E_ORG_ID;
  if (out.includes('[id]')) {
    if (route.startsWith('/dashboard/projects/') && project) out = out.replace('[id]', project);
    else if (route.startsWith('/dashboard/account/api-tokens/')) return null; // needs a token id; covered by the tokens page itself
    else return null;
  }
  if (out.includes('[publicId]')) {
    if (!org) return null;
    out = out.replace('[publicId]', org);
  }
  if (out.includes('[slug]')) out = out.replace('[slug]', process.env.E2E_CHANGELOG_SLUG || 'latest');
  if (/\[[^\]]+\]/.test(out)) return null;
  return out;
}

const PUBLIC_ONLY = new Set(['/', '/login', '/signup', '/forgot-password', '/reset-password', '/set-new-password', '/auth/handoff', '/cli-authorize']);

for (const route of inventory.dashboard) {
  if (PUBLIC_ONLY.has(route)) continue;
  test(`opens ${route}`, async ({ page, baseURL }) => {
    const target = fill(route);
    test.skip(target === null, `no fixture for ${route}`);
    const response = await page.goto(target!, { waitUntil: 'domcontentloaded' });
    expect(response, 'navigation answered').not.toBeNull();
    expect(response!.status(), `${target} answers`).toBeLessThan(400);
    // Give client-side redirects (legacy routes) a moment, then make sure we did not land on sign-in.
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await expect(page).not.toHaveURL(/\/login/);
    const body = (await page.locator('body').innerText().catch(() => '')) || '';
    for (const marker of ERROR_MARKERS) expect(body, `${target} shows "${marker}"`).not.toContain(marker);
  });
}

test('the inventory matches the app directory', async () => {
  // The generator's --check mode is what CI runs; here we only assert the file is non-trivial.
  expect(inventory.dashboard.length).toBeGreaterThan(40);
  expect(inventory.dashboard).toContain('/dashboard/projects');
  expect(inventory.dashboard).toContain('/dashboard/projects/[id]/sql');
});
