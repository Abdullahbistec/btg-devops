package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/network/armnetwork/v4"
	"github.com/spf13/cobra"
)

// ---------- data types ----------

type PublicIPFinding struct {
	Severity       Severity `json:"severity"`
	Category       string   `json:"category"`
	PIPName        string   `json:"pip_name"`
	ResourceGroup  string   `json:"resource_group"`
	IPAddress      string   `json:"ip_address,omitempty"`
	SKU            string   `json:"sku"`
	Description    string   `json:"description"`
	Recommendation string   `json:"recommendation"`
}

type PublicIPSummary struct {
	TotalPIPs          int            `json:"total_pips"`
	UnattachedPIPs     int            `json:"unattached_pips"`
	FindingsBySeverity map[string]int `json:"findings_by_severity"`
	BySKU              map[string]int `json:"by_sku"`
	ByAllocation       map[string]int `json:"by_allocation"`
	EstimatedWasteUSD  float64        `json:"estimated_monthly_waste_usd"`
}

type PublicIPReport struct {
	Summary  PublicIPSummary   `json:"summary"`
	Findings []PublicIPFinding `json:"findings"`
}

// ---------- command ----------

var publicIPCmd = &cobra.Command{
	Use:   "publicip",
	Short: "Analyze Public IP addresses for unused/unattached resources wasting money",
	Long:  "Checks all Public IP addresses for unattached PIPs, allocation method, SKU tier, DDoS protection, and idle resources.",
	RunE:  runPublicIP,
}

func init() {
	analyzeCmd.AddCommand(publicIPCmd)
	publicIPCmd.Flags().StringVar(&flagSubscriptionID, "subscription-id", "", "Azure Subscription ID (overrides AZURE_SUBSCRIPTION_ID env var)")
	publicIPCmd.Flags().StringVar(&flagResourceGroup, "resource-group", "", "Filter by resource group (optional)")
	publicIPCmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
}

func runPublicIP(_ *cobra.Command, _ []string) error {
	ctx := context.Background()
	subID := getSubscriptionID()
	if subID == "" {
		return fmt.Errorf("subscription ID required: set --subscription-id or AZURE_SUBSCRIPTION_ID env var")
	}

	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("azure auth failed: %w", err)
	}

	pipClient, err := armnetwork.NewPublicIPAddressesClient(subID, cred, nil)
	if err != nil {
		return fmt.Errorf("creating public IP client: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Fetching Public IP addresses for subscription %s...\n", subID)
	var pips []*armnetwork.PublicIPAddress
	pager := pipClient.NewListAllPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("listing public IPs: %w", err)
		}
		pips = append(pips, page.Value...)
	}

	// Filter by resource group if specified
	if flagResourceGroup != "" {
		var filtered []*armnetwork.PublicIPAddress
		for _, pip := range pips {
			if pip.ID != nil {
				rg := extractResourceGroup(*pip.ID)
				if strings.EqualFold(rg, flagResourceGroup) {
					filtered = append(filtered, pip)
				}
			}
		}
		pips = filtered
	}

	fmt.Fprintf(os.Stderr, "Found %d Public IP addresses. Analyzing...\n", len(pips))

	report := analyzePublicIPs(pips)

	switch flagOutput {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	default:
		printPublicIPReport(report)
	}
	return nil
}

// Approximate monthly cost for an unattached Standard SKU static PIP
const standardPIPMonthlyCostUSD = 3.65

// AnalyzePublicIPs is the exported, testable form of analyzePublicIPs.
func AnalyzePublicIPs(pips []*armnetwork.PublicIPAddress) PublicIPReport {
	return analyzePublicIPs(pips)
}

