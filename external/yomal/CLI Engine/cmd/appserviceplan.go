package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/appservice/armappservice/v2"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/monitor/armmonitor"
	"github.com/spf13/cobra"
)

// ---------- data types ----------

type ASPFinding struct {
	Severity       Severity `json:"severity"`
	Category       string   `json:"category"`
	PlanName       string   `json:"plan_name"`
	ResourceGroup  string   `json:"resource_group"`
	SKU            string   `json:"sku"`
	Description    string   `json:"description"`
	Recommendation string   `json:"recommendation"`
}

type ASPSummary struct {
	TotalPlans         int            `json:"total_plans"`
	EmptyPlans         int            `json:"empty_plans"`
	OverProvPlans      int            `json:"over_provisioned_plans"`
	FindingsBySeverity map[string]int `json:"findings_by_severity"`
	BySKU              map[string]int `json:"by_sku"`
	EstimatedWasteUSD  float64        `json:"estimated_monthly_waste_usd"`
}

type ASPReport struct {
	Summary  ASPSummary   `json:"summary"`
	Findings []ASPFinding `json:"findings"`
}

// ---------- command ----------

var appServicePlanCmd = &cobra.Command{
	Use:   "appserviceplan",
	Short: "Analyze App Service Plans for over-provisioning, empty plans, and SKU right-sizing",
	Long:  "Checks all App Service Plans for empty plans with no apps, over-provisioned instances based on CPU/memory, SKU optimization opportunities, and cost waste.",
	RunE:  runAppServicePlan,
}

func init() {
	analyzeCmd.AddCommand(appServicePlanCmd)
	appServicePlanCmd.Flags().StringVar(&flagSubscriptionID, "subscription-id", "", "Azure Subscription ID (overrides AZURE_SUBSCRIPTION_ID env var)")
	appServicePlanCmd.Flags().StringVar(&flagResourceGroup, "resource-group", "", "Filter by resource group (optional)")
	appServicePlanCmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
}

func runAppServicePlan(_ *cobra.Command, _ []string) error {
	ctx := context.Background()
	subID := getSubscriptionID()
	if subID == "" {
		return fmt.Errorf("subscription ID required: set --subscription-id or AZURE_SUBSCRIPTION_ID env var")
	}

	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("azure auth failed: %w", err)
	}

	planClient, err := armappservice.NewPlansClient(subID, cred, nil)
	if err != nil {
		return fmt.Errorf("creating app service plan client: %w", err)
	}

	webClient, err := armappservice.NewWebAppsClient(subID, cred, nil)
	if err != nil {
		return fmt.Errorf("creating web apps client: %w", err)
	}

	metricsClient, err := armmonitor.NewMetricsClient(subID, cred, nil)
	if err != nil {
		return fmt.Errorf("creating metrics client: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Fetching App Service Plans for subscription %s...\n", subID)
	var plans []*armappservice.Plan
	pager := planClient.NewListPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("listing app service plans: %w", err)
		}
		plans = append(plans, page.Value...)
	}

	// Filter by resource group if specified
	if flagResourceGroup != "" {
		var filtered []*armappservice.Plan
		for _, p := range plans {
			if p.ID != nil {
				rg := extractResourceGroup(*p.ID)
				if strings.EqualFold(rg, flagResourceGroup) {
					filtered = append(filtered, p)
				}
			}
		}
		plans = filtered
	}

	fmt.Fprintf(os.Stderr, "Found %d App Service Plans. Analyzing...\n", len(plans))

	// Fetch all web apps and build a map of plan ID -> app count.
	// The subscription-level plan list API may not populate NumberOfSites,
	// so we count apps ourselves as the source of truth.
	fmt.Fprintf(os.Stderr, "Fetching Web Apps to count apps per plan...\n")
	planAppCount := map[string]int{} // lowercased plan resource ID -> count
	webPager := webClient.NewListPager(nil)
	for webPager.More() {
		page, err := webPager.NextPage(ctx)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Warning: could not list web apps: %v\n", err)
			break
		}
		for _, app := range page.Value {
			if app.Properties != nil && app.Properties.ServerFarmID != nil {
				planID := strings.ToLower(*app.Properties.ServerFarmID)
				planAppCount[planID]++
			}
		}
	}

	report := analyzeASPs(ctx, plans, planAppCount, webClient, planClient, metricsClient)

	switch flagOutput {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	default:
		printASPReport(report)
	}
	return nil
}

