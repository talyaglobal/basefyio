import { test, expect, request, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { apiBase } from '../helpers/api';

/**
 * Guided tours, end to end (@tours). Runs only with a DEDICATED account:
 * E2E_TOURS_EMAIL / E2E_TOURS_PASSWORD, never the shared e2e fixture account
 * (overlapping CI runs would reset each other's tour state). Skipped too when
 * the guided_tours flag is not on for that account. The last test also needs
 * E2E_TOURS_EMAIL_2 / E2E_TOURS_PASSWORD_2.
 *
 * Each test signs in inside its own fresh browser context (no shared storage
 * state, no basefyio_tours_auto key). State is read back through the API.
 */
const EMAIL = process.env.E2E_TOURS_EMAIL;
const PASSWORD = process.env.E2E_TOURS_PASSWORD;
const EMAIL_2 = process.env.E2E_TOURS_EMAIL_2;
const PASSWORD_2 = process.env.E2E_TOURS_PASSWORD_2;

test.skip(!EMAIL || !PASSWORD, 'no E2E_TOURS_EMAIL / E2E_TOURS_PASSWORD (dedicated tours account)');

type Tours = { autoEnabled: boolean; seen: string[] };
type Tokens = { accessToken: string };

let API = '';
let flagOn = false;
let projectId: string | null = null;
let context: BrowserContext;
let page: Page;

async function apiLogin(email: string, password: string) {
  const api = await request.newContext();
  const res = await api.post(`${API}/auth/login`, { data: { email, password } });
  if (!res.ok()) throw new Error(`tours e2e: API login failed (${res.status()})`);
  const tokens = (await res.json()) as Tokens;
  return { api, headers: { Authorization: `Bearer ${tokens.accessToken}` } };
}

async function readTours(email: string, password: string): Promise<Tours> {
  const { api, headers } = await apiLogin(email, password);
  try {
    const res = await api.get(`${API}/auth/profile`, { headers });
    const body = (await res.json()) as { tours?: Tours };
    return body.tours ?? { autoEnabled: false, seen: [] };
  } finally {
    await api.dispose();
  }
}

async function patchTours(email: string, password: string, data: Record<string, unknown>) {
  const { api, headers } = await apiLogin(email, password);
  try {
    const res = await api.patch(`${API}/auth/profile/tours`, { headers, data });
    if (!res.ok()) throw new Error(`tours e2e: PATCH tours failed (${res.status()})`);
  } finally {
    await api.dispose();
  }
}

async function signIn(p: Page, email: string, password: string) {
  await p.goto('/login');
  await p.locator('input[type="email"], input[name="email"]').first().fill(email);
  await p.locator('input[type="password"]').first().fill(password);
  await p.getByRole('button', { name: /^sign in$/i }).first().click();
  await p.waitForURL(/\/dashboard/, { timeout: 45_000 });
}

async function freshPage(browser: Browser, baseURL: string | undefined) {
  const ctx = await browser.newContext({ baseURL });
  return { ctx, p: await ctx.newPage() };
}

const popover = (p: Page) => p.locator('.driver-popover');
const closeTour = (p: Page) => p.locator('.driver-popover .driver-popover-close-btn').click();
const decided = (p: Page) => expect(p.locator('body[data-tour-auto]')).toBeAttached({ timeout: 30_000 });

test.describe.serial('@tours guided tours', () => {
  test.beforeAll(async ({ browser, baseURL }) => {
    API = apiBase(baseURL || process.env.E2E_BASE_URL || 'http://localhost:3000');
    const { api, headers } = await apiLogin(EMAIL!, PASSWORD!);
    try {
      const f = await api.get(`${API}/features/me`, { headers });
      flagOn = f.ok() && !!((await f.json()) as { guided_tours?: boolean }).guided_tours;
      if (flagOn) {
        const teams = (await (await api.get(`${API}/teams`, { headers })).json()) as Array<{ id: string; isPersonal?: boolean }>;
        const team = teams.find((t) => t.isPersonal) ?? teams[0];
        if (team) {
          const list = (await (await api.get(`${API}/projects?teamId=${team.id}`, { headers })).json()) as
            | Array<{ id: string; status: string }>
            | { projects?: Array<{ id: string; status: string }> };
          const projects = Array.isArray(list) ? list : (list.projects ?? []);
          projectId = projects.find((p) => p.status !== 'DELETED')?.id ?? null;
        }
      }
    } finally {
      await api.dispose();
    }
    if (!flagOn) return;
    await patchTours(EMAIL!, PASSWORD!, { autoEnabled: true, resetSeen: true });
    ({ ctx: context, p: page } = await freshPage(browser, baseURL));
    await signIn(page, EMAIL!, PASSWORD!);
  });

  test.afterAll(async () => {
    await context?.close().catch(() => {});
    if (flagOn) await patchTours(EMAIL!, PASSWORD!, { autoEnabled: false }).catch(() => {});
  });

  test.beforeEach(() => {
    test.skip(!flagOn, 'guided_tours is not on for the tours account');
  });

  test('the first visit shows the shell tour; closing it marks one tour seen', async () => {
    await page.goto('/dashboard/projects');
    await expect(popover(page)).toBeVisible({ timeout: 30_000 });
    await closeTour(page);
    await expect(popover(page)).toHaveCount(0);
    await expect.poll(async () => (await readTours(EMAIL!, PASSWORD!)).seen.length, { timeout: 15_000 }).toBe(1);
    expect((await readTours(EMAIL!, PASSWORD!)).autoEnabled).toBe(true);
  });

  test('the next visit shows the page tour; a further reload shows none', async () => {
    await page.goto('/dashboard/projects');
    await expect(popover(page)).toBeVisible({ timeout: 30_000 });
    await closeTour(page);
    await expect.poll(async () => (await readTours(EMAIL!, PASSWORD!)).seen.length, { timeout: 15_000 }).toBe(2);

    await page.reload();
    await decided(page);
    await expect(popover(page)).toHaveCount(0);
  });

  test('"Don\'t show again" turns automatic tours off; the header button still opens one', async () => {
    test.skip(!projectId, 'the tours account has no project to open');
    await page.goto(`/dashboard/projects/${projectId}`);
    await expect(popover(page)).toBeVisible({ timeout: 30_000 });
    await popover(page).getByLabel("Don't show again").check();
    await expect.poll(async () => (await readTours(EMAIL!, PASSWORD!)).autoEnabled, { timeout: 15_000 }).toBe(false);
    await closeTour(page);

    await page.goto(`/dashboard/projects/${projectId}/sql`);
    await decided(page);
    await expect(popover(page)).toHaveCount(0);

    await page.locator('[data-tour="shell-tour-button"]').click();
    await expect(popover(page)).toBeVisible({ timeout: 15_000 });
    await closeTour(page);
  });

  test('the Account card switches tours back on and shows them again', async () => {
    await page.goto('/dashboard/account');
    const card = page.locator('#guided-tours');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByRole('switch', { name: /Start tours automatically/ })).not.toBeChecked();

    await card.getByRole('button', { name: 'Show tours again' }).click();
    await expect
      .poll(async () => {
        const t = await readTours(EMAIL!, PASSWORD!);
        return `${t.autoEnabled}:${t.seen.length}`;
      }, { timeout: 15_000 })
      .toBe('true:0');

    await page.goto('/dashboard/projects');
    await expect(popover(page)).toBeVisible({ timeout: 30_000 });
    await closeTour(page);
  });

  test('a second user in the same browser context is unaffected', async ({ browser, baseURL }) => {
    test.skip(!EMAIL_2 || !PASSWORD_2, 'no E2E_TOURS_EMAIL_2 / E2E_TOURS_PASSWORD_2');
    await patchTours(EMAIL_2!, PASSWORD_2!, { autoEnabled: true, resetSeen: true });
    try {
      const { ctx, p } = await freshPage(browser, baseURL);
      try {
        await signIn(p, EMAIL!, PASSWORD!);
        await p.goto('/dashboard/projects');
        await expect(popover(p)).toBeVisible({ timeout: 30_000 });
        await p.locator('.driver-popover').getByLabel("Don't show again").check();
        await expect.poll(async () => (await readTours(EMAIL!, PASSWORD!)).autoEnabled, { timeout: 15_000 }).toBe(false);
        await closeTour(p);

        await p.getByRole('button', { name: /^Account menu/ }).click();
        await p.getByRole('button', { name: 'Sign out' }).click();
        await p.waitForURL(/\/login|\/auth\//, { timeout: 45_000 });

        await signIn(p, EMAIL_2!, PASSWORD_2!);
        await p.goto('/dashboard/projects');
        await expect(popover(p)).toBeVisible({ timeout: 30_000 });
        await closeTour(p);

        expect((await readTours(EMAIL!, PASSWORD!)).autoEnabled).toBe(false);
      } finally {
        await ctx.close();
      }
    } finally {
      await patchTours(EMAIL_2!, PASSWORD_2!, { autoEnabled: false }).catch(() => {});
    }
  });
});
