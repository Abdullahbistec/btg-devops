# Idle & Waste Resource Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `btg-devops analyze idle` command that scans Azure resources for zero-usage/over-provisioned waste, ported from `git remote yomal`'s un-migrated `CLI Engine/cmd/usage.go` + 9 `usage_<service>.go` builders + `idle.go`, writing findings into the same `findings` table every other analyzer uses so the dashboard's already-built "Waste Findings" tab (`web/app/cost/page.tsx`) starts showing real data.

**Architecture:** Port `usage.go` (shared waste-scoring engine) and its 9 per-resource-type builder files verbatim into the `cmd` package (they're mutually dependent and must land together to compile). Port `idle.go` with one real change: restructure its JSON output from yomal's `{idle, high_waste, medium_waste}` triple-array shape into this repo's standard `{summary, findings}` `Report` pattern, introducing a new `idleCategory()` function that maps `(WasteScore, ResourceType)` onto category strings the dashboard already filters on. Wire the new `idle` command into `cmd/analyze_all.go`'s Azure command list and `web/lib/btg-runner.ts`'s `AZURE_COMMANDS`, so it runs as part of every Azure audit.

**Tech Stack:** Go 1.25 (Cobra CLI, Azure SDK for Go), Next.js/TypeScript (dashboard).

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-08-06-idle-waste-detection-design.md` — this plan implements it exactly, with one correction (see below).
- **Spec correction:** the spec states "No new go.mod dependencies." This is wrong — `usage.go`'s `queryCostTrend()` (called from `buildUsageReport()`, which `idle.go` calls for every resource) uses `github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/costmanagement/armcostmanagement`, which is not currently in `go.mod`. Task 1 adds it.
- `IdleFinding`'s resource-identifying field is named `ResourceName` / `json:"resource_name"` — this exact name is required so it flows through the existing Go (`resourceFields` in `cmd/analyze_all.go`) and TypeScript (`extractResource()` in `web/lib/btg-runner.ts`) heuristics with zero changes to either.
- No changes to `web/lib/btg-runner.ts`'s `extractResource()`, `cmd/analyze_all.go`'s `resourceFields`/`extractFindings()`, or any existing command's file.
- Do not port `costanalysis.go`, `collect.go`, or `seedadmin.go` from yomal's fork (out of scope per the design spec's Non-goals).
- Any symbol yomal's ported files redefine that already exists in the active `cmd` package must be dropped in favor of the existing definition, not duplicated. (Verified during design research: none of the 11 files being ported actually redefine `Severity`, `deref()`, `extractResourceGroup()`, or `getSubscriptionID()` — they only use them. No such collisions are expected, but Task 2's build step is the safety net if one is found.)
- Category mapping table (from the design spec, exact):

  | WasteScore | Resource type | Category |
  |---|---|---|
  | `IDLE` | `microsoft.network/publicipaddresses` | `Unused IP` |
  | `IDLE` | `microsoft.web/serverfarms` | `Empty Plan` |
  | `IDLE` | any other type | `Zero Usage` |
  | `HIGH` | any type | `Over-provisioned` |
  | `MEDIUM` | any type | `Over-provisioned` |
  | `LOW` / `HEALTHY` | — | no finding produced |

---

### Task 1: Add the `armcostmanagement` dependency

**Files:**
- Modify: `go.mod`, `go.sum`

**Interfaces:**
- Produces: `github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/costmanagement/armcostmanagement` importable by Task 2's files.

- [ ] **Step 1: Add the dependency**

Run from the repo root:

```bash
go get github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/costmanagement/armcostmanagement
```

This adds the module to `go.mod`'s `require` block and updates `go.sum`. Do not hand-edit either file — let `go get` resolve the version.

- [ ] **Step 2: Verify the existing build still succeeds**

```bash
go build ./...
```

Expected: succeeds with no errors (nothing imports the new package yet, so this just confirms the dependency resolved cleanly).

- [ ] **Step 3: Commit**

```bash
git add go.mod go.sum
git commit -m "chore: add armcostmanagement dependency for idle/waste detection"
```

---

### Task 2: Port `usage.go` and its 9 per-resource-type builders

**Files:**
- Create: `cmd/usage.go`
- Create: `cmd/usage_acr.go`
- Create: `cmd/usage_appservice.go`
- Create: `cmd/usage_appserviceplan.go`
- Create: `cmd/usage_cognitiveservices.go`
- Create: `cmd/usage_cosmosdb.go`
- Create: `cmd/usage_functions.go`
- Create: `cmd/usage_keyvault.go`
- Create: `cmd/usage_publicip.go`
- Create: `cmd/usage_storage.go`

**Interfaces:**
- Consumes: `Severity`/`Critical`/`Warning`/`Info` (existing, defined in `cmd/iam.go`), `deref()`/`extractResourceGroup()` (existing, `cmd/appservice_traffic.go` or wherever currently defined), `getSubscriptionID()`, `flagSubscriptionID`, `flagOutput` (existing package-level vars, `cmd/appservice_traffic.go`), `analyzeCmd` (existing Cobra parent command).
- Produces: types `MeterCost`, `UsageSubResource`, `UsageReport` (with fields `ResourceName`, `ResourceType`, `ResourceGroup`, `Period`, `Days`, `TotalCost`, `Currency`, `Severity`, `Meters`, `SubResources`, `TotalSaving`, `TopRecommendation`, `Utilization map[string]float64`, `WasteScore string`, `WasteReason string`, `PreviousCost`, `CostChangePct`, `CostTrend`); package vars `supportedUsageTypes []string`, `usageTypeAliases map[string]string`; functions `buildUsageReport(ctx, subID, cred, resourceID, name, resourceType, rg string, days int) (*UsageReport, error)` and `buildUtilizationString(util map[string]float64) string`, `calcWasteScore(cost, primaryPct, dailyActivity float64) (score, reason string)`, `costSeverity(cost float64) Severity` — all consumed by Task 3.
- Also produces a standalone `analyze usage` Cobra command (yomal's own resource drill-down feature), included because it ships in the same file as the shared engine — not part of this feature's stated goal, but harmless and not worth stripping out at the risk of missing a transitive dependency.
- Also produces `anyToFloat64(v any) float64`, a small helper `usage.go` calls internally that is not present anywhere in this repo — see Step 2 below. Nothing outside `usage.go` needs it directly.

- [ ] **Step 1: Copy all 10 files verbatim from yomal's fork**

Run from the repo root (requires the `yomal` remote already added — confirm with `git remote -v`; if missing, `git remote add yomal https://github.com/yomal321/btg-devops.git && git fetch yomal`):

```bash
git show yomal/main:"CLI Engine/cmd/usage.go" > cmd/usage.go
git show yomal/main:"CLI Engine/cmd/usage_acr.go" > cmd/usage_acr.go
git show yomal/main:"CLI Engine/cmd/usage_appservice.go" > cmd/usage_appservice.go
git show yomal/main:"CLI Engine/cmd/usage_appserviceplan.go" > cmd/usage_appserviceplan.go
git show yomal/main:"CLI Engine/cmd/usage_cognitiveservices.go" > cmd/usage_cognitiveservices.go
git show yomal/main:"CLI Engine/cmd/usage_cosmosdb.go" > cmd/usage_cosmosdb.go
git show yomal/main:"CLI Engine/cmd/usage_functions.go" > cmd/usage_functions.go
git show yomal/main:"CLI Engine/cmd/usage_keyvault.go" > cmd/usage_keyvault.go
git show yomal/main:"CLI Engine/cmd/usage_publicip.go" > cmd/usage_publicip.go
git show yomal/main:"CLI Engine/cmd/usage_storage.go" > cmd/usage_storage.go
```

- [ ] **Step 2: Add the one small helper `usage.go` borrows from `costanalysis.go`**

`usage.go` calls `anyToFloat64(v any) float64` (line ~563), which is defined in
yomal's `CLI Engine/cmd/costanalysis.go` — a file this plan deliberately does
not port (it duplicates the dashboard's already-working `SpendView`, per the
design spec's Non-goals). `anyToFloat64` itself is a small, generic,
self-contained type-converter with no other dependency on anything
cost-management-specific, so it is ported on its own rather than pulling in
the file it happens to live in. Add this function to the bottom of
`cmd/usage.go` (verified as the only such missing dependency — see below):

```go
func anyToFloat64(v any) float64 {
	switch val := v.(type) {
	case float64:
		return val
	case float32:
		return float64(val)
	case int:
		return float64(val)
	case int64:
		return float64(val)
	case int32:
		return float64(val)
	default:
		var f float64
		_, _ = fmt.Sscanf(fmt.Sprintf("%v", val), "%f", &f)
		return f
	}
}
```

`cmd/usage.go`'s existing import block already includes `"fmt"` — no import
changes needed.

- [ ] **Step 3: Build and vet**

```bash
go build ./...
go vet ./...
```

Expected: both succeed with no errors. This was verified end-to-end during
plan revision — Step 2's addition is the complete fix, no further missing
symbols. If `go build` reports a "redeclared" error for any symbol, that
means research missed a collision — delete the duplicate definition from the
newly-copied file (not from the pre-existing file) and re-run. If it reports
`undefined: <something>` for any symbol other than `anyToFloat64`, stop and
report BLOCKED rather than guessing — that would mean a second gap this plan
revision did not catch.

If `go vet` or `go build` complains about an unused import or a symbol only
referenced by `cmd/idle.go` (not yet ported — that's Task 3), that's expected
and will resolve once Task 3 lands; do not modify these files to work around
it. (In practice this shouldn't happen — these 10 files don't reference
anything from `idle.go`.)

- [ ] **Step 4: Run the existing test suite to confirm nothing broke**

```bash
go test ./...
```

Expected: all existing tests still pass (this task adds no tests of its own — `calcWasteScore` gets tests in Task 4).

- [ ] **Step 5: Commit**

```bash
git add cmd/usage.go cmd/usage_acr.go cmd/usage_appservice.go cmd/usage_appserviceplan.go cmd/usage_cognitiveservices.go cmd/usage_cosmosdb.go cmd/usage_functions.go cmd/usage_keyvault.go cmd/usage_publicip.go cmd/usage_storage.go
git commit -m "feat: port usage/waste-scoring engine from yomal's CLI Engine

Adds the shared UsageReport engine and its 9 per-resource-type
builders (cosmosdb, storage, appserviceplan, keyvault, acr,
appservice, functions, publicip, cognitiveservices), plus the
standalone 'analyze usage' drill-down command. Ported from
yomal/main:\"CLI Engine/cmd/\" per docs/superpowers/specs/2026-08-06-idle-waste-detection-design.md."
```

---

### Task 3: Port `idle.go` with the restructured findings output

**Files:**
- Create: `cmd/idle.go`

**Interfaces:**
- Consumes: everything Task 2 produces (`UsageReport`, `supportedUsageTypes`, `usageTypeAliases`, `buildUsageReport()`, `buildUtilizationString()`), plus existing `deref()`, `extractResourceGroup()`, `getSubscriptionID()`, `flagSubscriptionID`, `flagOutput`, `analyzeCmd`, `Severity`.
- Produces: `IdleFinding` struct, `IdleSummary` struct, `IdleReport` struct, `idleCategory(wasteScore, resourceType string) string` function — consumed by Task 4's tests. The `analyze idle` Cobra command itself is consumed by Task 5 (`allAzureCmds`) and Task 6 (`AZURE_COMMANDS`), which reference it only by the string `"idle"`, not by any Go symbol.

- [ ] **Step 1: Copy `idle.go` verbatim as a starting point**

```bash
git show yomal/main:"CLI Engine/cmd/idle.go" > cmd/idle.go
```

- [ ] **Step 2: Write the failing test for the new category-mapping function**

Create `cmd/idle_test.go`:

```go
package cmd

import "testing"

func TestIdleCategory_PublicIPIdle(t *testing.T) {
	got := idleCategory("IDLE", "microsoft.network/publicipaddresses")
	if got != "Unused IP" {
		t.Errorf("got %q, want %q", got, "Unused IP")
	}
}

func TestIdleCategory_AppServicePlanIdle(t *testing.T) {
	got := idleCategory("IDLE", "microsoft.web/serverfarms")
	if got != "Empty Plan" {
		t.Errorf("got %q, want %q", got, "Empty Plan")
	}
}

func TestIdleCategory_OtherTypeIdle(t *testing.T) {
	cases := []string{
		"microsoft.documentdb/databaseaccounts",
		"microsoft.storage/storageaccounts",
		"microsoft.keyvault/vaults",
		"microsoft.containerregistry/registries",
		"microsoft.web/sites",
		"microsoft.cognitiveservices/accounts",
	}
	for _, rtype := range cases {
		if got := idleCategory("IDLE", rtype); got != "Zero Usage" {
			t.Errorf("idleCategory(IDLE, %q) = %q, want %q", rtype, got, "Zero Usage")
		}
	}
}

func TestIdleCategory_HighWaste(t *testing.T) {
	if got := idleCategory("HIGH", "microsoft.storage/storageaccounts"); got != "Over-provisioned" {
		t.Errorf("got %q, want %q", got, "Over-provisioned")
	}
}

func TestIdleCategory_MediumWaste(t *testing.T) {
	if got := idleCategory("MEDIUM", "microsoft.web/sites"); got != "Over-provisioned" {
		t.Errorf("got %q, want %q", got, "Over-provisioned")
	}
}

func TestIdleCategory_LowAndHealthyProduceNoFinding(t *testing.T) {
	for _, score := range []string{"LOW", "HEALTHY"} {
		if got := idleCategory(score, "microsoft.storage/storageaccounts"); got != "" {
			t.Errorf("idleCategory(%q, ...) = %q, want empty string", score, got)
		}
	}
}
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
go test ./cmd/ -run TestIdleCategory -v
```

Expected: FAIL — `undefined: idleCategory` (the function doesn't exist yet).

- [ ] **Step 4: Add the new types and `idleCategory()` function**

In `cmd/idle.go`, add after the existing `idleEntry` type definition (keep `idleEntry` — it's still used internally to build the table view):

```go
type IdleFinding struct {
	Severity       Severity `json:"severity"`
	Category       string   `json:"category"`
	ResourceName   string   `json:"resource_name"`
	ResourceType   string   `json:"resource_type"`
	ResourceGroup  string   `json:"resource_group"`
	Description    string   `json:"description"`
	Recommendation string   `json:"recommendation"`
}

type IdleSummary struct {
	TotalScanned        int            `json:"total_scanned"`
	IdleCount           int            `json:"idle_count"`
	HighWasteCount      int            `json:"high_waste_count"`
	MediumWasteCount    int            `json:"medium_waste_count"`
	TotalWastedPerMonth float64        `json:"total_wasted_per_month"`
	FindingsBySeverity  map[string]int `json:"findings_by_severity"`
}

type IdleReport struct {
	Summary  IdleSummary   `json:"summary"`
	Findings []IdleFinding `json:"findings"`
}

// idleCategory maps a WasteScore + ARM resource type onto the dashboard's
// COST_CATEGORIES taxonomy (web/app/cost/page.tsx). LOW and HEALTHY return ""
// — callers must skip creating a finding when this returns "".
func idleCategory(wasteScore, resourceType string) string {
	switch wasteScore {
	case "IDLE":
		switch resourceType {
		case "microsoft.network/publicipaddresses":
			return "Unused IP"
		case "microsoft.web/serverfarms":
			return "Empty Plan"
		default:
			return "Zero Usage"
		}
	case "HIGH", "MEDIUM":
		return "Over-provisioned"
	default:
		return ""
	}
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
go test ./cmd/ -run TestIdleCategory -v
```

Expected: PASS for all 6 test functions.

- [ ] **Step 6: Restructure `runIdle` to build the flat findings list alongside the existing table buckets**

Replace the analysis loop and everything after it in `runIdle` (from `// Analyze each resource` through the end of the function) with:

```go
	// Analyze each resource
	var idleResources []idleEntry
	var highWasteResources []idleEntry
	var mediumWasteResources []idleEntry
	var findings []IdleFinding

	for i, res := range resources {
		if i > 0 {
			time.Sleep(time.Second)
		}
		fmt.Fprintf(os.Stderr, "[%d/%d] Checking %s...\n", i+1, total, res.name)

		report, err := buildUsageReport(ctx, subID, cred, res.id, res.name, res.resourceType, res.rg, flagIdleDays)
		if err != nil {
			fmt.Fprintf(os.Stderr, "  skipped: %v\n", err)
			continue
		}

		switch report.WasteScore {
		case "IDLE":
			idleResources = append(idleResources, idleEntry{report: report, scoreRank: 0})
		case "HIGH":
			highWasteResources = append(highWasteResources, idleEntry{report: report, scoreRank: 1})
		case "MEDIUM":
			mediumWasteResources = append(mediumWasteResources, idleEntry{report: report, scoreRank: 2})
		}

		if category := idleCategory(report.WasteScore, res.resourceType); category != "" {
			findings = append(findings, IdleFinding{
				Severity:       report.Severity,
				Category:       category,
				ResourceName:   report.ResourceName,
				ResourceType:   report.ResourceType,
				ResourceGroup:  report.ResourceGroup,
				Description:    report.WasteReason,
				Recommendation: report.TopRecommendation,
			})
		}
	}

	if flagOutput == "json" {
		summary := IdleSummary{
			TotalScanned:       total,
			IdleCount:          len(idleResources),
			HighWasteCount:     len(highWasteResources),
			MediumWasteCount:   len(mediumWasteResources),
			FindingsBySeverity: map[string]int{},
		}
		for _, e := range idleResources {
			summary.TotalWastedPerMonth += e.report.TotalCost
		}
		for _, e := range highWasteResources {
			summary.TotalWastedPerMonth += e.report.TotalCost
		}
		for _, e := range mediumWasteResources {
			summary.TotalWastedPerMonth += e.report.TotalCost
		}
		for _, f := range findings {
			summary.FindingsBySeverity[string(f.Severity)]++
		}

		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(IdleReport{Summary: summary, Findings: findings})
	}

	return printIdleReport(idleResources, highWasteResources, mediumWasteResources, total, flagIdleDays)
```

- [ ] **Step 7: Delete the now-unused `outputIdleJSON` function**

Remove the entire `outputIdleJSON` function (the `// ---------- json output ----------` section) from `cmd/idle.go` — its `{idle, high_waste, medium_waste}` shape is replaced by the `IdleReport` encoding inlined in Step 6. Leave `printIdleReport` (the `// ---------- table output ----------` section) untouched — the table view keeps its original three-section layout.

- [ ] **Step 8: Build and test**

```bash
go build ./...
go vet ./...
go test ./...
```

Expected: all succeed. If `go build` reports `"encoding/json" imported and not used` or similar, check that `idle.go`'s import block still includes `encoding/json` (it does — `outputIdleJSON` used it too, and Step 6's inlined encoding still needs it).

- [ ] **Step 9: Manual smoke check of the command surface**

```bash
go run . analyze idle --help
```

Expected: shows `--type`, `--days`, `--subscription-id`, `--output` flags with the descriptions from `cmd/idle.go`'s `init()`. (Running it against a real subscription requires Azure credentials not available in this environment — that verification happens once the user has credentials configured, not as part of this task.)

- [ ] **Step 10: Commit**

```bash
git add cmd/idle.go cmd/idle_test.go
git commit -m "feat: add analyze idle command with findings-table-compatible output

Ports idle.go from yomal's CLI Engine, restructuring its JSON output
from a {idle, high_waste, medium_waste} triple-array into this repo's
standard {summary, findings} shape via a new idleCategory() mapping
onto the dashboard's existing COST_CATEGORIES taxonomy."
```

---

### Task 4: Add tests for `calcWasteScore` (ported in Task 2)

**Files:**
- Create: `cmd/usage_test.go`

**Interfaces:**
- Consumes: `calcWasteScore(cost, primaryPct, dailyActivity float64) (score, reason string)` (from Task 2).

- [ ] **Step 1: Write the tests**

Create `cmd/usage_test.go`:

```go
package cmd

import "testing"

func TestCalcWasteScore_ZeroCost(t *testing.T) {
	score, _ := calcWasteScore(0, -1, -1)
	if score != "IDLE" {
		t.Errorf("got %q, want IDLE", score)
	}
}

func TestCalcWasteScore_ZeroUtilizationAndActivity(t *testing.T) {
	score, _ := calcWasteScore(15, 0, 0)
	if score != "IDLE" {
		t.Errorf("got %q, want IDLE", score)
	}
}

func TestCalcWasteScore_PercentBased_High(t *testing.T) {
	score, _ := calcWasteScore(50, 3, -1)
	if score != "HIGH" {
		t.Errorf("got %q, want HIGH (primaryPct=3 < 5, cost=50 > 10)", score)
	}
}

func TestCalcWasteScore_PercentBased_Medium(t *testing.T) {
	score, _ := calcWasteScore(50, 8, -1)
	if score != "MEDIUM" {
		t.Errorf("got %q, want MEDIUM (primaryPct=8 < 10, cost=50 > 10)", score)
	}
}

func TestCalcWasteScore_PercentBased_Low(t *testing.T) {
	score, _ := calcWasteScore(50, 20, -1)
	if score != "LOW" {
		t.Errorf("got %q, want LOW (primaryPct=20 < 35, cost=50 > 10)", score)
	}
}

func TestCalcWasteScore_PercentBased_Healthy(t *testing.T) {
	score, _ := calcWasteScore(50, 80, -1)
	if score != "HEALTHY" {
		t.Errorf("got %q, want HEALTHY (primaryPct=80 >= 70)", score)
	}
}

func TestCalcWasteScore_CountBased_IdleZeroActivity(t *testing.T) {
	score, _ := calcWasteScore(5, -1, 0)
	if score != "IDLE" {
		t.Errorf("got %q, want IDLE (dailyActivity=0, cost>0)", score)
	}
}

func TestCalcWasteScore_CountBased_High(t *testing.T) {
	score, _ := calcWasteScore(25, -1, 5)
	if score != "HIGH" {
		t.Errorf("got %q, want HIGH (dailyActivity=5 < 10, cost=25 > 20)", score)
	}
}

func TestCalcWasteScore_CountBased_Medium(t *testing.T) {
	score, _ := calcWasteScore(60, -1, 50)
	if score != "MEDIUM" {
		t.Errorf("got %q, want MEDIUM (dailyActivity=50 < 100, cost=60 > 50)", score)
	}
}

func TestCalcWasteScore_CountBased_Healthy(t *testing.T) {
	score, _ := calcWasteScore(60, -1, 500)
	if score != "HEALTHY" {
		t.Errorf("got %q, want HEALTHY (dailyActivity=500, well above thresholds)", score)
	}
}
```

- [ ] **Step 2: Run the tests to verify they pass**

```bash
go test ./cmd/ -run TestCalcWasteScore -v
```

Expected: PASS for all 9 test functions. (These test already-ported, unmodified behavior — this step confirms the port preserved it correctly, rather than driving new implementation.)

- [ ] **Step 3: Commit**

```bash
git add cmd/usage_test.go
git commit -m "test: add coverage for ported calcWasteScore thresholds"
```

---

### Task 5: Wire `idle` into `analyze all`

**Files:**
- Modify: `cmd/analyze_all.go`

**Interfaces:**
- Consumes: the `"idle"` command name (string only — no Go symbol dependency on `cmd/idle.go`).

- [ ] **Step 1: Add `idle` to the Azure command list and service label map**

In `cmd/analyze_all.go`, modify the `allServiceLabels` map:

```go
var allServiceLabels = map[string]string{
	"appservice-traffic": "App Service",
	"storage":            "Storage",
	"nsg":                "NSG",
	"acr":                "ACR",
	"cosmosdb":           "Cosmos DB",
	"keyvault":           "Key Vault",
	"functions":          "Functions",
	"publicip":           "Public IP",
	"appserviceplan":     "App Service Plan",
	"cognitiveservices":  "Cognitive Services",
	"resourcegroup":      "Resource Groups",
	"iam":                "IAM",
	"sp-expiry":          "SP Expiry",
	"idle":               "Idle & Waste",
	"powerplatform":      "Power Platform",
	"pp-environments":    "PP Environments",
	"pp-apps":            "PP Apps",
	"pp-flows":           "PP Flows",
	"pp-powerbi":         "Power BI",
}

var allAzureCmds = []string{
	"appservice-traffic", "storage", "nsg", "acr", "cosmosdb",
	"keyvault", "functions", "publicip", "appserviceplan",
	"cognitiveservices", "resourcegroup", "iam", "sp-expiry", "idle",
}
```

- [ ] **Step 2: Update the now-stale scope description and verify**

`analyzeAllCmd`'s `Long` field describes the `azure` scope as "12 + sp-expiry" commands — now stale (13 + idle = 14 total). In `cmd/analyze_all.go`, change:

```go
	Long: `Runs every analyzer in sequence and merges findings into a single report.

Scope flags:
  --scope azure    Azure analyzers only (12 + sp-expiry)
  --scope pp       Power Platform analyzers only (5 commands)
  --scope all      Everything (default)
```

to:

```go
	Long: `Runs every analyzer in sequence and merges findings into a single report.

Scope flags:
  --scope azure    Azure analyzers only (13 + sp-expiry + idle)
  --scope pp       Power Platform analyzers only (5 commands)
  --scope all      Everything (default)
```

Then build and check the help output:

```bash
go build ./...
go run . analyze all --help
```

Expected: builds cleanly; `--help` shows the updated scope description.

- [ ] **Step 3: Run the existing test suite**

```bash
go test ./...
```

Expected: all existing tests pass (no test currently asserts the exact contents of `allAzureCmds`, so none should break; if one does, update its expected list to include `"idle"`).

- [ ] **Step 4: Commit**

```bash
git add cmd/analyze_all.go
git commit -m "feat: include idle in analyze all's Azure scope"
```

---

### Task 6: Wire `idle` into the dashboard's audit runner

**Files:**
- Modify: `web/lib/btg-runner.ts`

**Interfaces:**
- Consumes: the `"idle"` command name (string only).

- [ ] **Step 1: Add `idle` to `AZURE_COMMANDS` and `SERVICE_LABELS`**

In `web/lib/btg-runner.ts`, modify:

```typescript
export const AZURE_COMMANDS = [
  'appservice-traffic',
  'storage',
  'nsg',
  'acr',
  'cosmosdb',
  'keyvault',
  'functions',
  'publicip',
  'appserviceplan',
  'cognitiveservices',
  'resourcegroup',
  'iam',
  'sp-expiry',
  'idle',
] as const;
```

and:

```typescript
const SERVICE_LABELS: Record<string, string> = {
  'appservice-traffic': 'App Service',
  'storage': 'Storage',
  'nsg': 'NSG',
  'acr': 'ACR',
  'cosmosdb': 'Cosmos DB',
  'keyvault': 'Key Vault',
  'functions': 'Functions',
  'publicip': 'Public IPs',
  'appserviceplan': 'App Service Plan',
  'cognitiveservices': 'Cognitive Services',
  'resourcegroup': 'Resource Groups',
  'iam': 'IAM',
  'sp-expiry': 'SP Expiry',
  'idle': 'Idle & Waste',
  'powerplatform': 'Power Platform',
  'pp-environments': 'PP Environments',
  'pp-apps': 'PP Apps',
  'pp-flows': 'PP Flows',
  'pp-powerbi': 'Power BI',
};
```

- [ ] **Step 2: Confirm `extractResource()` already handles the new finding shape**

Open `web/lib/btg-runner.ts` and check the `RawFinding` interface and `extractResource()` function (documented in the design spec as needing zero changes because `IdleFinding`'s JSON field is `resource_name`, which `RawFinding.resource_name` and `extractResource()`'s check `raw.resource_name` already cover). Confirm this by reading the current file — do not edit `extractResource()` or `RawFinding`. If for any reason `resource_name` is not present in that function today, stop and report back rather than editing it as a side effect of this task.

- [ ] **Step 3: Run the existing test suite**

```bash
cd web
npm test
```

Expected: `btg-runner.test.ts` passes unchanged (no test currently pins the exact contents of `AZURE_COMMANDS`/`SERVICE_LABELS`; if one does, update its expectations to include `idle`).

- [ ] **Step 4: Type-check**

```bash
cd web
npx tsc --noEmit
```

Expected: no new type errors.

- [ ] **Step 5: Commit**

```bash
cd web
git add lib/btg-runner.ts
git commit -m "feat: run idle detection as part of every Azure dashboard audit"
```

---

### Task 7: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Full Go build, vet, and test**

```bash
go build ./...
go vet ./...
go test ./... -v
```

Expected: all succeed, including the new `TestIdleCategory_*` (Task 3) and `TestCalcWasteScore_*` (Task 4) tests alongside every pre-existing test.

- [ ] **Step 2: Full web build/type-check**

```bash
cd web
npx tsc --noEmit
npm test
```

Expected: no errors.

- [ ] **Step 3: Confirm the CLI command surface**

```bash
go run . analyze idle --help
go run . analyze all --help
```

Expected: `analyze idle` shows its 4 flags; `analyze all --help`'s scope description is either updated (if you took the optional Task 5 Step 2 polish) or still says "12 + sp-expiry" (acceptable, cosmetic only).

- [ ] **Step 4: Note remaining manual verification for the user**

This environment has no live Azure credentials, so the following cannot be verified by an automated task and should be checked by the user once they run this against a real subscription:
- `btg-devops analyze idle --output json` produces the `IdleReport` shape and populates the `findings` table via the normal audit pipeline.
- The dashboard's Cost & Usage → "Waste Findings" tab shows real `Zero Usage`/`Unused IP`/`Empty Plan`/`Over-provisioned` findings after running an Azure audit.

Report this to the user as the final step of implementation — do not claim end-to-end success without it having been checked against a real subscription.
