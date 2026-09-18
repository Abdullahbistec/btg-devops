# Hetzner Cost Estimate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Price every Hetzner resource from the live Hetzner pricing API, surface a monthly run-rate as its own provider view in Actual Spend, and give the Claude analysis agent a cost signal it currently lacks.

**Architecture:** The Go CLI gains a pricing client that fetches `/v1/pricing` once per run and prices servers, volumes, and primary IPs by type and location. A new `analyze hetzner-cost` command emits a run-rate report, which the dashboard stores as snapshots (mirroring the Azure `cost_snapshots` pattern) and reads back without ever calling Hetzner on page load. Azure and Hetzner figures are never summed — Azure is billed actuals, Hetzner is a list-price estimate.

**Tech Stack:** Go 1.26 + Cobra (CLI), Next.js 14 App Router + TypeScript (web), PostgreSQL, vitest (web tests), `go test` (CLI tests).

**Spec:** `docs/superpowers/specs/2026-09-12-hetzner-cost-estimate-design.md`

## Global Constraints

- **Use `gross` prices, never `net`.** They are equal while `vat_rate` is 0, and `gross` stays correct if it ever isn't.
- **Currency always comes from the API payload** (`pricing.currency`). Never hardcode a currency or a symbol. This account returns `USD`.
- **Every run-rate figure is labelled a list-price estimate, not an invoice.** The hcloud API has no billing endpoint.
- **Never sum Azure and Hetzner into one number.** They mean different things.
- Hetzner auth is the existing read-only `HCLOUD_TOKEN`. No new permission is required.
- Follow existing file patterns: analyzers are `cmd/hetzner_*.go` registered via `analyzeCmd.AddCommand` in `init()`; pure `hetznerXxxFindings(...)` functions are tested against in-memory fixtures with no network.

---

### Task 1: Hetzner pricing client

**Files:**
- Create: `cmd/hetzner_pricing.go`
- Create: `cmd/testdata/hetzner_pricing.json`
- Test: `cmd/hetzner_pricing_test.go`

**Interfaces:**
- Consumes: `hetznerFetch(ctx, token, url, out)` and `hetznerAPIBase` from `cmd/hetzner_helpers.go`.
- Produces:
  - `type hetznerPricing struct`
  - `func fetchHetznerPricing(ctx context.Context, token string) (*hetznerPricing, error)`
  - `func parseHetznerPricing(raw []byte) (*hetznerPricing, error)`
  - `func (p *hetznerPricing) Currency() string`
  - `func (p *hetznerPricing) ServerMonthly(typeName, location string) (float64, bool)`
  - `func (p *hetznerPricing) VolumeMonthlyPerGB() float64`
  - `func (p *hetznerPricing) PrimaryIPMonthly(ipType, location string) (float64, bool)`

  The `bool` is `found`. Callers must not silently treat a miss as 0 — see Step 1's fallback test.

- [ ] **Step 1: Capture the fixture**

Run this and commit the result. It is real payload shape, which is the point — a hand-written fixture would encode assumptions rather than reality.

```bash
curl -s -H "Authorization: Bearer $HCLOUD_TOKEN" \
  https://api.hetzner.cloud/v1/pricing -o cmd/testdata/hetzner_pricing.json
```

The payload has `pricing.currency`, `pricing.vat_rate`, `pricing.volume.price_per_gb_month.{net,gross}`, `pricing.server_types[]` (each with `name` and `prices[]` keyed by `location`, each price having `price_monthly.{net,gross}`), and `pricing.primary_ips[]` (each with `type` and the same `prices[]` shape).

- [ ] **Step 2: Write the failing tests**

