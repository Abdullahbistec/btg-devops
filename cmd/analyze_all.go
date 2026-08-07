package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"
)

// ---------- data types ----------

type UnifiedFinding struct {
	Severity       string `json:"severity"`
	Category       string `json:"category"`
	Service        string `json:"service"`
	Resource       string `json:"resource"`
	Environment    string `json:"environment,omitempty"`
	Description    string `json:"description"`
	Recommendation string `json:"recommendation"`
}

type AllSummary struct {
	StartedAt          string         `json:"started_at"`
	CompletedAt        string         `json:"completed_at"`
	DurationSeconds    int            `json:"duration_seconds"`
	CommandsRun        int            `json:"commands_run"`
	CommandsFailed     int            `json:"commands_failed"`
	TotalFindings      int            `json:"total_findings"`
	FindingsBySeverity map[string]int `json:"findings_by_severity"`
	FindingsByService  map[string]int `json:"findings_by_service"`
}

type AllReport struct {
	Summary  AllSummary       `json:"summary"`
	Findings []UnifiedFinding `json:"findings"`
	Errors   []string         `json:"errors,omitempty"`
}

// ---------- command catalogue ----------

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

var allPPCmds = []string{
	"powerplatform", "pp-environments", "pp-apps", "pp-flows", "pp-powerbi",
}

// resource field names tried in priority order when normalising findings
var resourceFields = []string{
	"app_name", "resource_name", "principal", "workspace_name",
	"flow_name", "name", "resource", "license_name",
}

// ---------- flags ----------

var (
	flagAllScope string
	flagAllFail  bool
)

// ---------- command ----------

var analyzeAllCmd = &cobra.Command{
	Use:   "all",
	Short: "Run all analyzers and produce a combined report",
	Long: `Runs every analyzer in sequence and merges findings into a single report.

Scope flags:
  --scope azure    Azure analyzers only (13 + sp-expiry + idle)
  --scope pp       Power Platform analyzers only (5 commands)
  --scope all      Everything (default)

Use --fail-on-critical to exit with code 1 when Critical findings are present.
Useful as a CI/CD pipeline gate:

  btg-devops analyze all --output json --fail-on-critical`,
	RunE: runAnalyzeAll,
}

func init() {
	analyzeCmd.AddCommand(analyzeAllCmd)
	analyzeAllCmd.Flags().StringVar(&flagAllScope, "scope", "all", "Scope: all, azure, or pp")
	analyzeAllCmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
	analyzeAllCmd.Flags().BoolVar(&flagAllFail, "fail-on-critical", false, "Exit code 1 if any Critical findings exist")
}

func runAnalyzeAll(cmd *cobra.Command, args []string) error {
	binary, err := os.Executable()
	if err != nil {
		return fmt.Errorf("could not determine binary path: %w", err)
	}

	var commands []string
	switch flagAllScope {
	case "azure":
		commands = allAzureCmds
	case "pp":
		commands = allPPCmds
	default:
		commands = append(append([]string{}, allAzureCmds...), allPPCmds...)
	}

	startedAt := time.Now()
	summary := AllSummary{
		StartedAt:          startedAt.Format(time.RFC3339),
		FindingsBySeverity: map[string]int{},
		FindingsByService:  map[string]int{},
	}

	var allFindings []UnifiedFinding
	var errors []string

	for _, name := range commands {
		fmt.Fprintf(os.Stderr, "  ▶ analyze %s\n", name)
		out, runErr := exec.Command(binary, "analyze", name, "--output", "json").Output()
		if runErr != nil {
			msg := fmt.Sprintf("analyze %s: %v", name, runErr)
			fmt.Fprintf(os.Stderr, "    ✗ %s\n", msg)
			errors = append(errors, msg)
			summary.CommandsFailed++
			continue
		}
		summary.CommandsRun++
		allFindings = append(allFindings, extractFindings(name, out)...)
	}

	completedAt := time.Now()
	summary.CompletedAt = completedAt.Format(time.RFC3339)
	summary.DurationSeconds = int(completedAt.Sub(startedAt).Seconds())
	summary.TotalFindings = len(allFindings)

	for _, f := range allFindings {
		summary.FindingsBySeverity[f.Severity]++
		summary.FindingsByService[f.Service]++
	}

	report := AllReport{Summary: summary, Findings: allFindings, Errors: errors}

	switch flagOutput {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if encErr := enc.Encode(report); encErr != nil {
			return encErr
		}
	default:
		printAllTable(report)
	}

	if flagAllFail && summary.FindingsBySeverity["Critical"] > 0 {
		return fmt.Errorf("%d Critical finding(s) found", summary.FindingsBySeverity["Critical"])
	}
	return nil
}

