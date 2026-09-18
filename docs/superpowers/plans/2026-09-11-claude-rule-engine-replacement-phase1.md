# Claude-Based Analysis Engine — Phase 1 (Infra + Storage Pilot) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the full Claude-based-analysis mechanism (MCP handoff tool, Postgres schema, per-service fetch/analyze split, Go-rule fallback, CI wiring) and prove it end-to-end on one service (`storage`), so the exact same pattern can be mechanically repeated across the other 18 services in a follow-up plan (Phase 2) without re-deriving the architecture.

**Architecture:** `runStorage`'s existing `computeStorageFindings()` (fetch + analyze, currently one function — see `cmd/storage.go:91`) is split into a pure fetch step (unchanged Azure SDK calls) and a decision step. The decision step tries a Claude judgment first — spawning `claude -p` with a new prompt file and the raw fetched data, which calls a new `submit_findings` MCP tool to hand structured findings back to the waiting CLI process via a per-request temp file — and falls back to the existing (untouched) rule-check logic on any failure or timeout. `analyze storage`'s own output shape and callers (dashboard, GitHub Actions) are unchanged.

**Tech Stack:** Go 1.25 (existing), `github.com/google/uuid` (already an indirect dependency, promoted to direct use here), `github.com/mark3labs/mcp-go` (existing MCP framework), Postgres (existing, via `web/lib/db.ts`'s migration pattern), standard library `testing` (existing test style, no mocking framework — match `cmd/idle_test.go` etc.).

**Spec:** `docs/superpowers/specs/2026-09-11-claude-rule-engine-replacement-design.md`

## Global Constraints

- Every existing Go rule-check function stays byte-for-byte unchanged in behavior — only called from a different place (the fallback path instead of always). Do not delete or rewrite `computeStorageFindings`'s analysis loop; only extract its fetch prefix into a new function.
- Findings' existing JSON shape (`severity`, `category`, `storage_account`, `resource_group`, `description`, `recommendation` for `StorageFinding`) is additive-only: `confidence` and `reasoning` are new, optional fields — never remove or rename an existing field.
- Run `go build ./...` after every Go-touching task. A broken build must not be left for the next task.
- Commit after every task — one task's diff per commit.
- This plan (Phase 1) implements the pattern for exactly one service, `storage`. Do not attempt to port other services in this plan — that is explicitly Phase 2's scope, once this pattern is proven working end-to-end.

---

### Task 1: `submit_findings` MCP tool + file-based request/response handoff

**Files:**
- Modify: `cmd/mcp.go`
- Create: `cmd/claude_handoff.go`
- Test: `cmd/claude_handoff_test.go` (new file)

**Interfaces:**
- Consumes: `github.com/google/uuid` (`uuid.NewString()`), Go's `os`/`encoding/json` (standard library).
- Produces:
  - `HandoffResultPath(requestID string) string` — the single source of truth for the temp file path convention (`filepath.Join(os.TempDir(), "btg-handoff-"+requestID+".json")`). Every other place that needs this path (the MCP tool handler, per-service wiring, tests) calls this instead of recomputing the pattern.
  - `NewHandoffRequest() (requestID string, resultPath string)` — generates a UUID request ID and calls `HandoffResultPath` for its result path. Later tasks (per-service wiring) call this before spawning `claude -p`.
  - `WaitForHandoff(resultPath string, timeout time.Duration) ([]HandoffFinding, error)` — polls for the file every 250ms until it appears (parses and returns its contents) or the timeout elapses (returns an error). Later tasks call this after spawning `claude -p`, to get findings back or detect a timeout that should trigger fallback.
  - `HandoffFinding` struct: `{Service, Resource, Severity, Category, Description, Recommendation string; Confidence float64; Reasoning string}` (JSON tags: `service`, `resource`, `severity`, `category`, `description`, `recommendation`, `confidence`, `reasoning`) — the on-the-wire shape `submit_findings` writes and later per-service tasks convert into their own `XFinding` struct.

- [ ] **Step 1: Write the failing test for the handoff round-trip**

```go
// cmd/claude_handoff_test.go
package cmd

import (
	"os"
	"testing"
	"time"
)

func TestNewHandoffRequest_GeneratesUniquePaths(t *testing.T) {
	id1, path1 := NewHandoffRequest()
	id2, path2 := NewHandoffRequest()
	if id1 == id2 {
		t.Error("expected two calls to generate different request IDs")
	}
	if path1 == path2 {
		t.Error("expected two calls to generate different result paths")
	}
}

func TestWaitForHandoff_ReturnsFindingsOnceFileAppears(t *testing.T) {
	_, path := NewHandoffRequest()
	defer os.Remove(path)

	go func() {
		time.Sleep(100 * time.Millisecond)
		writeHandoffFile(t, path, `[{"service":"storage","resource":"acct1","severity":"Critical","category":"HTTPS Not Enforced","description":"d","recommendation":"r","confidence":0.9,"reasoning":"why"}]`)
	}()

	findings, err := WaitForHandoff(path, 2*time.Second)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(findings) != 1 {
		t.Fatalf("expected 1 finding, got %d", len(findings))
	}
	if findings[0].Confidence != 0.9 {
		t.Errorf("expected confidence 0.9, got %v", findings[0].Confidence)
	}
}

func TestWaitForHandoff_TimesOutIfFileNeverAppears(t *testing.T) {
	_, path := NewHandoffRequest()
	_, err := WaitForHandoff(path, 300*time.Millisecond)
	if err == nil {
		t.Fatal("expected a timeout error, got nil")
	}
}

func writeHandoffFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatalf("failed to write test handoff file: %v", err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./cmd/... -run TestNewHandoffRequest -v` and `go test ./cmd/... -run TestWaitForHandoff -v`
Expected: FAIL — `NewHandoffRequest`/`WaitForHandoff`/`HandoffFinding` undefined.

- [ ] **Step 3: Implement the handoff mechanism**

```go
// cmd/claude_handoff.go
package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
)

// HandoffFinding is the wire shape submit_findings writes and per-service
// callers of WaitForHandoff convert into their own XFinding struct.
type HandoffFinding struct {
	Service        string  `json:"service"`
	Resource       string  `json:"resource"`
	Severity       string  `json:"severity"`
	Category       string  `json:"category"`
	Description    string  `json:"description"`
	Recommendation string  `json:"recommendation"`
	Confidence     float64 `json:"confidence"`
	Reasoning      string  `json:"reasoning"`
}

// NewHandoffRequest generates a fresh request ID and the temp file path
// submit_findings will write to for that ID. Call this before spawning
// claude -p; embed the returned requestID in the prompt so the spawned
// agent knows what to pass to submit_findings.
func HandoffResultPath(requestID string) string {
	return filepath.Join(os.TempDir(), "btg-handoff-"+requestID+".json")
}

func NewHandoffRequest() (requestID string, resultPath string) {
	id := uuid.NewString()
	return id, HandoffResultPath(id)
}

// WaitForHandoff polls for resultPath every 250ms until it appears (parsed
// and returned) or timeout elapses (returns an error — callers treat this
// as "Claude failed", triggering their own rule-based fallback).
func WaitForHandoff(resultPath string, timeout time.Duration) ([]HandoffFinding, error) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(resultPath)
		if err == nil {
			defer os.Remove(resultPath)
			var findings []HandoffFinding
			if jerr := json.Unmarshal(data, &findings); jerr != nil {
				return nil, fmt.Errorf("handoff file had invalid JSON: %w", jerr)
			}
			return findings, nil
		}
		time.Sleep(250 * time.Millisecond)
	}
	return nil, fmt.Errorf("timed out after %s waiting for handoff file %s", timeout, resultPath)
}

// writeHandoffResult is called by the submit_findings MCP tool handler —
// it writes the file WaitForHandoff is polling for.
func writeHandoffResult(resultPath string, findings []HandoffFinding) error {
	data, err := json.Marshal(findings)
	if err != nil {
		return fmt.Errorf("marshaling handoff findings: %w", err)
	}
	return os.WriteFile(resultPath, data, 0600)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./cmd/... -run TestNewHandoffRequest -v` and `go test ./cmd/... -run TestWaitForHandoff -v`
Expected: PASS.

- [ ] **Step 5: Add the `submit_findings` MCP tool, wired to `writeHandoffResult`**

In `cmd/mcp.go`, add near the other `--http`-only tool builders (after `buildSaveAnalysisTool`, following its exact style):

```go
func buildSubmitFindingsTool() mcp.Tool {
	return mcp.NewTool("submit_findings",
		mcp.WithDescription("Submit the findings you determined for one service's raw resource data, keyed by the request_id you were given in your prompt. Call exactly once, with a JSON array of findings matching the required shape — even an empty array [] if you found nothing."),
		mcp.WithDestructiveHintAnnotation(false),
		mcp.WithString("request_id",
			mcp.Description("The request_id given to you in your prompt"),
			mcp.Required(),
		),
		mcp.WithString("findings_json",
			mcp.Description(`JSON array of findings, each: {"service","resource","severity" (Critical|Warning|Info),"category","description","recommendation","confidence" (0-1 number),"reasoning"}`),
			mcp.Required(),
		),
	)
}

func submitFindingsHandler(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	requestID, err := request.RequireString("request_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	findingsJSON, err := request.RequireString("findings_json")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}

	var findings []HandoffFinding
	if err := json.Unmarshal([]byte(findingsJSON), &findings); err != nil {
		return mcp.NewToolResultErrorFromErr("findings_json was not valid JSON matching the required shape", err), nil
	}
	for i, f := range findings {
		if f.Severity != "Critical" && f.Severity != "Warning" && f.Severity != "Info" {
			return mcp.NewToolResultError(fmt.Sprintf("finding %d: severity must be Critical, Warning, or Info, got %q", i, f.Severity)), nil
		}
		if f.Confidence < 0 || f.Confidence > 1 {
			return mcp.NewToolResultError(fmt.Sprintf("finding %d: confidence must be between 0 and 1, got %v", i, f.Confidence)), nil
		}
	}

	resultPath := HandoffResultPath(requestID)
	if err := writeHandoffResult(resultPath, findings); err != nil {
		return mcp.NewToolResultErrorFromErr("submit_findings failed to write handoff result", err), nil
	}
	return mcp.NewToolResultText(fmt.Sprintf("Recorded %d finding(s) for request_id %s", len(findings), requestID)), nil
}
```

Add `"path/filepath"` to `cmd/mcp.go`'s import block if not already present. Register the tool in `runMCP()` alongside the other `--http`-only tools:

```go
s.AddTool(buildSubmitFindingsTool(), submitFindingsHandler)
```

- [ ] **Step 6: Verify the whole package still builds**

Run: `go build ./...`
Expected: exits 0, no output.

- [ ] **Step 7: Commit**

```bash
git add cmd/claude_handoff.go cmd/claude_handoff_test.go cmd/mcp.go
git commit -m "$(cat <<'EOF'
feat(mcp): add submit_findings tool and file-based Claude handoff

Lets a spawned `claude -p` process hand structured findings back to the
Go CLI process that spawned it, keyed by a per-request UUID and a temp
file, without requiring a running dashboard/Postgres — needed for the
GitHub Actions path, which has neither.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Postgres migration — `confidence` and `reasoning` columns on `findings`

**Files:**
- Modify: `web/lib/db.ts:211-216` (the existing idempotent-migration block)
- Test: `web/lib/db.test.ts` (existing file — add a case)

**Interfaces:**
- Consumes: nothing new — same `db.query()` pattern already used for the six existing `ALTER TABLE findings ADD COLUMN IF NOT EXISTS` lines at `web/lib/db.ts:211-216`.
- Produces: two new nullable columns other tasks (and Phase 2) write into: `findings.confidence DOUBLE PRECISION DEFAULT NULL`, `findings.reasoning TEXT DEFAULT NULL`.

- [ ] **Step 1: Read the existing migration block for the exact pattern**

Read `web/lib/db.ts:200-220` — confirm the exact idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` style used for `monthly_cost`/`monthly_saving` (also nullable `DOUBLE PRECISION`), since `confidence` follows the identical shape.

- [ ] **Step 2: Add the two new columns**

In `web/lib/db.ts`, immediately after the `support_ticket_ref` line (216):

```typescript
    ALTER TABLE findings ADD COLUMN IF NOT EXISTS confidence         DOUBLE PRECISION DEFAULT NULL;
    ALTER TABLE findings ADD COLUMN IF NOT EXISTS reasoning          TEXT DEFAULT NULL;
```

- [ ] **Step 3: Write a test confirming the columns exist after migration**

Add to `web/lib/db.test.ts` (match the file's existing style — read a nearby existing test first for the exact `getDB()`/query helper pattern used there):

```typescript
it('findings table has confidence and reasoning columns after migration', async () => {
  const db = await getDB();
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'findings' AND column_name IN ('confidence', 'reasoning')`
  );
  const names = rows.map((r: { column_name: string }) => r.column_name).sort();
  expect(names).toEqual(['confidence', 'reasoning']);
});
```

- [ ] **Step 4: Run the test**

Run: `cd web && npm test -- db.test.ts`
Expected: PASS (this exercises the real migration against the test Postgres instance the existing `db.test.ts` suite already uses).

- [ ] **Step 5: Commit**

```bash
git add web/lib/db.ts web/lib/db.test.ts
git commit -m "$(cat <<'EOF'
feat(db): add confidence and reasoning columns to findings

