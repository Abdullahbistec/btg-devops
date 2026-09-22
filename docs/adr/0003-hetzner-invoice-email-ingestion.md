# ADR-0003: Read real Hetzner invoices from email instead of the account Console

**Status:** Accepted — supersedes ADR-0002
**Date:** 2026-09-22

## Context

[ADR-0002](0002-hetzner-invoice-scraping-deviation.md) accepted a
Playwright-based scraper that logged into `accounts.hetzner.com` with the
account's actual email/password to read real invoice totals, since the
Hetzner Cloud API has no invoice endpoint. That ADR also recorded three
unresolved risks: Hetzner's ToS was never checked for this kind of
automation, the account password was stored as a plain environment
variable (unlike comparable secrets elsewhere in this codebase), and there
was no plan for what happens if 2FA is later enabled on the real account.

Checking Hetzner's own documentation surfaced a materially better option:
Hetzner supports emailing each invoice as a PDF (an opt-in setting under
Console → Billing → Invoicing). That PDF can be read from a mailbox instead
of driving a browser against the Console.

## Decision

Replace the Playwright console-login scraper
(`web/lib/hetznerInvoiceScrape.ts`, removed) with
`web/lib/hetznerInvoiceEmail.ts`, which:

- Connects to an IMAP mailbox (`INVOICE_IMAP_HOST`/`PORT`/`USER`/`PASSWORD`)
  and searches for mail from Hetzner's invoice-notification sender.
- Extracts the PDF attachment and parses its text for invoice number, date,
  and total, via a pure `parseInvoicePdfText()` function kept separate from
  the IMAP I/O specifically so it can be unit-tested without a live
  mailbox.
- Never touches the Hetzner account's actual login. The only credential
  this needs is mailbox access.

This makes ADR-0001's original policy (Hetzner integration stays
credential-free and API-only, using only the scoped `HCLOUD_TOKEN`)
effectively intact again — the exception ADR-0002 carved out for the
account login is no longer needed, because this path never uses it.

## Consequences

- **Two of ADR-0002's three unresolved risks are eliminated outright**, not
  mitigated: there is no Hetzner-account credential to leak, and reading
  your own mailbox is not console automation, so the ToS question ADR-0002
  raised about automating `accounts.hetzner.com` does not apply to this
  path. (A mailbox-provider ToS could theoretically apply to IMAP polling,
  but that is a far more standard, permitted use case than scraping a
  provider's account console.)
- **A new, smaller-blast-radius credential is introduced**: mailbox
  access. A leak of `INVOICE_IMAP_PASSWORD` exposes whatever else is in
  that mailbox, which is real but categorically smaller than full Hetzner
  account compromise (billing, DNS, every project, account settings).
  Using a dedicated mailbox (or a mail-provider app password scoped to
  IMAP only) rather than a general company inbox would shrink this
  further — not yet decided, left to whoever configures this in practice.
- **Still unverified against a real invoice.** `parseInvoicePdfText()`'s
  layout assumptions are a best-effort guess, not confirmed against
  Hetzner's actual PDF template. The first real run will likely need
  adjustment to the regex patterns — this is the same class of caveat
  ADR-0002's scraper carried, just with a much cheaper failure mode (a
  parse error, not a flagged account).
- **Requires a one-time manual step** this code cannot do itself: turning
  on "email invoice as PDF" in the Hetzner Console for the account being
  billed.
- **`playwright` is removed as a runtime dependency.** `@playwright/test`
  (this project's e2e test tooling) is unrelated and unaffected.

## What ADR-0002 remains for

ADR-0002 is kept, not deleted, as the historical record of why the
Console-login approach was tried, what it cost, and why it was replaced —
standard ADR practice is to supersede, not rewrite, a prior decision.
