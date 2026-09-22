import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { PDFParse } from 'pdf-parse';

export interface HetznerInvoice {
  invoiceNumber: string;
  date: string; // YYYY-MM-DD
  total: number;
  currency: string;
}

// Hetzner sends invoice notifications from this address when "email invoice
// as PDF" is enabled under Console -> Billing -> Invoicing. Verified via
// Hetzner's own docs (docs.hetzner.com billing pages) that this delivery
// option exists; the exact PDF layout below is NOT verified against a real
// invoice — see parseInvoicePdfText()'s doc comment.
const HETZNER_INVOICE_SENDER = 'noreply@hetzner.com';

/**
 * Reads real Hetzner invoices from an IMAP mailbox instead of logging into
 * the Hetzner account Console — see docs/adr/0003-hetzner-invoice-email-ingestion.md
 * for why this replaced the earlier Playwright console-login scraper
 * (docs/adr/0002, now superseded). This needs only mailbox credentials
 * (INVOICE_IMAP_*), never the Hetzner account's own login, and requires
 * "email invoice as PDF" to be turned on for this account under Console ->
 * Billing -> Invoicing — this code cannot enable that setting itself.
 *
 * UNVERIFIED against a real invoice email: the PDF text layout parsed by
 * parseInvoicePdfText() below is a best-effort guess at Hetzner's invoice
 * format, not confirmed against a live sample. Expect the first real run to
 * need adjustment — every message from HETZNER_INVOICE_SENDER found is
 * still fetched, but one that fails to parse is skipped with a warning
 * rather than aborting the whole run, since one already-imported invoice
 * shouldn't block a later one from being read.
 */
export async function fetchHetznerInvoicesFromEmail(): Promise<HetznerInvoice[]> {
  const host = process.env.INVOICE_IMAP_HOST;
  const port = Number(process.env.INVOICE_IMAP_PORT ?? 993);
  const user = process.env.INVOICE_IMAP_USER;
  const password = process.env.INVOICE_IMAP_PASSWORD;
  if (!host || !user || !password) {
    throw new Error(
      'INVOICE_IMAP_HOST / INVOICE_IMAP_USER / INVOICE_IMAP_PASSWORD not set — required for invoice email ingestion (see .env.local.example)'
    );
  }

  const client = new ImapFlow({
    host,
    port,
    secure: port === 993,
    auth: { user, pass: password },
    logger: false,
  });

  const invoices: HetznerInvoice[] = [];
  const skipped: string[] = [];

  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ from: HETZNER_INVOICE_SENDER });
      if (!uids || uids.length === 0) {
        throw new Error(
          `No emails found from ${HETZNER_INVOICE_SENDER} in INBOX — confirm "email invoice as PDF" is ` +
          'enabled for this Hetzner account (Console -> Billing -> Invoicing) and that this mailbox ' +
          'actually receives that address\'s mail.'
        );
      }

      for (const uid of uids) {
        const raw = await client.download(uid, undefined, { uid: true });
        if (!raw?.content) continue;
        const chunks: Buffer[] = [];
        for await (const chunk of raw.content) chunks.push(chunk as Buffer);
        const parsed = await simpleParser(Buffer.concat(chunks));

        const pdfAttachment = parsed.attachments.find(a => a.contentType === 'application/pdf');
        if (!pdfAttachment) {
          skipped.push(`uid ${uid}: no PDF attachment found`);
          continue;
        }

        const parser = new PDFParse({ data: pdfAttachment.content });
        try {
          const { text } = await parser.getText();
          const invoice = parseInvoicePdfText(text);
          invoices.push(invoice);
        } catch (e) {
          skipped.push(`uid ${uid}: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          await parser.destroy();
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }

  if (invoices.length === 0) {
    throw new Error(
      `Found ${skipped.length} email(s) from ${HETZNER_INVOICE_SENDER} but none parsed into a usable ` +
      `invoice. Details: ${skipped.join('; ') || 'none'}. The PDF layout parser likely needs adjustment ` +
      '— see parseInvoicePdfText() in web/lib/hetznerInvoiceEmail.ts.'
    );
  }

  return invoices;
}

/**
 * Extracts an invoice number, date, and total from a Hetzner invoice PDF's
 * plain-text content. UNVERIFIED against a real invoice — this is a
 * best-effort pattern based on typical European B2B invoice layouts, not
 * confirmed against Hetzner's actual template. Exported separately from
 * fetchHetznerInvoicesFromEmail() so it can be unit-tested with a fixed
 * text sample once a real invoice's extracted text is available, without
 * needing a live mailbox.
 */
export function parseInvoicePdfText(text: string): HetznerInvoice {
  const invoiceNumberMatch = text.match(/Invoice\s*(?:No\.?|Number)?\s*[:#]?\s*([A-Z0-9-]{6,})/i);
  const dateMatch = text.match(/(\d{4}-\d{2}-\d{2})/) ?? text.match(/(\d{2}\.\d{2}\.\d{4})/);
  const totalMatch = text.match(/Total\s*(?:Amount)?\s*[:]?\s*([€$])\s*([\d,]+\.\d{2})/i);

  if (!invoiceNumberMatch || !dateMatch || !totalMatch) {
    throw new Error(
      `could not find invoice number, date, and total in PDF text (found: ` +
      `number=${!!invoiceNumberMatch}, date=${!!dateMatch}, total=${!!totalMatch})`
    );
  }

  const rawDate = dateMatch[1];
  const isoDate = rawDate.includes('.')
    ? rawDate.split('.').reverse().join('-') // DD.MM.YYYY -> YYYY-MM-DD
    : rawDate;

  return {
    invoiceNumber: invoiceNumberMatch[1],
    date: isoDate,
    currency: totalMatch[1] === '$' ? 'USD' : 'EUR',
    total: parseFloat(totalMatch[2].replace(/,/g, '')),
  };
}
