# Hetzner Cost Estimate — Design

**Date:** 2026-09-12
**Status:** Proposed

## Problem

The Cost & Usage page's "Actual Spend" tab is entirely Azure. Hetzner
contributes nothing to it, even though this account runs 15 servers, 22
volumes, and 28 primary IPs — roughly **$247/month**, or ~$2,960/year, that
the dashboard is currently blind to.

The only Hetzner cost figure that exists anywhere is unattached-volume waste
in `cmd/hetzner_volumes.go`, and it is wrong in two ways (below).

## Evidence gathered

Verified against the live account on 2026-09-12:

- `GET /v1/pricing` works with the **existing read-only `HCLOUD_TOKEN`** — no
  new permission, one call, ~41 KB.
- It returns `currency: USD`, `vat_rate: 0` (so net == gross), and covers
  `server_types` (29), `volume`, `primary_ips`, `floating_ips`,
  `server_backup`, `load_balancer_types`, priced **per location**.
- Measured run rate: servers $213.35, volumes (320 GB) $24.54, primary IPs
  $9.00 — **$246.89 USD/month**.

### Bug 1 — wrong currency symbol

`hetznerVolumeGBMonthlyEUR` (`cmd/hetzner_volumes.go:21`) and the `€%.2f`
format strings assume euros. The account bills in **USD**. Every Hetzner
waste figure currently shows a euro sign on a dollar account.

### Bug 2 — hardcoded price stale by 74%

The constant is `0.0440`/GB/month; the API returns **`0.0767`**. An
unattached 100 GB volume is reported as €4.40 when it actually costs $7.67.
Both bugs are small, independent of everything below, and should land first.

## Goals

1. Fix the two bugs above.
2. Price every Hetzner resource from the **live pricing API**, not constants.
3. Surface a Hetzner monthly run-rate in Actual Spend, as its own provider
   view.
4. Give the Claude analysis agent a cost signal, so generated summaries can
   weigh money alongside risk instead of ranking on severity alone.

## Non-goals

- **Billed actuals.** The hcloud API exposes no invoice or spend-history
  endpoint; that lives in the Hetzner console. This is list-price run-rate
  and must be labelled as an estimate everywhere it appears.
- **Traffic overage.** `included_traffic` and `price_per_tb_traffic` exist in
  the payload, but actual egress is not retrievable per-resource. Excluded.
- Backups, snapshots, and images are out of scope for v1.
- No blending of Azure and Hetzner into one total — see "Surfacing".

## Design

### CLI (Go)

**New `cmd/hetzner_pricing.go`** — fetches `/v1/pricing` once per run via the
existing `hetznerFetch` helper, caches it in memory, and exposes lookups:

```go
type hetznerPricing struct { /* parsed payload */ }

func fetchHetznerPricing(ctx, token) (*hetznerPricing, error)
func (p *hetznerPricing) Currency() string
func (p *hetznerPricing) ServerMonthly(typeName, location string) float64
func (p *hetznerPricing) VolumeMonthlyPerGB() float64
func (p *hetznerPricing) PrimaryIPMonthly(ipType, location string) float64
```

Prices are per-location and the payload gives `net` and `gross`; use `gross`,
which equals `net` while `vat_rate` is 0 and stays correct if it isn't.

**`cmd/hetzner_servers.go`** — add `ServerType` to the `hetznerServer`
struct. It is not currently unmarshalled (`:46-55`) and is the pricing key.
Also resolve datacenter location properly: an exploratory script read it as
`undefined` and fell back to the first price entry. Harmless for EU
locations, which are near-identical, but wrong in principle.

**`cmd/hetzner_volumes.go`** — delete the constant, price via
`VolumeMonthlyPerGB()`, and format with the API's currency rather than `€`.

**New `btg-devops analyze hetzner-cost --output json`** — emits the run-rate
report: total, currency, and breakdowns by resource class, by server type,
and by location.

### Storage

Mirror the Azure pattern rather than calling Hetzner on page load:

