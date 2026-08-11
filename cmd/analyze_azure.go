package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/chanbistec/btg-devops/provider"
	"github.com/spf13/cobra"
)

var analyzeAzureCmd = &cobra.Command{
	Use:   "azure",
	Short: "Run every registered Azure analyzer via the provider registry",
	Long: `Runs every Azure analyzer registered with the provider registry and merges
their findings into one report — the same 14 analyzers 'analyze all --scope
azure' runs, reached through provider.Run("azure") instead of re-executing
this binary as a subprocess per command.

Each analyzer's own detection logic is completely untouched by this command;
this only calls the same computeXxxFindings functions runXxx already calls,
through a thin per-command adapter registered in that command's own init().`,
	RunE: runAnalyzeAzure,
}

func init() {
	analyzeCmd.AddCommand(analyzeAzureCmd)
	analyzeAzureCmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
}

func runAnalyzeAzure(cmd *cobra.Command, args []string) error {
	ctx := context.Background()
	result := provider.Run(ctx, "azure")

	for _, err := range result.Errors {
		fmt.Fprintf(os.Stderr, "  ✗ %v\n", err)
	}

	switch flagOutput {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(result.Findings)
	default:
		printProviderFindingsTable("azure", result.Findings, result.Errors)
	}
	return nil
}

func printProviderFindingsTable(providerName string, findings []provider.Finding, errs []error) {
	fmt.Println()
	fmt.Printf("%s PROVIDER — COMBINED ANALYSIS\n", strings.ToUpper(providerName))
	fmt.Println(strings.Repeat("=", 100))
	fmt.Println()

	bySeverity := map[string]int{}
	for _, f := range findings {
		bySeverity[string(f.Severity)]++
	}

	fmt.Println("SUMMARY")
	fmt.Println(strings.Repeat("-", 50))
	fmt.Printf("  Total Findings: %d\n", len(findings))
	fmt.Printf("  Critical: %d  |  Warning: %d  |  Info: %d\n",
		bySeverity["Critical"], bySeverity["Warning"], bySeverity["Info"])
	if len(errs) > 0 {
		fmt.Printf("  Analyzer Errors: %d\n", len(errs))
	}
	fmt.Println()

	if len(findings) == 0 {
		fmt.Println("  No issues found.")
		return
	}

	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "SEVERITY\tSERVICE\tCATEGORY\tRESOURCE\tDESCRIPTION\t")
	fmt.Fprintln(w, "--------\t-------\t--------\t--------\t-----------\t")
	for _, f := range findings {
		if f.Severity != provider.Critical && f.Severity != provider.Warning {
			continue
		}
		desc := f.Description
		if len(desc) > 75 {
			desc = desc[:72] + "..."
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t\n", f.Severity, f.Service, f.Category, f.Resource, desc)
	}
	w.Flush()
	fmt.Println()
}
