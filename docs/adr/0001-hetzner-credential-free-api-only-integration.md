# ADR-0001: Hetzner integration stays credential-free and API-only

**Status:** Accepted (retroactively documented — see note below)
**Date:** 2026-09-12 (decision originates here; this record written 2026-09-22)

## Note on this record

This ADR did not exist as a numbered document until 2026-09-22. The commit
that added Hetzner invoice scraping (`2dba102`, `web/lib/hetznerInvoiceScrape.ts`)
cited it as "this project's own ADR-001/ADR-006
(`docs/hetzner-cost-estimator ADR.md`)" — no such file existed anywhere in
the repository. This document and
[ADR-0002](0002-hetzner-invoice-scraping-deviation.md) are written now to
make that citation true, grounded in the actual prior decision (below),
rather than to retroactively invent a decision that was never made.

## Context

`docs/superpowers/specs/2026-09-12-hetzner-cost-estimate-design.md`
established the Hetzner cost-estimate feature on `GET /v1/pricing`,
explicitly noting it "works with the **existing read-only `HCLOUD_TOKEN`**
— no [additional credential needed]". Every other Hetzner analyzer in this
codebase (`cmd/hetzner_*.go`) follows the same pattern: a single scoped,
read-only project API token (`HCLOUD_TOKEN`), never the account's actual
login.

## Decision

The Hetzner integration in this project uses only `HCLOUD_TOKEN` — a
scoped, revocable, read-only Hetzner Cloud API token generated from
Cloud Console → Security → API Tokens. It never stores or uses the
Hetzner account's actual email/password login. This applies to every
Hetzner-related feature in this project unless a specific, later ADR
records an explicit, scoped exception.

## Consequences

- **Blast radius on leak is contained.** If `HCLOUD_TOKEN` leaks, the
  damage is limited to whatever that token's scope allows (read access to
  one Hetzner project), and it can be revoked/rotated from the Hetzner
  console without touching the account's actual credentials.
- **Some data is permanently unavailable this way.** The Hetzner Cloud API
  has no invoice/billing endpoint — this policy means the cost views in
  this project can only ever show a list-price *estimate*, never a real
  billed figure, unless a later ADR explicitly accepts the tradeoff of a
  credential-based exception (see ADR-0002).
