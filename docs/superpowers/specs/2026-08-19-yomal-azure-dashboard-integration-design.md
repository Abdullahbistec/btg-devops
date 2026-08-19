# Porting Yomal's Extra Azure Coverage + Dashboard UI — Design

Date: 2026-08-19
Branch: abd-production-2

## Context

Two separate systems both carry the name "Yomal" in this repo, and this design touches both:

- `external/yomal/CLI Engine` — Yomal's original, standalone Go module and collector.
  It writes directly to its own Postgres schema (`internal/db/`: users, mailer,
  analysis_requests) and powers `external/yomal/dashboard`, a separate Next.js 16
  app. Per `docs/superpowers/specs/2026-08-06-unified-analyzer-interface-design.md`
  and `docs/superpowers/specs/2026-08-17-yomal-dashboard-power-platform-design.md`,
  this has already been established twice as a genuinely separate module, not to
  be unified with our own `cmd/` — both prior designs ported analyzer *logic*
  across the boundary rather than merging modules or running one system's binary
  against the other's database. This design follows the same precedent, in the
  opposite direction: Yomal's dashboard already gained our Power Platform logic
  (2026-08-17); this design ports Yomal's extra *Azure* analyzer logic into our
  own `cmd/` instead.
- `docs/consolidation-plan.md` — a separate, already-written analysis of our own
  `cmd/` package (14 Azure analyzers originally authored by a colleague named
  Yomal, already ported into `cmd/` and registered against `provider.Analyzer`;
  5 Power Platform analyzers; 5 Hetzner analyzers). That plan's own phase table
  (§7) is the template this design's phase table follows, and its Phase 8
  ("remaining analyzers... additive, one PR per check") is exactly the shape of
  Sub-project A below.

Comparing `external/yomal/CLI Engine`'s extractor list against our own `cmd/`
found four things Yomal's original tool covers that never made it into our own
Azure analyzer set: VM analysis, CDN analysis, per-service usage/utilization
analytics (9 sub-extractors), and cost analysis. Separately, our own
`web/app/dashboard/page.tsx` (SQLite-backed, serves Azure/PP/Hetzner behind one
`?scope=` filter) is missing several UI components that `external/yomal/dashboard`'s
home page already has: `SeverityDonut`, `TopIssues`, `RegionSection`/
`CrossRegionCheck`/`RegionListCard`, `SavingsCard`, `ResourceDeltaList`,
`MiniSeverityCard`, `DashboardSearch`.

This design covers both gaps as three related, independently shippable
sub-projects.

## Goals

- New Azure findings coverage — VM, CDN, usage/utilization, cost — ported into
  our own `cmd/`, following the exact same `provider.Analyzer` pattern the
  existing 24 analyzers already use, flowing through the same
  CLI → `btg-runner.ts` → SQLite → `/api/dashboard`+`/api/findings` → dashboard
  pipeline as everything else.
- A generic `location` and `monthly_cost`/`monthly_saving` fact on findings,
  populated by whichever provider's analyzer already has the data (Hetzner and
  Azure's `idle` analyzer both already compute or extract this internally today
  — it just never reaches the finding), and net-new for the 13 other Azure
  analyzers and Power Platform.
- The missing dashboard components ported into `web/app/dashboard/page.tsx`,
  generic across `?scope=azure|pp|hetzner|all`, degrading gracefully (not
  fabricating data) wherever a given provider has none of the underlying fact.

## Non-goals

- No change to `external/yomal/CLI Engine` or `external/yomal/dashboard` — this
  is a one-directional logic port, read-only against that codebase.
- No merging of Go modules, no running Yomal's CLI Engine binary against our
  SQLite database, no Postgres involved at any point — per the established
  precedent above.
- No change to the existing, separate Cost Management feature
  (`web/lib/costManagement.ts`, `/cost` page, `cost_snapshots` table) unless
  Sub-project A's overlap investigation (below) finds a reason to touch it —
  and if so, that becomes its own follow-up, not silently folded into this one.
- No severity-scale changes (`docs/consolidation-plan.md`'s 3→4 level migration,
  §5/§7 Phase 6, is an independent, already-scoped piece of work — unrelated to
  this design and not touched by it).

## Sub-project A — New Azure analyzer coverage

Four new commands, each a new `cmd/*.go` file registered against
`provider.Analyzer` exactly like the existing 24 (see
`docs/consolidation-plan.md` §3 "Analyzer interface" and §4 "Registry" — no
interface changes needed, this is purely additive):