// Approximate monthly costs by SKU tier
var skuMonthlyCostUSD = map[string]float64{
	"F1": 0, "D1": 9.49, "B1": 13.14, "B2": 26.28, "B3": 52.56,
	"S1": 73.00, "S2": 146.00, "S3": 292.00,
	"P1V2": 83.95, "P2V2": 167.90, "P3V2": 335.79,
	"P1V3": 93.44, "P2V3": 186.88, "P3V3": 373.75,
	"P0V3": 74.46, "P1MV3": 186.88, "P2MV3": 373.75, "P3MV3": 747.51,
	"I1": 298.00, "I2": 596.00, "I3": 1192.00,
	"I1V2": 298.00, "I2V2": 596.00, "I3V2": 1192.00,
}

func analyzeASPs(ctx context.Context, plans []*armappservice.Plan, planAppCount map[string]int, _ *armappservice.WebAppsClient, _ *armappservice.PlansClient, metricsClient *armmonitor.MetricsClient) ASPReport {
	report := ASPReport{
		Summary: ASPSummary{
			TotalPlans:         len(plans),
			FindingsBySeverity: map[string]int{},
			BySKU:              map[string]int{},
		},
	}

	for _, plan := range plans {
		name := deref(plan.Name)
		rg := ""
		if plan.ID != nil {
			rg = extractResourceGroup(*plan.ID)
		}

		skuName := ""
		skuTier := ""
		if plan.SKU != nil {
			skuName = deref(plan.SKU.Name)
			skuTier = deref(plan.SKU.Tier)
		}
		report.Summary.BySKU[skuName]++

		// Check 1: Empty plan (no apps)
		// Use the pre-built web app count map (single list call) as source of truth.
		// The subscription-level plan list API often returns NumberOfSites as 0
		// even for plans with apps deployed, and per-plan Get calls are N+1.
		appCount := 0
		if plan.ID != nil {
			appCount = planAppCount[strings.ToLower(*plan.ID)]
		}
		// Fallback to NumberOfSites from the plan properties
		if appCount == 0 && plan.Properties != nil && plan.Properties.NumberOfSites != nil {
			appCount = int(*plan.Properties.NumberOfSites)
		}
		if appCount == 0 {
			report.Summary.EmptyPlans++
			cost := skuMonthlyCostUSD[skuName]
			// Multiply by worker count
			workers := 1
			if plan.SKU != nil && plan.SKU.Capacity != nil {
				workers = int(*plan.SKU.Capacity)
			}
			waste := cost * float64(workers)
			report.Summary.EstimatedWasteUSD += waste
			sev := Critical
			if strings.EqualFold(skuTier, "Free") || strings.EqualFold(skuTier, "Shared") {
				sev = Info
			}
			desc := fmt.Sprintf("Plan '%s' (%s) has no apps deployed", name, skuName)
			if waste > 0 {
				desc += fmt.Sprintf(" — wasting ~$%.0f/mo", waste)
			}
			report.addASPFinding(ASPFinding{
				Severity:       sev,
				Category:       "Empty Plan",
				PlanName:       name,
				ResourceGroup:  rg,
				SKU:            skuName,
				Description:    desc,
				Recommendation: "Delete the empty App Service Plan to stop incurring charges",
			})
		}

		// Check 2: Over-provisioned workers (capacity > 1) — check CPU/memory usage
		workers := 1
		if plan.SKU != nil && plan.SKU.Capacity != nil {
			workers = int(*plan.SKU.Capacity)
		}
		if workers > 1 && plan.ID != nil && appCount > 0 {
			avgCPU, avgMem := getASPMetrics(ctx, metricsClient, *plan.ID)
			if avgCPU >= 0 && avgCPU < 20 && avgMem >= 0 && avgMem < 30 {
				report.Summary.OverProvPlans++
				report.addASPFinding(ASPFinding{
					Severity:       Warning,
					Category:       "Over-Provisioned",
					PlanName:       name,
					ResourceGroup:  rg,
					SKU:            fmt.Sprintf("%s x%d", skuName, workers),
					Description:    fmt.Sprintf("Plan '%s' has %d workers but avg CPU=%.0f%%, Memory=%.0f%% (7d)", name, workers, avgCPU, avgMem),
					Recommendation: "Scale down the number of instances or enable autoscale",
				})
			}
		}

		// Check 3: Premium/Isolated SKU with low app count
		if (strings.HasPrefix(skuTier, "Premium") || strings.HasPrefix(skuTier, "Isolated")) && appCount > 0 && appCount <= 2 {
			report.addASPFinding(ASPFinding{
				Severity:       Info,
				Category:       "SKU Right-Sizing",
				PlanName:       name,
				ResourceGroup:  rg,
				SKU:            skuName,
				Description:    fmt.Sprintf("Plan '%s' (%s tier) hosts only %d app(s) — may be over-specced", name, skuTier, appCount),
				Recommendation: "Evaluate if a Standard tier plan would suffice for the workload",
			})
		}

		// Check 4: Free/Shared tier in production (no SLA)
		if strings.EqualFold(skuTier, "Free") || strings.EqualFold(skuTier, "Shared") {
			if appCount > 0 {
				report.addASPFinding(ASPFinding{
					Severity:       Warning,
					Category:       "No SLA",
					PlanName:       name,
					ResourceGroup:  rg,
					SKU:            skuName,
					Description:    fmt.Sprintf("Plan '%s' uses %s tier with %d app(s) — no SLA guarantee", name, skuTier, appCount),
					Recommendation: "Upgrade to Basic or Standard tier for production workloads with SLA",
				})
			}
		}

		// Check 5: High worker count without autoscale (potential waste)
		if workers >= 4 {
			report.addASPFinding(ASPFinding{
				Severity:       Info,
				Category:       "Autoscale",
				PlanName:       name,
				ResourceGroup:  rg,
				SKU:            fmt.Sprintf("%s x%d", skuName, workers),
				Description:    fmt.Sprintf("Plan '%s' has %d fixed workers — consider autoscale", name, workers),
				Recommendation: "Enable autoscale to dynamically adjust capacity and reduce costs during low-traffic periods",
			})
		}

	}

	return report
}

