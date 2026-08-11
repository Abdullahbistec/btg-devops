package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/chanbistec/btg-devops/internal/crypto"
	"github.com/chanbistec/btg-devops/internal/db"
	"github.com/chanbistec/btg-devops/internal/extractors"
	"github.com/chanbistec/btg-devops/internal/mailer"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/spf13/cobra"
)

// defaultAnalyzerRoutineID is the "btg-devops-mcp-analyzer" Claude Code
// routine that processes analysis_requests via the MCP server (spec 8).
// Overridable via ANALYZER_ROUTINE_ID in case the routine is ever recreated
// under a new ID.
const defaultAnalyzerRoutineID = "trig_016EuQk8v8sTJT8oiYrHbJau"

// triggerAnalyzerRoutine fires the analyzer routine immediately via its
// /fire API endpoint (https://platform.claude.com/docs/en/api/claude-code/routines-fire)
// instead of waiting for its own daily cron — otherwise an audit that
// finishes after the routine's one daily tick has its analysis pushed to
// the following day. Best-effort: a failure here is a latency regression
// (the routine's daily schedule still catches it eventually), not a reason
// to fail an otherwise-successful audit, so every error just logs and
// returns.
func triggerAnalyzerRoutine(ctx context.Context) {
	token := os.Getenv("ROUTINE_TRIGGER_TOKEN")
	if token == "" {
		fmt.Fprintln(os.Stderr, "  note: ROUTINE_TRIGGER_TOKEN not set — skipping immediate analyzer trigger (it will still run on its daily schedule)")
		return
	}
	routineID := os.Getenv("ANALYZER_ROUTINE_ID")
	if routineID == "" {
		routineID = defaultAnalyzerRoutineID
	}

	url := fmt.Sprintf("https://api.anthropic.com/v1/claude_code/routines/%s/fire", routineID)
	body, _ := json.Marshal(map[string]string{
		"text": "A new audit just finished collecting and queued analysis requests — please process them now instead of waiting for the daily schedule.",
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(string(body)))
	if err != nil {
		fmt.Fprintf(os.Stderr, "  warning: building analyzer trigger request: %v\n", err)
		return
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("anthropic-beta", "experimental-cc-routine-2026-04-01")
	req.Header.Set("anthropic-version", "2023-06-01")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "  warning: triggering analyzer routine: %v\n", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		fmt.Fprintf(os.Stderr, "  warning: analyzer trigger returned %d: %s\n", resp.StatusCode, string(body))
		return
	}
	fmt.Fprintln(os.Stderr, "  triggered analyzer routine to run immediately (same-day analysis instead of waiting for its daily schedule)")
}

var collectTrigger string

var collectCmd = &cobra.Command{
	Use:   "collect",
	Short: "Collect Azure resource data and save to PostgreSQL",
	Long: `Runs all 12 Azure resource extractors for each active subscription in the DB,
and saves results to PostgreSQL as new audit rows.

If --subscription-id is provided, only that subscription is audited.
Otherwise all active subscriptions from the DB are audited.`,
	RunE: runCollect,
}

func init() {
	rootCmd.AddCommand(collectCmd)
	collectCmd.Flags().StringVar(&flagSubscriptionID, "subscription-id", "", "Azure Subscription ID (audit only this one)")
	collectCmd.Flags().StringVar(&collectTrigger, "trigger", "manual", "How the run was triggered: manual or scheduled")
}

func runCollect(_ *cobra.Command, _ []string) error {
	ctx := context.Background()

	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		return fmt.Errorf("DATABASE_URL env var is required")
	}
	if collectTrigger != "manual" && collectTrigger != "scheduled" {
		return fmt.Errorf("--trigger must be 'manual' or 'scheduled', got %q", collectTrigger)
	}

	fmt.Fprintf(os.Stderr, "Connecting to database...\n")
	pool, err := db.Connect(ctx, databaseURL)
	if err != nil {
		return fmt.Errorf("database connection failed: %w", err)
	}
	defer pool.Close()

	if err := db.ApplySchema(ctx, pool); err != nil {
		return fmt.Errorf("schema setup failed: %w", err)
	}

	// --- Resolve which subscriptions to audit ---
	var subs []db.SubscriptionCredentials
	specificID := getSubscriptionID()

	if specificID != "" {
		sub, _ := db.FindSubscriptionCredentials(ctx, pool, specificID)
		if sub != nil {
			subs = []db.SubscriptionCredentials{*sub}
		} else {
			// Not in DB — fall back to env vars
			subs = []db.SubscriptionCredentials{{SubscriptionID: specificID, SubscriptionName: specificID}}
		}
	} else {
		subs, err = db.FindAllActiveSubscriptions(ctx, pool)
		if err != nil {
			return fmt.Errorf("loading subscriptions from DB: %w", err)
		}
		if len(subs) == 0 {
			return fmt.Errorf("no active subscriptions found in DB — add one via the dashboard or set --subscription-id")
		}
	}

	fmt.Fprintf(os.Stderr, "Auditing %d subscription(s)...\n\n", len(subs))

	var collectErrs []string
	for _, sub := range subs {
		if err := collectForSubscription(ctx, pool, sub, collectTrigger); err != nil {
			fmt.Fprintf(os.Stderr, "ERROR auditing %s: %v\n", sub.SubscriptionName, err)
			collectErrs = append(collectErrs, fmt.Sprintf("%s: %v", sub.SubscriptionName, err))
		}
	}
	if len(collectErrs) > 0 {
		return fmt.Errorf("audit collection failed for %d subscription(s): %s", len(collectErrs), strings.Join(collectErrs, "; "))
	}
	return nil
}

