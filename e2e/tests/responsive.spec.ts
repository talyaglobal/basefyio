import { test, expect } from '@playwright/test';

/**
 * Narrow screens keep the header and the project page usable (#48, #49):
 * nothing scrolls sideways and the user menu stays on screen at phone,
 * tablet and small-laptop widths.
 */
test.skip(() => process.env.E2E_NO_AUTH === '1', 'no e2e credentials');
// CI runs against the deployed site, which only carries this change after the release: run with E2E_RESPONSIVE=1.
test.skip(() => process.env.E2E_RESPONSIVE !== '1', 'set E2E_RESPONSIVE=1 against a build that has the change');

const project = () => process.env.E2E_PROJECT_ID as string;

for (const width of [390, 768, 1024]) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 800 } });

    test('the header fits and the user menu is on screen', async ({ page }) => {
      await page.goto('/dashboard');
      const header = page.locator('header').first();
      await expect(header).toBeVisible({ timeout: 30_000 });
      const overflow = await header.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow, 'header overflows sideways').toBeLessThanOrEqual(0);
      const avatar = header.locator('[data-nav-dropdown-root="true"] button').last();
      const box = await avatar.boundingBox();
      expect(box, 'user menu button is rendered').not.toBeNull();
      expect(box!.x + box!.width, 'user menu is inside the viewport').toBeLessThanOrEqual(width);
    });

    test('a project page does not scroll sideways', async ({ page }) => {
      await page.goto(`/dashboard/projects/${project()}`);
      await expect(page.getByText(process.env.E2E_PROJECT_NAME || 'e2e-nav-v2').first()).toBeVisible({ timeout: 30_000 });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, 'page overflows sideways').toBeLessThanOrEqual(0);
    });
  });
}

test.describe('at 390px the project menu is a drawer', () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test('the menu button opens the project navigation', async ({ page }) => {
    await page.goto(`/dashboard/projects/${project()}`);
    const menu = page.getByRole('button', { name: 'Open project menu' });
    await expect(menu).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('link', { name: 'SQL Editor' })).toBeHidden();
    await menu.click();
    await expect(page.getByRole('link', { name: 'SQL Editor' })).toBeVisible();
  });
});