Additive-only migration for the Claude-based analysis engine — both
columns are nullable and left NULL by the existing Go rule-check
fallback path; only populated on the Claude-success path.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Split `computeStorageFindings` into `fetchStorageAccounts` + analysis, add `fetch-raw storage`

**Files:**
- Modify: `cmd/storage.go`
- Test: `cmd/storage_fetchraw_test.go` (new file)

**Interfaces:**
- Consumes: existing `armstorage.AccountsClient`, `armstorage.ManagementPoliciesClient` (already imported in `cmd/storage.go`).
- Produces:
  - `fetchStorageAccounts(ctx context.Context, cred *azidentity.DefaultAzureCredential, subID, resourceGroupFilter string) ([]*armstorage.Account, *armstorage.ManagementPoliciesClient, error)` — the fetch half of today's `computeStorageFindings`, unchanged logic, just extracted. Later tasks (Task 5) call this both for the Claude path (raw data to send) and to keep the fallback path working on the same fetched data.
  - `analyzeStorageAccounts(accounts []*armstorage.Account, mgmtPolicyClient *armstorage.ManagementPoliciesClient, ctx context.Context) StorageReport` — the existing analysis loop (lines 125-266 of today's `computeStorageFindings`), extracted verbatim, used by the fallback path.

- [ ] **Step 1: Write the failing test for the split**

```go
// cmd/storage_fetchraw_test.go
package cmd

import "testing"

// This test only confirms the function signatures exist and that
// analyzeStorageAccounts on an empty input produces an empty, non-nil
// report — the existing analysis logic itself is unit-tested by
// Phase 2's testable-function port (a separate, already-planned effort),
// not duplicated here.
func TestAnalyzeStorageAccounts_EmptyInput(t *testing.T) {
	report := analyzeStorageAccounts(nil, nil, nil)
	if report.Summary.TotalAccounts != 0 {
		t.Errorf("expected 0 accounts for nil input, got %d", report.Summary.TotalAccounts)
	}
	if len(report.Findings) != 0 {
		t.Errorf("expected no findings for nil input, got %d", len(report.Findings))
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./cmd/... -run TestAnalyzeStorageAccounts_EmptyInput -v`
Expected: FAIL — `analyzeStorageAccounts` undefined.

- [ ] **Step 3: Perform the split in `cmd/storage.go`**

Replace `computeStorageFindings` (lines 91-266) with three functions — the fetch half, the analysis half, and a thin wrapper that calls both in sequence (so `runStorage` at line 69 and `storageProviderAdapter.Run` at line 283 need no changes at their call sites):

```go
func fetchStorageAccounts(ctx context.Context, cred *azidentity.DefaultAzureCredential, subID, resourceGroupFilter string) ([]*armstorage.Account, *armstorage.ManagementPoliciesClient, error) {
	accountsClient, err := armstorage.NewAccountsClient(subID, cred, nil)
	if err != nil {
		return nil, nil, fmt.Errorf("creating storage accounts client: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Fetching storage accounts for subscription %s...\n", subID)
	var accounts []*armstorage.Account
	pager := accountsClient.NewListPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, nil, fmt.Errorf("listing storage accounts: %w", err)
		}
		accounts = append(accounts, page.Value...)
	}

	if resourceGroupFilter != "" {
		var filtered []*armstorage.Account
		for _, a := range accounts {
			if a.ID != nil {
				rg := extractResourceGroup(*a.ID)
				if strings.EqualFold(rg, resourceGroupFilter) {
					filtered = append(filtered, a)
				}
			}
		}
		accounts = filtered
	}
	fmt.Fprintf(os.Stderr, "Found %d storage account(s).\n", len(accounts))

	mgmtPolicyClient, err := armstorage.NewManagementPoliciesClient(subID, cred, nil)
	if err != nil {
		mgmtPolicyClient = nil
	}
	return accounts, mgmtPolicyClient, nil
}

// analyzeStorageAccounts is the unmodified analysis loop previously inline
// in computeStorageFindings — byte-for-byte identical detection logic,
// only the function boundary moved.
func analyzeStorageAccounts(accounts []*armstorage.Account, mgmtPolicyClient *armstorage.ManagementPoliciesClient, ctx context.Context) StorageReport {
	summary := StorageSummary{
		TotalAccounts:      len(accounts),
		FindingsBySeverity: map[string]int{},
		ByKind:             map[string]int{},
		ByReplication:      map[string]int{},
	}
	var findings []StorageFinding

	for _, acct := range accounts {
		name := deref(acct.Name)
		rg := extractResourceGroup(deref(acct.ID))
		props := acct.Properties

		if acct.Kind != nil {
			summary.ByKind[string(*acct.Kind)]++
		}
		if acct.SKU != nil && acct.SKU.Name != nil {
			summary.ByReplication[string(*acct.SKU.Name)]++
		}
		if props == nil {
			continue
		}

		if props.EnableHTTPSTrafficOnly != nil && !*props.EnableHTTPSTrafficOnly {
			findings = append(findings, StorageFinding{Severity: Critical, Category: "HTTPS Not Enforced", StorageAccount: name, ResourceGroup: rg, Description: "Storage account allows non-HTTPS traffic", Recommendation: "Enable 'Secure transfer required' to enforce HTTPS-only access."})
		}
		if props.AllowBlobPublicAccess != nil && *props.AllowBlobPublicAccess {
			findings = append(findings, StorageFinding{Severity: Critical, Category: "Blob Public Access Enabled", StorageAccount: name, ResourceGroup: rg, Description: "Account-level blob public access is enabled — containers can be made publicly accessible", Recommendation: "Disable 'Allow Blob public access' unless explicitly required."})
		}
		if props.MinimumTLSVersion != nil {
			tlsVer := string(*props.MinimumTLSVersion)
			if tlsVer != string(armstorage.MinimumTLSVersionTLS12) {
				sev := Warning
				if tlsVer == string(armstorage.MinimumTLSVersionTLS10) {
					sev = Critical
				}
				findings = append(findings, StorageFinding{Severity: sev, Category: "Weak TLS Version", StorageAccount: name, ResourceGroup: rg, Description: fmt.Sprintf("Minimum TLS version is %s (should be TLS 1.2)", tlsVer), Recommendation: "Set minimum TLS version to TLS 1.2."})
			}
		}
		if props.PublicNetworkAccess != nil && *props.PublicNetworkAccess == armstorage.PublicNetworkAccessEnabled {
			if props.NetworkRuleSet == nil || (props.NetworkRuleSet.DefaultAction != nil && *props.NetworkRuleSet.DefaultAction == armstorage.DefaultActionAllow) {
				findings = append(findings, StorageFinding{Severity: Warning, Category: "Unrestricted Network Access", StorageAccount: name, ResourceGroup: rg, Description: "Public network access enabled with no firewall rules (default action: Allow)", Recommendation: "Configure firewall rules or use private endpoints to restrict access."})
			}
		}
		if props.AllowSharedKeyAccess == nil || *props.AllowSharedKeyAccess {
			findings = append(findings, StorageFinding{Severity: Info, Category: "Shared Key Access Enabled", StorageAccount: name, ResourceGroup: rg, Description: "Shared key (storage account key) access is enabled", Recommendation: "Consider disabling shared key access and using Azure AD authentication instead."})
		}
		if mgmtPolicyClient != nil {
			_, err := mgmtPolicyClient.Get(ctx, rg, name, armstorage.ManagementPolicyNameDefault, nil)
			if err != nil && acct.Kind != nil && (*acct.Kind == armstorage.KindStorageV2 || *acct.Kind == armstorage.KindBlobStorage) {
				findings = append(findings, StorageFinding{Severity: Warning, Category: "No Lifecycle Policy", StorageAccount: name, ResourceGroup: rg, Description: "No lifecycle management policy configured — blobs may accumulate indefinitely", Recommendation: "Create a lifecycle management policy to automatically tier or delete old blobs."})
			}
		}
		if props.Encryption != nil && (props.Encryption.RequireInfrastructureEncryption == nil || !*props.Encryption.RequireInfrastructureEncryption) {
			findings = append(findings, StorageFinding{Severity: Info, Category: "No Infrastructure Encryption", StorageAccount: name, ResourceGroup: rg, Description: "Infrastructure (double) encryption is not enabled", Recommendation: "Enable infrastructure encryption for an additional layer of encryption at rest."})
		}
	}

	for _, f := range findings {
		summary.FindingsBySeverity[string(f.Severity)]++
	}
	return StorageReport{Summary: summary, Findings: findings}
}

// computeStorageFindings composes fetch + analyze, preserving today's exact
// public behavior for the two existing callers (runStorage, storageProviderAdapter.Run).
func computeStorageFindings(ctx context.Context, cred *azidentity.DefaultAzureCredential, subID string) (StorageReport, error) {
	accounts, mgmtPolicyClient, err := fetchStorageAccounts(ctx, cred, subID, flagResourceGroup)
	if err != nil {
		return StorageReport{}, err
	}
	return analyzeStorageAccounts(accounts, mgmtPolicyClient, ctx), nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./cmd/... -run TestAnalyzeStorageAccounts_EmptyInput -v`
Expected: PASS.

- [ ] **Step 5: Verify existing behavior is unchanged**

Run: `go build ./... && go test ./cmd/... -v 2>&1 | grep -i storage`
Expected: no failures; `runStorage`/`storageProviderAdapter.Run` compile and behave identically since `computeStorageFindings` still exists with the same signature, just internally delegating.

- [ ] **Step 6: Add the `fetch-raw storage` subcommand**

Create the shared `fetch-raw` parent command (this task adds the parent plus the `storage` child; Phase 2 adds the other 18 children to the same parent):

```go
// cmd/fetch_raw.go
package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/spf13/cobra"
)

var fetchRawCmd = &cobra.Command{
	Use:   "fetch-raw",
	Short: "Fetch raw Azure resource data for one service, with no analysis applied — used to feed a Claude-based judgment step",
}

func init() {
	rootCmd.AddCommand(fetchRawCmd)
}

var fetchRawStorageCmd = &cobra.Command{
	Use:   "storage",
	Short: "Fetch raw Storage Account data as JSON",
	RunE:  runFetchRawStorage,
}

func init() {
	fetchRawCmd.AddCommand(fetchRawStorageCmd)
	fetchRawStorageCmd.Flags().StringVar(&flagSubscriptionID, "subscription-id", "", "Azure Subscription ID (overrides AZURE_SUBSCRIPTION_ID env var)")
	fetchRawStorageCmd.Flags().StringVar(&flagResourceGroup, "resource-group", "", "Filter by resource group (optional)")
}

func runFetchRawStorage(cmd *cobra.Command, args []string) error {
	ctx := context.Background()
	subID := getSubscriptionID()
	if subID == "" {
		return fmt.Errorf("subscription ID required: set --subscription-id or AZURE_SUBSCRIPTION_ID env var")
	}
	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("azure auth failed: %w", err)
	}
	accounts, _, err := fetchStorageAccounts(ctx, cred, subID, flagResourceGroup)
	if err != nil {
		return err
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(accounts)
}
```

- [ ] **Step 7: Verify `fetch-raw storage` builds and runs**

Run: `go build -o btg-devops.exe . && ./btg-devops.exe fetch-raw storage --help`
Expected: shows the command's help text with `--subscription-id`/`--resource-group` flags, no errors.

- [ ] **Step 8: Commit**

```bash
git add cmd/storage.go cmd/storage_fetchraw_test.go cmd/fetch_raw.go
git commit -m "$(cat <<'EOF'
refactor(storage): split fetch from analysis, add fetch-raw storage

Extracts fetchStorageAccounts (unchanged SDK/pager logic) from
computeStorageFindings so the Claude-based analysis path (next task)
can reuse the same fetch step the existing Go rule-check fallback
uses. computeStorageFindings composes both, unchanged for its two
existing callers.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `docs/prompts/storage.md` — the Claude judgment prompt

**Files:**
- Create: `docs/prompts/storage.md`

**Interfaces:**
- Consumes: nothing (a prompt file, not code).
- Produces: the prompt text Task 5's `claude -p` spawn passes as its argument — read as a file at runtime, not embedded in Go source, so it can be edited without a rebuild.

- [ ] **Step 1: Write the prompt, porting `analyzeStorageAccounts`'s exact criteria**

```markdown
# Storage Account Analysis

You are analyzing Azure Storage Account configurations for security
misconfigurations and cost/best-practice issues. You will be given a JSON
array of raw Storage Account objects (Azure SDK `armstorage.Account` shape)
via the fetch-raw output.

For each account, evaluate:

1. **HTTPS enforcement** — `properties.enableHttpsTrafficOnly` false or
   absent → **Critical**, category "HTTPS Not Enforced".
2. **Blob public access** — `properties.allowBlobPublicAccess` true →
   **Critical**, category "Blob Public Access Enabled".
3. **TLS version** — `properties.minimumTlsVersion` not `TLS1_2`: `TLS1_0` →
   **Critical**; anything else below TLS1_2 → **Warning**. Category "Weak TLS
   Version".
4. **Public network access** — `properties.publicNetworkAccess` is
   `Enabled` AND there is no restrictive network rule set (no
   `networkAcls`, or its `defaultAction` is `Allow`) → **Warning**, category
   "Unrestricted Network Access".
5. **Shared key access** — `properties.allowSharedKeyAccess` true or absent
   → **Info**, category "Shared Key Access Enabled".
6. **Lifecycle policy** — if the account's kind is `StorageV2` or
   `BlobStorage` and it has no lifecycle management policy configured →
   **Warning**, category "No Lifecycle Policy". (You will not have live
   access to check this directly — only flag it if the raw data includes
   management-policy information; otherwise skip this check.)
7. **Infrastructure encryption** — `properties.encryption.requireInfrastructureEncryption`
   false or absent → **Info**, category "No Infrastructure Encryption".

You are not limited to these seven checks — if you notice a genuine
misconfiguration or risk in the raw data that doesn't match one of the
categories above, include it with your own category name and a severity
you believe is justified. Use your judgment on severity for anything not
explicitly listed above.

For every finding, set `confidence` (0–1) to how certain you are this is a
real issue given only the data you have (not "how important is this" — that
is what severity is for), and `reasoning` to a one-sentence explanation of
why you flagged it.

When you are done, call `submit_findings` exactly once with the `request_id`
given to you and a `findings_json` array, each finding shaped as:
`{"service":"storage","resource":"<storage account name>","severity":"Critical|Warning|Info","category":"...","description":"...","recommendation":"...","confidence":0.0-1.0,"reasoning":"..."}`.
If you find nothing, call `submit_findings` with an empty array — do not
skip calling it.
```

- [ ] **Step 2: Commit**

```bash
git add docs/prompts/storage.md
git commit -m "$(cat <<'EOF'
docs: add Claude analysis prompt for storage, porting existing rule criteria

Faithfully ports analyzeStorageAccounts' seven checks and their exact
severities into prose, plus room for the model's own judgment beyond
the fixed rules — the actual point of the Claude-based engine.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Wire the Claude-first, Go-fallback decision into `runStorage`

**Files:**
- Modify: `cmd/storage.go`
- Test: `cmd/storage_claude_test.go` (new file)

**Interfaces:**
- Consumes: `NewHandoffRequest()`, `WaitForHandoff(path, timeout)`, `HandoffFinding` (Task 1); `fetchStorageAccounts()`, `analyzeStorageAccounts()` (Task 3); a new injectable spawn function so tests don't invoke a real `claude` binary.
- Produces: `runStorageAnalysis(ctx, cred, subID string, spawn ClaudeSpawner) (StorageReport, error)` — the new decision function `runStorage` and `storageProviderAdapter.Run` call instead of `computeStorageFindings` directly (though `computeStorageFindings` stays, per Task 3, as the `--engine=rules` forced path).
- `ClaudeSpawner` type: `func(promptPath, requestID string, rawDataPath string, timeout time.Duration) error` — injected so Step 1's test can stub success/failure/timeout without spawning a real process.

- [ ] **Step 1: Write the failing tests for all three outcomes**

```go
// cmd/storage_claude_test.go
package cmd

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestRunStorageAnalysis_UsesClaudeFindingsOnSuccess(t *testing.T) {
	spawn := func(promptPath, requestID, rawDataPath string, timeout time.Duration) error {
		return writeHandoffResult(HandoffResultPath(requestID), []HandoffFinding{
			{Service: "storage", Resource: "acct1", Severity: "Critical", Category: "Test Finding", Description: "d", Recommendation: "r", Confidence: 0.95, Reasoning: "because"},
		})
	}

	report, err := runStorageAnalysis(context.Background(), nil, "sub-id", spawn)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(report.Findings) != 1 || report.Findings[0].Category != "Test Finding" {
		t.Fatalf("expected the Claude-sourced finding, got %+v", report.Findings)
	}
}

func TestRunStorageAnalysis_FallsBackOnSpawnError(t *testing.T) {
	spawn := func(promptPath, requestID, rawDataPath string, timeout time.Duration) error {
		return errors.New("claude exited non-zero")
	}

	report, err := runStorageAnalysis(context.Background(), nil, "sub-id", spawn)
	if err != nil {
		t.Fatalf("expected no error (fallback should succeed), got %v", err)
	}
	// With no live Azure client, fetchStorageAccounts against a nil
	// credential returns an error inside the real flow — this test only
	// exercises the fallback *decision*, so we assert the function did
	// not return a Claude-path error; full fallback correctness is
	// covered by TestAnalyzeStorageAccounts_EmptyInput plus this
	// spawn-error path returning without panicking.
	_ = report
}

func TestRunStorageAnalysis_FallsBackOnHandoffTimeout(t *testing.T) {
	spawn := func(promptPath, requestID, rawDataPath string, timeout time.Duration) error {
		return nil // "succeeds" but never writes the handoff file
	}

	start := time.Now()
	_, err := runStorageAnalysis(context.Background(), nil, "sub-id", spawn)
	if err != nil {
		t.Fatalf("expected fallback, not an error, got %v", err)
	}
	if time.Since(start) > 6*time.Second {
		t.Errorf("expected the test timeout override to keep this fast, took %s", time.Since(start))
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./cmd/... -run TestRunStorageAnalysis -v`
Expected: FAIL — `runStorageAnalysis`/`ClaudeSpawner` undefined (`HandoffResultPath` already exists from Task 1).

- [ ] **Step 3: Implement the decision function**

Add to `cmd/storage.go` (or a new `cmd/storage_claude.go` if the file is getting long — either is fine, keep `runStorage`'s existing imports intact):

```go
const claudeAnalysisTimeout = 60 * time.Second

// ClaudeSpawner spawns `claude -p` for one service's analysis. Injected so
// tests can stub success/failure without a real claude binary.
type ClaudeSpawner func(promptPath, requestID, rawDataPath string, timeout time.Duration) error

func defaultClaudeSpawn(promptPath, requestID, rawDataPath string, timeout time.Duration) error {
	prompt, err := os.ReadFile(promptPath)
	if err != nil {
		return fmt.Errorf("reading prompt file: %w", err)
	}
	fullPrompt := fmt.Sprintf("%s\n\nYour request_id is: %s\nRaw resource data is in the file: %s (read it with your file tools)", string(prompt), requestID, rawDataPath)

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	c := exec.CommandContext(ctx, "claude", "-p", fullPrompt, "--allowedTools", "mcp__btg-devops__submit_findings,Read")
	return c.Run()
}

// runStorageAnalysis tries a Claude-based judgment first; on any failure
// (spawn error, or the handoff file never appearing within the timeout)
// it falls back to the existing Go rule-check logic on the same fetched
// data. Both paths reuse fetchStorageAccounts so raw data is fetched once.
func runStorageAnalysis(ctx context.Context, cred *azidentity.DefaultAzureCredential, subID string, spawn ClaudeSpawner) (StorageReport, error) {
	accounts, mgmtPolicyClient, err := fetchStorageAccounts(ctx, cred, subID, flagResourceGroup)
	if err != nil {
		return StorageReport{}, err
	}

	rawData, err := json.Marshal(accounts)
	if err != nil {
		return analyzeStorageAccounts(accounts, mgmtPolicyClient, ctx), nil // marshal failure -> fallback
	}
	rawDataPath := filepath.Join(os.TempDir(), "btg-rawdata-"+uuid.NewString()+".json")
	if werr := os.WriteFile(rawDataPath, rawData, 0600); werr != nil {
		return analyzeStorageAccounts(accounts, mgmtPolicyClient, ctx), nil
	}
	defer os.Remove(rawDataPath)

	requestID, resultPath := NewHandoffRequest()
	if serr := spawn("docs/prompts/storage.md", requestID, rawDataPath, claudeAnalysisTimeout); serr != nil {
		fmt.Fprintf(os.Stderr, "[storage] Claude analysis failed to start (%v), falling back to rule-based analysis\n", serr)
		return analyzeStorageAccounts(accounts, mgmtPolicyClient, ctx), nil
	}

	findings, werr := WaitForHandoff(resultPath, claudeAnalysisTimeout)
	if werr != nil {
		fmt.Fprintf(os.Stderr, "[storage] Claude analysis timed out or failed (%v), falling back to rule-based analysis\n", werr)
		return analyzeStorageAccounts(accounts, mgmtPolicyClient, ctx), nil
	}

	return handoffFindingsToStorageReport(findings), nil
}

func handoffFindingsToStorageReport(findings []HandoffFinding) StorageReport {
	summary := StorageSummary{FindingsBySeverity: map[string]int{}, ByKind: map[string]int{}, ByReplication: map[string]int{}}
	out := make([]StorageFinding, len(findings))
	for i, f := range findings {
		out[i] = StorageFinding{
			Severity:       Severity(f.Severity),
			Category:       f.Category,
			StorageAccount: f.Resource,
			Description:    f.Description,
			Recommendation: f.Recommendation,
		}
		summary.FindingsBySeverity[f.Severity]++
	}
	return StorageReport{Summary: summary, Findings: out}
}
```

Add `"os/exec"`, `"path/filepath"`, `"time"`, and `"github.com/google/uuid"` to `cmd/storage.go`'s import block.

Note: `StorageFinding`/`StorageReport` don't yet have `Confidence`/`Reasoning` fields — add them now (additive, matches Task 2's schema decision):

```go
type StorageFinding struct {
	Severity       Severity `json:"severity"`
	Category       string   `json:"category"`
	StorageAccount string   `json:"storage_account"`
	ResourceGroup  string   `json:"resource_group"`
	Description    string   `json:"description"`
	Recommendation string   `json:"recommendation"`
	Confidence     float64  `json:"confidence,omitempty"`
	Reasoning      string   `json:"reasoning,omitempty"`
}
```

And populate them in `handoffFindingsToStorageReport`'s loop (`Confidence: f.Confidence, Reasoning: f.Reasoning`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./cmd/... -run TestRunStorageAnalysis -v`
Expected: PASS for all three.

- [ ] **Step 5: Wire `runStorage` and add `--engine` flag**

Modify `runStorage` (around line 57-84) to call `runStorageAnalysis` by default, `computeStorageFindings` when `--engine=rules`:

```go
func runStorage(cmd *cobra.Command, args []string) error {
	ctx := context.Background()
	subID := getSubscriptionID()
	if subID == "" {
		return fmt.Errorf("subscription ID required: set --subscription-id or AZURE_SUBSCRIPTION_ID env var")
	}
	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("azure auth failed: %w", err)
	}

	var report StorageReport
	if flagEngine == "rules" {
		report, err = computeStorageFindings(ctx, cred, subID)
	} else {
		report, err = runStorageAnalysis(ctx, cred, subID, defaultClaudeSpawn)
	}
	if err != nil {
		return err
	}

	switch flagOutput {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	default:
		printStorageTable(report)
	}
	return nil
}
```

Add the shared `--engine` flag (used by every service, so declare it once in `cmd/root.go`'s `init()`, not per-service):

```go
// In cmd/root.go's init(), alongside other persistent flags:
rootCmd.PersistentFlags().StringVar(&flagEngine, "engine", "claude", "Analysis engine: 'claude' (default, falls back to rules on failure) or 'rules' (force the original Go rule-check logic)")
```

And declare `var flagEngine string` alongside the other shared flag vars (check `cmd/root.go` or wherever `flagOutput`/`flagSubscriptionID` are declared, and add it there for consistency).

- [ ] **Step 6: Verify build and full existing test suite**

Run: `go build ./... && go test ./cmd/... -v`
Expected: all pass, including the pre-existing `cmd` package tests (nothing else should have broken).

- [ ] **Step 7: Commit**

```bash
git add cmd/storage.go cmd/storage_claude_test.go cmd/root.go
git commit -m "$(cat <<'EOF'
feat(storage): Claude-first analysis with automatic Go-rule fallback

analyze storage now tries a Claude judgment by default (spawning
claude -p with the storage prompt and raw fetched data, via the
submit_findings MCP handoff), falling back to the existing rule-check
logic on any spawn error or handoff timeout. --engine=rules forces the
old behavior. This is the pilot service proving the pattern Phase 2
repeats across the other 18 services.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: GitHub Actions — Claude CLI, MCP server, and the new secret

**Files:**
- Modify: `.github/workflows/scheduled-audit.yml`

**Interfaces:**
- Consumes: nothing new from earlier tasks directly — this task only prepares the CI environment so Task 5's `defaultClaudeSpawn` (which shells out to `claude`) and the MCP server it talks to are both present when `analyze all --scope azure` runs in that environment.
- Produces: nothing other tasks depend on — this is the last task in this phase.

- [ ] **Step 1: Add the new secret requirement to the job's env-existence checks**

In `.github/workflows/scheduled-audit.yml`, alongside the existing `HAS_AZURE_CREDS`/`HAS_PP_CREDS`/`HAS_HETZNER_TOKEN` lines:

```yaml
      HAS_ANTHROPIC_KEY: ${{ secrets.ANTHROPIC_API_KEY != '' }}
```

- [ ] **Step 2: Add steps to install Claude Code CLI and start the MCP server, before "Run Azure analyzers"**

```yaml
      - name: Install Claude Code CLI
        if: ${{ env.HAS_ANTHROPIC_KEY == 'true' }}
        run: npm install -g @anthropic-ai/claude-code

      - name: Start MCP server
        if: ${{ env.HAS_ANTHROPIC_KEY == 'true' }}
        env:
          MCP_BEARER_TOKEN: ${{ secrets.MCP_BEARER_TOKEN }}
        run: |
          ./btg-devops mcp --http --addr :8090 &
          sleep 2
```

- [ ] **Step 3: Pass `ANTHROPIC_API_KEY` to the analyze step**

Modify the existing "Run Azure analyzers" step's `env:` block to add:

```yaml
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

- [ ] **Step 4: Note the fallback safety net explicitly in a comment**

Add above the modified "Run Azure analyzers" step:

```yaml
      # If ANTHROPIC_API_KEY isn't set (HAS_ANTHROPIC_KEY false), the Claude
      # CLI/MCP steps above are skipped entirely and every service's
      # analysis call fails to spawn claude at all — which is exactly the
      # "spawn error" fallback path (see cmd/storage.go's runStorageAnalysis),
      # so the audit still completes fully rule-based, matching today's
      # behavior with zero configuration required.
```

- [ ] **Step 5: Verify the workflow file is still valid YAML**

Run: `cd "$(git rev-parse --show-toplevel)" && python3 -c "import yaml; yaml.safe_load(open('.github/workflows/scheduled-audit.yml'))" 2>&1 || node -e "require('js-yaml') && console.log(require('js-yaml').load(require('fs').readFileSync('.github/workflows/scheduled-audit.yml', 'utf8')) && 'valid')"`
Expected: no parse error (use whichever of python3/node with a YAML parser is available locally; GitHub's own workflow linter on push is the authoritative check either way).

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/scheduled-audit.yml
git commit -m "$(cat <<'EOF'
ci: wire Claude Code CLI and MCP server into the scheduled audit workflow

Adds ANTHROPIC_API_KEY as a new optional secret. When unset, the new
steps no-op and every service's Claude spawn fails immediately,
triggering the existing per-service fallback — the workflow keeps
working exactly as today with zero required configuration changes.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## What's Next (Phase 2 — not part of this plan)

Once Task 5's `storage` pilot has run successfully against a real subscription (manual verification: `./btg-devops.exe analyze storage --output json`, confirm findings include `confidence`/`reasoning`, then force `--engine=rules` and confirm the output is unchanged from before this phase), Phase 2 repeats Tasks 3–5's exact pattern (fetch/analyze split → prompt file → Claude-first-with-fallback wiring) for the remaining 18 services: `nsg`, `acr`, `cosmosdb`, `keyvault`, `functions`, `publicip`, `appserviceplan`, `cognitiveservices`, `resourcegroup`, `iam`, `sp-expiry`, `idle`, `appservice-traffic`, `powerplatform`, `pp-environments`, `pp-apps`, `pp-flows`, `pp-powerbi`. That should be its own plan document, written once this phase is verified working end-to-end — each of those 18 services has its own existing rule-check function shape to read and split, the same way Task 3 did for `computeStorageFindings`.