// failAndAlert marks the audit row failed and sends a best-effort email
// alert to every active user in a notification-enabled role. Centralized
// here so every failure path reports through the same channel instead of
// some being silent (see plan: audit-failed email).
func failAndAlert(ctx context.Context, pool *pgxpool.Pool, auditID string, sub db.SubscriptionCredentials, reason string) {
	_ = db.FailAudit(ctx, pool, auditID, reason)

	var recipients []string
	if roles, err := db.FindEnabledRoles(ctx, pool); err != nil {
		fmt.Fprintf(os.Stderr, "  warning: could not resolve notification roles: %v\n", err)
	} else if emails, err := db.FindActiveUserEmailsByRoles(ctx, pool, roles); err != nil {
		fmt.Fprintf(os.Stderr, "  warning: could not resolve notification recipients: %v\n", err)
	} else {
		recipients = emails
	}

	mailer.SendAlert(
		fmt.Sprintf("btg-devops audit failed: %s", sub.SubscriptionName),
		fmt.Sprintf("Audit %s for subscription %s (%s) failed.\n\nReason: %s", auditID, sub.SubscriptionName, sub.SubscriptionID, reason),
		recipients,
	)
}

func collectForSubscription(ctx context.Context, pool *pgxpool.Pool, sub db.SubscriptionCredentials, trigger string) error {
	subID := sub.SubscriptionID

	// --- Create audit row ---
	auditID, err := db.CreateAudit(ctx, pool, db.CreateAuditParams{
		SubscriptionID: subID,
		TriggerType:    trigger,
	})
	if err != nil {
		return fmt.Errorf("creating audit row: %w", err)
	}
	fmt.Fprintf(os.Stderr, "Audit started: %s\n\n", auditID)

	// --- Azure credentials ---
	var cred azcore.TokenCredential
	if sub.ClientSecretEnc != "" {
		secret, err := crypto.DecryptSecret(sub.ClientSecretEnc)
		if err != nil {
			failAndAlert(ctx, pool, auditID, sub, fmt.Sprintf("decrypt credentials failed: %v", err))
			return fmt.Errorf("decrypt credentials: %w", err)
		}
		cred, err = azidentity.NewClientSecretCredential(sub.TenantID, sub.ClientID, secret, nil)
		if err != nil {
			failAndAlert(ctx, pool, auditID, sub, fmt.Sprintf("azure auth failed: %v", err))
			return fmt.Errorf("azure auth failed: %w", err)
		}
		_ = db.TouchLastAudit(ctx, pool, subID)
		fmt.Fprintf(os.Stderr, "Using credentials from database for: %s\n", sub.SubscriptionName)
	} else {
		cred, err = azidentity.NewDefaultAzureCredential(nil)
		if err != nil {
			failAndAlert(ctx, pool, auditID, sub, fmt.Sprintf("azure auth failed: %v", err))
			return fmt.Errorf("azure auth failed: %w", err)
		}
		fmt.Fprintf(os.Stderr, "Using credentials from environment variables\n")
	}

	// --- Run all 12 extractors ---
	type extractor struct {
		key string
		run func() (any, error)
	}

	allExtractors := []extractor{
		{"storage", func() (any, error) { return extractors.ExtractStorage(ctx, subID, cred) }},
		{"iam", func() (any, error) { return extractors.ExtractIAM(ctx, subID, cred) }},
		{"nsg", func() (any, error) { return extractors.ExtractNSG(ctx, subID, cred) }},
		{"acr", func() (any, error) { return extractors.ExtractACR(ctx, subID, cred) }},
		{"cosmosdb", func() (any, error) { return extractors.ExtractCosmosDB(ctx, subID, cred) }},
		{"keyvault", func() (any, error) { return extractors.ExtractKeyVault(ctx, subID, cred) }},
		{"functions", func() (any, error) { return extractors.ExtractFunctions(ctx, subID, cred) }},
		{"appservice", func() (any, error) { return extractors.ExtractAppService(ctx, subID, cred) }},
		{"appserviceplan", func() (any, error) { return extractors.ExtractAppServicePlan(ctx, subID, cred) }},
		{"publicip", func() (any, error) { return extractors.ExtractPublicIP(ctx, subID, cred) }},
		{"cognitiveservices", func() (any, error) { return extractors.ExtractCognitiveServices(ctx, subID, cred) }},
		{"resourcegroup", func() (any, error) { return extractors.ExtractResourceGroup(ctx, subID, cred) }},
		{"cdn", func() (any, error) { return extractors.ExtractCDN(ctx, subID, cred) }},
		{"vm", func() (any, error) { return extractors.ExtractVM(ctx, subID, cred) }},
		// Envelope-only listing of EVERY resource type — covers the ones
		// without a dedicated extractor (spec 11 §6).
		{"inventory", func() (any, error) { return extractors.ExtractInventory(ctx, subID, cred) }},
	}

	rawData := map[string]any{
		"collected_at":    time.Now().UTC().Format(time.RFC3339),
		"subscription_id": subID,
	}
	resourceCounts := map[string]int{}
	// scopeHashes holds one SHA-256 per resource-type scope that actually
	// collected data, used by the analyzer to skip re-analyzing a scope
	// whose config hasn't changed since the previous audit (spec 14). A
	// scope is deliberately left out of this map when its extractor failed
	// — an absent hash can never look like a "match" against a prior audit,
	// so a failed extraction always forces a real re-analysis rather than
	// silently caching stale/missing data.
	scopeHashes := map[string]string{}
	var extractErrors []string
	total := len(allExtractors)

	for i, e := range allExtractors {
		fmt.Fprintf(os.Stderr, "[%d/%d] Extracting %s...\n", i+1, total, e.key)
		if err := db.UpdateAuditStep(ctx, pool, auditID, fmt.Sprintf("extracting %s (%d/%d)", e.key, i+1, total)); err != nil {
			fmt.Fprintf(os.Stderr, "  warning: %v\n", err)
		}
		data, err := e.run()
		if err != nil {
			extractErrors = append(extractErrors, fmt.Sprintf("%s: %v", e.key, err))
			fmt.Fprintf(os.Stderr, "  warning: %v\n", err)
			rawData[e.key] = nil
			resourceCounts[e.key] = 0
			continue
		}
		rawData[e.key] = data
		resourceCounts[e.key] = countResources(data)
		if hash, err := extractors.ScopeHash(data); err != nil {
			fmt.Fprintf(os.Stderr, "  warning: hashing %s: %v\n", e.key, err)
		} else {
			scopeHashes[e.key] = hash
		}
	}

	// Cost and Usage are saved into their own columns (see SaveCostUsageData
	// below), not merged into raw_data — keeping them out of that blob means
	// reading cost/usage later never requires Postgres to parse the much
	// larger 12-resource-type JSON just to pull out these two keys.
	//
	// current_step keeps counting from the extractor loop above (total+1,
	// total+2) rather than restarting at 1/2 — the dashboard's step list
	// (STEP_ORDER in app/audits/page.tsx) expects one continuous sequence of
	// 14 steps, not 12 followed by a separate 1-of-2.
	fmt.Fprintf(os.Stderr, "[1/2] Extracting cost...\n")
	if err := db.UpdateAuditStep(ctx, pool, auditID, fmt.Sprintf("extracting cost (%d/%d)", total+1, total+2)); err != nil {
		fmt.Fprintf(os.Stderr, "  warning: %v\n", err)
	}
	costData, err := extractors.ExtractCost(ctx, subID, cred)
	if err != nil {
		extractErrors = append(extractErrors, fmt.Sprintf("cost: %v", err))
		fmt.Fprintf(os.Stderr, "  warning: %v\n", err)
	}
	fmt.Fprintf(os.Stderr, "[2/2] Extracting usage...\n")
	if err := db.UpdateAuditStep(ctx, pool, auditID, fmt.Sprintf("extracting usage (%d/%d)", total+2, total+2)); err != nil {
		fmt.Fprintf(os.Stderr, "  warning: %v\n", err)
	}
	usageData, err := extractors.ExtractUsage(ctx, subID, cred)
	if err != nil {
		extractErrors = append(extractErrors, fmt.Sprintf("usage: %v", err))
		fmt.Fprintf(os.Stderr, "  warning: %v\n", err)
	}

	// If every single extractor and the cost call failed, the audit
	// collected nothing usable — treat that as a real failure instead of
	// silently completing with an empty/garbage record. Usage is excluded
	// from this count: ExtractUsage always returns a nil top-level error by
	// design (a metrics glitch on one resource shouldn't fail the whole
	// audit), so it can never appear in extractErrors and including it in
	// the threshold would make this check unreachable.
	totalChecks := total + 1
	if len(extractErrors) >= totalChecks {
		reason := fmt.Sprintf("all %d data checks failed: %s", totalChecks, strings.Join(extractErrors, "; "))
		failAndAlert(ctx, pool, auditID, sub, reason)
		return fmt.Errorf("all extractors and cost/usage failed for subscription %s", sub.SubscriptionName)
	}

	// --- Serialize and save ---
	rawJSON, err := json.Marshal(rawData)
	if err != nil {
		failAndAlert(ctx, pool, auditID, sub, fmt.Sprintf("json marshal failed: %v", err))
		return fmt.Errorf("marshaling raw data: %w", err)
	}
	countsJSON, err := json.Marshal(resourceCounts)
	if err != nil {
		failAndAlert(ctx, pool, auditID, sub, fmt.Sprintf("json marshal failed: %v", err))
		return fmt.Errorf("marshaling resource counts: %w", err)
	}
	hashesJSON, err := json.Marshal(scopeHashes)
	if err != nil {
		failAndAlert(ctx, pool, auditID, sub, fmt.Sprintf("json marshal failed: %v", err))
		return fmt.Errorf("marshaling scope hashes: %w", err)
	}
	if err := db.CompleteAudit(ctx, pool, auditID, json.RawMessage(rawJSON), json.RawMessage(countsJSON), json.RawMessage(hashesJSON)); err != nil {
		// CompleteAudit failed, so the row is stuck at status="running" —
		// mark it failed instead of leaving it stuck forever.
		failAndAlert(ctx, pool, auditID, sub, fmt.Sprintf("completing audit failed: %v", err))
		return fmt.Errorf("saving audit: %w", err)
	}

	// Auto-queue one analysis request per resource type that actually
	// collected data, so the scheduled MCP-server analyzer has something to
	// process without anyone clicking "Analyze" in the dashboard. Best-effort
	// — a queuing failure here shouldn't fail an otherwise-successful audit.
	//
	// Each resource-type scope is checked against the last audit that
	// actually finished analyzing it (spec 14 — per-scope analysis cache):
	// an identical hash means that scope's config genuinely hasn't changed,
	// so it's queued with cache_hit=true for the analyzer to carry findings
	// forward instead of spending agent time re-deriving the same result.
	// cost/usage/"all" are never in scopeHashes, so they always queue as a
	// normal (non-cached) request — by design, per spec 14.
	var scopesToQueue []db.ScopeToQueue
	for _, e := range allExtractors {
		if resourceCounts[e.key] == 0 {
			continue
		}
		cacheHit := false
		if hash, ok := scopeHashes[e.key]; ok {
			if prevHash, found, err := db.PreviousAnalyzedScopeHash(ctx, pool, sub.SubscriptionID, auditID, e.key); err != nil {
				fmt.Fprintf(os.Stderr, "  warning: cache check for %s: %v\n", e.key, err)
			} else if found && prevHash == hash {
				// Staleness ceiling (spec 14 A5): a scope that already
				// cache-hit db.CacheStalenessCeiling times in a row forces a
				// real re-analysis now instead of caching indefinitely.
				if streak, err := db.TrailingCacheHitStreak(ctx, pool, sub.SubscriptionID, auditID, e.key); err != nil {
					fmt.Fprintf(os.Stderr, "  warning: cache streak check for %s: %v\n", e.key, err)
				} else if streak < db.CacheStalenessCeiling {
					cacheHit = true
				}
			}
		}
		scopesToQueue = append(scopesToQueue, db.ScopeToQueue{Scope: e.key, CacheHit: cacheHit})
	}
	// Cost and usage are extracted separately (see below) and previously
	// never got queued at all — the scheduled agent only ever saw the 12
	// resource-type scopes, silently skipping cost/usage analysis every
	// audit. Queue "cost" whenever any cost rows came back, and one
	// "usage:<slug>" per resource type that actually has metric data.
	if costData != nil && costData.TotalRows > 0 {
		scopesToQueue = append(scopesToQueue, db.ScopeToQueue{Scope: "cost"})
	}
	for _, slug := range extractors.UsageTypeSlugs(usageData) {
		scopesToQueue = append(scopesToQueue, db.ScopeToQueue{Scope: "usage:" + slug})
	}
	if err := db.QueueAnalysisRequests(ctx, pool, auditID, scopesToQueue); err != nil {
		fmt.Fprintf(os.Stderr, "  warning: %v\n", err)
	} else if len(scopesToQueue) > 0 {
		triggerAnalyzerRoutine(ctx)
	}

	var costJSON, usageJSON json.RawMessage
	if costData != nil {
		if costJSON, err = json.Marshal(costData); err != nil {
			fmt.Fprintf(os.Stderr, "  warning: marshaling cost data: %v\n", err)
		}
	}
	if usageData != nil {
		if usageJSON, err = json.Marshal(usageData); err != nil {
			fmt.Fprintf(os.Stderr, "  warning: marshaling usage data: %v\n", err)
		}
	}
	if err := db.SaveCostUsageData(ctx, pool, auditID, costJSON, usageJSON); err != nil {
		fmt.Fprintf(os.Stderr, "  warning: %v\n", err)
	}

	// --- Print summary ---
	fmt.Fprintf(os.Stderr, "\nAudit complete: %s\n", auditID)
	fmt.Fprintf(os.Stderr, "Resource counts:\n")
	for k, v := range resourceCounts {
		fmt.Fprintf(os.Stderr, "  %-20s %d\n", k, v)
	}
	if len(extractErrors) > 0 {
		fmt.Fprintf(os.Stderr, "\nWarnings (%d extractor(s) had errors):\n", len(extractErrors))
		for _, e := range extractErrors {
			fmt.Fprintf(os.Stderr, "  • %s\n", e)
		}
	}

	fmt.Println(auditID)
	return nil
}

func countResources(data any) int {
	if data == nil {
		return 0
	}
	b, err := json.Marshal(data)
	if err != nil {
		return 0
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		return 0
	}
	for k, v := range m {
		if len(k) > 6 && k[:6] == "total_" {
			var n int
			if err := json.Unmarshal(v, &n); err == nil {
				return n
			}
		}
	}
	return 0
}
