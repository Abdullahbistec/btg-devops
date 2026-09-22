import { NextRequest, NextResponse } from 'next/server';
import { getHetznerInvoices, saveHetznerInvoices } from '@/lib/db';
import { isAdminRequest } from '@/lib/auth';
import { logServerError } from '@/lib/api-error';
import { consumeRateLimit } from '@/lib/rate-limit';
import { fetchHetznerInvoicesFromEmail } from '@/lib/hetznerInvoiceEmail';

// Admin-only: this reads (GET) or triggers (POST) reading real invoice data
// from an IMAP mailbox (see docs/adr/0003-hetzner-invoice-email-ingestion.md)
// — not the scoped, read-only HCLOUD_TOKEN the rest of the Hetzner cost
// routes use. It needs mailbox credentials, never the Hetzner account's own
// login (see docs/adr/0002, now superseded by ADR-0003).

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

/** Manually triggered only — never called from the scheduler. Rate-limited
 * server-side to one attempt per rolling 24h regardless of how many times
 * the button is clicked — a lighter-weight precaution than the old
 * console-login scraper needed (no real account login is at stake anymore),
 * kept mainly to avoid hammering the mailbox provider on a retry loop.
 * Errors are returned verbatim (unlike apiError's generic 500) because they
 * are the exact operational detail — a PDF parser that needs adjustment, a
 * mailbox with no matching mail — an admin needs to fix this or decide to
 * abandon it, not a schema leak to hide. */
export async function POST(req: NextRequest) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const limit = await consumeRateLimit('hetzner-invoice-email-fetch', 1, 86400);
  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: `Already attempted within the last 24h — retry in ~${Math.ceil(limit.retryAfterSeconds / 3600)}h.`,
      },
      { status: 429 }
    );
  }
  try {
    const invoices = await fetchHetznerInvoicesFromEmail();
    await saveHetznerInvoices(invoices);
    return NextResponse.json({ invoices, scraped: invoices.length });
  } catch (e) {
    logServerError(e, 'POST /api/cost/hetzner/invoices');
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