```go
package cmd

import (
	"os"
	"testing"
)

func loadPricingFixture(t *testing.T) *hetznerPricing {
	t.Helper()
	raw, err := os.ReadFile("testdata/hetzner_pricing.json")
	if err != nil {
		t.Fatalf("reading fixture: %v", err)
	}
	p, err := parseHetznerPricing(raw)
	if err != nil {
		t.Fatalf("parseHetznerPricing: %v", err)
	}
	return p
}

func TestHetznerPricing_Currency(t *testing.T) {
	if got := loadPricingFixture(t).Currency(); got != "USD" {
		t.Errorf("Currency() = %q, want USD", got)
	}
}

func TestHetznerPricing_VolumeMonthlyPerGB(t *testing.T) {
	// Regression guard: this was hardcoded at 0.0440 and drifted badly.
	// The point is that the number comes from the payload, not source.
	got := loadPricingFixture(t).VolumeMonthlyPerGB()
	if got <= 0.05 || got >= 0.12 {
		t.Errorf("VolumeMonthlyPerGB() = %v, want a plausible live price", got)
	}
}

func TestHetznerPricing_ServerMonthly_KnownType(t *testing.T) {
	price, ok := loadPricingFixture(t).ServerMonthly("cpx11", "fsn1")
	if !ok {
		t.Fatal("ServerMonthly(cpx11, fsn1) not found")
	}
	if price <= 0 {
		t.Errorf("price = %v, want > 0", price)
	}
}

func TestHetznerPricing_ServerMonthly_UnknownTypeReportsMiss(t *testing.T) {
	// A miss must be reported, never returned as a silent 0 — that would
	// understate the run rate and look like a free server.
	if _, ok := loadPricingFixture(t).ServerMonthly("nonexistent-type", "fsn1"); ok {
		t.Error("ServerMonthly(nonexistent-type) reported found, want miss")
	}
}

func TestHetznerPricing_ServerMonthly_UnknownLocationFallsBack(t *testing.T) {
	// Locations price near-identically, so falling back is acceptable —
	// but it must still report found, with a real price.
	price, ok := loadPricingFixture(t).ServerMonthly("cpx11", "no-such-location")
	if !ok || price <= 0 {
		t.Errorf("got (%v, %v), want a fallback price", price, ok)
	}
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `go test ./cmd/ -run TestHetznerPricing -v`
Expected: FAIL — `undefined: parseHetznerPricing`, `undefined: hetznerPricing`.

- [ ] **Step 4: Implement the client**

```go
package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
)

type hetznerPriceAmount struct {
	Net   string `json:"net"`
	Gross string `json:"gross"`
}

type hetznerLocationPrice struct {
	Location     string             `json:"location"`
	PriceMonthly hetznerPriceAmount `json:"price_monthly"`
}

type hetznerServerTypePrice struct {
	Name   string                 `json:"name"`
	Prices []hetznerLocationPrice `json:"prices"`
}

type hetznerPrimaryIPPrice struct {
	Type   string                 `json:"type"`
	Prices []hetznerLocationPrice `json:"prices"`
}

type hetznerPricing struct {
	Pricing struct {
		Currency string `json:"currency"`
		VATRate  string `json:"vat_rate"`
		Volume   struct {
			PricePerGBMonth hetznerPriceAmount `json:"price_per_gb_month"`
		} `json:"volume"`
		ServerTypes []hetznerServerTypePrice `json:"server_types"`
		PrimaryIPs  []hetznerPrimaryIPPrice  `json:"primary_ips"`
	} `json:"pricing"`
}

func parseHetznerPricing(raw []byte) (*hetznerPricing, error) {
	var p hetznerPricing
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("parsing hetzner pricing: %w", err)
	}
	if p.Pricing.Currency == "" {
		return nil, fmt.Errorf("hetzner pricing payload has no currency")
	}
	return &p, nil
}

func fetchHetznerPricing(ctx context.Context, token string) (*hetznerPricing, error) {
	var p hetznerPricing
	if err := hetznerFetch(ctx, token, hetznerAPIBase+"/pricing", &p); err != nil {
		return nil, err
	}
	if p.Pricing.Currency == "" {
		return nil, fmt.Errorf("hetzner pricing payload has no currency")
	}
	return &p, nil
}

func (p *hetznerPricing) Currency() string { return p.Pricing.Currency }

func parseAmount(a hetznerPriceAmount) float64 {
	v, err := strconv.ParseFloat(a.Gross, 64)
	if err != nil {
		return 0
	}
	return v
}

// pickLocation returns the price for loc, falling back to the first entry
// when the location is absent. Locations price near-identically, so the
// fallback is sound — returning 0 would not be.
func pickLocation(prices []hetznerLocationPrice, loc string) (float64, bool) {
	if len(prices) == 0 {
		return 0, false
	}
	for _, pr := range prices {
		if pr.Location == loc {
			return parseAmount(pr.PriceMonthly), true
		}
	}
	return parseAmount(prices[0].PriceMonthly), true
}

func (p *hetznerPricing) ServerMonthly(typeName, location string) (float64, bool) {
	for _, st := range p.Pricing.ServerTypes {
		if st.Name == typeName {
			return pickLocation(st.Prices, location)
		}
	}
	return 0, false
}

func (p *hetznerPricing) VolumeMonthlyPerGB() float64 {
	return parseAmount(p.Pricing.Volume.PricePerGBMonth)
}