| Command | Ported from | Status |
|---|---|---|
| `vm` | `external/yomal/CLI Engine/internal/extractors/vm.go` | New coverage, no known overlap |
| `cdn` | `external/yomal/CLI Engine/internal/extractors/cdn.go` | New coverage, no known overlap |
| `usage` | `external/yomal/CLI Engine/internal/extractors/usage.go` + 9 per-service `usage_*.go` files | **Overlap risk** — may double-report the same over-provisioned/idle resources our existing `idle` analyzer already flags |
| `cost-analysis` | `external/yomal/CLI Engine/cmd/costanalysis.go`, `internal/extractors/cost.go`, `internal/extractors/pricing.go` | **Overlap risk** — may duplicate or conflict with the existing, separate Cost Management feature |

**Open question, first task of this sub-project:** read the four source files
above in full and determine, concretely:
1. Does `usage`'s detection logic produce findings on the same
   resource+condition pairs `idle` already does? If so — merge into `idle`
   rather than shipping a duplicate-sounding second analyzer, following
   `docs/consolidation-plan.md`'s existing convention of one analyzer per
   distinct check, not per source file.
2. Does `cost-analysis` produce per-finding waste/cost estimates (fits
   alongside `idle`'s `TotalCost`/`TotalSaving`, feeds Sub-project B) or
   account-level spend totals (fits alongside Cost Management, and likely
   shouldn't be a "finding" at all)?

This investigation produces a short scoping note (not a full second design
doc) before any of the four commands are built, and may change the table
above — e.g. `usage`'s checks might get absorbed into `idle` instead of
shipping as their own command.

## Sub-project B — Generic `location` + cost facts

**Schema** (SQLite, `web/lib/db.ts`), additive, following the exact
`ALTER TABLE ... ADD COLUMN` + try/catch pattern already used five times in
that file (per `docs/consolidation-plan.md` §5):

```sql
ALTER TABLE findings ADD COLUMN location TEXT DEFAULT '';
ALTER TABLE findings ADD COLUMN monthly_cost REAL DEFAULT NULL;
ALTER TABLE findings ADD COLUMN monthly_saving REAL DEFAULT NULL;
```

`monthly_cost` = what the flagged resource currently costs (known today only
for `idle`'s findings). `monthly_saving` = estimated saving if remediated
(same source). Both are per-finding facts, distinct from the account-level
spend `cost_snapshots` already tracks — no overlap, different granularity,
different source.

**Go side** — extend the shared interchange struct (`provider.Finding`) with
`Location`, `MonthlyCost *float64`, `MonthlySaving *float64`. Population, by
provider:

- **Hetzner** — wire the `Datacenter` field each of the 5 analyzers already
  extracts (confirmed present on `hetzner_servers.go`'s finding struct; verify
  the other 4 during implementation) through to `Location`. Zero new API calls.
- **Azure, `idle` only** — wire the already-computed `TotalCost`/`TotalSaving`
  fields (`cmd/idle.go`) through to `MonthlyCost`/`MonthlySaving`. Zero new
  API calls.
- **Azure, other 13 analyzers** — one mechanical line each, reading `.Location`
  off the ARM SDK response object each analyzer already holds (every
  `arm*` resource type exposes this field). No new API calls, no new
  permissions.
- **Power Platform** — new extraction in `pp_environments.go`, reading the
  environment's location from the BAP API response it already calls. Exact
  response field name to be confirmed against the live API during
  implementation (not yet verified against Microsoft's schema).

**TypeScript side** (`web/lib/btg-runner.ts`) — add `location`,
`monthlyCost`, `monthlySaving` to `NormalizedFinding` and pass them through
directly from the Go JSON output. No field-guessing heuristic, unlike the
existing `extractResource()` — Go now supplies these directly, avoiding a
second version of the drift `docs/consolidation-plan.md` §2.2 already
documents for resource-name extraction.

**API layer** (`/api/dashboard`, `/api/findings`) — include the three new
columns in existing finding rows; add one new aggregate query each for
location breakdown (`GROUP BY location`) and cost/saving totals
(`SUM(monthly_cost)`, `SUM(monthly_saving)`), scoped by the same
`buildScopeFilter()` every other query already uses.

## Sub-project C — Dashboard UI port

Ported into `web/app/dashboard/page.tsx`, generic across all four
`?scope=` values per the earlier decision to build these provider-agnostic
rather than Azure-only:

| Component | Data source | Provider availability |
|---|---|---|
| `SeverityDonut` | existing `bySeverity` | All |
| `TopIssues` | existing `findings` (client-side top-N) | All |
| `MiniSeverityCard` | existing `kpi` | All |
| `RecentAuditsCard` | existing (already have `RecentAuditsList`) | All |
| `DashboardSearch` | existing `findings` (client-side filter) | All |
| `ResourceDeltaList` | new query: current vs. previous audit's `byService`/`resourcesScanned`, scoped | All |
| `RegionSection` / `CrossRegionCheck` / `RegionListCard` | Sub-project B's `location` | Azure + Hetzner (once populated); PP once its extraction lands |
| `SavingsCard` | Sub-project B's `monthly_cost`/`monthly_saving` | Azure (`idle` today; wider once Sub-project A's `cost-analysis` lands, pending the overlap resolution); Hetzner once a pricing lookup is added to its waste checks (not in this design's scope — flagged, not built); PP shows an explicit "not available" state, not zero |

Empty/partial-data states must say what's actually true (e.g. "no location
data for this audit yet") rather than rendering a zero or an empty chart
indistinguishable from "no waste found."

## Sequencing

Ordered so schema work unblocks the most and no phase requires reverting a
later one, mirroring the phase-table convention in
`docs/consolidation-plan.md` §7:

| Phase | Work | Depends on |
|---|---|---|
| 1 | Schema: add `location`/`monthly_cost`/`monthly_saving` columns; wire Hetzner's existing `Datacenter` and Azure `idle`'s existing `TotalCost`/`TotalSaving` through (zero new API calls) | — |
| 2 | Azure `.Location` extraction across the other 13 analyzers | 1 |
| 3 | Power Platform environment location extraction (API field TBC) | 1 |
| 4 | Read Yomal's `vm.go`/`cdn.go`/`usage.go`/`costanalysis.go`/`pricing.go`; resolve the `usage`-vs-`idle` and `cost-analysis`-vs-Cost-Management overlap questions; produce the scoping note | — (independent of 1–3) |
| 5 | Build `vm` + `cdn` analyzers | 4 |
| 6 | Build `usage` and/or `cost-analysis` analyzers, per what 4 decided | 4, and 1 if either writes cost facts |
| 7 | Dashboard: `SeverityDonut`, `TopIssues`, `MiniSeverityCard`, `ResourceDeltaList`, `DashboardSearch` | — (usable once 1 ships, but not blocked by it functionally) |
| 8 | Dashboard: `RegionSection`/`CrossRegionCheck`/`RegionListCard` | 1, 2, 3 |
| 9 | Dashboard: `SavingsCard` | 1, and 6 for coverage beyond `idle` |

Phases 4–6 (analyzer coverage) and 1–3 (schema) can proceed in parallel —
neither blocks the other. Phase 7 can start as soon as phase 1 lands.

## Testing

Follows the existing house conventions this repo has already converged on
(`docs/consolidation-plan.md` §3):

- New Go analyzers: pure-logic, table-driven tests per check, matching the
  existing `idle_test.go`/`usage_test.go`-style precedent, plus exhaustive
  `xxxFindingsToProvider` adapter-conversion tests (the "5-of-5" bar PP and
  Hetzner already meet, per §3's testing row).
- Any new REST-fetch code (if `cost-analysis` needs one) uses the
  `httptest.Server`-backed fixture pattern `hetzner_fetch_test.go` already
  established, not a fresh approach.
- Schema migration: verify additive `ALTER TABLE` is idempotent and safe to
  run against a database that already has rows (matches the existing
  try/catch pattern's own implicit contract).
- Dashboard components: manual verification against a real audit for each
  `?scope=` value, including the empty/partial-data states explicitly (no
  location data yet, no cost data for PP, etc.) — these are the states most
  likely to silently render wrong.

## Risks

| Risk | Mitigation |
|---|---|
| `usage` analyzer ships before its overlap with `idle` is resolved, producing confusing duplicate findings | Phase 4 is a hard gate before phase 6 — no `usage` code ships until the scoping note exists |
| `cost-analysis` reintroduces per-request Azure Cost Management calls, recreating the rate-limit problem the scheduled-routine work already solved | Phase 4's investigation must explicitly check whether `costanalysis.go` calls Cost Management live or uses only the static `pricing.go` list-price approach (matching Hetzner's existing pattern per `docs/consolidation-plan.md` §6) — if the former, it must route through the existing scheduled-routine pattern, not a fresh live call path |
| PP location field name assumption is wrong, extraction silently returns empty strings forever | Verify against a live BAP API response during phase 3's implementation, not assumed from documentation alone |
| Region/savings UI components ship before their backing data exists for a given scope, rendering misleadingly as "0" or empty rather than "not available yet" | Explicit empty-state design per component (see Sub-project C table), covered in the testing section above |