```sql
CREATE TABLE hetzner_cost_snapshots (
  id            TEXT PRIMARY KEY,
  total_monthly DOUBLE PRECISION NOT NULL,
  currency      TEXT NOT NULL,
  by_category   JSONB NOT NULL,   -- servers / volumes / primary_ips
  by_type       JSONB NOT NULL,   -- cx33 @ fsn1, ...
  fetched_at    TIMESTAMPTZ NOT NULL
);
```

A separate table, not a `provider` column on `cost_snapshots` — that table is
keyed by `subscription_id` and shaped around Azure's service/resource-group
breakdown, which does not fit.

Storing snapshots also gives Hetzner the same history-over-time the Azure
view has, which a live-only call could not.

**`findings.currency`** — add a nullable `TEXT` column beside the existing
`monthly_cost`. Today `monthly_cost` is a bare number with no currency
attached, while `cost_snapshots` has one. Nothing sums those values yet, so
this is not an active bug, but the first cross-provider "total savings" tile
would silently add EUR to USD.

### API

- `GET /api/cost/hetzner` — reads the latest snapshot; never calls Hetzner.
- `POST /api/cost-requests` — gains an optional `provider: 'azure' | 'hetzner'`
  (default `azure`, so existing callers are unaffected).
- The scheduler's daily cost refresh triggers both.

### Surfacing

Actual Spend gains a provider switch: **[Azure] [Hetzner]**. The two are
never summed. Azure shows billed actuals from Cost Management; Hetzner shows
a list-price estimate, with that distinction stated in the view rather than
buried in a tooltip — the numbers mean genuinely different things, and one
blended figure would lose that.

Hetzner view: total run-rate, breakdown by resource class, by server type,
by location, and the estimate caveat.

### Claude agent / MCP exposure

The async analysis agent currently cannot see cost at all.
`web/lib/analysisContext.ts` builds the entire `get_audit_data` context from
severity, service, and description (`:25`, `:28-34`) and never reads
`monthly_cost`. That is why generated summaries rank purely by risk and never
say what anything costs — the agent has no money signal to reason with.

Two changes, both in `buildAuditContext` so every MCP caller benefits without
a new tool:

1. **Cost on the finding lines** where one exists:

   ```
   - [Critical] Hetzner Volumes/backup-vol-3: unattached — $7.67/mo
   ```

   Rendered from `monthly_cost` + the new `findings.currency`, and omitted
   entirely when null, so Azure findings that carry no cost are unchanged.

2. **A cost block** alongside the severity and service counts:

   ```
   Estimated monthly cost attributable to findings: $31.40 (USD)
   Hetzner run rate: $246.89/mo (list-price estimate, not billed)
   Top findings by cost: ...
   ```

This is deliberately a context change rather than a new MCP tool. The tool
surface (`list_pending_requests` / `get_audit_data` / `save_analysis`) stays
as it is, the Go MCP server needs no change at all, and every existing caller
picks the cost data up for free. A dedicated `get_hetzner_cost` tool would
only earn its place if the agent needs run-rate *without* an audit, which no
current flow requires.

The run-rate line must carry its estimate caveat **inside the context
string**. The agent quotes what it is given, and an unqualified figure will
end up in an executive summary as though it were an invoice.

## Testing

- `parseHetznerPricing` against a captured payload fixture: per-location
  lookup, missing type, missing location falling back explicitly rather than
  silently, `gross` vs `net`.
- Run-rate arithmetic against a fixed inventory fixture — the whole value of
  the feature is one number being right.
- A regression test pinning volume pricing to the API value, so the stale
  constant cannot reappear.
- Existing Hetzner analyzer tests must stay green.

## Risks

- **List price ≠ invoice.** Committed discounts, promotions, or partial-month
  proration will not be reflected. Mitigated by labelling, not by code.
- **Pricing payload drift.** If Hetzner reshapes `/v1/pricing`, parsing
  breaks. The fixture test will catch it at build time rather than in
  production.
- **Per-location fallback.** When a type has no entry for a location, falling
  back to the first price silently under- or over-states. Fall back
  explicitly and surface it.

## Open questions

1. Should the run-rate include **powered-off servers**? Hetzner still bills
   for them, so yes by default — but they arguably belong flagged as waste.
2. Does the 2,960/yr figure warrant a **budget threshold** for Hetzner, the
   way `monthly_budget` works for Azure subscriptions?
