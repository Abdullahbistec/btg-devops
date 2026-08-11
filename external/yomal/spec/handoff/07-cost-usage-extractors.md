# Spec 7 — Cost & Usage Extractors (CLI) + Dashboard Integration

> Scope: this spec touches the **Go CLI** (`CLI Engine/`), not just the dashboard. Read fully
> before writing any code — it explains why the existing `analyze cost` / `analyze usage`
> commands are **not** reused as-is.

## Why not reuse the existing commands

`CLI Engine/cmd/costanalysis.go` and `CLI Engine/cmd/usage.go` already exist and already call
Azure Cost Management + Azure Monitor. Both have the same architectural problem: **they compute
interpretive judgments in Go instead of extracting raw data for Claude to interpret** — which is
exactly the anti-pattern `spec/mainflow.md` already rejected for the other 12 resource types
("Claude decides what matters... because that would make Claude a checklist checker instead of
an investigator").

Concrete problems found by reading the code:

| File | Problem |
|---|---|
| `costanalysis.go` | No `Granularity` set on the Cost Management query → one lump total for the whole window, not a real time series. `ExportTypeActualCost` only (no amortized cost) — Reservation/Savings Plan purchases spike on the purchase date instead of spreading across usage. `report.Currency = "USD"` hardcoded before any row is parsed — silently wrong for non-USD subscriptions. Zero-cost rows dropped; negative rows (credits/refunds) netted into totals with no labeling. No pagination (`NextLink`) handling. Zero tests. |
| `usage.go` | Same underlying `queryMeterCostsBetween` cost-query pattern (same granularity/currency/pagination issues). On top of that, `calcWasteScore()` hardcodes business judgments as Go thresholds: `primaryPct < 5 && cost > 10 → "HIGH" / "severely over-provisioned"`, `dailyActivity < 10 && cost > 20 → "HIGH"`, etc. These thresholds are arbitrary, not configurable, untested, and — critically — **they're exactly the kind of judgment call the project already decided belongs to Claude, not hardcoded Go.** It also runs one Cost Management query **per resource sequentially** with a hardcoded `time.Sleep(time.Second)` between each — for a subscription with 50 resources that's 50+ seconds just for cost, before Monitor calls. |

**Decision: leave both files in place as legacy standalone terminal commands** (same treatment
`mainflow.md` already gives `analyze [module]`), and build two **new** extractors under
`internal/extractors/` that follow the same raw-extract-only pattern as the other 12.

---

## What to reuse vs. not reuse from the existing code

| Reuse (mechanically solid) | Don't reuse (interpretive / inaccurate) |
|---|---|
| `armmonitor.NewMetricsClient` call pattern — per-metric aggregation typing (`Count`/`Total`/`Average` mapped to the correct datapoint field) | `calcWasteScore()` and all "tip" / `MonthlySaving` heuristics |
| 429 retry-with-backoff pattern from `queryMeterCostsBetween` | Hardcoded `costSeverity()` thresholds ($200/$50) |
| The list of 8 resource types with meaningful runtime metrics (cosmosdb, storage, appserviceplan, keyvault, acr, appservice/functions, publicip, cognitiveservices) — same set, used to decide which resources get a Usage entry | Per-resource-type "sub-resource" breakdown logic (e.g. `runCosmosDBUsage`) — too bespoke, encodes judgment about what matters |
| `armcostmanagement.NewQueryClient` construction | The one-lump-sum, no-`Granularity`, hardcoded-currency query shape |

---

## New Cost Extractor — `internal/extractors/cost.go`

Signature matches every other extractor: `ExtractCost(ctx context.Context, subID string, cred azcore.TokenCredential) (*CostData, error)`.

**One subscription-scope query, not per-resource.** This is both more accurate and far faster
than `usage.go`'s per-resource sequential loop:

```go
query := armcostmanagement.QueryDefinition{
    Type:      ExportTypeActualCost,       // keep raw; do NOT also silently drop AmortizedCost —
                                            // see "amortized cost" note below
    Timeframe: TimeframeTypeCustom,
    TimePeriod: { From: <audit window start>, To: <audit window end> },
    Dataset: {
        Granularity: GranularityTypeDaily,          // ← the fix: real per-day rows
        Aggregation: { "totalCost": { Name: "Cost", Function: Sum } },
        Grouping: [
            { Type: Dimension, Name: "ResourceId" },
            { Type: Dimension, Name: "ServiceName" },
        ],
        // no Filter — pull the whole subscription in one query
    },
}
```

Scope: `/subscriptions/{subID}` (same as existing code — no management-group support needed yet).

**Amortized cost**: query `ExportTypeAmortizedCost` as a **second** call and keep both raw
result sets under separate keys (`actual_cost_rows`, `amortized_cost_rows`) rather than picking
one — let Claude explain the difference when it matters (e.g. "this spike is a Reservation
purchase, not a usage increase" is something Claude can say if it sees both series; Go cannot
decide this correctly without re-implementing amortization logic itself).

**Fixes applied vs. the legacy code:**
- Explicit `GranularityTypeDaily` → real day-by-day rows, not one aggregate.
- **No currency fallback.** Read whatever `Currency` column the API returns per row, raw. If a
  row has no currency column, leave it `null` in the cleaned JSON — do not assume USD. Let
  Claude flag "currency unknown for N rows" if that happens; don't silently misrepresent it.
- **Keep every row**, including zero-cost and negative (credit/refund) rows. Do not filter
  anything — that's a business judgment call, not a cleaning decision. (Contrast with the
  4-field noise strip in `cleaner.go` — `etag`/`systemData`/`type`/`id` are genuinely never
  meaningful; a $0 or negative cost row is real billing data.)
