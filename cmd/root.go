package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

// validEngines is the set of values --engine accepts. Kept as a small,
// explicit check rather than a validation framework — this is the only
// enum-like persistent flag the CLI has today.
var validEngines = map[string]bool{"claude": true, "rules": true}

var rootCmd = &cobra.Command{
	Use:   "btg-devops",
	Short: "BTG DevOps CLI — Azure subscription analysis and recommendations",
	Long:  "A DevOps CLI that examines Azure subscriptions for anomalies, cost savings, misconfigurations, and best practices.",
}

// flagEngine selects the analysis engine: "claude" (default, falls back to
// rules on failure) or "rules" (force the original Go rule-check logic).
var flagEngine string

func init() {
	rootCmd.PersistentFlags().StringVar(&flagEngine, "engine", "claude", "Analysis engine: 'claude' (default, falls back to rules on failure) or 'rules' (force the original Go rule-check logic)")
	rootCmd.PersistentPreRunE = func(cmd *cobra.Command, args []string) error {
		if !validEngines[flagEngine] {
			return fmt.Errorf("invalid --engine %q: must be \"claude\" or \"rules\"", flagEngine)
		}
		return nil
	}
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
