import { test, expect, chromium } from '@playwright/test';

/**
 * The flows Phase 1 must not break (@critical): sign-in, the projects list,
 * a project's overview, the table editor, a SQL statement, the REST
 * explorer, storage, auth and backups. They run against the fixture project
 * the global setup prepared and change nothing in it; the one flow that
 * creates data (a project through the dialog) is @gated behind E2E_CREATE=1.
 */
test.skip(() => process.env.E2E_NO_AUTH === '1', 'no e2e credentials');

const project = () => process.env.E2E_PROJECT_ID as string;

test.describe.serial('@critical dashboard flows', () => {
  test('signs in through the login page', async ({ baseURL }) => {
    // A fresh browser without the stored state: the real form, the real redirect.
    const browser = await chromium.launch();
    const page = await browser.newPage({ baseURL });
    try {
      await page.goto('/login');
      await page.locator('input[type="email"], input[name="email"]').first().fill(process.env.E2E_EMAIL!);
      await page.locator('input[type="password"]').first().fill(process.env.E2E_PASSWORD!);
      await page.getByRole('button', { name: /^sign in$/i }).first().click();
      await page.waitForURL(/\/dashboard/, { timeout: 45_000 });
      await expect(page).not.toHaveURL(/\/login/);
    } finally {
      await browser.close();
    }
  });

  test('lists the fixture project', async ({ page }) => {
    await page.goto('/dashboard/projects');
    await expect(page.getByText(process.env.E2E_PROJECT_NAME || 'e2e-nav-v2').first()).toBeVisible({ timeout: 30_000 });
  });

  test('opens the project overview', async ({ page }) => {
    const res = await page.goto(`/dashboard/projects/${project()}`);
    expect(res?.status()).toBeLessThan(400);
    await expect(page.getByText(process.env.E2E_PROJECT_NAME || 'e2e-nav-v2').first()).toBeVisible({ timeout: 30_000 });
  });

  test('opens the table editor', async ({ page }) => {
    const res = await page.goto(`/dashboard/projects/${project()}/tables`);
    expect(res?.status()).toBeLessThan(400);
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await expect(page.locator('body')).not.toContainText('Application error');
  });

  test('runs a SQL statement', async ({ page }) => {
    await page.goto(`/dashboard/projects/${project()}/sql`);
    const editor = page.locator('textarea').first();
    await expect(editor).toBeVisible({ timeout: 30_000 });
    await editor.fill('select 42 as answer');
    await page.getByRole('button', { name: /^Run/ }).first().click();
    await expect(page.getByText('answer').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('42').first()).toBeVisible();
  });

  for (const [name, path] of [
    ['REST explorer', 'api-explorer'],
    ['storage', 'storage'],
    ['auth', 'auth'],
    ['backups', 'backup'],
    ['connection details', 'connect'],
  ] as const) {
    test(`opens ${name}`, async ({ page }) => {
      const res = await page.goto(`/dashboard/projects/${project()}/${path}`);
      expect(res?.status()).toBeLessThan(400);
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
      await expect(page).not.toHaveURL(/\/login/);
      const body = await page.locator('body').innerText();
      expect(body).not.toContain('Application error');
      expect(body).not.toContain('Something went wrong');
    });
  }
});

test('@gated creates a project through the dialog and deletes it again', async ({ page, request, baseURL }) => {
  test.skip(process.env.E2E_CREATE !== '1', 'E2E_CREATE=1 opts in (provisions a database)');
  const name = `e2e-ui-${Date.now().toString(36)}`;
  await page.goto('/dashboard/projects');
  await page.getByRole('button', { name: /create project|new project/i }).first().click();
  await page.getByRole('radio', { name: /postgres|relational/i }).first().click().catch(async () => {
    await page.locator('[role="radiogroup"] [aria-checked]').first().click();
  });
  await page.getByRole('button', { name: /next|continue/i }).first().click().catch(() => {});
  await page.getByPlaceholder('Project name').fill(name);
  await page.getByRole('button', { name: /^create/i }).last().click();
  await page.waitForURL(/\/dashboard\/projects\/[0-9a-f-]{36}/, { timeout: 120_000 });
  const id = page.url().split('/dashboard/projects/')[1].split(/[/?#]/)[0];
  // Clean up through the API with the browser's own token.
  const token = await page.evaluate(() => localStorage.getItem('basefyio_access_token'));
  const del = await request.delete(`${baseURL}/api/proxy/projects/${id}`, { headers: { Authorization: `Bearer ${token}`, Origin: baseURL! } });
  expect(del.status(), 'fixture project removed').toBeLessThan(400);
});