- **Follow `NextLink` pagination** if `QueryClientUsageResponse` exposes one — check the SDK
  version already vendored (`armcostmanagement v1.1.1`, confirmed in `go.mod`, no new dependency
  needed) for the actual pagination shape before assuming a single page is always enough.
- Retry-with-backoff on 429, same pattern as `queryMeterCostsBetween`.

**Output shape** (`CostData` struct, mirrors the other extractors' `TotalX` + raw-items shape):
```go
type CostData struct {
    TotalRows        int               `json:"total_rows"`
    Currency         string            `json:"currency,omitempty"` // only set if uniform across all rows; omit if mixed/unknown
    Period           struct{ From, To string } `json:"period"`
    ActualCostRows   []json.RawMessage `json:"actual_cost_rows"`
    AmortizedCostRows []json.RawMessage `json:"amortized_cost_rows"`
}
```
Each row is the raw Cost Management API row shape (ResourceId, ServiceName, Cost, Currency,
UsageDate) passed through `CleanResource` for consistency — there isn't much noise to strip here
since these aren't SDK resource structs, but run it through the same cleaner for a uniform
pattern across all extractors.

---

## New Usage Extractor — `internal/extractors/usage.go`

Signature: `ExtractUsage(ctx context.Context, subID string, cred azcore.TokenCredential, resourceIDs map[string][]string) (*UsageData, error)`
— takes the resource IDs already collected by the other 12 extractors this run (keyed by
type, e.g. `"cosmosdb": [...]`) so it doesn't need its own resource-listing pass.

For each resource ID belonging to one of the 8 types with meaningful runtime metrics (same list
as `usageTypeAliases` in `usage.go`), call `armmonitor.NewMetricsClient(subID, cred, nil)` with
the metric names appropriate to that resource type:

| Resource type | Metric names to pull |
|---|---|
| cosmosdb | `TotalRequestUnits`, `NormalizedRUConsumption` |
| storage | `UsedCapacity`, `Transactions` |
| appserviceplan / appservice / functions | `CpuPercentage`, `MemoryPercentage`, `Requests` |
| keyvault | `ServiceApiHit` |
| acr | `TotalPullCount`, `TotalPushCount` |
| publicip | `BytesInDDoS`, `PacketsInDDoS` (or whatever the resource actually exposes) |
| cognitiveservices | `TotalCalls`, `TotalErrors` |

**Do not compute a waste score, a "tip" string, or a dollar-savings estimate in Go.** Return the
raw datapoints (or day-averaged values, consistent with `queryResourceMetrics`'s existing
Count/Total/Average handling — that logic is fine to reuse since it's just correct unit
conversion, not a judgment call) per resource, per metric. Claude sees this alongside the Cost
extractor's per-resource cost rows in the same `raw_data` blob and draws the "5% RU utilization
at $340/month" conclusion itself, the same way it already draws conclusions about NSG rules or
storage encryption settings — no new interpretation code needed on the Go side.

**Output shape:**
```go
type UsageData struct {
    TotalResourcesSampled int               `json:"total_resources_sampled"`
    Period                struct{ From, To string } `json:"period"`
    Metrics               []json.RawMessage `json:"metrics"` // one entry per {resource_id, metric_name, values[]}
}
```

**Rate limits**: keep the existing 429 retry/backoff pattern. Since this iterates one Monitor
call per resource (Monitor doesn't support a bulk subscription-wide metrics query the way Cost
Management does), keep a small delay between calls if needed, but there's no reason to serialize
strictly — a bounded worker pool (e.g. 5 concurrent) is fine and much faster than the existing
one-second-sleep-per-resource loop.

---

## Wiring into the collect pipeline

`cmd/collect.go`'s `collectForSubscription` already assembles `rawData := map[string]any{...}`
with one key per extractor. Add two more entries to the extractor slice:

```go
{key: "cost",  run: func() (any, error) { return extractors.ExtractCost(ctx, subID, cred) }},
{key: "usage", run: func() (any, error) { return extractors.ExtractUsage(ctx, subID, cred, collectedResourceIDs) }},
```

`usage` must run **after** the 12 resource extractors (needs their resource IDs) — collect.go
already runs extractors sequentially in a slice, so just place these two entries last and thread
through a `collectedResourceIDs map[string][]string` built while iterating the other 12 results.

`resourceCounts` (used by `countResources()` for the dashboard's per-audit tiles) should **not**
gain `cost`/`usage` entries — those aren't "resource counts", they're cost/metric data. Leave the
existing 12-key `resource_counts` shape alone; cost/usage live only in `raw_data`.

---

## Azure RBAC changes

Update `README.md` / `CONTRIBUTING.md`'s permissions list. The service principal currently needs
plain **Reader**; add:
- **Cost Management Reader** (for the Cost extractor — confirmed required by the existing
  `costanalysis.go`/`usage.go` error messages)
- **Monitoring Reader** (for the Usage extractor's `armmonitor.MetricsClient` calls)

No new Go dependencies — `armcostmanagement v1.1.1` and `armmonitor v0.11.0` are already in
`go.mod` (currently only used by the legacy standalone commands).

---

## Dashboard integration

No new dashboard architecture needed. `cost` and `usage` become two more entries in the
resource-type scope selector already built in `AnalysisPanel` (`app/components/AnalysisPanel.tsx`)
— they show up in the `resourceTypes` dropdown exactly like `storage`, `nsg`, etc., since that
dropdown is already driven by `Object.keys(resourceCounts)`... **except** cost/usage won't be in
`resource_counts` (see above), so the dropdown needs a small addition: always include `cost` and
`usage` as scope options if `raw_data.cost` / `raw_data.usage` exist, independent of
`resourceCounts`. Everything else — the per-scope caching in `claude_analysis.by_resource`, the
"Analyze" button, the findings display — works unchanged, since Claude just receives
`raw_data.cost` or `raw_data.usage` as the payload for that scope, same as any other resource
type.

**Definition of done:**
- `btg-devops collect` saves `raw_data.cost` and `raw_data.usage` for every completed audit.
- Cost data is per-day, per-resource, with real (not hardcoded) currency, including zero/negative
  rows.
- Usage data is raw per-resource metric values, with zero waste-score/tip logic in Go.
- Dashboard's Analyze scope dropdown includes "cost" and "usage" and can run Claude analysis on
  either, producing findings the same way as any of the 12 resource types.
- Legacy `analyze cost` / `analyze usage` terminal commands are untouched and still work
  standalone.

---

## Explicitly out of scope for this spec

- Rewriting or removing `costanalysis.go` / `usage.go` — they stay as legacy terminal tools.
- Amortization math, waste scoring, or savings estimates in Go — that's Claude's job now.
- Management-group or multi-subscription cost scopes — subscription-scope only, matching the
  rest of the pipeline.
