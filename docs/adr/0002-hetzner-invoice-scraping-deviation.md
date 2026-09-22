# ADR-0002: Real invoice scraping is a scoped, explicit exception to ADR-0001

**Status:** Superseded by [ADR-0003](0003-hetzner-invoice-email-ingestion.md) (2026-09-22, same day) —
kept as the historical record; the Playwright console-login scraper this
ADR accepted has been removed from the codebase.
**Date:** 2026-09-22

## Note on this record

Written together with [ADR-0001](0001-hetzner-credential-free-api-only-integration.md)
to correct a citation in `2dba102` ("feat(hetzner): add real invoice
scraping via Hetzner account Console login") that referenced a
non-existent "ADR-001/ADR-006 (`docs/hetzner-cost-estimator ADR.md`)".
See ADR-0001's note for the full context. This ADR is the actual, real
record of the deviation that commit made — written after the code, not
before it. Treat the "Unresolved risks" section as still open, not as a
formality.

## Context

ADR-0001 fixes this project's Hetzner integration to a scoped, read-only
API token. But the Hetzner Cloud API has no invoice/billing endpoint at
all (verified against `docs.hetzner.cloud`) — so under ADR-0001 alone,
this project's cost views can only ever show a list-price *estimate*,
never a real billed figure. The only other way to get a real number is to
log into `accounts.hetzner.com` (the web console, not the Cloud API) and
read the actual invoice list there.

## Decision

`web/lib/hetznerInvoiceScrape.ts` is accepted as a scoped, explicit
exception to ADR-0001, bounded as follows:

- It is the **only** place in this project that uses the Hetzner
  account's actual login (`HETZNER_CONSOLE_EMAIL` / `HETZNER_CONSOLE_PASSWORD`),
  as opposed to the scoped `HCLOUD_TOKEN` everything else uses.
- It is manually triggered only (`POST /api/cost/hetzner/invoices`),
  admin-gated, and never called from the scheduler.
- It is rate-limited server-side to one attempt per rolling 24h,
  regardless of how many times the UI button is clicked.
- It refuses to proceed past a 2FA prompt — it does not, and must not,
  extract or store a TOTP secret.
- Any failure saves a screenshot to the OS temp dir specifically to make
  debugging the (expected, disclosed) selector drift possible.
- The risk is stated directly in the dashboard UI (`web/app/cost/page.tsx`),
  not only in a code comment.

## Consequences

- **The blast radius is materially larger than ADR-0001 accepted for the
  rest of this project.** `HCLOUD_TOKEN` is scoped and revocable; the
  account login this feature stores is not — a leak of
  `HETZNER_CONSOLE_EMAIL`/`PASSWORD` (via Postgres or env exposure) is a
  full Hetzner account compromise (billing, DNS, every project, account
  settings), not a scoped-token compromise. The admin gate and rate limit
  protect against *misuse* of this feature; they do not reduce what an
  attacker gets from *exposure* of the credential itself.
- **This likely runs against Hetzner's terms of service.** Automated
  login/scraping of a provider's account console, outside a documented
  API, is commonly prohibited by cloud-provider ToS independent of
  whether it trips fraud/bot detection. This was not checked against
  Hetzner's actual ToS before this code was written.
- **This creates pressure to disable 2FA on the real account.** The
  feature correctly refuses to run against a 2FA-protected account, which
  means the practical "fix" for a scraper failure is either disabling 2FA
  on the real Hetzner account (weakening its actual security) or
  abandoning the feature. This tradeoff was not stated anywhere before
  this ADR.
- **The password is stored as a plain environment variable**, unlike the
  Settings-page subscription client secrets in the same codebase, which
  get AES-256-GCM encryption at rest (`web/lib/crypto.ts`). Given the
  blast-radius point above, this credential arguably warrants the same
  treatment, not the `HCLOUD_TOKEN` treatment it currently gets.
- **Unverified against a live account.** A single unauthenticated fetch of
  the login page returned HTTP 429 from Hetzner's own infrastructure
  during development, so neither the login form's selectors nor the
  invoices page's table structure were confirmed against the real site.
  The first real use will likely need selector adjustments.

## Unresolved risks (as of this writing)

The following were identified when this ADR was written and are **not**
yet resolved in code:

1. Hetzner's ToS has not been checked for whether this kind of automation
   is permitted at all.
2. The account password is not encrypted at rest, unlike comparable
   secrets elsewhere in this codebase.
3. No decision has been recorded on what to do if 2FA is later enabled on
   the real account (expected security hardening) and this feature stops
   working as a result.

Recommendation carried over from the original review: test against a
non-production Hetzner login before pointing this at the real BISTEC
account, and resolve at least risk #1 before relying on this feature
operationally.
