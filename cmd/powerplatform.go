package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore/policy"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/chanbistec/btg-devops/provider"
	"github.com/spf13/cobra"
)

// ---------- data types ----------

type PPFinding struct {
	Severity      Severity `json:"severity"`
	Category      string   `json:"category"`
	LicenseName   string   `json:"license_name"`
	SKUPartNumber string   `json:"sku_part_number"`
	Description   string   `json:"description"`
	Recommendation string  `json:"recommendation"`
}

type PPLicenseDetail struct {
	SKUPartNumber   string  `json:"sku_part_number"`
	FriendlyName    string  `json:"friendly_name"`
	Purchased       int     `json:"purchased"`
	Consumed        int     `json:"consumed"`
	Unused          int     `json:"unused"`
	UnusedPct       float64 `json:"unused_pct"`
	Status          string  `json:"status"`
	EstMonthlyWaste float64 `json:"est_monthly_waste_usd"`
}

type PPSummary struct {
	TotalSKUs          int            `json:"total_skus"`
	TotalPurchased     int            `json:"total_purchased"`
	TotalConsumed      int            `json:"total_consumed"`
	TotalUnused        int            `json:"total_unused"`
	EstMonthlyWaste    float64        `json:"est_monthly_waste_usd"`
	FindingsBySeverity map[string]int `json:"findings_by_severity"`
}

type PPReport struct {
	Summary  PPSummary         `json:"summary"`
	Licenses []PPLicenseDetail `json:"licenses"`
	Findings []PPFinding       `json:"findings"`
}

// Graph API response types
type graphSKUsResponse struct {
	Value         []graphSubscribedSKU `json:"value"`
	OdataNextLink string               `json:"@odata.nextLink"`
}

type graphSubscribedSKU struct {
	SKUPartNumber    string            `json:"skuPartNumber"`
	SKUID            string            `json:"skuId"`
	ConsumedUnits    int               `json:"consumedUnits"`
	PrepaidUnits     graphPrepaidUnits `json:"prepaidUnits"`
	CapabilityStatus string            `json:"capabilityStatus"`
	AppliesTo        string            `json:"appliesTo"`
}

type graphPrepaidUnits struct {
	Enabled   int `json:"enabled"`
	Suspended int `json:"suspended"`
	Warning   int `json:"warning"`
}

// ---------- license metadata ----------

var ppFriendlyNames = map[string]string{
	"POWERAPPS_PER_USER":                  "Power Apps per User Plan",
	"POWERAPPS_PER_APP":                   "Power Apps per App Plan",
	"POWERAPPS_DEV":                       "Power Apps Developer Plan",
	"POWERAPPS_PORTALS_LOGIN_T2":          "Power Apps Portals Login",
	"FLOW_PER_USER":                       "Power Automate per User Plan",
	"FLOW_PER_USER_VIRAL":                 "Power Automate Free",
	"FLOW_PER_BUSINESS_PROCESS":           "Power Automate per Flow Plan",
	"FLOW_FREE":                           "Power Automate Free",
	"POWERBI_PRO":                         "Power BI Pro",
	"POWERBI_PREMIUM_PER_USER":            "Power BI Premium per User",
	"POWERBI_PREMIUM_P1":                  "Power BI Premium P1",
	"POWERBI_PREMIUM_P2":                  "Power BI Premium P2",
	"POWER_BI_STANDARD":                   "Power BI (Free)",
	"DYN365_ENTERPRISE_PLAN1":             "Dynamics 365 Customer Engagement Plan",
	"DYN365_ENTERPRISE_SALES":             "Dynamics 365 Sales Enterprise",
	"DYN365_ENTERPRISE_CUSTOMER_SERVICE":  "Dynamics 365 Customer Service Enterprise",
	"DYN365_BUSINESS_CENTRAL_ESSENTIAL":   "Dynamics 365 Business Central Essential",
	"DYN365_BUSINESS_CENTRAL_PREMIUM":     "Dynamics 365 Business Central Premium",
	"POWER_VIRTUAL_AGENTS_VIRAL":          "Power Virtual Agents (Trial)",
}

