package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/chanbistec/btg-devops/provider"
	"github.com/spf13/cobra"
)

var analyzeHetznerCmd = &cobra.Command{
	Use:   "hetzner",
	Short: "Run every registered Hetzner Cloud analyzer via the provider registry",
	Long: `Runs every Hetzner Cloud analyzer registered with the provider registry and
merges their findings into one report, reached through provider.Run("hetzner")
— the same mechanism 'analyze azure' uses for the Azure provider.

Each analyzer's own detection logic lives in its own hetzner_*.go file; this
only calls the same computeXxxFindings functions runXxx already calls,
through a thin per-command adapter registered in that command's own init().`,
	RunE: runAnalyzeHetzner,
}

func init() {
	analyzeCmd.AddCommand(analyzeHetznerCmd)
	analyzeHetznerCmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
}

func runAnalyzeHetzner(cmd *cobra.Command, args []string) error {
	ctx := context.Background()
	result := provider.Run(ctx, "hetzner")

	for _, err := range result.Errors {
		fmt.Fprintf(os.Stderr, "  ✗ %v\n", err)
	}

	switch flagOutput {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(result.Findings)
	default:
		printProviderFindingsTable("hetzner", result.Findings, result.Errors)
	}
	return nil
}
