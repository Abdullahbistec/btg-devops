import { chromium, type Page } from 'playwright';
import { tmpdir } from 'os';
import { join } from 'path';

export interface HetznerInvoice {
  invoiceNumber: string;
  date: string; // YYYY-MM-DD
  total: number;
  currency: string;
}

const LOGIN_URL = 'https://accounts.hetzner.com/login';
const INVOICES_URL = 'https://accounts.hetzner.com/invoice';

/**
 * Logs into the Hetzner account Console with a headless browser and scrapes
 * the real invoice list — the only way to get an actual billed figure, since
 * (see web/app/api/cost/hetzner/route.ts and the ADRs this deviates from)
 * the Hetzner Cloud API has no invoice endpoint at all.
 *
 * This is a deliberate, explicitly-approved deviation from this project's
 * own ADR-001/ADR-006 (docs/hetzner-cost-estimator ADR.md), which kept the
 * Hetzner integration credential-free and API-only. It needs the account's
 * actual login (HETZNER_CONSOLE_EMAIL / HETZNER_CONSOLE_PASSWORD), a
 * materially bigger secret than the scoped, read-only HCLOUD_TOKEN the rest
 * of this project uses — see .env.local.example for the full tradeoff.
 *
 * UNVERIFIED against a live account: a single unauthenticated fetch of
 * LOGIN_URL during development returned HTTP 429 from Hetzner's own
 * infrastructure, so neither the login form's selectors nor the invoices
 * page's table structure below could be confirmed against the real site.
 * Expect the first real run to need adjustment — see FIELD_SELECTORS,
 * INVOICE_ROW_SELECTOR below, and the screenshot this function saves to the
 * OS temp dir on failure to make that adjustment possible without guessing
 * blind a second time.
 *
 * Deliberately NOT wired into the scheduler (unlike the cost-snapshot
 * refresh) — every call here is a real login against the real account, and
 * the caller (POST /api/cost/hetzner/invoices) rate-limits it to one attempt
 * per rolling 24h so a UI misclick or retry loop can't hammer Hetzner's
 * login and risk tripping their fraud/bot detection on the account.
 */
export async function scrapeHetznerInvoices(): Promise<HetznerInvoice[]> {
  const email = process.env.HETZNER_CONSOLE_EMAIL;
  const password = process.env.HETZNER_CONSOLE_PASSWORD;
  if (!email || !password) {
    throw new Error('HETZNER_CONSOLE_EMAIL / HETZNER_CONSOLE_PASSWORD not set — required for invoice scraping (see .env.local.example)');
  }

  const browser = await chromium.launch({ headless: true });
  let page: Page | null = null;
  try {
    page = await browser.newPage();
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Conventional Symfony-form field names historically used at this URL —
    // unconfirmed this session (see module doc). Tries a couple of
    // plausible alternates and fails loudly, rather than silently, if none
    // match: a wrong selector must surface as "adjust this" not "logged in
    // with an empty password".
    await fillFirstMatch(page, ['#_username', 'input[name="_username"]', 'input[type="email"]'], email);
    await fillFirstMatch(page, ['#_password', 'input[name="_password"]', 'input[type="password"]'], password);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {}),
      page.click('button[type="submit"], input[type="submit"]'),
    ]);

    // A 2FA/TOTP prompt must stop this cleanly, not be mistaken for a
    // successful login or hang waiting for input that will never come. This
    // tool does not, and should not, extract or store a TOTP secret — that
    // is a worse credential than the password it already holds.
    const twoFactorField = await page.$(
      'input[name*="totp" i], input[name*="2fa" i], input[name*="otp" i], input[autocomplete="one-time-code"]'
    );
    if (twoFactorField) {
      throw new Error(
        '2FA is enabled on this Hetzner account — automated login cannot proceed past it. ' +
        'Disable 2FA on this service account to use invoice scraping, or switch to PDF-invoice upload instead.'
      );
    }

    const loginError = await page.$('.alert-danger, .error, [role="alert"]');
    if (loginError) {
      const text = (await loginError.textContent())?.trim();
      throw new Error(`Hetzner login failed: ${text || 'an error was shown on the login page but its text could not be read'}`);
    }

    await page.goto(INVOICES_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Table structure is equally unverified — same caveat as the login
    // selectors above. This reads whatever rows exist in the first
    // <table><tbody> on the page and expects [number, date, amount] cell
    // order; adjust to match the real invoices page.
    const rawRows = await page.$$eval('table tbody tr', trs =>
      trs.map(tr => Array.from(tr.querySelectorAll('td')).map(td => td.textContent?.trim() || ''))
    );

    if (rawRows.length === 0) {
      throw new Error(
        `Login appears to have succeeded but no invoice rows were found at ${INVOICES_URL} — ` +
        'the page structure is likely different from what this scraper expects. Check the failure screenshot.'
      );
    }

    const invoices: HetznerInvoice[] = [];
    for (const cells of rawRows) {
      const [invoiceNumber, dateText, amountText] = cells;
      if (!invoiceNumber || !dateText || !amountText) continue;
      const amountMatch = amountText.match(/([€$])\s*([\d,]+\.\d{2})/);
      const parsedDate = new Date(dateText);
      if (!amountMatch || Number.isNaN(parsedDate.getTime())) continue;
      invoices.push({
        invoiceNumber,
        date: parsedDate.toISOString().slice(0, 10),
        currency: amountMatch[1] === '$' ? 'USD' : 'EUR',
        total: parseFloat(amountMatch[2].replace(/,/g, '')),
      });
    }
    return invoices;
  } catch (e) {
    if (page) {
      const shotPath = join(tmpdir(), `hetzner-invoice-scrape-failure-${Date.now()}.png`);
      await page.screenshot({ path: shotPath }).catch(() => {});
      if (e instanceof Error) e.message += ` (failure screenshot saved to ${shotPath})`;
    }
    throw e;
  } finally {
    await browser.close();
  }
}

async function fillFirstMatch(page: Page, selectors: string[], value: string): Promise<void> {
  for (const selector of selectors) {
    const el = await page.$(selector);
    if (el) {
      await el.fill(value);
      return;
    }
  }
  throw new Error(
    `Hetzner login form: none of the expected field selectors matched (tried: ${selectors.join(', ')}) — ` +
    'the page structure has likely changed from what this scraper expects. Check the failure screenshot.'
  );
}