// ppMonthlyCostUSD is the estimated per-seat monthly cost for each SKU
var ppMonthlyCostUSD = map[string]float64{
	"POWERAPPS_PER_USER":                 20.0,
	"POWERAPPS_PER_APP":                  5.0,
	"FLOW_PER_USER":                      15.0,
	"FLOW_PER_BUSINESS_PROCESS":          100.0,
	"POWERBI_PRO":                        10.0,
	"POWERBI_PREMIUM_PER_USER":           20.0,
	"DYN365_ENTERPRISE_PLAN1":            115.0,
	"DYN365_ENTERPRISE_SALES":            65.0,
	"DYN365_ENTERPRISE_CUSTOMER_SERVICE": 50.0,
	"DYN365_BUSINESS_CENTRAL_ESSENTIAL":  70.0,
	"DYN365_BUSINESS_CENTRAL_PREMIUM":    100.0,
}

func isPowerPlatformSKU(partNumber string) bool {
	upper := strings.ToUpper(partNumber)
	for _, keyword := range []string{"POWERAPPS", "FLOW_", "POWERBI", "POWER_BI", "DYN365", "POWER_VIRTUAL", "CDS_"} {
		if strings.Contains(upper, keyword) {
			return true
		}
	}
	return false
}

func isTrialSKU(partNumber string) bool {
	upper := strings.ToUpper(partNumber)
	return strings.Contains(upper, "VIRAL") ||
		strings.Contains(upper, "TRIAL") ||
		strings.HasSuffix(upper, "_FREE") ||
		strings.Contains(upper, "_DEV")
}

// ---------- command ----------

var flagTenantID string

var powerplatformCmd = &cobra.Command{
	Use:   "powerplatform",
	Short: "Analyze Power Platform license usage and cost waste",
	Long:  "Scans Microsoft 365 / Power Platform license subscriptions via the Graph API to identify unused seats, suspended licenses, and cost savings opportunities.",
	RunE:  runPowerPlatform,
}

func init() {
	analyzeCmd.AddCommand(powerplatformCmd)
	powerplatformCmd.Flags().StringVar(&flagTenantID, "tenant-id", "", "Azure Tenant ID (overrides AZURE_TENANT_ID env var)")
	powerplatformCmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
	provider.Register("powerplatform", powerplatformProviderAdapter{})
}

func getTenantID() string {
	if flagTenantID != "" {
		return flagTenantID
	}
	return os.Getenv("AZURE_TENANT_ID")
}

func runPowerPlatform(cmd *cobra.Command, args []string) error {
	ctx := context.Background()

	tenantID := getTenantID()
	if tenantID == "" {
		return fmt.Errorf("tenant ID required: set --tenant-id or AZURE_TENANT_ID env var")
	}

	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("azure auth failed: %w", err)
	}

	report, err := computePowerPlatformFindings(ctx, cred, tenantID)
	if err != nil {
		return err
	}

	switch flagOutput {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	default:
		printPPTable(report)
	}

	return nil
}

