import { test, expect } from '@playwright/test';

/**
 * Smoke coverage for the most critical entry points. These intentionally avoid
 * real credentials so they can run against any environment; extend with an
 * authenticated journey (login -> create project -> run SQL) using test creds.
 */

test('login page renders with email + password fields', async ({ page }) => {
  await page.goto('/login');
  await expect(page).toHaveURL(/\/login/);
  await expect(
    page.locator('input[type="email"], input[name="email"]').first(),
  ).toBeVisible();
  await expect(page.locator('input[type="password"]').first()).toBeVisible();
});

test('unauthenticated dashboard redirects to login', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login/);
});
