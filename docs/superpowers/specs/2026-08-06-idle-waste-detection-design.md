# Idle & Waste Resource Detection — Design

Date: 2026-08-06
Branch: abd-production

## Context

Earlier this session, investigating yomal's fork (`git remote yomal`, branches
`yomal/main`/`yomal/production`) turned up a `CLI Engine/cmd/` directory
containing real, un-ported functionality: `costanalysis.go` (Azure Cost
Management API), `usage.go` + 9 `usage_<service>.go` per-resource-type
builders, and `idle.go` (idle/wasteful resource detection built on top of the
usage data). None of this exists in the active root `cmd/` package — it was
lost when the repo was restructured (root `cmd/` used to literally live at
`CLI Engine/cmd/`, per an old commit message: "add CLI Engine to repo (was
untracked after restructure)").

The concrete motivation: the dashboard's **Cost & Usage** page
(`web/app/cost/page.tsx`) already has two tabs. "Actual Spend" works today —
it calls the Azure Cost Management Query API directly from a Next.js API
route (`web/app/api/cost/spend/route.ts`), independent of the Go CLI. "Waste
Findings" is built and wired (reads `/api/findings?audit_id=...` and filters
client-side by a `COST_CATEGORIES` set: `Zero Usage`, `Orphaned`, `Stale App`,
`Over-provisioned`, `Unused IP`, etc.) but has nothing to show, because none
of the current 13 Azure analyzers produce those categories. This design ports
the piece that would.

## Goals

- Port `usage.go`, its 9 `usage_<service>.go` builders, and `idle.go` from
  yomal's fork into the active `cmd/` package as a new `analyze idle` command.
- Make its findings land in the same `findings` table as every other
  analyzer, tagged with categories the dashboard's `COST_CATEGORIES` filter
  already recognizes — so "Waste Findings" starts showing real data with no
  frontend changes.
- Run it as part of the standard Azure audit path (`analyze all --scope
  azure`, and the dashboard's normal audit trigger).

## Non-goals

- **`costanalysis.go` is not ported.** It duplicates what
  `web/app/api/cost/spend/route.ts` already does today (Azure Cost Management
  Query API, called directly from Next.js). Porting it to Go would add a
  second code path hitting the same API with no new capability.
- **`collect.go` and `seedadmin.go` are not ported.** They depend on
  `internal/db`, `internal/extractors`, `internal/mailer`, and a Postgres
  driver (`github.com/jackc/pgx/v5/pgxpool`) — none of which exist anywhere in
  this codebase. That's a different, more evolved multi-tenant architecture on
  yomal's side, unrelated to this repo's stateless-CLI-plus-SQLite-via-Next.js
  design.
- **Not built on the Analyzer interface design**
  ([2026-08-06-unified-analyzer-interface-design.md](2026-08-06-unified-analyzer-interface-design.md)).
  That refactor is approved but not yet implemented. `idle` is built matching
  today's existing ad hoc pattern (own `Finding` struct, own `runIdle`,
  standalone JSON/table output) so there's no ordering dependency between the
  two pieces of work — when the interface refactor lands, `idle` becomes
  analyzer #19 in that same pass.
- **The 1-second per-resource rate-limit sleep in yomal's `idle.go` is kept
  as-is, not optimized.** Documented as a known tradeoff below, not solved
  here.
- No changes to `web/lib/btg-runner.ts`'s `extractResource()` or
  `analyze_all.go`'s `resourceFields` heuristic — the new command's output is
  shaped to work with both as they exist today (see "Wiring").
- No new `go.mod` dependencies.

## Design

### 1. Scope: what gets ported

From `yomal/main:"CLI Engine/cmd/"`:

- `usage.go` — the shared waste-scoring engine: `calcWasteScore()`,
  `MeterCost`/`UsageSubResource`/`UsageReport` types, `supportedUsageTypes`
  (8 ARM resource types), `usageTypeAliases`.
- `usage_acr.go`, `usage_appservice.go`, `usage_appserviceplan.go`,
  `usage_cognitiveservices.go`, `usage_cosmosdb.go`, `usage_functions.go`,
  `usage_keyvault.go`, `usage_publicip.go`, `usage_storage.go` — the 9
  per-type report builders. (`appservice` and `functions` both target the ARM
  type `microsoft.web/sites`, differentiated by resource `kind` — that's why
  there are 9 builder files for 8 ARM types.)
- `idle.go` — the `analyze idle` command: discovers resources by type, calls
  the corresponding `usage_<service>.go` builder for each, buckets results by
  `WasteScore`.

During the port, any symbol yomal's copy redefines that already exists in the
active `cmd` package — `Severity` type and its `Critical`/`Warning`/`Info`
constants, `deref()`, `extractResourceGroup()`, `getSubscriptionID()` — is
dropped in favor of the existing definition. They're the same package; a
duplicate definition would fail to compile.

### 2. Output shape: restructuring `idle.go`'s report

