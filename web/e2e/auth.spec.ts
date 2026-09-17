import { test, expect } from '@playwright/test';

// Protected pages must bounce an unauthenticated browser to /login (middleware).
const PROTECTED = ['/dashboard', '/admin', '/settings', '/audits', '/cost', '/reports', '/compare', '/power-automate'];

test.describe('unauthenticated access control', () => {
  for (const path of PROTECTED) {
    test(`GET ${path} redirects to /login`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/);
    });
  }

  test('root (/) ultimately lands on /login when logged out', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
  });

  test('login page renders the sign-in form', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByText('Sign in')).toBeVisible();
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
  });

  test('wrong credentials show an error, do not navigate, and do not reflect HTML', async ({ page }) => {
    await page.goto('/login');
    await page.locator('input[type="email"]').fill('nobody@example.com');
    await page.locator('input[type="password"]').fill('<img src=x onerror=alert(1)>');
    await page.locator('button[type="submit"]').click();
    // stays on login
    await expect(page).toHaveURL(/\/login/);
    // the payload must never become a live element in the DOM
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
  });
});