func analyzePublicIPs(pips []*armnetwork.PublicIPAddress) PublicIPReport {
	report := PublicIPReport{
		Summary: PublicIPSummary{
			TotalPIPs:          len(pips),
			FindingsBySeverity: map[string]int{},
			BySKU:              map[string]int{},
			ByAllocation:       map[string]int{},
		},
	}

	for _, pip := range pips {
		name := deref(pip.Name)
		rg := ""
		if pip.ID != nil {
			rg = extractResourceGroup(*pip.ID)
		}

		sku := "Basic"
		if pip.SKU != nil && pip.SKU.Name != nil {
			sku = string(*pip.SKU.Name)
		}
		report.Summary.BySKU[sku]++

		allocation := "Dynamic"
		if pip.Properties != nil && pip.Properties.PublicIPAllocationMethod != nil {
			allocation = string(*pip.Properties.PublicIPAllocationMethod)
		}
		report.Summary.ByAllocation[allocation]++

		ipAddr := ""
		if pip.Properties != nil && pip.Properties.IPAddress != nil {
			ipAddr = *pip.Properties.IPAddress
		}

		// Check 1: Unattached PIP (no IPConfiguration)
		isAttached := pip.Properties != nil && pip.Properties.IPConfiguration != nil
		if !isAttached {
			report.Summary.UnattachedPIPs++
			sev := Warning
			if strings.EqualFold(sku, "Standard") {
				sev = Critical // Standard PIPs cost money even when unattached
				report.Summary.EstimatedWasteUSD += standardPIPMonthlyCostUSD
			}
			report.addFinding(PublicIPFinding{
				Severity:       sev,
				Category:       "Unused Resource",
				PIPName:        name,
				ResourceGroup:  rg,
				IPAddress:      ipAddr,
				SKU:            sku,
				Description:    fmt.Sprintf("Public IP '%s' is not attached to any resource", name),
				Recommendation: "Delete the Public IP or attach it to a resource to avoid unnecessary costs",
			})
		}

		// Check 2: Basic SKU (should migrate to Standard)
		if strings.EqualFold(sku, "Basic") {
			report.addFinding(PublicIPFinding{
				Severity:       Warning,
				Category:       "SKU Upgrade",
				PIPName:        name,
				ResourceGroup:  rg,
				IPAddress:      ipAddr,
				SKU:            sku,
				Description:    fmt.Sprintf("Public IP '%s' uses Basic SKU (retiring Sept 2025)", name),
				Recommendation: "Migrate to Standard SKU for zone redundancy and better SLA",
			})
		}

		// Check 3: Dynamic allocation on Standard SKU (unusual)
		if strings.EqualFold(sku, "Standard") && strings.EqualFold(allocation, "Dynamic") {
			report.addFinding(PublicIPFinding{
				Severity:       Info,
				Category:       "Configuration",
				PIPName:        name,
				ResourceGroup:  rg,
				IPAddress:      ipAddr,
				SKU:            sku,
				Description:    fmt.Sprintf("Standard Public IP '%s' uses Dynamic allocation", name),
				Recommendation: "Standard PIPs typically use Static allocation; verify this is intentional",
			})
		}

		// Check 4: No DDoS protection (check via zones and tags as proxy)
		if pip.Properties != nil && pip.Properties.DdosSettings == nil {
			report.addFinding(PublicIPFinding{
				Severity:       Info,
				Category:       "Security",
				PIPName:        name,
				ResourceGroup:  rg,
				IPAddress:      ipAddr,
				SKU:            sku,
				Description:    fmt.Sprintf("Public IP '%s' has no DDoS protection settings configured", name),
				Recommendation: "Consider enabling Azure DDoS Protection for internet-facing resources",
			})
		}

		// Check 5: No availability zones (Standard SKU)
		if strings.EqualFold(sku, "Standard") && len(pip.Zones) == 0 {
			report.addFinding(PublicIPFinding{
				Severity:       Info,
				Category:       "Availability",
				PIPName:        name,
				ResourceGroup:  rg,
				IPAddress:      ipAddr,
				SKU:            sku,
				Description:    fmt.Sprintf("Standard Public IP '%s' is not zone-redundant", name),
				Recommendation: "Use zone-redundant PIPs for higher availability",
			})
		}

	}

	return report
}

func (r *PublicIPReport) addFinding(f PublicIPFinding) {
	r.Findings = append(r.Findings, f)
	r.Summary.FindingsBySeverity[string(f.Severity)]++
}

func printPublicIPReport(report PublicIPReport) {
	fmt.Println()
	fmt.Println("╔══════════════════════════════════════════════════════════════╗")
	fmt.Println("║           PUBLIC IP ADDRESS ANALYSIS REPORT                  ║")
	fmt.Println("╚══════════════════════════════════════════════════════════════╝")
	fmt.Println()

	// Summary
	fmt.Printf("  Total Public IPs:     %d\n", report.Summary.TotalPIPs)
	fmt.Printf("  Unattached PIPs:      %d\n", report.Summary.UnattachedPIPs)
	if report.Summary.EstimatedWasteUSD > 0 {
		fmt.Printf("  Est. Monthly Waste:   $%.2f/mo\n", report.Summary.EstimatedWasteUSD)
	}
	fmt.Println()

	// SKU breakdown
	fmt.Println("  SKU Breakdown:")
	for sku, count := range report.Summary.BySKU {
		fmt.Printf("    %-12s %d\n", sku, count)
	}
	fmt.Println()

	// Allocation breakdown
	fmt.Println("  Allocation Method:")
	for alloc, count := range report.Summary.ByAllocation {
		fmt.Printf("    %-12s %d\n", alloc, count)
	}
	fmt.Println()

	// Severity breakdown
	fmt.Println("  Findings by Severity:")
	for _, sev := range []string{"Critical", "Warning", "Info"} {
		if count, ok := report.Summary.FindingsBySeverity[sev]; ok {
			fmt.Printf("    %-12s %d\n", sev, count)
		}
	}
	fmt.Println()

	if len(report.Findings) == 0 {
		fmt.Println("  ✅ No issues found!")
		return
	}

	// Findings table
	fmt.Println("  ── Findings ──")
	fmt.Println()
	w := tabwriter.NewWriter(os.Stdout, 2, 4, 2, ' ', 0)
	fmt.Fprintf(w, "  SEVERITY\tCATEGORY\tPIP NAME\tRESOURCE GROUP\tDESCRIPTION\n")
	fmt.Fprintf(w, "  --------\t--------\t--------\t--------------\t-----------\n")
	for _, f := range report.Findings {
		fmt.Fprintf(w, "  %s\t%s\t%s\t%s\t%s\n",
			f.Severity, f.Category, f.PIPName, f.ResourceGroup, f.Description)
	}
	w.Flush()
	fmt.Println()

	// Recommendations
	fmt.Println("  ── Recommendations ──")
	fmt.Println()
	seen := map[string]bool{}
	for _, f := range report.Findings {
		if !seen[f.Recommendation] {
			fmt.Printf("  • %s\n", f.Recommendation)
			seen[f.Recommendation] = true
		}
	}
	fmt.Println()
}