func computePowerPlatformFindings(ctx context.Context, cred *azidentity.DefaultAzureCredential, tenantID string) (PPReport, error) {
	tokenResp, err := cred.GetToken(ctx, policy.TokenRequestOptions{
		Scopes: []string{"https://graph.microsoft.com/.default"},
	})
	if err != nil {
		return PPReport{}, fmt.Errorf("acquiring graph api token: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Fetching Power Platform license data for tenant %s...\n", tenantID)

	skus, err := fetchSubscribedSKUs(ctx, tokenResp.Token)
	if err != nil {
		return PPReport{}, fmt.Errorf("fetching subscribed SKUs: %w", err)
	}

	var ppSKUs []graphSubscribedSKU
	for _, sku := range skus {
		if isPowerPlatformSKU(sku.SKUPartNumber) {
			ppSKUs = append(ppSKUs, sku)
		}
	}

	fmt.Fprintf(os.Stderr, "Found %d Power Platform license SKU(s). Analyzing...\n", len(ppSKUs))

	summary := PPSummary{FindingsBySeverity: map[string]int{}}
	var licenses []PPLicenseDetail
	var findings []PPFinding

	for _, sku := range ppSKUs {
		purchased := sku.PrepaidUnits.Enabled + sku.PrepaidUnits.Warning
		consumed := sku.ConsumedUnits
		unused := purchased - consumed
		if unused < 0 {
			unused = 0
		}
		var unusedPct float64
		if purchased > 0 {
			unusedPct = float64(unused) / float64(purchased) * 100
		}

		friendlyName, ok := ppFriendlyNames[sku.SKUPartNumber]
		if !ok {
			friendlyName = sku.SKUPartNumber
		}

		costPerSeat := ppMonthlyCostUSD[sku.SKUPartNumber]
		monthlyWaste := float64(unused) * costPerSeat

		licenses = append(licenses, PPLicenseDetail{
			SKUPartNumber:   sku.SKUPartNumber,
			FriendlyName:    friendlyName,
			Purchased:       purchased,
			Consumed:        consumed,
			Unused:          unused,
			UnusedPct:       unusedPct,
			Status:          sku.CapabilityStatus,
			EstMonthlyWaste: monthlyWaste,
		})

		summary.TotalSKUs++
		summary.TotalPurchased += purchased
		summary.TotalConsumed += consumed
		summary.TotalUnused += unused
		summary.EstMonthlyWaste += monthlyWaste

		// 1. Suspended license — users have lost access
		if sku.CapabilityStatus == "Suspended" {
			findings = append(findings, PPFinding{
				Severity:       Critical,
				Category:       "Suspended License",
				LicenseName:    friendlyName,
				SKUPartNumber:  sku.SKUPartNumber,
				Description:    fmt.Sprintf("%s is suspended — users may have lost access", friendlyName),
				Recommendation: "Renew or cancel this license subscription to resolve the suspension.",
			})
		}

		// 2. Warning state — seats expiring soon
		if sku.PrepaidUnits.Warning > 0 {
			findings = append(findings, PPFinding{
				Severity:       Warning,
				Category:       "License Expiring",
				LicenseName:    friendlyName,
				SKUPartNumber:  sku.SKUPartNumber,
				Description:    fmt.Sprintf("%s has %d seat(s) in warning state — subscription may be expiring", friendlyName, sku.PrepaidUnits.Warning),
				Recommendation: "Renew the subscription before it expires to avoid service disruption.",
			})
		}

		// 3. All seats unused (zero consumption) — only when we know this SKU actually costs money;
		// otherwise "$0/month wasted" is a fabricated cost claim (common for auto-granted/free-pool SKUs).
		if !isTrialSKU(sku.SKUPartNumber) && purchased > 0 && consumed == 0 && costPerSeat > 0 {
			findings = append(findings, PPFinding{
				Severity:       Critical,
				Category:       "Zero Usage",
				LicenseName:    friendlyName,
				SKUPartNumber:  sku.SKUPartNumber,
				Description:    fmt.Sprintf("%s: %d purchased seats with 0 users assigned — $%.0f/month wasted", friendlyName, purchased, monthlyWaste),
				Recommendation: fmt.Sprintf("Cancel %s subscription immediately if not planned for use.", friendlyName),
			})
		}

		// 4. Severe waste (>=80% unused, >=10 seats)
		if !isTrialSKU(sku.SKUPartNumber) && consumed > 0 && unused >= 10 && unusedPct >= 80 && costPerSeat > 0 {
			findings = append(findings, PPFinding{
				Severity:       Critical,
				Category:       "Severe License Waste",
				LicenseName:    friendlyName,
				SKUPartNumber:  sku.SKUPartNumber,
				Description:    fmt.Sprintf("%s: %d of %d seats unused (%.0f%%) — est. $%.0f/month waste", friendlyName, unused, purchased, unusedPct, monthlyWaste),
				Recommendation: fmt.Sprintf("Reduce %s from %d to %d seats to save ~$%.0f/month.", friendlyName, purchased, consumed, monthlyWaste),
			})
		} else if !isTrialSKU(sku.SKUPartNumber) && consumed > 0 && unused >= 5 && unusedPct >= 50 && costPerSeat > 0 {
			// 5. Moderate waste (>=50% unused, >=5 seats)
			findings = append(findings, PPFinding{
				Severity:       Warning,
				Category:       "License Waste",
				LicenseName:    friendlyName,
				SKUPartNumber:  sku.SKUPartNumber,
				Description:    fmt.Sprintf("%s: %d of %d seats unused (%.0f%%) — est. $%.0f/month waste", friendlyName, unused, purchased, unusedPct, monthlyWaste),
				Recommendation: fmt.Sprintf("Consider reducing %s from %d to %d seats.", friendlyName, purchased, consumed),
			})
		} else if !isTrialSKU(sku.SKUPartNumber) && consumed > 0 && unused >= 2 && unusedPct >= 20 && costPerSeat > 0 {
			// 6. Minor waste (>=20% unused)
			findings = append(findings, PPFinding{
				Severity:       Info,
				Category:       "Unused Seats",
				LicenseName:    friendlyName,
				SKUPartNumber:  sku.SKUPartNumber,
				Description:    fmt.Sprintf("%s: %d seat(s) unused (%.0f%%) — est. $%.0f/month", friendlyName, unused, unusedPct, monthlyWaste),
				Recommendation: "Monitor usage and remove unused licenses at next renewal.",
			})
		}

		// 7. Trial/viral license in active use
		if isTrialSKU(sku.SKUPartNumber) && consumed > 0 {
			findings = append(findings, PPFinding{
				Severity:       Info,
				Category:       "Trial License in Use",
				LicenseName:    friendlyName,
				SKUPartNumber:  sku.SKUPartNumber,
				Description:    fmt.Sprintf("%s is a trial/free plan with %d active users", friendlyName, consumed),
				Recommendation: "Evaluate if users need a paid plan for production workloads.",
			})
		}
	}

	for _, f := range findings {
		summary.FindingsBySeverity[string(f.Severity)]++
	}

	report := PPReport{
		Summary:  summary,
		Licenses: licenses,
		Findings: findings,
	}
	return report, nil
}

// ---------- provider registration ----------

type powerplatformProviderAdapter struct{}

func (powerplatformProviderAdapter) Name() string { return "powerplatform" }

func (powerplatformProviderAdapter) Run(ctx context.Context) ([]provider.Finding, error) {
	tenantID := getTenantID()
	if tenantID == "" {
		return nil, fmt.Errorf("tenant ID required: set --tenant-id or AZURE_TENANT_ID env var")
	}
	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return nil, fmt.Errorf("azure auth failed: %w", err)
	}
	report, err := computePowerPlatformFindings(ctx, cred, tenantID)
	if err != nil {
		return nil, err
	}
	return powerplatformFindingsToProvider(report.Findings), nil
}

