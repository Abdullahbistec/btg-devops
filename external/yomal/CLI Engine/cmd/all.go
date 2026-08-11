package cmd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/spf13/cobra"
)

// ---------- command ----------

var allCmd = &cobra.Command{
	Use:   "all",
	Short: "Run all 12 analyzers and produce a combined report",
	Long:  "Runs every Azure resource analyzer sequentially and outputs a combined report.\nUse --output json to get a single JSON object containing all results.",
	RunE:  runAll,
}

func init() {
	analyzeCmd.AddCommand(allCmd)
	allCmd.Flags().StringVar(&flagSubscriptionID, "subscription-id", "", "Azure Subscription ID (overrides AZURE_SUBSCRIPTION_ID env var)")
	allCmd.Flags().StringVar(&flagResourceGroup, "resource-group", "", "Filter by resource group (optional)")
	allCmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
}

// ---------- analyzer registry ----------

type analyzerDef struct {
	key  string // JSON key in combined output
	name string // human-readable label
	fn   func(*cobra.Command, []string) error
}

var allAnalyzers = []analyzerDef{
	{"appservice_traffic", "App Service Traffic", runAppServiceTraffic},
	{"iam", "IAM (RBAC)", runIAM},
	{"storage", "Storage Accounts", runStorage},
	{"nsg", "Network Security Groups", runNSG},
	{"acr", "Container Registries", runACR},
	{"cosmosdb", "Cosmos DB", runCosmosDB},
	{"keyvault", "Key Vaults", runKeyVault},
	{"functions", "Azure Functions", runFunctions},
	{"publicip", "Public IP Addresses", runPublicIP},
	{"appserviceplan", "App Service Plans", runAppServicePlan},
	{"cognitiveservices", "Cognitive Services", runCognitiveServices},
	{"resourcegroup", "Resource Groups", runResourceGroup},
}

// ---------- entry point ----------

func runAll(_ *cobra.Command, _ []string) error {
	subID := getSubscriptionID()
	if subID == "" {
		return fmt.Errorf("subscription ID required: set --subscription-id or AZURE_SUBSCRIPTION_ID env var")
	}

	if flagOutput == "json" {
		return runAllJSON()
	}
	return runAllTable()
}

// ---------- table mode ----------

// runAllTable calls every analyzer sequentially and lets each one print its own
// section to stdout.  No changes to individual analyzer files are needed.
func runAllTable() error {
	total := len(allAnalyzers)

	fmt.Println()
	fmt.Println(strings.Repeat("═", 100))
	fmt.Printf("  FULL AZURE SUBSCRIPTION AUDIT  (%d analyzers)\n", total)
	fmt.Println(strings.Repeat("═", 100))
	fmt.Println()

	var skipped []string

	for i, a := range allAnalyzers {
		fmt.Fprintf(os.Stderr, "[%d/%d] Analyzing %s...\n", i+1, total, a.name)

		if err := a.fn(nil, nil); err != nil {
			skipped = append(skipped, fmt.Sprintf("[%d/%d] %s — %v", i+1, total, a.name, err))
			fmt.Printf("\n  [SKIPPED] %s failed: %v\n\n", a.name, err)
		}

		fmt.Println() // blank line between sections
	}

	fmt.Println(strings.Repeat("═", 100))
	fmt.Println("  SCAN COMPLETE")
	if len(skipped) > 0 {
		fmt.Printf("  %d analyzer(s) skipped:\n", len(skipped))
		for _, s := range skipped {
			fmt.Printf("    • %s\n", s)
		}
	} else {
		fmt.Printf("  All %d analyzers ran successfully.\n", total)
	}
	fmt.Println(strings.Repeat("═", 100))
	fmt.Println()

	return nil
}

// ---------- JSON mode ----------

// runAllJSON captures each analyzer's JSON output via an os.Pipe redirect and
// merges them into one combined JSON object written to stdout.
func runAllJSON() error {
	total := len(allAnalyzers)
	combined := make(map[string]json.RawMessage, total)

	for i, a := range allAnalyzers {
		fmt.Fprintf(os.Stderr, "[%d/%d] Analyzing %s...\n", i+1, total, a.name)

		raw, err := captureJSON(a.fn)
		if err != nil {
			fmt.Fprintf(os.Stderr, "  Warning: %s failed: %v\n", a.name, err)
			combined[a.key] = json.RawMessage(`null`)
			continue
		}
		combined[a.key] = raw
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(combined)
}

// captureJSON redirects os.Stdout to an os.Pipe while fn runs, reads all bytes
// written, validates them as JSON, and returns the raw bytes.
func captureJSON(fn func(*cobra.Command, []string) error) (json.RawMessage, error) {
	origStdout := os.Stdout

	pr, pw, err := os.Pipe()
	if err != nil {
		return json.RawMessage(`null`), fmt.Errorf("pipe create: %w", err)
	}
	os.Stdout = pw

	// Drain the pipe in a goroutine so the writer never blocks.
	var buf bytes.Buffer
	copyDone := make(chan struct{})
	go func() {
		io.Copy(&buf, pr) //nolint:errcheck
		close(copyDone)
	}()

	runErr := fn(nil, nil)

	pw.Close()
	<-copyDone
	pr.Close()
	os.Stdout = origStdout

	if runErr != nil {
		return json.RawMessage(`null`), runErr
	}

	raw := bytes.TrimSpace(buf.Bytes())
	if len(raw) == 0 || !json.Valid(raw) {
		// Analyzer printed a non-JSON message (e.g. "No resources found.")
		return json.RawMessage(`null`), nil
	}

	return json.RawMessage(raw), nil
}