// extractFindings normalises a raw JSON blob from one analyzer into UnifiedFindings.
func extractFindings(cmdName string, raw []byte) []UnifiedFinding {
	label := allServiceLabels[cmdName]
	if label == "" {
		label = cmdName
	}

	var report map[string]json.RawMessage
	if err := json.Unmarshal(raw, &report); err != nil {
		return nil
	}

	findingsRaw, ok := report["findings"]
	if !ok {
		return nil
	}

	var rawFindings []map[string]interface{}
	if err := json.Unmarshal(findingsRaw, &rawFindings); err != nil {
		return nil
	}

	var out []UnifiedFinding
	for _, f := range rawFindings {
		sev := strField(f, "severity")
		if sev == "" {
			continue
		}
		uf := UnifiedFinding{
			Service:        label,
			Severity:       sev,
			Category:       strField(f, "category"),
			Description:    strField(f, "description"),
			Recommendation: strField(f, "recommendation"),
			Environment:    strField(f, "environment"),
		}
		for _, field := range resourceFields {
			if v := strField(f, field); v != "" {
				uf.Resource = v
				break
			}
		}
		out = append(out, uf)
	}
	return out
}

func strField(m map[string]interface{}, key string) string {
	if v, ok := m[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

func printAllTable(r AllReport) {
	fmt.Println()
	fmt.Println("AZURE + POWER PLATFORM — COMBINED ANALYSIS")
	fmt.Println(strings.Repeat("=", 100))
	fmt.Println()

	fmt.Println("SUMMARY")
	fmt.Println(strings.Repeat("-", 50))
	fmt.Printf("  Commands Run:    %d\n", r.Summary.CommandsRun)
	if r.Summary.CommandsFailed > 0 {
		fmt.Printf("  Commands Failed: %d\n", r.Summary.CommandsFailed)
	}
	fmt.Printf("  Duration:        %ds\n", r.Summary.DurationSeconds)
	fmt.Printf("  Total Findings:  %d\n", r.Summary.TotalFindings)
	fmt.Printf("  Critical:        %d\n", r.Summary.FindingsBySeverity["Critical"])
	fmt.Printf("  Warning:         %d\n", r.Summary.FindingsBySeverity["Warning"])
	fmt.Printf("  Info:            %d\n", r.Summary.FindingsBySeverity["Info"])
	fmt.Println()

	if len(r.Errors) > 0 {
		fmt.Println("ERRORS")
		fmt.Println(strings.Repeat("-", 50))
		for _, e := range r.Errors {
			fmt.Printf("  ⚠  %s\n", e)
		}
		fmt.Println()
	}

	// Table: Critical and Warning only (Info inflates output)
	critical := r.Summary.FindingsBySeverity["Critical"]
	warning := r.Summary.FindingsBySeverity["Warning"]
	if critical+warning == 0 {
		fmt.Println("  No Critical or Warning findings.")
		return
	}

	fmt.Println("CRITICAL & WARNING FINDINGS")
	fmt.Println(strings.Repeat("-", 50))
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "SEVERITY\tSERVICE\tCATEGORY\tRESOURCE\tDESCRIPTION\t")
	fmt.Fprintln(w, "--------\t-------\t--------\t--------\t-----------\t")
	for _, f := range r.Findings {
		if f.Severity != "Critical" && f.Severity != "Warning" {
			continue
		}
		desc := f.Description
		if len(desc) > 75 {
			desc = desc[:72] + "..."
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t\n",
			f.Severity, f.Service, f.Category, f.Resource, desc)
	}
	w.Flush()

	infoCount := r.Summary.FindingsBySeverity["Info"]
	fmt.Printf("\n  (%d Critical, %d Warning shown; %d Info omitted — use --output json for full list)\n",
		critical, warning, infoCount)
	fmt.Println()
}