// powerplatformFindingsToProvider is split out from Run() so the conversion
// is testable without live credentials.
func powerplatformFindingsToProvider(findings []PPFinding) []provider.Finding {
	out := make([]provider.Finding, len(findings))
	for i, f := range findings {
		out[i] = provider.Finding{
			Provider:       "powerplatform",
			Service:        "Power Platform",
			Severity:       provider.Severity(f.Severity),
			Category:       f.Category,
			Resource:       f.LicenseName,
			Description:    f.Description,
			Recommendation: f.Recommendation,
		}
	}
	return out
}

func fetchSubscribedSKUs(ctx context.Context, token string) ([]graphSubscribedSKU, error) {
	var all []graphSubscribedSKU
	url := "https://graph.microsoft.com/v1.0/subscribedSkus"

	for url != "" {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Accept", "application/json")

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, err
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("graph api returned %d: %s", resp.StatusCode, string(body))
		}

		var page graphSKUsResponse
		if err := json.Unmarshal(body, &page); err != nil {
			return nil, err
		}
		all = append(all, page.Value...)
		url = page.OdataNextLink
	}

	return all, nil
}

func printPPTable(r PPReport) {
	fmt.Println()
	fmt.Println("POWER PLATFORM LICENSE ANALYSIS")
	fmt.Println(strings.Repeat("=", 100))
	fmt.Println()

	fmt.Println("SUMMARY")
	fmt.Println(strings.Repeat("-", 50))
	fmt.Printf("  Power Platform SKUs:  %d\n", r.Summary.TotalSKUs)
	fmt.Printf("  Total Purchased:      %d seats\n", r.Summary.TotalPurchased)
	fmt.Printf("  Total Consumed:       %d seats\n", r.Summary.TotalConsumed)
	fmt.Printf("  Total Unused:         %d seats\n", r.Summary.TotalUnused)
	if r.Summary.EstMonthlyWaste > 0 {
		fmt.Printf("  Est. Monthly Waste:   $%.2f USD\n", r.Summary.EstMonthlyWaste)
		fmt.Printf("  Est. Annual Waste:    $%.2f USD\n", r.Summary.EstMonthlyWaste*12)
	}
	fmt.Println()

	if len(r.Licenses) > 0 {
		fmt.Println("LICENSE BREAKDOWN")
		fmt.Println(strings.Repeat("-", 50))
		w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(w, "LICENSE\tSTATUS\tPURCHASED\tCONSUMED\tUNUSED\tUNUSED%\tEST WASTE/MO\t")
		fmt.Fprintln(w, "-------\t------\t---------\t--------\t------\t-------\t------------\t")
		for _, l := range r.Licenses {
			waste := "—"
			if l.EstMonthlyWaste > 0 {
				waste = fmt.Sprintf("$%.0f", l.EstMonthlyWaste)
			}
			fmt.Fprintf(w, "%s\t%s\t%d\t%d\t%d\t%.0f%%\t%s\t\n",
				l.FriendlyName, l.Status, l.Purchased, l.Consumed, l.Unused, l.UnusedPct, waste)
		}
		w.Flush()
		fmt.Println()
	}

	fmt.Println("FINDINGS")
	fmt.Println(strings.Repeat("-", 50))
	fmt.Printf("  Critical: %d  |  Warning: %d  |  Info: %d\n",
		r.Summary.FindingsBySeverity["Critical"],
		r.Summary.FindingsBySeverity["Warning"],
		r.Summary.FindingsBySeverity["Info"])
	fmt.Println()

	if len(r.Findings) == 0 {
		fmt.Println("  No issues found.")
		return
	}

	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "SEVERITY\tCATEGORY\tLICENSE\tDESCRIPTION\t")
	fmt.Fprintln(w, "--------\t--------\t-------\t-----------\t")
	for _, f := range r.Findings {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t\n",
			f.Severity, f.Category, f.LicenseName, f.Description)
	}
	w.Flush()

	fmt.Println()
	fmt.Println("RECOMMENDATIONS")
	fmt.Println(strings.Repeat("-", 50))
	for _, f := range r.Findings {
		icon := "ℹ️ "
		if f.Severity == Critical {
			icon = "🔴"
		} else if f.Severity == Warning {
			icon = "🟡"
		}
		fmt.Printf("  %s [%s] %s: %s\n", icon, f.Severity, f.Category, f.Recommendation)
	}
	fmt.Println()
}
