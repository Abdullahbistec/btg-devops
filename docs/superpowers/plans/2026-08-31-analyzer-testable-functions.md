# Analyzer Testable-Function Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each of this repo's 12 Azure analyzer files (all except `idle.go`, which already has this) a pure, client-less `AnalyzeXFindings`-shaped function — ported verbatim from Yomal's already-written version of the same file — with a real unit test, so each analyzer's check logic finally has test coverage independent of a live Azure connection.

**Architecture:** Each of the 13 analyzer files in `cmd/` already contains its live-Azure-calling `runXxx`/`computeXxxFindings` function. This plan adds one new, additive, pure function per file (same name/signature as Yomal's copy) that takes already-fetched Azure SDK data and returns findings with no client calls — purely mechanical porting, since Yomal's version already exists, is already correct (confirmed via file-by-file comparison — no check-logic divergence anywhere), and only needs retyping where the source file has character-encoding corruption (mojibake) to fix along the way.

**Tech Stack:** Go 1.23+ (matching this repo's existing `go.mod`), standard library `testing` package (matching this repo's existing test style — no testify, no mocking framework; see `cmd/idle_test.go`/`cmd/hetzner_findings_test.go`/`cmd/pp_test.go` for the established pattern of plain table-driven tests against pure functions).

**Spec:** `docs/superpowers/specs/2026-08-31-analyzer-testable-functions-design.md`

## Global Constraints

- Every ported function keeps Yomal's exact name and signature — do not rename anything during the port.
- Source files live at `external/yomal/CLI Engine/cmd/<same-filename>.go` — read the exact function from there before writing each test, don't reconstruct it from memory of the spec's summary.
- Retype (don't copy-paste) any string literal containing `â€”`, `ðŸŽ‰`, `â€¢`, or similar mojibake — these are UTF-8/Windows-1252 double-encoding corruption in the source, not intentional characters. Compare against this repo's own existing (correct) strings for the same finding where one already exists.
- Each ported function is purely additive — no existing function in any target file changes signature or behavior in this plan, except the two named bug fixes (cognitiveservices.go's Sprintf, and the two dead-code deletions) called out in their specific tasks.
- Run `go build ./...` from the repo root after every task — a broken build in one file must not be left for the next task to discover.
- Commit after every task. Small, reviewable diffs — one file's port per commit, not a batch at the end.

---

### Task 1: `acr.go` — port `AnalyzeACRFindings`

**Files:**
- Modify: `cmd/acr.go`
- Test: `cmd/acr_test.go` (new file)

**Interfaces:**
- Consumes: `armcontainerregistry.Registry` (already imported in `cmd/acr.go`), this repo's existing `ACRFinding`/`Severity` types (already defined in `cmd/acr.go`).
- Produces: `AnalyzeACRFindings(registries []*armcontainerregistry.Registry) []ACRFinding` — later usable by anything wanting ACR checks without a live client (no other task in this plan consumes it; it's the deliverable itself).

- [ ] **Step 1: Read the source function**

Read `external/yomal/CLI Engine/cmd/acr.go`, lines 310–417 (the `AnalyzeACRFindings` function). Note its exact checks: Admin Account Enabled (Critical), Public Network Access (Warning), No Private Endpoint (Warning), Retention Policy missing/short (Warning), no Customer-Managed Key (Info), Content Trust disabled (Info), Export Policy allowed (Info), Basic SKU (Info), Zone Redundancy not enabled (Info), Geo-Replication check explicitly skipped (needs a live client — confirm the source skips it, since File A's version has it live).

- [ ] **Step 2: Write the failing test**

```go
package cmd

import (
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/containerregistry/armcontainerregistry/v2"
)

func boolPtr(b bool) *bool { return &b }
func strPtr(s string) *string { return &s }

func TestAnalyzeACRFindings_AdminAccountEnabled(t *testing.T) {
	name := "myregistry"
	registries := []*armcontainerregistry.Registry{
		{
			Name: &name,
			Properties: &armcontainerregistry.RegistryProperties{
				AdminUserEnabled: boolPtr(true),
			},
		},
	}

	findings := AnalyzeACRFindings(registries)

	found := false
	for _, f := range findings {
		if f.Category == "Admin Account" {
			found = true
			if f.Severity != SeverityCritical {
				t.Errorf("expected Critical severity for admin account enabled, got %v", f.Severity)
			}
		}
	}
	if !found {
		t.Error("expected an Admin Account finding when AdminUserEnabled is true, got none")
	}
}

func TestAnalyzeACRFindings_NoFindingsForHardenedRegistry(t *testing.T) {
	name := "hardened-registry"
	registries := []*armcontainerregistry.Registry{
		{
			Name: &name,
			Properties: &armcontainerregistry.RegistryProperties{
				AdminUserEnabled: boolPtr(false),
			},
		},
	}

	findings := AnalyzeACRFindings(registries)

	for _, f := range findings {
		if f.Category == "Admin Account" {
			t.Errorf("did not expect an Admin Account finding when AdminUserEnabled is false, got: %+v", f)
		}
	}
}
```

Adjust field names/types (`Properties`, `AdminUserEnabled`, etc.) to exactly match what `cmd/acr.go`'s existing `runACR`/`computeACRFindings` already uses for the same SDK type — copy the exact field access pattern from there rather than guessing.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./cmd/... -run TestAnalyzeACRFindings -v`
Expected: FAIL — `AnalyzeACRFindings` undefined.

- [ ] **Step 3: Port the function**

Copy `AnalyzeACRFindings` from `external/yomal/CLI Engine/cmd/acr.go:310-417` into `cmd/acr.go`, placed after the existing `computeACRFindings` function. Retype any mojibake. Do not change its signature.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./cmd/... -run TestAnalyzeACRFindings -v`
Expected: PASS.

- [ ] **Step 5: Verify the whole package still builds**

Run: `go build ./...`
Expected: exits 0, no output.

- [ ] **Step 6: Commit**

```bash
git add cmd/acr.go cmd/acr_test.go
git commit -m "feat(acr): add AnalyzeACRFindings pure function, ported from yomal, with test"
```

---

### Task 2: `appservice_traffic.go` — port `ClassifyTrafficStatus`

**Files:**
- Modify: `cmd/appservice_traffic.go`
- Test: `cmd/appservice_traffic_test.go` (new file)

**Interfaces:**
- Consumes: this repo's existing `AppTrafficReport` type (already defined in `cmd/appservice_traffic.go`).
- Produces: `ClassifyTrafficStatus(report *AppTrafficReport)` — mutates or returns the report's status classification (confirm exact signature — reported as taking `*AppTrafficReport` — while reading the source in Step 1).

- [ ] **Step 1: Read the source function**

Read `external/yomal/CLI Engine/cmd/appservice_traffic.go`, lines 226–248 (`ClassifyTrafficStatus`). Confirm its exact signature and whether it mutates the report in place or returns a new value — match that exactly, don't assume.

- [ ] **Step 2: Write the failing test**

```go
package cmd

import "testing"

func TestClassifyTrafficStatus_IdleWithZeroTraffic(t *testing.T) {
	report := &AppTrafficReport{
		Requests:      0,
		BytesReceived: 0,
		BytesSent:     0,
	}

	ClassifyTrafficStatus(report)

	if report.Status != "Idle/Unused" {
		t.Errorf("expected Idle/Unused status for zero traffic, got %q", report.Status)
	}
}

func TestClassifyTrafficStatus_ActiveAboveThreshold(t *testing.T) {
	report := &AppTrafficReport{
		Requests: 5000,
	}

	ClassifyTrafficStatus(report)

	if report.Status != "Active" {
		t.Errorf("expected Active status for 5000 requests, got %q", report.Status)
	}
}
```

Adjust field names (`Status`, `Requests`, etc.) and the exact threshold values (0/100/1000 per the spec's documented classification bands) to match `AppTrafficReport`'s real field names in `cmd/appservice_traffic.go` — read the struct definition before finalizing this test.

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./cmd/... -run TestClassifyTrafficStatus -v`
Expected: FAIL — `ClassifyTrafficStatus` undefined.

- [ ] **Step 4: Port the function**

Copy `ClassifyTrafficStatus` from `external/yomal/CLI Engine/cmd/appservice_traffic.go:226-248` into `cmd/appservice_traffic.go`. No mojibake in this specific function (it's confined to `printTable` in the source), but double-check while copying.

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./cmd/... -run TestClassifyTrafficStatus -v`
Expected: PASS.

- [ ] **Step 6: Verify build**

Run: `go build ./...`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add cmd/appservice_traffic.go cmd/appservice_traffic_test.go
git commit -m "feat(appservice-traffic): add ClassifyTrafficStatus pure function, ported from yomal, with test"
```

---

### Task 3: `appserviceplan.go` — port `AnalyzeASPsData`

**Files:**
- Modify: `cmd/appserviceplan.go`
- Test: `cmd/appserviceplan_test.go` (new file)

**Interfaces:**
- Consumes: this repo's existing plan/app-count types already used by `computeAppServicePlanFindings`.
- Produces: `AnalyzeASPsData(plans, planAppCount) ASPReport` (confirm exact parameter types while reading source — reported as taking plans and a plan→app-count map).

- [ ] **Step 1: Read the source function**

Read `external/yomal/CLI Engine/cmd/appserviceplan.go` for `AnalyzeASPsData` (the CPU/Memory metrics check via Azure Monitor is confirmed skipped in this pure version — no "Over-Provisioned" finding will come from it). Note its exact parameter types.

- [ ] **Step 2: Write the failing test**

```go
package cmd

import "testing"

func TestAnalyzeASPsData_EmptyPlanFinding(t *testing.T) {
	// Construct one plan with zero apps assigned, using this repo's real
	// plan/app-count types — match the exact types AnalyzeASPsData takes,
	// confirmed in Step 1.
	report := AnalyzeASPsData(testEmptyASPPlans, testEmptyASPPlanAppCount)

	found := false
	for _, f := range report.Findings {
		if f.Category == "Empty Plan" {
			found = true
		}
	}
	if !found {
		t.Error("expected an Empty Plan finding for a plan with zero apps, got none")
	}
}
```

Replace `testEmptyASPPlans`/`testEmptyASPPlanAppCount` with real literal values matching `AnalyzeASPsData`'s actual parameter types once confirmed in Step 1 — this placeholder naming is here only to show test intent; the actual test must construct real typed values, not reference undefined test fixtures.

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./cmd/... -run TestAnalyzeASPsData -v`
Expected: FAIL — `AnalyzeASPsData` undefined (and/or compile error from undefined test fixtures, which Step 2 must resolve with real values, not leave as placeholders).

- [ ] **Step 4: Port the function**

Copy `AnalyzeASPsData` from `external/yomal/CLI Engine/cmd/appserviceplan.go` into `cmd/appserviceplan.go`, after `computeAppServicePlanFindings`.

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./cmd/... -run TestAnalyzeASPsData -v`
Expected: PASS.

- [ ] **Step 6: Verify build**

Run: `go build ./...`

- [ ] **Step 7: Commit**

```bash
git add cmd/appserviceplan.go cmd/appserviceplan_test.go
git commit -m "feat(appserviceplan): add AnalyzeASPsData pure function, ported from yomal, with test"
```

---

### Task 4: `cognitiveservices.go` — port `AnalyzeCogServicesFindings` + fix Sprintf bug

**Files:**
- Modify: `cmd/cognitiveservices.go`
- Test: `cmd/cognitiveservices_test.go` (new file)

**Interfaces:**
- Consumes: `armcognitiveservices.Account` (already imported).
- Produces: `AnalyzeCogServicesFindings(accounts []*armcognitiveservices.Account) []CognitiveServicesFinding`.

- [ ] **Step 1: Fix the pre-existing Sprintf bug first**

In `cmd/cognitiveservices.go`, find the "No Deployments" finding (around where a `fmt.Sprintf` call has a message like `"OpenAI/AI Services account has no model deployments — may be unused"` with no `%` format verbs — a Sprintf misuse). Replace `fmt.Sprintf("...")` with the plain string literal `"..."` (drop the `fmt.Sprintf` call entirely since there's nothing to format).

- [ ] **Step 2: Run existing tests to confirm nothing broke**

Run: `go build ./... && go test ./cmd/... -run TestCognitiveServices -v`
Expected: builds clean; any existing cognitiveservices tests (if none exist yet, this is a no-op check) still pass.

- [ ] **Step 3: Read the source function**

Read `external/yomal/CLI Engine/cmd/cognitiveservices.go` for `AnalyzeCogServicesFindings` — 10 checks (Public Network Access, No Private Endpoint, No Managed Identity, No Customer-Managed Key, No Network Rules/Permissive Default, Outbound Access Not Restricted, Local Auth Enabled, Model Deployment/Provisioned Capacity/No Deployments, Provisioning Issue, Free Tier). Deployment check (#8) is confirmed present in this pure version (unlike some other files' offline variants).

- [ ] **Step 4: Write the failing test**

```go
package cmd

import (
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/cognitiveservices/armcognitiveservices"
)

func TestAnalyzeCogServicesFindings_PublicNetworkAccess(t *testing.T) {
	name := "my-openai"
	enabled := armcognitiveservices.PublicNetworkAccessEnabled
	accounts := []*armcognitiveservices.Account{
		{
			Name: &name,
			Properties: &armcognitiveservices.AccountProperties{
				PublicNetworkAccess: &enabled,
			},
		},
	}

	findings := AnalyzeCogServicesFindings(accounts)

	found := false
	for _, f := range findings {
		if f.Category == "Public Network Access" {
			found = true
		}
	}
	if !found {
		t.Error("expected a Public Network Access finding when public access is enabled, got none")
	}
}
```

Match exact field/type names to what `cmd/cognitiveservices.go`'s existing `computeCognitiveServicesFindings` already uses for the same SDK type.

- [ ] **Step 5: Run test to verify it fails**

Run: `go test ./cmd/... -run TestAnalyzeCogServicesFindings -v`
Expected: FAIL — undefined function.

- [ ] **Step 6: Port the function**

Copy `AnalyzeCogServicesFindings` from `external/yomal/CLI Engine/cmd/cognitiveservices.go` into `cmd/cognitiveservices.go`.

- [ ] **Step 7: Run test to verify it passes**

Run: `go test ./cmd/... -run TestAnalyzeCogServicesFindings -v`
Expected: PASS.

- [ ] **Step 8: Verify build**

Run: `go build ./...`

- [ ] **Step 9: Commit**

```bash
git add cmd/cognitiveservices.go cmd/cognitiveservices_test.go
git commit -m "fix(cognitiveservices): fix Sprintf misuse; add AnalyzeCogServicesFindings pure function with test"
```

---

### Task 5: `cosmosdb.go` — port `AnalyzeCosmosDBFindings`

**Files:**
- Modify: `cmd/cosmosdb.go`
- Test: `cmd/cosmosdb_test.go` (new file)

**Interfaces:**
- Consumes: `armcosmos.DatabaseAccountGetResults` (already imported, `armcosmos/v3`).
- Produces: `AnalyzeCosmosDBFindings(accounts []*armcosmos.DatabaseAccountGetResults) []CosmosDBFinding` (SQL-throughput-at-container-level check confirmed skipped — needs a live client).

- [ ] **Step 1: Read the source function**

Read `external/yomal/CLI Engine/cmd/cosmosdb.go` for `AnalyzeCosmosDBFindings`. 12 checks total in the live version; confirm exactly which are present in this pure variant (throughput checks need live client, so expect them excluded — verify against source, don't assume).

- [ ] **Step 2: Write the failing test**

```go
package cmd

import (
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/cosmos/armcosmos/v3"
)

func TestAnalyzeCosmosDBFindings_PublicNetworkAccess(t *testing.T) {
	name := "my-cosmos"
	enabled := armcosmos.PublicNetworkAccessEnabled
	accounts := []*armcosmos.DatabaseAccountGetResults{
		{
			Name: &name,
			Properties: &armcosmos.DatabaseAccountGetProperties{
				PublicNetworkAccess: &enabled,
			},
		},
	}

	findings := AnalyzeCosmosDBFindings(accounts)

	found := false
	for _, f := range findings {
		if f.Category == "Public Network Access" {
			found = true
		}
	}
	if !found {
		t.Error("expected a Public Network Access finding when enabled, got none")
	}
}
```

Match exact field/type names to `computeCosmosDBFindings`'s existing usage of the same SDK type.

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./cmd/... -run TestAnalyzeCosmosDBFindings -v`
Expected: FAIL.

- [ ] **Step 4: Port the function**

Copy `AnalyzeCosmosDBFindings` from `external/yomal/CLI Engine/cmd/cosmosdb.go` into `cmd/cosmosdb.go`. Retype mojibake (em-dashes, emoji) — this source file is confirmed to have encoding corruption.

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./cmd/... -run TestAnalyzeCosmosDBFindings -v`
Expected: PASS.

- [ ] **Step 6: Verify build**

Run: `go build ./...`

- [ ] **Step 7: Commit**

```bash
git add cmd/cosmosdb.go cmd/cosmosdb_test.go
git commit -m "feat(cosmosdb): add AnalyzeCosmosDBFindings pure function, ported from yomal, with test"
```

---

### Task 6: `functions.go` — port `AnalyzeFunctionsData` + delete dead check

**Files:**
- Modify: `cmd/functions.go`
- Test: `cmd/functions_test.go` (new file)

**Interfaces:**
- Consumes: new `FunctionAppInput` struct (ported from Yomal — this is a genuinely new type in this repo).
- Produces: `FunctionAppInput` struct + `AnalyzeFunctionsData([]FunctionAppInput) []FunctionsFinding`.

- [ ] **Step 1: Delete the dead check first**

In `cmd/functions.go`, find "check #7" — a no-op block checking client certificate mode that does nothing (`if ... { // Good — just note it }` or equivalent, computing nothing and adding no finding). Delete it entirely. Renumber any comments referencing check numbers 8+ if present.

- [ ] **Step 2: Verify build after deletion**

Run: `go build ./...`
Expected: exits 0 — deleting a no-op block should never break the build.

- [ ] **Step 3: Read the source function and struct**

Read `external/yomal/CLI Engine/cmd/functions.go` for the `FunctionAppInput` struct definition and `AnalyzeFunctionsData` function (10 checks — extension version `~4`, TLS `1.2`/`1.3`, FTP `AllAllowed`, SKU `Y1`/`EP*`, etc.).

- [ ] **Step 4: Write the failing test**

```go
package cmd

import "testing"

func TestAnalyzeFunctionsData_OldRuntimeVersion(t *testing.T) {
	inputs := []FunctionAppInput{
		{
			Name:                "old-func-app",
			FunctionsVersion:    "~3",
			HTTPSOnly:           true,
			MinTLSVersion:       "1.2",
		},
	}

	findings := AnalyzeFunctionsData(inputs)

	found := false
	for _, f := range findings {
		if f.Category == "Runtime Version" {
			found = true
		}
	}
	if !found {
		t.Error("expected a Runtime Version finding for ~3, got none")
	}
}
```

Match `FunctionAppInput`'s exact field names to Yomal's real struct (confirmed in Step 3) before finalizing.

- [ ] **Step 5: Run test to verify it fails**

Run: `go test ./cmd/... -run TestAnalyzeFunctionsData -v`
Expected: FAIL — `FunctionAppInput`/`AnalyzeFunctionsData` undefined.

- [ ] **Step 6: Port the struct and function**

Copy `FunctionAppInput` and `AnalyzeFunctionsData` from `external/yomal/CLI Engine/cmd/functions.go` into `cmd/functions.go`. Retype mojibake (confirmed present in this source file).

- [ ] **Step 7: Run test to verify it passes**

Run: `go test ./cmd/... -run TestAnalyzeFunctionsData -v`
Expected: PASS.

- [ ] **Step 8: Verify build**

Run: `go build ./...`

- [ ] **Step 9: Commit**

```bash
git add cmd/functions.go cmd/functions_test.go
git commit -m "feat(functions): delete dead client-cert check; add AnalyzeFunctionsData pure function with test"
```

---

### Task 7: `iam.go` — port `ResolvedAssignment` + `AnalyzeIAMFindings`

**Files:**
- Modify: `cmd/iam.go`
- Test: `cmd/iam_test.go` (new file)

**Interfaces:**
- Consumes: new `ResolvedAssignment` type (ported), this repo's existing `CustomRole` type (already defined in `cmd/iam.go`).
- Produces: `ResolvedAssignment` type + `AnalyzeIAMFindings(assignments []ResolvedAssignment, customRoles []CustomRole, _ string) []Finding`.

- [ ] **Step 1: Read the source type and function**

Read `external/yomal/CLI Engine/cmd/iam.go` for `ResolvedAssignment` and `AnalyzeIAMFindings` — 8 finding categories (Overprivileged, ServicePrincipal Overprivileged, Too Many Owners [>3], Orphaned Assignment, Duplicate Assignment, Direct User Assignment, Classic Admin Role, Overly Broad Custom Role).

- [ ] **Step 2: Write the failing test**

```go
package cmd

import "testing"

func TestAnalyzeIAMFindings_TooManyOwners(t *testing.T) {
	assignments := make([]ResolvedAssignment, 5)
	for i := range assignments {
		assignments[i] = ResolvedAssignment{
			RoleName:      "Owner",
			PrincipalType: "User",
			PrincipalName: "user" + string(rune('A'+i)),
			Scope:         "/subscriptions/test-sub",
		}
	}

	findings := AnalyzeIAMFindings(assignments, nil, "test-sub")

	found := false
	for _, f := range findings {
		if f.Category == "Too Many Owners" {
			found = true
		}
	}
	if !found {
		t.Error("expected a Too Many Owners finding with 5 Owner assignments, got none")
	}
}
```

Match `ResolvedAssignment`'s exact field names to Yomal's real struct (confirmed in Step 1) before finalizing — the fields shown are illustrative of intent, not confirmed exact names.

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./cmd/... -run TestAnalyzeIAMFindings -v`
Expected: FAIL.

- [ ] **Step 4: Port the type and function**

Copy `ResolvedAssignment` and `AnalyzeIAMFindings` from `external/yomal/CLI Engine/cmd/iam.go` into `cmd/iam.go`.

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./cmd/... -run TestAnalyzeIAMFindings -v`
Expected: PASS.

- [ ] **Step 6: Verify build**

Run: `go build ./...`

- [ ] **Step 7: Commit**

```bash
git add cmd/iam.go cmd/iam_test.go
git commit -m "feat(iam): add ResolvedAssignment type and AnalyzeIAMFindings pure function, ported from yomal, with test"
```

---

### Task 8: `idle.go` — verify only, no port needed

**Files:** none modified — this task is verification only.

**Interfaces:** none new.

- [ ] **Step 1: Confirm no divergence was missed**

Run: `diff "cmd/idle.go" "external/yomal/CLI Engine/cmd/idle.go"`
Expected: the diff shows only additions in this repo's copy (the `provider` adapter, `IdleFinding`/`IdleSummary`/`IdleReport` structs, `computeIdleFindings`) — no lines present in Yomal's copy that are absent from this repo's. If any such line is found, stop and report it rather than proceeding — that would mean the investigation missed something.

- [ ] **Step 2: No commit for this task**

Verification-only, nothing changed.

---

### Task 9: `keyvault.go` — port `AnalyzeKeyVaultFindings`

**Files:**
- Modify: `cmd/keyvault.go`
- Test: `cmd/keyvault_test.go` (new file)

**Interfaces:**
- Consumes: `armkeyvault.Vault` (already imported).
- Produces: `AnalyzeKeyVaultFindings(vaults []*armkeyvault.Vault, _ time.Time) []KeyVaultFinding` (expiry checks confirmed skipped — need data-plane Keys/Secrets clients).

- [ ] **Step 1: Read the source function**

Read `external/yomal/CLI Engine/cmd/keyvault.go` for `AnalyzeKeyVaultFindings` — checks 1-5, 7-8 present (Access Policies vs RBAC, Soft-Delete Disabled, No Purge Protection, Unrestricted Network Access, Overly Broad Key/Secret Permissions, No Private Endpoints, Short Retention <90d); check 6 (expiry) confirmed absent.

- [ ] **Step 2: Write the failing test**

```go
package cmd

import (
	"testing"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/keyvault/armkeyvault"
)

func TestAnalyzeKeyVaultFindings_SoftDeleteDisabled(t *testing.T) {
	name := "my-vault"
	disabled := false
	vaults := []*armkeyvault.Vault{
		{
			Name: &name,
			Properties: &armkeyvault.VaultProperties{
				EnableSoftDelete: &disabled,
			},
		},
	}

	findings := AnalyzeKeyVaultFindings(vaults, time.Now())

	found := false
	for _, f := range findings {
		if f.Category == "Soft-Delete" {
			found = true
		}
	}
	if !found {
		t.Error("expected a Soft-Delete finding when EnableSoftDelete is false, got none")
	}
}
```

Match exact field/type names to `computeKeyVaultFindings`'s existing usage of the same SDK type.

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./cmd/... -run TestAnalyzeKeyVaultFindings -v`
Expected: FAIL.

- [ ] **Step 4: Port the function**

Copy `AnalyzeKeyVaultFindings` from `external/yomal/CLI Engine/cmd/keyvault.go` into `cmd/keyvault.go`.

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./cmd/... -run TestAnalyzeKeyVaultFindings -v`
Expected: PASS.

- [ ] **Step 6: Verify build**

Run: `go build ./...`

- [ ] **Step 7: Commit**

```bash
git add cmd/keyvault.go cmd/keyvault_test.go
git commit -m "feat(keyvault): add AnalyzeKeyVaultFindings pure function, ported from yomal, with test"
```

---

### Task 10: `nsg.go` — port `AnalyzeNSGFindings`

**Files:**
- Modify: `cmd/nsg.go`
- Test: `cmd/nsg_test.go` (new file)

**Interfaces:**
- Consumes: `armnetwork.SecurityGroup` (already imported, `armnetwork/v4`).
- Produces: `AnalyzeNSGFindings(nsgs []*armnetwork.SecurityGroup) []NSGFinding`.

- [ ] **Step 1: Read the source function**

Read `external/yomal/CLI Engine/cmd/nsg.go` for `AnalyzeNSGFindings` — 4 checks (Unassociated NSG, Any-Any Allow Rule, Management Port Open to Internet [SSH/RDP/SMB/SQL/MySQL/Postgres/Mongo/Redis], Internet-Facing Rule).

- [ ] **Step 2: Write the failing test**

```go
package cmd

import (
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/network/armnetwork/v4"
)

func TestAnalyzeNSGFindings_UnassociatedNSG(t *testing.T) {
	name := "orphan-nsg"
	nsgs := []*armnetwork.SecurityGroup{
		{
			Name: &name,
			Properties: &armnetwork.SecurityGroupPropertiesFormat{
				NetworkInterfaces: nil,
				Subnets:           nil,
			},
		},
	}

	findings := AnalyzeNSGFindings(nsgs)

	found := false
	for _, f := range findings {
		if f.Category == "Unassociated NSG" {
			found = true
		}
	}
	if !found {
		t.Error("expected an Unassociated NSG finding when no interfaces/subnets attached, got none")
	}
}
```

Match exact field/type names to `computeNSGFindings`'s existing usage of the same SDK type.

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./cmd/... -run TestAnalyzeNSGFindings -v`
Expected: FAIL.

- [ ] **Step 4: Port the function**

Copy `AnalyzeNSGFindings` from `external/yomal/CLI Engine/cmd/nsg.go` into `cmd/nsg.go`. Retype mojibake (confirmed present, e.g. success-emoji corruption).

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./cmd/... -run TestAnalyzeNSGFindings -v`
Expected: PASS.

- [ ] **Step 6: Verify build**

Run: `go build ./...`

- [ ] **Step 7: Commit**

```bash
git add cmd/nsg.go cmd/nsg_test.go
git commit -m "feat(nsg): add AnalyzeNSGFindings pure function, ported from yomal, with test"
```

---

### Task 11: `publicip.go` — port testable wrapper + delete dead check

**Files:**
- Modify: `cmd/publicip.go`
- Test: `cmd/publicip_test.go` (new file)

**Interfaces:**
- Consumes: this repo's existing public-IP types already used by `computePublicIPFindings`.
- Produces: the exported testable wrapper function (confirm exact name in Step 1 — do not guess).

- [ ] **Step 1: Read the source function and confirm its exact name**

Read `external/yomal/CLI Engine/cmd/publicip.go` for the exported wrapper around `analyzePublicIPs` (reported as "the exported, testable form of `analyzePublicIPs`" — get its literal name and signature, don't assume it's called `AnalyzePublicIPs`).

- [ ] **Step 2: Delete the dead check in this repo's file**

In `cmd/publicip.go`, find "Check 6" — the no-op IPv4/IPv6-version branch that computes `version` and does nothing with it (`// Just track, not a finding unless needed`). Delete it entirely.

- [ ] **Step 3: Verify build after deletion**

Run: `go build ./...`
Expected: exits 0.

- [ ] **Step 4: Write the failing test**

```go
package cmd

import (
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/network/armnetwork/v4"
)

func TestPublicIPWrapper_UnattachedFinding(t *testing.T) {
	name := "orphan-pip"
	pips := []*armnetwork.PublicIPAddress{
		{
			Name: &name,
			Properties: &armnetwork.PublicIPAddressPropertiesFormat{
				IPConfiguration: nil,
			},
		},
	}

	// Replace with the exact function name confirmed in Step 1.
	findings := AnalyzePublicIPs(pips)

	found := false
	for _, f := range findings {
		if f.Category == "Unused Resource" {
			found = true
		}
	}
	if !found {
		t.Error("expected an unattached/Unused Resource finding, got none")
	}
}
```

- [ ] **Step 5: Run test to verify it fails**

Run: `go test ./cmd/... -run TestPublicIPWrapper -v`
Expected: FAIL.

- [ ] **Step 6: Port the function**

Copy the confirmed wrapper function from `external/yomal/CLI Engine/cmd/publicip.go` into `cmd/publicip.go`.

- [ ] **Step 7: Run test to verify it passes**

Run: `go test ./cmd/... -run TestPublicIPWrapper -v`
Expected: PASS.

- [ ] **Step 8: Verify build**

Run: `go build ./...`

- [ ] **Step 9: Commit**

```bash
git add cmd/publicip.go cmd/publicip_test.go
git commit -m "feat(publicip): delete dead IPv4/IPv6 check; add testable analysis wrapper, ported from yomal, with test"
```

---

### Task 12: `resourcegroup.go` — port `RGInput` + `AnalyzeRGFindings`

**Files:**
- Modify: `cmd/resourcegroup.go`
- Test: `cmd/resourcegroup_test.go` (new file)

**Interfaces:**
- Consumes: new `RGInput` struct (ported).
- Produces: `RGInput` struct (`Name`, `Location`, `Tags`, `IsEmpty`, `HasLock`) + `AnalyzeRGFindings(rgs []RGInput) []RGFinding`.

- [ ] **Step 1: Read the source type and function**

Read `external/yomal/CLI Engine/cmd/resourcegroup.go` for `RGInput` and `AnalyzeRGFindings` — 4 checks (Empty Resource Group/Warning, Tag Compliance/Warning-or-Critical, Naming Convention/Info, Missing Lock/Info).

- [ ] **Step 2: Write the failing test**

```go
package cmd

import "testing"

func TestAnalyzeRGFindings_EmptyResourceGroup(t *testing.T) {
	rgs := []RGInput{
		{
			Name:     "rg-empty-test",
			Location: "eastus",
			Tags:     map[string]string{},
			IsEmpty:  true,
			HasLock:  false,
		},
	}

	findings := AnalyzeRGFindings(rgs)

	found := false
	for _, f := range findings {
		if f.Category == "Empty Resource Group" {
			found = true
		}
	}
	if !found {
		t.Error("expected an Empty Resource Group finding, got none")
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./cmd/... -run TestAnalyzeRGFindings -v`
Expected: FAIL.

- [ ] **Step 4: Port the type and function**

Copy `RGInput` and `AnalyzeRGFindings` from `external/yomal/CLI Engine/cmd/resourcegroup.go` into `cmd/resourcegroup.go`. Retype mojibake (confirmed present in `printRGReport`, verify the ported function itself is clean).

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./cmd/... -run TestAnalyzeRGFindings -v`
Expected: PASS.

- [ ] **Step 6: Verify build**

Run: `go build ./...`

- [ ] **Step 7: Commit**

```bash
git add cmd/resourcegroup.go cmd/resourcegroup_test.go
git commit -m "feat(resourcegroup): add RGInput type and AnalyzeRGFindings pure function, ported from yomal, with test"
```

---

### Task 13: `storage.go` — port `AnalyzeStorageFindings`

**Files:**
- Modify: `cmd/storage.go`
- Test: `cmd/storage_test.go` (new file)

**Interfaces:**
- Consumes: `armstorage.Account` (already imported).
- Produces: `AnalyzeStorageFindings(accounts []*armstorage.Account) []StorageFinding` (lifecycle-policy check confirmed skipped — needs live client).

- [ ] **Step 1: Read the source function**

Read `external/yomal/CLI Engine/cmd/storage.go` for `AnalyzeStorageFindings` — 7 checks (HTTPS enforcement, blob public access, TLS version, public network access, shared key access, lifecycle policy [skipped in this pure variant], infrastructure encryption).

- [ ] **Step 2: Write the failing test**

```go
package cmd

import (
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/storage/armstorage"
)

func TestAnalyzeStorageFindings_HTTPSNotEnforced(t *testing.T) {
	name := "mystorageacct"
	disabled := false
	accounts := []*armstorage.Account{
		{
			Name: &name,
			Properties: &armstorage.AccountProperties{
				EnableHTTPSTrafficOnly: &disabled,
			},
		},
	}

	findings := AnalyzeStorageFindings(accounts)

	found := false
	for _, f := range findings {
		if f.Category == "HTTPS Enforcement" {
			found = true
		}
	}
	if !found {
		t.Error("expected an HTTPS Enforcement finding when EnableHTTPSTrafficOnly is false, got none")
	}
}
```

Match exact field/type names to `computeStorageFindings`'s existing usage of the same SDK type.

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./cmd/... -run TestAnalyzeStorageFindings -v`
Expected: FAIL.

- [ ] **Step 4: Port the function**

Copy `AnalyzeStorageFindings` from `external/yomal/CLI Engine/cmd/storage.go` into `cmd/storage.go`.

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./cmd/... -run TestAnalyzeStorageFindings -v`
Expected: PASS.

- [ ] **Step 6: Verify build**

Run: `go build ./...`

- [ ] **Step 7: Commit**

```bash
git add cmd/storage.go cmd/storage_test.go
git commit -m "feat(storage): add AnalyzeStorageFindings pure function, ported from yomal, with test"
```

---

### Task 14: `usage.go` and `usage_acr.go` — reconcile small diffs

**Files:**
- Modify: `cmd/usage.go`, `cmd/usage_acr.go` (only if Step 1/3 find something worth taking)

**Interfaces:** none new — this task reconciles two already-existing files, no new functions.

- [ ] **Step 1: Diff usage_acr.go**

Run: `diff "cmd/usage_acr.go" "external/yomal/CLI Engine/cmd/usage_acr.go"`
Expected: a small (~2-line) diff. Read both sides of the diff and determine whether Yomal's version fixes a real bug (e.g. a missing `fmt.Sprintf` per the original scoping pass's note) or is a cosmetic/irrelevant difference.

- [ ] **Step 2: Apply the fix if it's a real bug, skip if cosmetic**

If Step 1 found a real correctness difference, apply it to `cmd/usage_acr.go` by hand (it's a 2-line change — edit directly rather than copying the whole file). If cosmetic, do nothing and note that in the commit message for Step 5 (or skip committing entirely if nothing changed).

- [ ] **Step 3: Diff usage.go**

Run: `diff "cmd/usage.go" "external/yomal/CLI Engine/cmd/usage.go"`
Expected: a ~19-line diff. Read through it — determine whether it's a real logic/bug difference or cosmetic (gofmt, unused-param naming, etc.).

- [ ] **Step 4: Apply the fix if it's a real bug, skip if cosmetic**

Same approach as Step 2 — apply real fixes by hand, skip cosmetic ones.

- [ ] **Step 5: Verify build**

Run: `go build ./...`

- [ ] **Step 6: Commit (only if something changed)**

```bash
git add cmd/usage.go cmd/usage_acr.go
git commit -m "fix(usage): reconcile real differences from yomal's copy"
```

If nothing changed in Steps 2/4, skip this commit — don't commit a no-op.

---

### Task 15: Full-suite verification

**Files:** none — this task is end-to-end verification only.

- [ ] **Step 1: Run the full test suite**

Run: `go test ./... -v`
Expected: every test in `cmd/` passes, including all 12 new `Test*` functions added in Tasks 1-13 and any pre-existing tests (`cmd/idle_test.go`, `cmd/hetzner_findings_test.go`, `cmd/hetzner_test.go`, `cmd/pp_test.go`, `cmd/provider_adapter_test.go`).

- [ ] **Step 2: Run go vet**

Run: `go vet ./...`
Expected: no output (confirms the cognitiveservices.go Sprintf fix from Task 4 actually resolved the vet-shaped issue, and no new ported code introduces a new one).

- [ ] **Step 3: Confirm the CLI still builds and runs**

Run: `go build -o btg-devops . && ./btg-devops analyze --help`
Expected: builds successfully, help output lists all existing analyze subcommands unchanged (this plan added no new Cobra commands, only unexported/exported pure functions — the CLI's command surface must be identical to before this plan started).

- [ ] **Step 4: No commit for this task**

Verification-only.