Yomal's `idle.go` emits `{idle: [...], high_waste: [...], medium_waste:
[...]}` — three separate arrays keyed by bucket. Every other command in this
repo, and `analyze_all.go`'s `extractFindings()`, expect the `{summary:
{...}, findings: [...]}` shape (e.g. `StorageReport`, `PPEnvReport`).

The port restructures `runIdle` to build one flat finding list instead of
three buckets:

```go
type IdleFinding struct {
    Severity       Severity `json:"severity"`
    Category       string   `json:"category"`
    ResourceName   string   `json:"resource_name"`
    ResourceType   string   `json:"resource_type"`
    ResourceGroup  string   `json:"resource_group"`
    Description    string   `json:"description"`    // from UsageReport.WasteReason
    Recommendation string   `json:"recommendation"`  // from UsageReport.TopRecommendation
}

type IdleSummary struct {
    TotalScanned       int            `json:"total_scanned"`
    IdleCount          int            `json:"idle_count"`
    HighWasteCount     int            `json:"high_waste_count"`
    MediumWasteCount   int            `json:"medium_waste_count"`
    TotalWastedPerMonth float64       `json:"total_wasted_per_month"`
    FindingsBySeverity map[string]int `json:"findings_by_severity"`
}

type IdleReport struct {
    Summary  IdleSummary   `json:"summary"`
    Findings []IdleFinding `json:"findings"`
}
```

`--output table` keeps yomal's original three-section layout (IDLE / HIGH
WASTE / MEDIUM WASTE) for human readability — only the `--output json` shape
and the internal data flow change.

### 3. Severity and category mapping

Each `usage_<service>.go` builder already computes a `Severity` on the
`UsageReport` it returns (based on cost/utilization thresholds specific to
that resource type) — `idle.go` reuses that value directly on `IdleFinding`
rather than re-deriving severity from `WasteScore`.

`Category` has no equivalent in yomal's code (just a freeform `WasteReason`
sentence) and is new, mapping `(WasteScore, ResourceType)` onto categories
`web/app/cost/page.tsx`'s `COST_CATEGORIES` already filters on:

| WasteScore | Resource type | Category |
|---|---|---|
| `IDLE` | `microsoft.network/publicipaddresses` | `Unused IP` |
| `IDLE` | `microsoft.web/serverfarms` (appserviceplan) | `Empty Plan` |
| `IDLE` | any other type | `Zero Usage` |
| `HIGH` | any type | `Over-provisioned` |
| `MEDIUM` | any type | `Over-provisioned` |
| `LOW` / `HEALTHY` | — | no finding produced (matches yomal's `idle.go`, which already excludes these from its report) |

### 4. Wiring into the CLI and dashboard

- No new `go.mod` dependencies — `armresources`, `armmonitor`, `armstorage`,
  `armappservice`, `armkeyvault`, `armcontainerregistry`, `armcosmos`,
  `armcognitiveservices`, `armnetwork` are all already present (used by the
  existing 13 analyzers).
- `IdleFinding.ResourceName` (`json:"resource_name"`) is deliberately named to
  match a field both existing normalization heuristics already check: Go's
  `resourceFields` list in `analyze_all.go`, and TypeScript's
  `extractResource()` in `btg-runner.ts`. No changes needed to either
  heuristic for `idle` findings to flow through `analyze all` and the
  dashboard's audit runner correctly.
- `cmd/analyze_all.go`: add `"idle"` to `allAzureCmds`; add `"idle": "Idle &
  Waste"` to `allServiceLabels`.
- `web/lib/btg-runner.ts`: add `'idle'` to `AZURE_COMMANDS`; add `'idle':
  'Idle & Waste'` to `SERVICE_LABELS`. This is what makes `idle` run as part
  of every dashboard-triggered Azure audit.
- Flags on `analyze idle`, matching yomal's original: `--type` (optional,
  limit to one resource type via `usageTypeAliases`), `--days` (default 30),
  `--subscription-id`, `--output`.

**Known tradeoff, not solved here:** yomal's code sleeps 1 second between
each resource's Azure Monitor metrics call (deliberate rate-limiting). With
`idle` now part of every Azure audit, a subscription with hundreds of
resources across 8 types adds real time to every audit run. Left as-is;
worth revisiting if audit duration becomes a problem in practice.

### 5. Testing

Matching the style of `cmd/pp_test.go` (pure-logic units, no live API calls):

- `calcWasteScore()`'s score/reason output across its cost/utilization
  threshold boundaries (ported along with the function, existing behavior
  preserved).
- The `(WasteScore, ResourceType) → Category` mapping table in section 3 —
  one test per resource type × `{IDLE, HIGH, MEDIUM}`, confirming the
  expected category, plus a test confirming `LOW`/`HEALTHY` produce no
  finding.

No changes needed to any Next.js/dashboard test — `btg-runner.ts` and
`analyze_all.go`'s existing heuristics are unchanged; only their input data
(a new `idle` command's output) is new.
