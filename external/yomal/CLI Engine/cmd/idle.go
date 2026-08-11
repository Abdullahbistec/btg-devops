package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/resources/armresources"
	"github.com/spf13/cobra"
)

var flagIdleType string
var flagIdleDays int

type idleEntry struct {
	report    *UsageReport
	scoreRank int // 0=IDLE, 1=HIGH
}

var idleCmd = &cobra.Command{
	Use:   "idle",
	Short: "Scan for idle or highly wasteful Azure resources",
	Long:  "Scans all supported Azure resources and reports those with zero activity or very low utilization relative to cost. These are prime candidates for deletion or right-sizing.",
	RunE:  runIdle,
}

func init() {
	analyzeCmd.AddCommand(idleCmd)
	idleCmd.Flags().StringVar(&flagIdleType, "type", "", "Limit scan to one resource type (e.g. cosmosdb, storage, keyvault, acr, appservice, appserviceplan, publicip, cognitiveservices, functions)")
	idleCmd.Flags().IntVar(&flagIdleDays, "days", 30, "Number of past days to analyze (e.g. 7, 30, 90)")
	idleCmd.Flags().StringVar(&flagSubscriptionID, "subscription-id", "", "Azure Subscription ID (overrides AZURE_SUBSCRIPTION_ID env var)")
	idleCmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
}

// ---------- entry point ----------

func runIdle(_ *cobra.Command, _ []string) error {
	ctx := context.Background()
	subID := getSubscriptionID()
	if subID == "" {
		return fmt.Errorf("subscription ID required: set --subscription-id or AZURE_SUBSCRIPTION_ID env var")
	}

	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("azure auth failed: %w", err)
	}

	// Resolve which ARM types to scan
	var typesToScan []string
	if flagIdleType != "" {
		armType, ok := usageTypeAliases[strings.ToLower(flagIdleType)]
		if !ok {
			return fmt.Errorf("unknown type %q\n\nSupported types: cosmosdb, storage, appserviceplan, keyvault, acr, appservice, functions, publicip, cognitiveservices", flagIdleType)
		}
		typesToScan = []string{armType}
	} else {
		typesToScan = supportedUsageTypes
	}

	// Discover resources
	type resourceEntry struct {
		id           string
		name         string
		resourceType string
		rg           string
	}

	client, err := armresources.NewClient(subID, cred, nil)
	if err != nil {
		return fmt.Errorf("creating resources client: %w", err)
	}

	var resources []resourceEntry
	for _, rtype := range typesToScan {
		filter := fmt.Sprintf("resourceType eq '%s'", rtype)
		pager := client.NewListPager(&armresources.ClientListOptions{Filter: &filter})
		for pager.More() {
			page, err := pager.NextPage(ctx)
			if err != nil {
				break
			}
			for _, r := range page.Value {
				if r.ID == nil || r.Name == nil {
					continue
				}
				resources = append(resources, resourceEntry{
					id:           deref(r.ID),
					name:         deref(r.Name),
					resourceType: rtype,
					rg:           extractResourceGroup(deref(r.ID)),
				})
			}
		}
	}

	total := len(resources)
	if total == 0 {
		fmt.Println("No supported resources found in subscription.")
		return nil
	}

	fmt.Fprintf(os.Stderr, "Scanning %d resource(s) for idle/waste (last %d days)...\n\n", total, flagIdleDays)

	// Analyze each resource
	var idleResources []idleEntry
	var highWasteResources []idleEntry
	var mediumWasteResources []idleEntry

	for i, res := range resources {
		if i > 0 {
			time.Sleep(time.Second)
		}
		fmt.Fprintf(os.Stderr, "[%d/%d] Checking %s...\n", i+1, total, res.name)

		report, err := buildUsageReport(ctx, subID, cred, res.id, res.name, res.resourceType, res.rg, flagIdleDays)
		if err != nil {
			fmt.Fprintf(os.Stderr, "  skipped: %v\n", err)
			continue
		}

		switch report.WasteScore {
		case "IDLE":
			idleResources = append(idleResources, idleEntry{report: report, scoreRank: 0})
		case "HIGH":
			highWasteResources = append(highWasteResources, idleEntry{report: report, scoreRank: 1})
		case "MEDIUM":
			mediumWasteResources = append(mediumWasteResources, idleEntry{report: report, scoreRank: 2})
		}
	}

	if flagOutput == "json" {
		return outputIdleJSON(idleResources, highWasteResources, mediumWasteResources)
	}

	return printIdleReport(idleResources, highWasteResources, mediumWasteResources, total, flagIdleDays)
}

// ---------- json output ----------

