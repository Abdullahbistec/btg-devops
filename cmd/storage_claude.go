package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/storage/armstorage"
	"github.com/google/uuid"
)

// claudeAnalysisTimeout bounds the spawned claude process itself (the
// exec.CommandContext deadline inside defaultClaudeSpawn). It is a var (not
// a const) so tests can shrink it and keep the timeout-fallback test fast
// without a real wait.
//
// 60s (the original default) was never enough to reach a real conclusion —
// a live run against 20 real storage accounts took 4m14s (254s) end to end,
// submitting genuine Claude-judged findings; with 60s or even 180s the
// process was still killed mid-run every time, silently falling back to
// rules despite Claude never actually failing. 300s gives some margin over
// that one observed data point; it is not yet validated against the other
// 18 services Phase 2 will add, some of which may need more.
var claudeAnalysisTimeout = 300 * time.Second

// claudeHandoffGracePeriod bounds how long runStorageAnalysis waits for the
// handoff file *after* spawn has already returned successfully. defaultClaudeSpawn's
// exec.CommandContext.Run() is synchronous — it blocks until the claude
// process exits — so by the time spawn returns, the process is already gone.
// If it exited 0 without calling submit_findings, waiting the full
// claudeAnalysisTimeout again can never help; a short grace period covers
// any last write/rename delay in the MCP server writing the handoff file
// (see writeHandoffResult's write-then-rename) without doubling the cost of
// a silent no-op run. It is a var so tests can shrink it further.
var claudeHandoffGracePeriod = 3 * time.Second

// storageFetcher abstracts fetchStorageAccounts so tests can stub out the
// Azure round-trip. This matters because a nil *azidentity.DefaultAzureCredential
// (as used in tests that don't have live Azure credentials) doesn't make
// fetchStorageAccounts return an error — it panics deep inside the azidentity
// SDK's token-acquisition chain (a nil-receiver dereference), before any
// network call happens. Overriding this var lets tests exercise
// runStorageAnalysis's Claude/fallback decision without hitting that panic.
var storageFetcher = fetchStorageAccounts

// ClaudeSpawner spawns `claude -p` for one service's analysis. Injected so
// tests can stub success/failure without a real claude binary.
type ClaudeSpawner func(promptPath, requestID, rawDataPath string, timeout time.Duration) error

// mcpConfigPath points at the repo's .mcp.json, which declares the
// "btg-devops" MCP server (HTTP transport, submit_findings et al. — see
// cmd/mcp.go). It's a bare relative path, same fragility as promptPath below
// (resolved relative to the spawned process's cwd, not anchored to the repo
// root or binary location) — every invocation context Phase 1 exercises
// (manual repo-root run, CI) runs from the repo root, so this works today;
// see docs/superpowers/sdd .../progress.md's Task 4/5 conflict-scan note for
// the same tradeoff already accepted for promptPath.
const mcpConfigPath = ".mcp.json"

