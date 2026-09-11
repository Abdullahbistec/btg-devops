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