func outputIdleJSON(idle, high, medium []idleEntry) error {
	type jsonOut struct {
		Idle        []*UsageReport `json:"idle"`
		HighWaste   []*UsageReport `json:"high_waste"`
		MediumWaste []*UsageReport `json:"medium_waste"`
	}
	out := jsonOut{}
	for _, e := range idle {
		out.Idle = append(out.Idle, e.report)
	}
	for _, e := range high {
		out.HighWaste = append(out.HighWaste, e.report)
	}
	for _, e := range medium {
		out.MediumWaste = append(out.MediumWaste, e.report)
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(out)
}

// ---------- table output ----------

func printIdleReport(idle, high, medium []idleEntry, totalScanned, days int) error {
	idleCount := len(idle)
	highCount := len(high)
	mediumCount := len(medium)
	totalFound := idleCount + highCount + mediumCount

	fmt.Println()
	fmt.Println(strings.Repeat("═", 90))
	fmt.Printf("  IDLE & WASTE RESOURCE SCAN  (%d resources scanned, last %d days)\n", totalScanned, days)
	fmt.Println(strings.Repeat("═", 90))

	if totalFound == 0 {
		fmt.Println()
		fmt.Println("  ✓  No idle or wasteful resources found.")
		fmt.Println()
		fmt.Println(strings.Repeat("═", 90))
		return nil
	}

	var totalIdleCost, totalHighCost, totalMediumCost float64

	// IDLE section
	if idleCount > 0 {
		fmt.Println()
		fmt.Printf("  💤  IDLE  —  Zero activity detected (still billed or provisioned)\n")
		fmt.Println("  " + strings.Repeat("─", 86))
		for _, e := range idle {
			r := e.report
			totalIdleCost += r.TotalCost
			util := buildUtilizationString(r.Utilization)
			fmt.Printf("  %-35s  %-42s  $%.2f/mo\n", r.ResourceName, r.ResourceType, r.TotalCost)
			if util != "" {
				fmt.Printf("      Utilization: %s\n", util)
			}
			if r.WasteReason != "" {
				fmt.Printf("      → %s\n", r.WasteReason)
			}
			if r.TopRecommendation != "" && r.TopRecommendation != r.WasteReason {
				fmt.Printf("      ★ %s\n", r.TopRecommendation)
			}
			fmt.Println()
		}
	}

	// HIGH WASTE section
	if highCount > 0 {
		fmt.Println()
		fmt.Printf("  ⚠⚠  HIGH WASTE  —  Very low utilization relative to cost\n")
		fmt.Println("  " + strings.Repeat("─", 86))
		for _, e := range high {
			r := e.report
			totalHighCost += r.TotalCost
			util := buildUtilizationString(r.Utilization)
			fmt.Printf("  %-35s  %-42s  $%.2f/mo\n", r.ResourceName, r.ResourceType, r.TotalCost)
			if util != "" {
				fmt.Printf("      Utilization: %s\n", util)
			}
			if r.WasteReason != "" {
				fmt.Printf("      → %s\n", r.WasteReason)
			}
			if r.TotalSaving > 0 {
				fmt.Printf("      Save ~$%.0f/month\n", r.TotalSaving)
			}
			fmt.Println()
		}
	}

	// MEDIUM WASTE section
	if mediumCount > 0 {
		fmt.Println()
		fmt.Printf("  ⚠   MEDIUM WASTE  —  Low activity relative to cost, review capacity\n")
		fmt.Println("  " + strings.Repeat("─", 86))
		for _, e := range medium {
			r := e.report
			totalMediumCost += r.TotalCost
			util := buildUtilizationString(r.Utilization)
			fmt.Printf("  %-35s  %-42s  $%.2f/mo\n", r.ResourceName, r.ResourceType, r.TotalCost)
			if util != "" {
				fmt.Printf("      Utilization: %s\n", util)
			}
			if r.WasteReason != "" {
				fmt.Printf("      → %s\n", r.WasteReason)
			}
			if r.TotalSaving > 0 {
				fmt.Printf("      Save ~$%.0f/month\n", r.TotalSaving)
			}
			fmt.Println()
		}
	}

	// Summary
	totalWasted := totalIdleCost + totalHighCost + totalMediumCost
	fmt.Println(strings.Repeat("═", 90))
	fmt.Printf("  Idle Resources     : %d    ($%.2f/month)\n", idleCount, totalIdleCost)
	fmt.Printf("  High Waste         : %d    ($%.2f/month)\n", highCount, totalHighCost)
	fmt.Printf("  Medium Waste       : %d    ($%.2f/month)\n", mediumCount, totalMediumCost)
	fmt.Printf("  Total Wasted Spend : ~$%.2f/month\n", totalWasted)
	fmt.Println(strings.Repeat("═", 90))
	fmt.Println()

	return nil
}