func (p *hetznerPricing) PrimaryIPMonthly(ipType, location string) (float64, bool) {
	for _, ip := range p.Pricing.PrimaryIPs {
		if ip.Type == ipType {
			return pickLocation(ip.Prices, location)
		}
	}
	return 0, false
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `go test ./cmd/ -run TestHetznerPricing -v`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add cmd/hetzner_pricing.go cmd/hetzner_pricing_test.go cmd/testdata/hetzner_pricing.json
git commit -m "feat(hetzner): add pricing client backed by the live /v1/pricing API"
```

---

### Task 2: Price volumes from the API (fixes both live bugs)

**Files:**
- Modify: `cmd/hetzner_volumes.go:21` (delete constant), `:137` (waste calc), `:157` (description), `:231-232` (summary print)
- Test: `cmd/hetzner_findings_test.go` (add cases)

**Interfaces:**
- Consumes: `VolumeMonthlyPerGB()`, `Currency()` from Task 1.
- Produces: `hetznerVolumeFindings(volumes []hetznerVolume, summary *HetznerVolumeSummary, pricePerGB float64, currency string) []HetznerVolumeFinding` — the existing function gains two parameters so it stays pure and testable.

This task fixes both bugs from the spec: the euro symbol on a USD account, and the 74%-stale `0.0440` constant.

- [ ] **Step 1: Write the failing test**

```go
func TestHetznerVolumeFindings_UsesLivePriceAndCurrency(t *testing.T) {
	volumes := []hetznerVolume{
		{Name: "orphan-1", Size: 100, Server: nil, Created: time.Now().AddDate(0, 0, -30).Format(time.RFC3339)},
	}
	summary := &HetznerVolumeSummary{}

	findings := hetznerVolumeFindings(volumes, summary, 0.0767, "USD")

	if len(findings) != 1 {
		t.Fatalf("got %d findings, want 1", len(findings))
	}
	// 100GB x 0.0767 = 7.67, not the old hardcoded 100 x 0.0440 = 4.40
	if got := findings[0].EstMonthlyWaste; got < 7.66 || got > 7.68 {
		t.Errorf("EstMonthlyWaste = %v, want ~7.67", got)
	}
	if strings.Contains(findings[0].Description, "€") {
		t.Errorf("description still uses a euro sign on a USD account: %q", findings[0].Description)
	}
	if !strings.Contains(findings[0].Description, "USD") && !strings.Contains(findings[0].Description, "$") {
		t.Errorf("description does not state the currency: %q", findings[0].Description)
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `go test ./cmd/ -run TestHetznerVolumeFindings_UsesLivePriceAndCurrency -v`
Expected: FAIL — too many arguments to `hetznerVolumeFindings`.

- [ ] **Step 3: Implement**

Delete the constant at `cmd/hetzner_volumes.go:21`:

```go
// REMOVED: const hetznerVolumeGBMonthlyEUR = 0.0440
// Priced from the live API instead — the constant was both the wrong
// currency for this account and 74% below the real list price.
```

Change the signature and the two places that used the constant:

```go
func hetznerVolumeFindings(volumes []hetznerVolume, summary *HetznerVolumeSummary, pricePerGB float64, currency string) []HetznerVolumeFinding {
	// ...
	waste := float64(v.Size) * pricePerGB
	// ...
	Description: fmt.Sprintf("'%s' (%dGB) is not attached to any server — est. %.2f %s/month at list price", v.Name, v.Size, waste, currency),
```

Rename the summary field `EstMonthlyWasteEUR` to `EstMonthlyWaste` (JSON tag stays `est_monthly_waste_eur` for now — renaming it would break `web/lib/btg-runner.ts:147`, which is handled in Task 5). Update the print at `:231-232` to use `currency` instead of `€`.

In `runHetznerVolumes`, fetch pricing before computing:

```go
pricing, err := fetchHetznerPricing(cmd.Context(), token)
if err != nil {
	return fmt.Errorf("fetching hetzner pricing: %w", err)
}
findings := hetznerVolumeFindings(volumes, summary, pricing.VolumeMonthlyPerGB(), pricing.Currency())
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./cmd/ -run TestHetznerVolume -v`
Expected: PASS, including the pre-existing volume tests (update their call sites to pass `0.0767, "USD"`).

- [ ] **Step 5: Commit**

```bash
git add cmd/hetzner_volumes.go cmd/hetzner_findings_test.go
git commit -m "fix(hetzner): price volumes from the live API, not a stale EUR constant"
```

---

### Task 3: Capture server_type and price servers

**Files:**
- Modify: `cmd/hetzner_servers.go:46-55` (struct), add costing helper
- Test: `cmd/hetzner_findings_test.go`

**Interfaces:**
- Consumes: `ServerMonthly(typeName, location)` from Task 1.
- Produces: `func hetznerServerMonthlyCost(s hetznerServer, p *hetznerPricing) (float64, bool)`

`server_type` is returned by the API but not currently unmarshalled, which is why servers carry no cost today.

- [ ] **Step 1: Write the failing test**

```go
func TestHetznerServerMonthlyCost_UsesTypeAndLocation(t *testing.T) {
	p := loadPricingFixture(t)
	s := hetznerServer{
		Name:       "web-1",
		ServerType: hetznerServerType{Name: "cpx11"},
		Datacenter: hetznerDatacenter{Location: hetznerLocation{Name: "fsn1"}},
	}

	cost, ok := hetznerServerMonthlyCost(s, p)
	if !ok || cost <= 0 {
		t.Errorf("got (%v, %v), want a positive price", cost, ok)
	}
}

func TestHetznerServerMonthlyCost_UnknownTypeReportsMiss(t *testing.T) {
	p := loadPricingFixture(t)
	s := hetznerServer{Name: "x", ServerType: hetznerServerType{Name: "made-up"}}

	if _, ok := hetznerServerMonthlyCost(s, p); ok {
		t.Error("reported found for an unknown server type, want miss")
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `go test ./cmd/ -run TestHetznerServerMonthlyCost -v`
Expected: FAIL — `unknown field ServerType`, `undefined: hetznerServerMonthlyCost`.

- [ ] **Step 3: Implement**

Add to `cmd/hetzner_servers.go`:

```go
type hetznerServerType struct {
	Name string `json:"name"`
}
```

Add the field to `hetznerServer` (after `Status`):

```go
	ServerType   hetznerServerType `json:"server_type"`
```

Add the helper:

```go
// hetznerServerMonthlyCost prices one server by its type and datacenter
// location. Returns found=false for an unknown type rather than 0, so a
// pricing gap surfaces instead of quietly making a server look free.
func hetznerServerMonthlyCost(s hetznerServer, p *hetznerPricing) (float64, bool) {
	return p.ServerMonthly(s.ServerType.Name, s.Datacenter.Location.Name)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./cmd/ -run TestHetznerServer -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/hetzner_servers.go cmd/hetzner_findings_test.go
git commit -m "feat(hetzner): capture server_type and price servers from list pricing"
```

---

### Task 4: `analyze hetzner-cost` command

**Files:**
- Create: `cmd/hetzner_cost.go`
- Test: `cmd/hetzner_cost_test.go`

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces:
  - `type HetznerCostReport struct { Currency string; TotalMonthly float64; ByCategory map[string]float64; ByType map[string]HetznerCostLine; Unpriced []string; Estimate bool }`
  - `type HetznerCostLine struct { Count int; MonthlyTotal float64 }`
  - `func hetznerCostReport(servers []hetznerServer, volumes []hetznerVolume, ips []hetznerPrimaryIP, p *hetznerPricing) HetznerCostReport`

- [ ] **Step 1: Write the failing test**

```go
func TestHetznerCostReport_TotalsByCategory(t *testing.T) {
	p := loadPricingFixture(t)
	servers := []hetznerServer{
		{Name: "a", ServerType: hetznerServerType{Name: "cpx11"}, Datacenter: hetznerDatacenter{Location: hetznerLocation{Name: "fsn1"}}},
		{Name: "b", ServerType: hetznerServerType{Name: "cpx11"}, Datacenter: hetznerDatacenter{Location: hetznerLocation{Name: "fsn1"}}},
	}
	volumes := []hetznerVolume{{Name: "v1", Size: 100}}

	r := hetznerCostReport(servers, volumes, nil, p)

	if r.Currency != "USD" {
		t.Errorf("Currency = %q, want USD", r.Currency)
	}
	if !r.Estimate {
		t.Error("Estimate = false, want true — this is list price, never an invoice")
	}
	if r.ByType["cpx11"].Count != 2 {
		t.Errorf("cpx11 count = %d, want 2", r.ByType["cpx11"].Count)
	}
	// servers + volumes must both contribute
	if r.ByCategory["servers"] <= 0 || r.ByCategory["volumes"] <= 0 {
		t.Errorf("ByCategory = %+v, want positive servers and volumes", r.ByCategory)
	}
	want := r.ByCategory["servers"] + r.ByCategory["volumes"]
	if diff := r.TotalMonthly - want; diff > 0.01 || diff < -0.01 {
		t.Errorf("TotalMonthly = %v, want %v", r.TotalMonthly, want)
	}
}

func TestHetznerCostReport_RecordsUnpricedResources(t *testing.T) {
	p := loadPricingFixture(t)
	servers := []hetznerServer{{Name: "mystery", ServerType: hetznerServerType{Name: "made-up"}}}

	r := hetznerCostReport(servers, nil, nil, p)

	if len(r.Unpriced) != 1 || !strings.Contains(r.Unpriced[0], "mystery") {
		t.Errorf("Unpriced = %v, want the unpriced server named", r.Unpriced)
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `go test ./cmd/ -run TestHetznerCostReport -v`
Expected: FAIL — `undefined: hetznerCostReport`.

- [ ] **Step 3: Implement**

```go
package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

type HetznerCostLine struct {
	Count        int     `json:"count"`
	MonthlyTotal float64 `json:"monthly_total"`
}

type HetznerCostReport struct {
	Currency     string                     `json:"currency"`
	TotalMonthly float64                    `json:"total_monthly"`
	ByCategory   map[string]float64         `json:"by_category"`
	ByType       map[string]HetznerCostLine `json:"by_type"`
	Unpriced     []string                   `json:"unpriced,omitempty"`
	Estimate     bool                       `json:"estimate"`
	Note         string                     `json:"note"`
}

func hetznerCostReport(servers []hetznerServer, volumes []hetznerVolume, ips []hetznerPrimaryIP, p *hetznerPricing) HetznerCostReport {
	r := HetznerCostReport{
		Currency:   p.Currency(),
		ByCategory: map[string]float64{},
		ByType:     map[string]HetznerCostLine{},
		Estimate:   true,
		Note:       "List-price estimate from the Hetzner pricing API. Not a bill — Hetzner exposes no invoice endpoint.",
	}

	for _, s := range servers {
		cost, ok := hetznerServerMonthlyCost(s, p)
		if !ok {
			r.Unpriced = append(r.Unpriced, fmt.Sprintf("server %s (type %s)", s.Name, s.ServerType.Name))
			continue
		}
		r.ByCategory["servers"] += cost
		line := r.ByType[s.ServerType.Name]
		line.Count++
		line.MonthlyTotal += cost
		r.ByType[s.ServerType.Name] = line
	}

	perGB := p.VolumeMonthlyPerGB()
	for _, v := range volumes {
		r.ByCategory["volumes"] += float64(v.Size) * perGB
	}

	for _, ip := range ips {
		cost, ok := p.PrimaryIPMonthly(ip.Type, ip.Datacenter.Location.Name)
		if !ok {
			r.Unpriced = append(r.Unpriced, fmt.Sprintf("primary ip %s (type %s)", ip.Name, ip.Type))
			continue
		}
		r.ByCategory["primary_ips"] += cost
	}

	for _, v := range r.ByCategory {
		r.TotalMonthly += v
	}
	return r
}
```

Register the command following the `hetzner_volumes.go:63-78` pattern:

```go
var hetznerCostCmd = &cobra.Command{
	Use:   "hetzner-cost",
	Short: "Estimate monthly Hetzner run rate from live list pricing",
	RunE:  runHetznerCost,
}

func init() { analyzeCmd.AddCommand(hetznerCostCmd) }
```

`runHetznerCost` fetches pricing, servers (`/servers?per_page=50`), volumes, and primary IPs via `hetznerFetch`, calls `hetznerCostReport`, and prints JSON when `--output json` is set, mirroring `runHetznerVolumes`. Define `hetznerPrimaryIP` with `Name`, `Type`, and `Datacenter` fields matching the `/primary_ips` payload.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./cmd/ -run TestHetznerCostReport -v`
Expected: PASS.

- [ ] **Step 5: Verify against the live account**

Run: `go build -o btg-devops.exe . && ./btg-devops.exe analyze hetzner-cost --output json`
Expected: a total near **$246.89 USD/month** (15 servers, 22 volumes / 320GB, 28 primary IPs as of 2026-09-12). A wildly different number means a pricing lookup is silently missing — check `unpriced`.

- [ ] **Step 6: Commit**

```bash
git add cmd/hetzner_cost.go cmd/hetzner_cost_test.go
git commit -m "feat(hetzner): add analyze hetzner-cost run-rate command"
```

---

### Task 5: Database — currency column and snapshot table

**Files:**
- Modify: `web/lib/db.ts` (schema block near `:210-220`, plus new helpers)
- Modify: `web/lib/btg-runner.ts:147` (`extractMonthlyCost`)
- Test: `web/lib/db.test.ts`

**Interfaces:**
- Produces:
  - `saveHetznerCostSnapshot(data: { totalMonthly: number; currency: string; byCategory: unknown; byType: unknown }): Promise<void>`
  - `getHetznerCostSnapshot(): Promise<HetznerCostSnapshot | null>`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { saveHetznerCostSnapshot, getHetznerCostSnapshot, getDB } from './db';

describe('hetzner cost snapshots', () => {
  it('round-trips a snapshot and returns the newest', async () => {
    const db = await getDB();
    await db.query('DELETE FROM hetzner_cost_snapshots');

    await saveHetznerCostSnapshot({
      totalMonthly: 246.89, currency: 'USD',
      byCategory: { servers: 213.35, volumes: 24.54 },
      byType: { cpx11: { count: 1, monthly_total: 5.99 } },
    });

    const snap = await getHetznerCostSnapshot();
    expect(snap?.total_monthly).toBeCloseTo(246.89, 2);
    expect(snap?.currency).toBe('USD');
    expect(JSON.parse(snap!.by_category).servers).toBeCloseTo(213.35, 2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && npx vitest run lib/db.test.ts -t "hetzner cost"`
Expected: FAIL — `saveHetznerCostSnapshot is not a function`.

- [ ] **Step 3: Implement**

Add to the schema block in `db.ts`, following the existing `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` style:

```sql
CREATE TABLE IF NOT EXISTS hetzner_cost_snapshots (
  id            TEXT PRIMARY KEY,
  total_monthly DOUBLE PRECISION NOT NULL,
  currency      TEXT NOT NULL,
  by_category   TEXT NOT NULL,
  by_type       TEXT NOT NULL,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE findings ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT NULL;
```

`findings.currency` is nullable on purpose: existing Azure rows have no currency and must not be rewritten to a guess.

Add the two helpers mirroring `saveCostSnapshot` / `getCostSnapshot` (`db.ts:602`), ordering by `fetched_at DESC LIMIT 1`.

In `web/lib/btg-runner.ts`, extend `NormalizedFinding` with `currency: string | null` and set it in the mapper. The CLI's JSON tag is still `est_monthly_waste_eur` (Task 2 kept it for compatibility), so read the currency from the report rather than inferring it from the field name:

```typescript
export function extractCurrency(raw: RawFinding): string | null {
  return raw.currency ?? null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx vitest run lib/db.test.ts lib/btg-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/lib/db.ts web/lib/db.test.ts web/lib/btg-runner.ts
git commit -m "feat(db): add hetzner_cost_snapshots and findings.currency"
```

---

### Task 6: API routes

**Files:**
- Create: `web/app/api/cost/hetzner/route.ts`
- Modify: `web/app/api/cost-requests/route.ts:41` (provider param)

**Interfaces:**
- Consumes: `getHetznerCostSnapshot()` from Task 5.
- Produces: `GET /api/cost/hetzner` → `{ totalMonthly, currency, byCategory, byType, fetchedAt, estimate: true }` or `{ noData: true, message }`.

- [ ] **Step 1: Implement the read route**

Mirror `web/app/api/cost/spend/route.ts` exactly, including its "never calls the provider live" comment. It reads only the snapshot.

```typescript
import { NextResponse } from 'next/server';
import { getHetznerCostSnapshot } from '@/lib/db';

// Reads only the stored snapshot — never calls Hetzner. Mirrors
// /api/cost/spend. Unlike Azure this figure is a list-price estimate, never
// a bill, and `estimate: true` travels with it so the UI cannot forget.
export async function GET() {
  try {
    const snap = await getHetznerCostSnapshot();
    if (!snap) {
      return NextResponse.json({
        noData: true,
        message: 'No Hetzner cost snapshot yet. Click Refresh to request one.',
      });
    }
    return NextResponse.json({
      totalMonthly: snap.total_monthly,
      currency: snap.currency,
      byCategory: JSON.parse(snap.by_category),
      byType: JSON.parse(snap.by_type),
      fetchedAt: snap.fetched_at,
      estimate: true,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
```

- [ ] **Step 2: Add the provider param**

In `web/app/api/cost-requests/route.ts`, read `body?.provider` defaulting to `'azure'`. When it is `'hetzner'`, run the CLI's `analyze hetzner-cost` through the existing `runSingleCommand` path and save via `saveHetznerCostSnapshot`. Existing callers send no `provider` and are unaffected.

- [ ] **Step 3: Trigger Hetzner from the daily refresh**

The spec requires the scheduler's daily cost refresh to cover both providers.
`web/lib/scheduler.ts` already fires the Azure refresh; add the Hetzner one
beside it so a deployment with no one clicking Refresh still accumulates
snapshots:

```typescript
// Azure and Hetzner are independent — one failing must not skip the other,
// so these are settled separately rather than awaited in sequence.
await Promise.allSettled([
  requestCostRefresh({ provider: 'azure' }),
  requestCostRefresh({ provider: 'hetzner' }),
]);
```

Match the existing call's shape in that file; the point is that a Hetzner
failure cannot suppress the Azure refresh, nor the reverse.

- [ ] **Step 4: Verify manually**

```bash
curl -s -b cookie.txt -X POST http://localhost:3000/api/cost-requests \
  -H "Content-Type: application/json" -d '{"provider":"hetzner"}'
curl -s -b cookie.txt http://localhost:3000/api/cost/hetzner
```
Expected: the second call returns a `totalMonthly` near 246.89 with `estimate: true`.

- [ ] **Step 5: Commit**

```bash
git add web/app/api/cost/hetzner/route.ts web/app/api/cost-requests/route.ts web/lib/scheduler.ts
git commit -m "feat(api): add /api/cost/hetzner, a provider param, and a daily Hetzner refresh"
```

---

### Task 7: Give the Claude agent a cost signal

**Files:**
- Modify: `web/lib/analysisContext.ts:22-34`
- Test: `web/lib/analysisContext.test.ts` (create)

**Interfaces:**
- Consumes: `findings.monthly_cost`, `findings.currency` (Task 5); `getHetznerCostSnapshot()` (Task 5).

The agent currently reasons on severity alone — `buildAuditContext` never reads `monthly_cost`, which is why generated summaries rank risk and never mention money.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { formatFindingLine, buildCostBlock } from './analysisContext';

describe('analysis context cost signal', () => {
  it('appends cost to a finding line when present', () => {
    const line = formatFindingLine({
      severity: 'Critical', service: 'Hetzner Volumes', resource: 'orphan-1',
      description: 'unattached', monthly_cost: 7.67, currency: 'USD',
    });
    expect(line).toContain('7.67');
    expect(line).toContain('USD');
  });

  it('omits cost entirely when the finding has none', () => {
    const line = formatFindingLine({
      severity: 'Critical', service: 'ACR', resource: 'acr1',
      description: 'admin enabled', monthly_cost: null, currency: null,
    });
    expect(line).toBe('- [Critical] ACR/acr1: admin enabled');
  });

  it('labels the run rate as an estimate so the agent cannot quote it as a bill', () => {
    const block = buildCostBlock(31.4, 'USD', { totalMonthly: 246.89, currency: 'USD' });
    expect(block).toContain('246.89');
    expect(block.toLowerCase()).toContain('estimate');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && npx vitest run lib/analysisContext.test.ts`
Expected: FAIL — `formatFindingLine is not a function`.

- [ ] **Step 3: Implement**

Export the two helpers and use them in `buildAuditContext`:

```typescript
export function formatFindingLine(f: {
  severity: string; service: string; resource: string | null;
  description: string; monthly_cost: number | null; currency: string | null;
}): string {
  const base = `- [${f.severity}] ${f.service}/${f.resource || '(n/a)'}: ${f.description}`;
  if (f.monthly_cost == null) return base;
  return `${base} — ${f.monthly_cost.toFixed(2)} ${f.currency ?? ''}/mo`.replace(' /mo', '/mo');
}

export function buildCostBlock(
  findingsCost: number,
  currency: string,
  hetzner: { totalMonthly: number; currency: string } | null
): string {
  const lines = [`Estimated monthly cost attributable to findings: ${findingsCost.toFixed(2)} ${currency}`];
  if (hetzner) {
    lines.push(
      `Hetzner run rate: ${hetzner.totalMonthly.toFixed(2)} ${hetzner.currency}/mo ` +
      `(list-price estimate, not a bill)`
    );
  }
  return lines.join('\n');
}
```

Wire both into the returned array in `buildAuditContext`, after `By service`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx vitest run lib/analysisContext.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Verify end to end**

Queue a Summarize from the dashboard and confirm the generated summary references cost. The drain runs automatically when `CLAUDE_DRAIN_ENABLED` is set.

- [ ] **Step 6: Commit**

```bash
git add web/lib/analysisContext.ts web/lib/analysisContext.test.ts
git commit -m "feat(analysis): give the agent a cost signal alongside severity"
```

---

### Task 8: Actual Spend provider switch

**Files:**
- Modify: `web/app/cost/page.tsx` (`SpendView`, around `:639-734`)

**Interfaces:**
- Consumes: `GET /api/cost/hetzner` (Task 6).

- [ ] **Step 1: Add the provider switch**

In `SpendView`, add the state and the pill pair. Style copied from the existing `waste`/`spend` tabs at `:795-805` so the two switches look like siblings:

```tsx
const [provider, setProvider] = useState<'azure' | 'hetzner'>('azure');

<div style={{ display: 'flex', gap: 3, marginBottom: 12 }}>
  {(['azure', 'hetzner'] as const).map(p => (
    <button key={p} onClick={() => setProvider(p)} style={{
      padding: '4px 12px', fontSize: 11, fontWeight: 700, borderRadius: 3, cursor: 'pointer',
      background: provider === p ? 'var(--accent)' : 'transparent',
      border: `1px solid ${provider === p ? 'var(--accent)' : 'var(--border)'}`,
      color: provider === p ? '#fff' : 'var(--muted)',
    }}>
      {p === 'azure' ? 'Azure' : 'Hetzner'}
    </button>
  ))}
</div>
```

Wrap the existing Azure markup in `{provider === 'azure' && (...)}` and render `<HetznerSpendView />` otherwise.

- [ ] **Step 2: Add the Hetzner view**

```tsx
interface HetznerSpend {
  totalMonthly: number; currency: string;
  byCategory: Record<string, number>; byType: Record<string, { count: number; monthly_total: number }>;
  fetchedAt: string; noData?: boolean; message?: string;
}

function HetznerSpendView() {
  const [data, setData] = useState<HetznerSpend | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/cost/hetzner').then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ fontSize: 12, color: 'var(--muted)', padding: 32 }}>Loading…</div>;
  if (!data || data.noData) {
    return <div className="glass" style={{ borderRadius: 8, padding: '24px 20px', textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
      {data?.message ?? 'No Hetzner cost snapshot yet.'}
    </div>;
  }

  const cat = Object.entries(data.byCategory).map(([name, cost]) => ({ name, cost }));
  const types = Object.entries(data.byType).map(([name, v]) => ({ name: `${name} x${v.count}`, cost: v.monthly_total }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="glass" style={{ borderRadius: 10, padding: '22px 24px' }}>
        <div style={{ fontSize: 44, fontWeight: 800, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
          {data.totalMonthly.toLocaleString(undefined, { style: 'currency', currency: data.currency })}
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--muted)', marginLeft: 8 }}>/month</span>
        </div>
        {/* Stated inline, never a tooltip: this number is not a bill and a
            reader must not be able to miss that. */}
        <div style={{ fontSize: 11, color: 'var(--warn)', marginTop: 8, lineHeight: 1.5 }}>
          List-price estimate from Hetzner&apos;s pricing API, not a bill — Hetzner exposes no invoice endpoint.
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <BreakdownCard title="By Category" rows={cat} total={data.totalMonthly} currency={data.currency} color={ACCENT} />
        <BreakdownCard title="By Server Type" rows={types} total={data.totalMonthly} currency={data.currency} color={WARN} />
      </div>
    </div>
  );
}
```

`BreakdownCard` (`:346`) is reused as-is — it already takes `rows`, `total`, `currency`, and `color`.

- [ ] **Step 3: Verify both views**

Run the dashboard, open Cost & Usage → Actual Spend, switch between Azure and Hetzner. Confirm the Hetzner total is near $246.89, the estimate caveat is visible without hovering, and **no element anywhere sums the two providers**.

- [ ] **Step 4: Commit**

```bash
git add web/app/cost/page.tsx
git commit -m "feat(cost): add a Hetzner provider view to Actual Spend"
```

---

## Verification

Run before calling this done:

```bash
go test ./cmd/ -run Hetzner -v     # Tasks 1-4
cd web && npm test                 # Tasks 5, 7 — full suite must stay green
```

The 83-test web suite passing at the start of this work is the baseline; it must not shrink.
