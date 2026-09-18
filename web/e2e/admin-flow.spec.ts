import { test, expect, Page } from '@playwright/test';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// The env-var admin bypasses OTP (skipOtp) — the one flow we can drive fully E2E
// without an email inbox. Regular-user login requires an emailed OTP and is out
// of scope for automated E2E here.
test.describe('admin end-to-end journey', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'ADMIN_EMAIL/ADMIN_PASSWORD not set in .env.local');

  // Collect page-level console errors and failed requests across the journey.
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  async function login(page: Page) {
    await page.goto('/login');
    await page.locator('input[type="email"]').fill(ADMIN_EMAIL!);
    await page.locator('input[type="password"]').fill(ADMIN_PASSWORD!);
    await page.locator('button[type="submit"]').click();
    // Generous timeout: in dev the first hit compiles /login + /dashboard on demand.
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 45_000 });
  }

  // Aborted RSC prefetches (…?_rsc=…, ERR_ABORTED) are normal Next.js navigation
  // cancellations, not failures — don't count them as bugs.
  const isBenign = (url: string, err?: string) =>
    url.includes('_rsc=') || (err ?? '').includes('ERR_ABORTED');

  test.beforeEach(async ({ page }) => {
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('requestfailed', r => {
      const err = r.failure()?.errorText;
      if (!isBenign(r.url(), err)) failedRequests.push(`${r.method()} ${r.url()} — ${err}`);
    });
    page.on('response', r => { if (r.status() >= 500) failedRequests.push(`${r.status()} ${r.url()}`); });
  });

  test('admin can log in and reach the dashboard', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    // dashboard should render its shell (sidebar nav), not an error boundary
    await expect(page.locator('body')).not.toContainText('Application error');
    await expect(page.locator('body')).not.toContainText('Not signed in');
  });

  test('all main pages load without 5xx or error boundary', async ({ page }) => {
    // Next.js dev compiles each route on first hit; a cold heavy page (e.g. /admin)
    // can take >30s to fire the full `load` event. We only need the route to
    // respond and paint, so wait for domcontentloaded and give cold compiles room.
    test.setTimeout(180_000);
    await login(page);
    for (const path of ['/dashboard', '/audits', '/cost', '/reports', '/compare', '/settings', '/admin', '/power-automate']) {
      const resp = await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      expect(resp?.status(), `HTTP status for ${path}`).toBeLessThan(500);
      await expect(page.locator('body'), `error boundary on ${path}`).not.toContainText('Application error');
      await expect(page, `bounced to login on ${path}`).not.toHaveURL(/\/login/);
    }
  });

  test('no console errors or 5xx across the journey', async () => {
    // Assert on what the beforeEach hooks collected in the two tests above.
    expect(failedRequests, `server errors / failed requests:\n${failedRequests.join('\n')}`).toEqual([]);
    expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toEqual([]);
  });
});