// AnalyzeASPsData runs ASP checks without metrics — no Azure calls.
// Skips the over-provisioned CPU/memory check (requires Azure Monitor).
func AnalyzeASPsData(plans []*armappservice.Plan, planAppCount map[string]int) ASPReport {
	report := ASPReport{
		Summary: ASPSummary{
			TotalPlans:         len(plans),
			FindingsBySeverity: map[string]int{},
			BySKU:              map[string]int{},
		},
	}
	for _, plan := range plans {
		name := deref(plan.Name)
		rg := ""
		if plan.ID != nil {
			rg = extractResourceGroup(*plan.ID)
		}
		skuName := ""
		skuTier := ""
		if plan.SKU != nil {
			skuName = deref(plan.SKU.Name)
			skuTier = deref(plan.SKU.Tier)
		}
		report.Summary.BySKU[skuName]++

		appCount := 0
		if plan.ID != nil {
			appCount = planAppCount[strings.ToLower(*plan.ID)]
		}
		if appCount == 0 && plan.Properties != nil && plan.Properties.NumberOfSites != nil {
			appCount = int(*plan.Properties.NumberOfSites)
		}
		if appCount == 0 {
			report.Summary.EmptyPlans++
			cost := skuMonthlyCostUSD[skuName]
			workers := 1
			if plan.SKU != nil && plan.SKU.Capacity != nil {
				workers = int(*plan.SKU.Capacity)
			}
			waste := cost * float64(workers)
			report.Summary.EstimatedWasteUSD += waste
			sev := Critical
			if strings.EqualFold(skuTier, "Free") || strings.EqualFold(skuTier, "Shared") {
				sev = Info
			}
			desc := fmt.Sprintf("Plan '%s' (%s) has no apps deployed", name, skuName)
			if waste > 0 {
				desc += fmt.Sprintf(" — wasting ~$%.0f/mo", waste)
			}
			report.addASPFinding(ASPFinding{
				Severity: sev, Category: "Empty Plan",
				PlanName: name, ResourceGroup: rg, SKU: skuName,
				Description:    desc,
				Recommendation: "Delete the empty App Service Plan to stop incurring charges",
			})
		}

		if (strings.HasPrefix(skuTier, "Premium") || strings.HasPrefix(skuTier, "Isolated")) && appCount > 0 && appCount <= 2 {
			report.addASPFinding(ASPFinding{
				Severity: Info, Category: "SKU Right-Sizing",
				PlanName: name, ResourceGroup: rg, SKU: skuName,
				Description:    fmt.Sprintf("Plan '%s' (%s tier) hosts only %d app(s) — may be over-specced", name, skuTier, appCount),
				Recommendation: "Evaluate if a Standard tier plan would suffice for the workload",
			})
		}

		if (strings.EqualFold(skuTier, "Free") || strings.EqualFold(skuTier, "Shared")) && appCount > 0 {
			report.addASPFinding(ASPFinding{
				Severity: Warning, Category: "No SLA",
				PlanName: name, ResourceGroup: rg, SKU: skuName,
				Description:    fmt.Sprintf("Plan '%s' uses %s tier with %d app(s) — no SLA guarantee", name, skuTier, appCount),
				Recommendation: "Upgrade to Basic or Standard tier for production workloads with SLA",
			})
		}

		workers := 1
		if plan.SKU != nil && plan.SKU.Capacity != nil {
			workers = int(*plan.SKU.Capacity)
		}
		if workers >= 4 {
			report.addASPFinding(ASPFinding{
				Severity: Info, Category: "Autoscale",
				PlanName: name, ResourceGroup: rg, SKU: fmt.Sprintf("%s x%d", skuName, workers),
				Description:    fmt.Sprintf("Plan '%s' has %d fixed workers — consider autoscale", name, workers),
				Recommendation: "Enable autoscale to dynamically adjust capacity and reduce costs during low-traffic periods",
			})
		}
	}
	return report
}

