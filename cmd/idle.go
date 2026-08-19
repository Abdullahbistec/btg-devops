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
	"github.com/chanbistec/btg-devops/provider"
	"github.com/spf13/cobra"
)

var flagIdleType string
var flagIdleDays int

type idleEntry struct {
	report    *UsageReport
	scoreRank int // 0=IDLE, 1=HIGH
}

type IdleFinding struct {
	Severity       Severity `json:"severity"`
	Category       string   `json:"category"`
	ResourceName   string   `json:"resource_name"`
	ResourceType   string   `json:"resource_type"`
	ResourceGroup  string   `json:"resource_group"`
	Description    string   `json:"description"`
	Recommendation string   `json:"recommendation"`
	MonthlyCost    float64  `json:"monthly_cost"`
	MonthlySaving  float64  `json:"monthly_saving"`
}

type IdleSummary struct {
	TotalScanned        int            `json:"total_scanned"`
	IdleCount           int            `json:"idle_count"`
	HighWasteCount      int            `json:"high_waste_count"`
	MediumWasteCount    int            `json:"medium_waste_count"`
	TotalWastedPerMonth float64        `json:"total_wasted_per_month"`
	FindingsBySeverity  map[string]int `json:"findings_by_severity"`
}

type IdleReport struct {
	Summary  IdleSummary   `json:"summary"`
	Findings []IdleFinding `json:"findings"`
}

// idleCategory maps a WasteScore + ARM resource type onto the dashboard's
// COST_CATEGORIES taxonomy (web/app/cost/page.tsx). LOW and HEALTHY return ""
// — callers must skip creating a finding when this returns "".
func idleCategory(wasteScore, resourceType string) string {
	switch wasteScore {
	case "IDLE":
		switch resourceType {
		case "microsoft.network/publicipaddresses":
			return "Unused IP"
		case "microsoft.web/serverfarms":
			return "Empty Plan"
		default:
			return "Zero Usage"
		}
	case "HIGH", "MEDIUM":
		return "Over-provisioned"
	default:
		return ""
	}
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
	provider.Register("azure", idleProviderAdapter{})
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

	report, idleResources, highWasteResources, mediumWasteResources, total, err := computeIdleFindings(ctx, cred, subID, flagIdleType, flagIdleDays)
	if err != nil {
		return err
	}

	if flagOutput == "json" {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	}

	if total == 0 {
		fmt.Println("No supported resources found in subscription.")
		return nil
	}

	return printIdleReport(idleResources, highWasteResources, mediumWasteResources, total, flagIdleDays)
}

// computeIdleFindings holds the unmodified fetch+analyze body previously
// inline in runIdle. Detection logic is byte-for-byte identical to before —
// only the function boundary moved and output decisions (JSON encode vs.
// table print) were lifted into runIdle, so runIdle's own behavior for every
// flagOutput/total-resources combination is unchanged. Returns the report
// plus the three severity buckets runIdle's table path still needs.
func computeIdleFindings(ctx context.Context, cred *azidentity.DefaultAzureCredential, subID, idleType string, days int) (IdleReport, []idleEntry, []idleEntry, []idleEntry, int, error) {
	// Resolve which ARM types to scan
	var typesToScan []string
	if idleType != "" {
		armType, ok := usageTypeAliases[strings.ToLower(idleType)]
		if !ok {
			return IdleReport{}, nil, nil, nil, 0, fmt.Errorf("unknown type %q\n\nSupported types: cosmosdb, storage, appserviceplan, keyvault, acr, appservice, functions, publicip, cognitiveservices", idleType)
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
		return IdleReport{}, nil, nil, nil, 0, fmt.Errorf("creating resources client: %w", err)
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
		return IdleReport{Summary: IdleSummary{FindingsBySeverity: map[string]int{}}, Findings: nil}, nil, nil, nil, 0, nil
	}

	fmt.Fprintf(os.Stderr, "Scanning %d resource(s) for idle/waste (last %d days)...\n\n", total, days)

	// Analyze each resource
	var idleResources []idleEntry
	var highWasteResources []idleEntry
	var mediumWasteResources []idleEntry
	var findings []IdleFinding

	for i, res := range resources {
		if i > 0 {
			time.Sleep(time.Second)
		}
		fmt.Fprintf(os.Stderr, "[%d/%d] Checking %s...\n", i+1, total, res.name)

		report, err := buildUsageReport(ctx, subID, cred, res.id, res.name, res.resourceType, res.rg, days)
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

		if category := idleCategory(report.WasteScore, res.resourceType); category != "" {
			findings = append(findings, IdleFinding{
				Severity:       report.Severity,
				Category:       category,
				ResourceName:   report.ResourceName,
				ResourceType:   report.ResourceType,
				ResourceGroup:  report.ResourceGroup,
				Description:    report.WasteReason,
				Recommendation: report.TopRecommendation,
				MonthlyCost:    report.TotalCost,
				MonthlySaving:  report.TotalSaving,
			})
		}
	}

	summary := IdleSummary{
		TotalScanned:       total,
		IdleCount:          len(idleResources),
		HighWasteCount:     len(highWasteResources),
		MediumWasteCount:   len(mediumWasteResources),
		FindingsBySeverity: map[string]int{},
	}
	for _, e := range idleResources {
		summary.TotalWastedPerMonth += e.report.TotalCost
	}
	for _, e := range highWasteResources {
		summary.TotalWastedPerMonth += e.report.TotalCost
	}
	for _, e := range mediumWasteResources {
		summary.TotalWastedPerMonth += e.report.TotalCost
	}
	for _, f := range findings {
		summary.FindingsBySeverity[string(f.Severity)]++
	}

	return IdleReport{Summary: summary, Findings: findings}, idleResources, highWasteResources, mediumWasteResources, total, nil
}

// ---------- provider registration ----------

type idleProviderAdapter struct{}

func (idleProviderAdapter) Name() string { return "idle" }

func (idleProviderAdapter) Run(ctx context.Context) ([]provider.Finding, error) {
	subID := getSubscriptionID()
	if subID == "" {
		return nil, fmt.Errorf("subscription ID required: set --subscription-id or AZURE_SUBSCRIPTION_ID env var")
	}
	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return nil, fmt.Errorf("azure auth failed: %w", err)
	}
	report, _, _, _, _, err := computeIdleFindings(ctx, cred, subID, flagIdleType, flagIdleDays)
	if err != nil {
		return nil, err
	}
	return idleFindingsToProvider(report.Findings), nil
}

// idleFindingsToProvider is split out from Run() so the conversion is
// testable without live Azure credentials.
func idleFindingsToProvider(findings []IdleFinding) []provider.Finding {
	out := make([]provider.Finding, len(findings))
	for i, f := range findings {
		cost := f.MonthlyCost
		saving := f.MonthlySaving
		out[i] = provider.Finding{
			Provider:       "azure",
			Service:        "Idle & Waste",
			Severity:       provider.Severity(f.Severity),
			Category:       f.Category,
			Resource:       f.ResourceName,
			Description:    f.Description,
			Recommendation: f.Recommendation,
			MonthlyCost:    &cost,
			MonthlySaving:  &saving,
		}
	}
	return out
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
