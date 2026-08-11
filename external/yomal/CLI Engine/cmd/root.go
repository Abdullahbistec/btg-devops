package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "btg-devops",
	Short: "BTG DevOps CLI — Azure subscription analysis and recommendations",
	Long:  "A DevOps CLI that examines Azure subscriptions for anomalies, cost savings, misconfigurations, and best practices.",
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