func defaultClaudeSpawn(promptPath, requestID, rawDataPath string, timeout time.Duration) error {
	prompt, err := os.ReadFile(promptPath)
	if err != nil {
		return fmt.Errorf("reading prompt file: %w", err)
	}
	fullPrompt := fmt.Sprintf("%s\n\nYour request_id is: %s\nRaw resource data is in the file: %s (read it with your file tools)", string(prompt), requestID, rawDataPath)

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	// --mcp-config/--strict-mcp-config are required: without them, `claude -p`
	// has no way to know the "btg-devops" MCP server (and its submit_findings
	// tool) exists at all — --allowedTools alone only pre-approves a tool
	// name, it doesn't register the server that provides it. --strict-mcp-config
	// makes this the *only* MCP config claude loads (ignoring any user/global
	// config), so this spawn's tool surface is fully determined by this repo's
	// .mcp.json, matching how web/lib/routine-trigger.ts's triggerQueueDrain
	// spawns `claude -p` with MCP tool access (it also relies on --allowedTools
	// alone to pre-approve tools without an interactive permission prompt — no
	// --dangerously-skip-permissions or similar is needed here either).
	//
	// --add-dir os.TempDir() is required too: rawDataPath lives in the OS temp
	// directory (see runStorageAnalysis), outside the project's working
	// directory that Claude Code's Read tool is sandboxed to by default.
	// Without this, the spawned agent correctly refuses to read rawDataPath,
	// exits 0 having never called submit_findings, and the caller silently
	// falls back to rule-based analysis — every single time, on any machine.
	//
	// The prompt itself is piped via Stdin, not passed as a "-p <prompt>"
	// argument: `claude` on Windows resolves to a .cmd shim, and Go's
	// os/exec routes .cmd/.bat targets through cmd.exe — whose command-line
	// parsing truncates an argument at its first embedded newline,
	// regardless of Go's own (correct) quoting. A multi-paragraph prompt
	// like docs/prompts/storage.md silently arrived as just its first line,
	// which claude reasonably read as an ambiguous one-word request and
	// asked for clarification instead of ever calling submit_findings —
	// exiting 0, so this looked identical to a clean no-op run. Stdin never
	// passes through cmd.exe's argument parser, so this sidesteps the
	// truncation entirely rather than working around it.
	c := exec.CommandContext(ctx, "claude", "-p",
		"--mcp-config", mcpConfigPath,
		"--strict-mcp-config",
		"--add-dir", os.TempDir(),
		"--allowedTools", "mcp__btg-devops__submit_findings,Read",
	)
	c.Stdin = strings.NewReader(fullPrompt)
	// Without this, Cmd.Run() discards both to /dev/null (Go's default when
	// Stdout/Stderr are nil) — this was the exact reason the earlier missing
	// --add-dir bug was invisible: claude's own explanation of why it
	// couldn't proceed went nowhere anyone would see it.
	c.Stdout = os.Stderr
	c.Stderr = os.Stderr
	return c.Run()
}

// runStorageAnalysis tries a Claude-based judgment first; on any failure
// (spawn error, or the handoff file never appearing within the timeout)
// it falls back to the existing Go rule-check logic on the same fetched
// data. Both paths reuse fetchStorageAccounts so raw data is fetched once.
func runStorageAnalysis(ctx context.Context, cred *azidentity.DefaultAzureCredential, subID string, spawn ClaudeSpawner) (StorageReport, error) {
	accounts, mgmtPolicyClient, err := storageFetcher(ctx, cred, subID, flagResourceGroup)
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

	// spawn already returned (it runs c.Run() synchronously, blocking until
	// the claude process exits), so the process is gone by this point — a
	// short grace period covers any last write/rename delay, rather than
	// waiting the full claudeAnalysisTimeout a second time for something that
	// can no longer arrive.
	findings, werr := WaitForHandoff(resultPath, claudeHandoffGracePeriod)
	if werr != nil {
		fmt.Fprintf(os.Stderr, "[storage] Claude analysis timed out or failed (%v), falling back to rule-based analysis\n", werr)
		return analyzeStorageAccounts(accounts, mgmtPolicyClient, ctx), nil
	}

	return handoffFindingsToStorageReport(findings, accounts), nil
}

// handoffFindingsToStorageReport converts the Claude-sourced findings into a
// StorageReport. TotalAccounts/ByKind/ByReplication are computed from the
// actually-fetched accounts (mirroring analyzeStorageAccounts' own logic)
// rather than left blank, so the Claude-success path doesn't silently lose
// summary content the rule-based fallback path always provides.
func handoffFindingsToStorageReport(findings []HandoffFinding, accounts []*armstorage.Account) StorageReport {
	summary := StorageSummary{
		TotalAccounts:      len(accounts),
		FindingsBySeverity: map[string]int{},
		ByKind:             map[string]int{},
		ByReplication:      map[string]int{},
		Engine:             "claude",
	}
	for _, acct := range accounts {
		if acct.Kind != nil {
			summary.ByKind[string(*acct.Kind)]++
		}
		if acct.SKU != nil && acct.SKU.Name != nil {
			summary.ByReplication[string(*acct.SKU.Name)]++
		}
	}

	out := make([]StorageFinding, len(findings))
	for i, f := range findings {
		out[i] = StorageFinding{
			Severity:       Severity(f.Severity),
			Category:       f.Category,
			StorageAccount: f.Resource,
			ResourceGroup:  f.ResourceGroup,
			Description:    f.Description,
			Recommendation: f.Recommendation,
			Confidence:     f.Confidence,
			Reasoning:      f.Reasoning,
		}
		summary.FindingsBySeverity[f.Severity]++
	}
	return StorageReport{Summary: summary, Findings: out}
}
