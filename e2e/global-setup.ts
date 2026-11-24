import { chromium, request, type FullConfig } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apiBase, sleep } from './helpers/api';

/**
 * Signs the e2e account in once and keeps the browser state for every
 * authenticated test; makes sure the account owns one project the tests can
 * open (`E2E_PROJECT_NAME`, created through the API when missing) and
 * publishes its id and the account's organization id through environment
 * variables the specs read.
 *
 * Without E2E_EMAIL / E2E_PASSWORD it writes an empty state and sets
 * E2E_NO_AUTH=1, and the authenticated specs skip themselves.
 */
const STATE_DIR = join(__dirname, '.auth');
const STATE_FILE = join(STATE_DIR, 'state.json');

type ApiContext = Awaited<ReturnType<typeof request.newContext>>;

async function switchToursOff(api: ApiContext, API: string, auth: Record<string, string>) {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await api
      .patch(`${API}/auth/profile/tours`, { headers: auth, data: { autoEnabled: false } })
      .catch(() => null);
    lastStatus = res ? res.status() : 0;
    if (res && res.ok()) return;
    if (lastStatus === 404) {
      console.log('e2e: the API has no guided tours yet (404), nothing to switch off');
      return;
    }
    if (attempt < 3) await sleep(1_500);
  }
  // Still failing: only a problem when the feature is live for this account.
  let flagOn = false;
  try {
    const f = await api.get(`${API}/features/me`, { headers: auth });
    if (f.ok()) flagOn = !!((await f.json()) as { guided_tours?: boolean }).guided_tours;
  } catch {
    /* treated as flag off */
  }
  if (flagOn) {
    throw new Error(`e2e: guided_tours is on for the e2e account but automatic tours could not be switched off (last status ${lastStatus})`);
  }
  console.warn(`e2e: warning, could not switch automatic tours off (last status ${lastStatus}); guided_tours is not on for this account, continuing`);
}

export default async function globalSetup(config: FullConfig) {
  mkdirSync(STATE_DIR, { recursive: true });
  const baseURL = (config.projects[0]?.use?.baseURL as string) || process.env.E2E_BASE_URL || 'http://localhost:3000';
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  if (!email || !password) {
    writeFileSync(STATE_FILE, JSON.stringify({ cookies: [], origins: [] }));
    process.env.E2E_NO_AUTH = '1';
    console.log('e2e: no E2E_EMAIL / E2E_PASSWORD, authenticated specs will be skipped');
    return;
  }

  // 1. The API: tokens, the organization and a project to open.
  const API = apiBase(baseURL).replace(/\/+$/, '');
  const api = await request.newContext();
  const login = await api.post(`${API}/auth/login`, { data: { email, password } });
  if (!login.ok()) throw new Error(`e2e: API login failed (${login.status()}): ${(await login.text()).slice(0, 200)}`);
  const tokens = (await login.json()) as { accessToken: string; refreshToken: string };
  const auth = { Authorization: `Bearer ${tokens.accessToken}` };

  // Automatic tours off for this shared account, so a popover never covers a
  // click in the other specs. Never turned ON here.
  await switchToursOff(api, API, auth);

  const teams = (await (await api.get(`${API}/teams`, { headers: auth })).json()) as Array<{ id: string; publicId?: string; isPersonal?: boolean }>;
  const team = teams.find((t) => t.isPersonal) ?? teams[0];
  if (!team) throw new Error('e2e: the account has no organization');
  process.env.E2E_ORG_ID = team.publicId || team.id;

  const projectName = process.env.E2E_PROJECT_NAME || 'e2e-nav-v2';
  const list = (await (await api.get(`${API}/projects?teamId=${team.id}`, { headers: auth })).json()) as Array<{ id: string; name: string; status: string }> | { projects?: Array<{ id: string; name: string; status: string }> };
  const projects = Array.isArray(list) ? list : (list.projects ?? []);
  let project = projects.find((p) => p.name === projectName && p.status !== 'DELETED');
  if (!project) {
    const created = await api.post(`${API}/projects`, { headers: auth, data: { name: projectName, teamId: team.id, databaseType: 'RELATIONAL', description: 'Playwright e2e fixture; safe to delete' } });
    if (!created.ok()) throw new Error(`e2e: could not create the fixture project (${created.status()}): ${(await created.text()).slice(0, 200)}`);
    project = (await created.json()) as { id: string; name: string; status: string };
    console.log(`e2e: created fixture project ${project.id}`);
  }
  process.env.E2E_PROJECT_ID = project.id;
  // The newest release note, for the /changelog/[slug] routes.
  const latest = await api.get(`${baseURL.replace(/\/+$/, '')}/api/changelog/latest`).catch(() => null);
  if (latest && latest.ok()) {
    const body = (await latest.json()) as { latest?: { slug?: string } };
    if (body.latest?.slug) process.env.E2E_CHANGELOG_SLUG = body.latest.slug;
  }
  await api.dispose();

  // 2. The browser: sign in through the real page and keep the state.
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL });
  // Second safety net: this browser never starts a tour on its own, and the
  // saved state carries the key for every spec.
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem('basefyio_tours_auto', 'off');
    } catch {
      /* storage unavailable */
    }
  });
  const page = await context.newPage();
  await page.goto('/login');
  await page.locator('input[type="email"], input[name="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill(password);
  await page.getByRole('button', { name: /^sign in$/i }).first().click();
  await page.waitForURL(/\/dashboard/, { timeout: 45_000 });
  await page.evaluate(() => window.localStorage.setItem('basefyio_tours_auto', 'off'));
  await page.context().storageState({ path: STATE_FILE });
  await browser.close();
  console.log(`e2e: signed in as ${email}; project ${project.id}; organization ${process.env.E2E_ORG_ID}`);
}
