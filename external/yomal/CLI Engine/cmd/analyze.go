package cmd

import (
	"github.com/spf13/cobra"
)

var analyzeCmd = &cobra.Command{
	Use:   "analyze",
	Short: "Analyze Azure resources for insights and recommendations",
}

func init() {
	rootCmd.AddCommand(analyzeCmd)
}
