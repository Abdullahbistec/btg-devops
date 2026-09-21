import { NextRequest, NextResponse } from 'next/server';
import { getHetznerInvoices, saveHetznerInvoices } from '@/lib/db';
import { isAdminRequest } from '@/lib/auth';
import { logServerError } from '@/lib/api-error';
import { consumeRateLimit } from '@/lib/rate-limit';
import { scrapeHetznerInvoices } from '@/lib/hetznerInvoiceScrape';

// Admin-only: this reads (GET) or triggers (POST) a real login against the
// actual Hetzner account console, not just Hetzner-scoped estimate data —
// a materially more sensitive operation than the rest of the Hetzner cost
// routes, which only ever use the scoped, read-only HCLOUD_TOKEN.

export async function GET(req: NextRequest) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const invoices = await getHetznerInvoices();
    return NextResponse.json({ invoices });
  } catch (e) {
    const correlationId = logServerError(e, 'GET /api/cost/hetzner/invoices');
    return NextResponse.json({ error: 'Something went wrong on our side.', correlationId }, { status: 500 });
  }
}

/** Manually triggered only — never called from the scheduler. Every call is
 * a real login against the real Hetzner account, and accounts.hetzner.com
 * has been observed rate-limiting even a single unauthenticated page fetch
 * (see hetznerInvoiceScrape.ts's module doc), so this is throttled hard
 * server-side: one attempt per rolling 24h regardless of how many times the
 * button is clicked, to avoid tripping Hetzner's fraud/bot detection on the
 * real account. Errors are returned verbatim (unlike apiError's generic
 * 500) because they are the exact operational detail — a 2FA block, a
 * selector that no longer matches — an admin needs to fix this or decide to
 * abandon it, not a schema leak to hide. */
export async function POST(req: NextRequest) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const limit = await consumeRateLimit('hetzner-invoice-scrape', 1, 86400);
  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: `Already attempted within the last 24h — retry in ~${Math.ceil(limit.retryAfterSeconds / 3600)}h. ` +
          'This limit is deliberately strict: repeated automated logins risk Hetzner flagging the real account.',
      },
      { status: 429 }
    );
  }
  try {
    const invoices = await scrapeHetznerInvoices();
    await saveHetznerInvoices(invoices);
    return NextResponse.json({ invoices, scraped: invoices.length });
  } catch (e) {
    logServerError(e, 'POST /api/cost/hetzner/invoices');
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