func getASPMetrics(ctx context.Context, metricsClient *armmonitor.MetricsClient, resourceID string) (avgCPU float64, avgMem float64) {
	avgCPU = -1
	avgMem = -1

	endTime := time.Now().UTC()
	startTime := endTime.Add(-7 * 24 * time.Hour)
	timespan := fmt.Sprintf("%s/%s", startTime.Format(time.RFC3339), endTime.Format(time.RFC3339))
	interval := "PT1H"
	aggregation := "Average"

	resp, err := metricsClient.List(ctx, resourceID, &armmonitor.MetricsClientListOptions{
		Metricnames: strPtr("CpuPercentage,MemoryPercentage"),
		Timespan:    &timespan,
		Interval:    &interval,
		Aggregation: &aggregation,
	})
	if err != nil {
		return
	}

	for _, metric := range resp.Value {
		metricName := deref(metric.Name.Value)
		total := 0.0
		count := 0
		for _, ts := range metric.Timeseries {
			for _, dp := range ts.Data {
				if dp.Average != nil {
					total += *dp.Average
					count++
				}
			}
		}
		if count == 0 {
			continue
		}
		avg := total / float64(count)
		switch {
		case strings.EqualFold(metricName, "CpuPercentage"):
			avgCPU = avg
		case strings.EqualFold(metricName, "MemoryPercentage"):
			avgMem = avg
		}
	}
	return
}

func strPtr(s string) *string {
	return &s
}

func (r *ASPReport) addASPFinding(f ASPFinding) {
	r.Findings = append(r.Findings, f)
	r.Summary.FindingsBySeverity[string(f.Severity)]++
}

func printASPReport(report ASPReport) {
	fmt.Println()
	fmt.Println("╔══════════════════════════════════════════════════════════════╗")
	fmt.Println("║           APP SERVICE PLAN ANALYSIS REPORT                   ║")
	fmt.Println("╚══════════════════════════════════════════════════════════════╝")
	fmt.Println()

	fmt.Printf("  Total Plans:          %d\n", report.Summary.TotalPlans)
	fmt.Printf("  Empty Plans:          %d\n", report.Summary.EmptyPlans)
	fmt.Printf("  Over-Provisioned:     %d\n", report.Summary.OverProvPlans)
	if report.Summary.EstimatedWasteUSD > 0 {
		fmt.Printf("  Est. Monthly Waste:   $%.2f/mo\n", report.Summary.EstimatedWasteUSD)
	}
	fmt.Println()

	fmt.Println("  SKU Breakdown:")
	for sku, count := range report.Summary.BySKU {
		fmt.Printf("    %-12s %d\n", sku, count)
	}
	fmt.Println()

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

	fmt.Println("  ── Findings ──")
	fmt.Println()
	w := tabwriter.NewWriter(os.Stdout, 2, 4, 2, ' ', 0)
	fmt.Fprintf(w, "  SEVERITY\tCATEGORY\tPLAN NAME\tSKU\tDESCRIPTION\n")
	fmt.Fprintf(w, "  --------\t--------\t---------\t---\t-----------\n")
	for _, f := range report.Findings {
		fmt.Fprintf(w, "  %s\t%s\t%s\t%s\t%s\n",
			f.Severity, f.Category, f.PlanName, f.SKU, f.Description)
	}
	w.Flush()
	fmt.Println()

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
