package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/costmanagement/armcostmanagement"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/monitor/armmonitor"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/resources/armresources"
	"github.com/spf13/cobra"
)

// ---------- shared types ----------

type MeterCost struct {
	Name     string  `json:"name"`
	Cost     float64 `json:"cost"`
	Currency string  `json:"currency"`
}

type UsageSubResource struct {
	Name          string            `json:"name"`
	Cost          float64           `json:"cost"`
	Currency      string            `json:"currency"`
	Severity      Severity          `json:"severity"`
	Details       map[string]string `json:"details"`
	Meters        []MeterCost       `json:"meters"`
	Tip           string            `json:"tip"`
	MonthlySaving float64           `json:"monthly_saving"`
}

type UsageReport struct {
	ResourceName      string             `json:"resource_name"`
	ResourceType      string             `json:"resource_type"`
	ResourceGroup     string             `json:"resource_group"`
	Period            string             `json:"period"`
	Days              int                `json:"days"`
	TotalCost         float64            `json:"total_cost"`
	Currency          string             `json:"currency"`
	Severity          Severity           `json:"severity"`
	Meters            []MeterCost        `json:"meters"`
	SubResources      []UsageSubResource `json:"sub_resources"`
	TotalSaving       float64            `json:"total_saving"`
	TopRecommendation string             `json:"top_recommendation"`
	Utilization       map[string]float64 `json:"utilization,omitempty"`
	WasteScore        string             `json:"waste_score,omitempty"`
	WasteReason       string             `json:"waste_reason,omitempty"`
	PreviousCost      float64            `json:"previous_cost,omitempty"`
	CostChangePct     float64            `json:"cost_change_pct,omitempty"`
	CostTrend         string             `json:"cost_trend,omitempty"`
}

// ---------- command ----------

var flagResourceName string
var flagUsageDays int
var flagUsageAll bool
var flagUsageType string

var usageCmd = &cobra.Command{
	Use:   "usage",
	Short: "Deep cost and usage drill-down for a specific Azure resource (or all resources with --all)",
	Long:  "Finds a named resource, queries its actual cost from Azure Cost Management, and shows a hierarchical breakdown by sub-resource and meter with saving recommendations. Use --all to run across every supported resource in the subscription, or --type <name> to run for all resources of one type.",
	RunE:  runUsage,
}

func init() {
	analyzeCmd.AddCommand(usageCmd)
	usageCmd.Flags().StringVar(&flagResourceName, "resource", "", "Name of the Azure resource to drill into")
	usageCmd.Flags().BoolVar(&flagUsageAll, "all", false, "Run usage drill-down for ALL supported resources in the subscription")
	usageCmd.Flags().StringVar(&flagUsageType, "type", "", "Run usage drill-down for ALL resources of a given type (e.g. cosmosdb, storage, keyvault, acr, appservice, appserviceplan, publicip, cognitiveservices, functions)")
	usageCmd.Flags().StringVar(&flagSubscriptionID, "subscription-id", "", "Azure Subscription ID (overrides AZURE_SUBSCRIPTION_ID env var)")
	usageCmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
	usageCmd.Flags().IntVar(&flagUsageDays, "days", 30, "Number of past days to include (e.g. 7, 30, 90)")
}

// ---------- supported resource types ----------

var supportedUsageTypes = []string{
	"microsoft.documentdb/databaseaccounts",
	"microsoft.storage/storageaccounts",
	"microsoft.web/serverfarms",
	"microsoft.keyvault/vaults",
	"microsoft.containerregistry/registries",
	"microsoft.web/sites",
	"microsoft.network/publicipaddresses",
	"microsoft.cognitiveservices/accounts",
}

// usageTypeAliases maps short human-friendly names to ARM resource type strings.
var usageTypeAliases = map[string]string{
	"cosmosdb":          "microsoft.documentdb/databaseaccounts",
	"cosmos":            "microsoft.documentdb/databaseaccounts",
	"storage":           "microsoft.storage/storageaccounts",
	"storageaccount":    "microsoft.storage/storageaccounts",
	"appserviceplan":    "microsoft.web/serverfarms",
	"asp":               "microsoft.web/serverfarms",
	"serviceplan":       "microsoft.web/serverfarms",
	"keyvault":          "microsoft.keyvault/vaults",
	"kv":                "microsoft.keyvault/vaults",
	"acr":               "microsoft.containerregistry/registries",
	"containerregistry": "microsoft.containerregistry/registries",
	"appservice":        "microsoft.web/sites",
	"webapp":            "microsoft.web/sites",
	"functions":         "microsoft.web/sites",
	"functionapp":       "microsoft.web/sites",
	"publicip":          "microsoft.network/publicipaddresses",
	"pip":               "microsoft.network/publicipaddresses",
	"cognitiveservices": "microsoft.cognitiveservices/accounts",
	"openai":            "microsoft.cognitiveservices/accounts",
	"cognitive":         "microsoft.cognitiveservices/accounts",
}

// ---------- entry point ----------

func runUsage(_ *cobra.Command, _ []string) error {
	if !flagUsageAll && flagUsageType == "" && flagResourceName == "" {
		return fmt.Errorf("one of --resource <name>, --type <type>, or --all is required\n\nSupported types: cosmosdb, storage, appserviceplan, keyvault, acr, appservice, functions, publicip, cognitiveservices")
	}

	ctx := context.Background()
	subID := getSubscriptionID()
	if subID == "" {
		return fmt.Errorf("subscription ID required: set --subscription-id or AZURE_SUBSCRIPTION_ID env var")
	}

	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("azure auth failed: %w", err)
	}

	if flagUsageAll {
		return runUsageAll(ctx, subID, cred)
	}
	if flagUsageType != "" {
		return runUsageByType(ctx, subID, cred, flagUsageType)
	}
	return runUsageSingle(ctx, subID, cred, flagResourceName)
}

// ---------- single resource ----------

func runUsageSingle(ctx context.Context, subID string, cred *azidentity.DefaultAzureCredential, name string) error {
	fmt.Fprintf(os.Stderr, "Searching for resource '%s'...\n", name)

	resourceID, resourceType, rg, err := findResourceByName(ctx, subID, cred, name)
	if err != nil {
		return fmt.Errorf("resource not found: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Found: %s (%s) in %s\n", name, resourceType, rg)
	fmt.Fprintf(os.Stderr, "Fetching cost and usage data for last %d days...\n", flagUsageDays)

	report, err := buildUsageReport(ctx, subID, cred, resourceID, name, resourceType, rg, flagUsageDays)
	if err != nil {
		return fmt.Errorf("usage analysis failed: %w", err)
	}

	return outputUsageReport(report)
}

// ---------- by type ----------

func runUsageByType(ctx context.Context, subID string, cred *azidentity.DefaultAzureCredential, typeAlias string) error {
	armType, ok := usageTypeAliases[strings.ToLower(typeAlias)]
	if !ok {
		return fmt.Errorf("unknown type %q\n\nSupported types: cosmosdb, storage, appserviceplan, keyvault, acr, appservice, functions, publicip, cognitiveservices", typeAlias)
	}

	client, err := armresources.NewClient(subID, cred, nil)
	if err != nil {
		return fmt.Errorf("creating resources client: %w", err)
	}

	type resourceEntry struct {
		id   string
		name string
		rg   string
	}
	var resources []resourceEntry

	filter := fmt.Sprintf("resourceType eq '%s'", armType)
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
				id:   deref(r.ID),
				name: deref(r.Name),
				rg:   extractResourceGroup(deref(r.ID)),
			})
		}
	}

	total := len(resources)
	fmt.Fprintf(os.Stderr, "Found %d %s resource(s). Running usage analysis...\n\n", total, typeAlias)

	if total == 0 {
		fmt.Printf("No %s resources found in subscription.\n", typeAlias)
		return nil
	}

	if flagOutput != "json" {
		fmt.Println(strings.Repeat("═", 90))
		fmt.Printf("  %s USAGE ANALYSIS  (%d resources, last %d days)\n", strings.ToUpper(typeAlias), total, flagUsageDays)
		fmt.Println(strings.Repeat("═", 90))
	}

	var allReports []*UsageReport
	var totalSaving float64
	var grandTotal float64
	var skipped []string

	for i, res := range resources {
		if i > 0 {
			time.Sleep(time.Second) // avoid Cost Management API rate limits
		}
		fmt.Fprintf(os.Stderr, "[%d/%d] Analyzing %s...\n", i+1, total, res.name)

		report, err := buildUsageReport(ctx, subID, cred, res.id, res.name, armType, res.rg, flagUsageDays)
		if err != nil {
			skipped = append(skipped, fmt.Sprintf("%s — %v", res.name, err))
			continue
		}

		if flagOutput == "json" {
			allReports = append(allReports, report)
		} else {
			printUsageReport(report)
		}

		totalSaving += report.TotalSaving
		grandTotal += report.TotalCost
	}

	if flagOutput == "json" {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(allReports)
	}

	fmt.Println(strings.Repeat("═", 90))
	fmt.Printf("  SUMMARY — %s\n", strings.ToUpper(typeAlias))
	fmt.Printf("  Resources Analyzed       : %d\n", total-len(skipped))
	fmt.Printf("  Grand Total Cost         : $%.2f\n", grandTotal)
	fmt.Printf("  Potential Monthly Saving : ~$%.0f\n", totalSaving)
	if len(skipped) > 0 {
		fmt.Printf("  Skipped (%d):\n", len(skipped))
		for _, s := range skipped {
			fmt.Printf("    • %s\n", s)
		}
	}
	fmt.Println(strings.Repeat("═", 90))
	fmt.Println()

	return nil
}

// ---------- all resources ----------

func runUsageAll(ctx context.Context, subID string, cred *azidentity.DefaultAzureCredential) error {
	fmt.Fprintf(os.Stderr, "Listing all supported resources in subscription...\n")

	client, err := armresources.NewClient(subID, cred, nil)
	if err != nil {
		return fmt.Errorf("creating resources client: %w", err)
	}

	// Collect all resources of supported types
	type resourceEntry struct {
		id           string
		name         string
		resourceType string
		rg           string
	}
	var resources []resourceEntry

	for _, rtype := range supportedUsageTypes {
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
	fmt.Fprintf(os.Stderr, "Found %d supported resource(s). Running usage analysis...\n\n", total)

	if total == 0 {
		fmt.Println("No supported resources found in subscription.")
		return nil
	}

	// Print header for --all mode
	if flagOutput != "json" {
		fmt.Println(strings.Repeat("═", 90))
		fmt.Printf("  FULL SUBSCRIPTION USAGE ANALYSIS  (%d resources, last %d days)\n", total, flagUsageDays)
		fmt.Println(strings.Repeat("═", 90))
	}

	var allReports []*UsageReport
	var totalSaving float64
	var grandTotal float64
	var skipped []string

	for i, res := range resources {
		if i > 0 {
			time.Sleep(time.Second) // avoid Cost Management API rate limits
		}
		fmt.Fprintf(os.Stderr, "[%d/%d] Analyzing %s (%s)...\n", i+1, total, res.name, res.resourceType)

		report, err := buildUsageReport(ctx, subID, cred, res.id, res.name, res.resourceType, res.rg, flagUsageDays)
		if err != nil {
			skipped = append(skipped, fmt.Sprintf("%s — %v", res.name, err))
			continue
		}

		if flagOutput == "json" {
			allReports = append(allReports, report)
		} else {
			printUsageReport(report)
		}

		totalSaving += report.TotalSaving
		grandTotal += report.TotalCost
	}

	if flagOutput == "json" {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(allReports)
	}

	// Summary footer
	fmt.Println(strings.Repeat("═", 90))
	fmt.Printf("  SUMMARY\n")
	fmt.Printf("  Total Resources Analyzed : %d\n", total-len(skipped))
	fmt.Printf("  Grand Total Cost         : $%.2f\n", grandTotal)
	fmt.Printf("  Potential Monthly Saving : ~$%.0f\n", totalSaving)
	if len(skipped) > 0 {
		fmt.Printf("  Skipped (%d):\n", len(skipped))
		for _, s := range skipped {
			fmt.Printf("    • %s\n", s)
		}
	}
	fmt.Println(strings.Repeat("═", 90))
	fmt.Println()

	return nil
}

// ---------- shared builder ----------

func buildUsageReport(ctx context.Context, subID string, cred *azidentity.DefaultAzureCredential, resourceID, name, resourceType, rg string, days int) (*UsageReport, error) {
	var report *UsageReport
	var err error

	switch strings.ToLower(resourceType) {
	case "microsoft.documentdb/databaseaccounts":
		report, err = runCosmosDBUsage(ctx, subID, cred, resourceID, name, rg, days)
	case "microsoft.storage/storageaccounts":
		report, err = runStorageUsage(ctx, subID, cred, resourceID, name, rg, days)
	case "microsoft.web/serverfarms":
		report, err = runASPUsage(ctx, subID, cred, resourceID, name, rg, days)
	case "microsoft.keyvault/vaults":
		report, err = runKeyVaultUsage(ctx, subID, cred, resourceID, name, rg, days)
	case "microsoft.containerregistry/registries":
		report, err = runACRUsage(ctx, subID, cred, resourceID, name, rg, days)
	case "microsoft.web/sites":
		report, err = runAppServiceUsage(ctx, subID, cred, resourceID, name, rg, days)
	case "microsoft.network/publicipaddresses":
		report, err = runPublicIPUsage(ctx, subID, cred, resourceID, name, rg, days)
	case "microsoft.cognitiveservices/accounts":
		report, err = runCognitiveServicesUsage(ctx, subID, cred, resourceID, name, rg, days)
	default:
		report, err = runGenericUsage(ctx, subID, cred, resourceID, name, resourceType, rg, days)
	}

	if err != nil || report == nil {
		return report, err
	}

	// Attach cost trend — non-fatal if previous period query fails
	prevCost, changePct, trendLabel := queryCostTrend(ctx, subID, cred, resourceID, report.TotalCost, days)
	if trendLabel != "" {
		report.PreviousCost = prevCost
		report.CostChangePct = changePct
		report.CostTrend = trendLabel
	}

	return report, nil
}

// ---------- output helper ----------

func outputUsageReport(report *UsageReport) error {
	switch flagOutput {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	default:
		printUsageReport(report)
	}
	return nil
}

// ---------- resource finder ----------

func findResourceByName(ctx context.Context, subID string, cred *azidentity.DefaultAzureCredential, name string) (resourceID, resourceType, rg string, err error) {
	client, err := armresources.NewClient(subID, cred, nil)
	if err != nil {
		return "", "", "", fmt.Errorf("creating resources client: %w", err)
	}

	filter := fmt.Sprintf("name eq '%s'", name)
	pager := client.NewListPager(&armresources.ClientListOptions{Filter: &filter})

	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return "", "", "", fmt.Errorf("listing resources: %w", err)
		}
		for _, r := range page.Value {
			if r.Name != nil && strings.EqualFold(*r.Name, name) {
				rid := deref(r.ID)
				rtype := ""
				if r.Type != nil {
					rtype = *r.Type
				}
				rgrp := extractResourceGroup(rid)
				return rid, rtype, rgrp, nil
			}
		}
	}

	return "", "", "", fmt.Errorf("no resource named '%s' found in subscription", name)
}

// ---------- meter cost query ----------

// queryMeterCosts queries Cost Management for the last N days.
func queryMeterCosts(ctx context.Context, subID string, cred *azidentity.DefaultAzureCredential, resourceID string, days int) (meters map[string]float64, total float64, currency string, err error) {
	endTime := time.Now().UTC()
	startTime := endTime.AddDate(0, 0, -days)
	return queryMeterCostsBetween(ctx, subID, cred, resourceID, startTime, endTime)
}

// queryMeterCostsBetween queries Cost Management for an explicit time window.
func queryMeterCostsBetween(ctx context.Context, subID string, cred *azidentity.DefaultAzureCredential, resourceID string, startTime, endTime time.Time) (meters map[string]float64, total float64, currency string, err error) {
	client, ferr := armcostmanagement.NewQueryClient(cred, nil)
	if ferr != nil {
		return nil, 0, "USD", fmt.Errorf("creating cost client: %w", ferr)
	}

	scope := fmt.Sprintf("/subscriptions/%s", subID)

	exportType := armcostmanagement.ExportTypeActualCost
	timeframe := armcostmanagement.TimeframeTypeCustom
	costFunc := armcostmanagement.FunctionTypeSum
	dimType := armcostmanagement.QueryColumnTypeDimension
	opType := armcostmanagement.QueryOperatorTypeIn
	ridLower := strings.ToLower(resourceID)

	query := armcostmanagement.QueryDefinition{
		Type:      &exportType,
		Timeframe: &timeframe,
		TimePeriod: &armcostmanagement.QueryTimePeriod{
			From: &startTime,
			To:   &endTime,
		},
		Dataset: &armcostmanagement.QueryDataset{
			Aggregation: map[string]*armcostmanagement.QueryAggregation{
				"totalCost": {
					Name:     strPtr("Cost"),
					Function: &costFunc,
				},
			},
			Grouping: []*armcostmanagement.QueryGrouping{
				{Type: &dimType, Name: strPtr("MeterSubcategory")},
			},
			Filter: &armcostmanagement.QueryFilter{
				Dimensions: &armcostmanagement.QueryComparisonExpression{
					Name:     strPtr("ResourceId"),
					Operator: &opType,
					Values:   []*string{&ridLower},
				},
			},
		},
	}

	var result armcostmanagement.QueryClientUsageResponse
	var rerr error
	for attempt := 0; attempt < 4; attempt++ {
		result, rerr = client.Usage(ctx, scope, query, nil)
		if rerr == nil {
			break
		}
		var respErr *azcore.ResponseError
		if errors.As(rerr, &respErr) && respErr.StatusCode == 429 {
			wait := time.Duration(2<<attempt) * time.Second // 2s, 4s, 8s, 16s
			fmt.Fprintf(os.Stderr, "  Rate limited (429) — retrying in %v...\n", wait)
			time.Sleep(wait)
			continue
		}
		break
	}
	if rerr != nil {
		return nil, 0, "USD", rerr
	}

	meters = map[string]float64{}
	currency = "USD"

	if result.Properties == nil {
		return meters, 0, currency, nil
	}

	colIdx := map[string]int{}
	for i, col := range result.Properties.Columns {
		if col.Name != nil {
			colIdx[strings.ToLower(*col.Name)] = i
		}
	}

	costIdx, hasCost := colIdx["cost"]
	meterIdx, hasMeter := colIdx["metersubcategory"]
	curIdx, hasCur := colIdx["currency"]

	for _, row := range result.Properties.Rows {
		if !hasCost || costIdx >= len(row) {
			continue
		}
		cost := anyToFloat64(row[costIdx])
		if cost == 0 {
			continue
		}

		meterName := "Other"
		if hasMeter && meterIdx < len(row) {
			if s := fmt.Sprintf("%v", row[meterIdx]); s != "" && s != "<nil>" {
				meterName = s
			}
		}
		if hasCur && curIdx < len(row) {
			currency = fmt.Sprintf("%v", row[curIdx])
		}

		meters[meterName] += cost
		total += cost
	}

	return meters, total, currency, nil
}

// queryCostTrend compares currentCost against the previous equivalent period.
// Returns previousCost, change%, and a display string. Returns empty string on failure.
func queryCostTrend(ctx context.Context, subID string, cred *azidentity.DefaultAzureCredential, resourceID string, currentCost float64, days int) (prevCost, changePct float64, trend string) {
	now := time.Now().UTC()
	prevEnd := now.AddDate(0, 0, -days)
	prevStart := prevEnd.AddDate(0, 0, -days)

	_, prevCost, _, err := queryMeterCostsBetween(ctx, subID, cred, resourceID, prevStart, prevEnd)
	if err != nil || prevCost == 0 {
		return 0, 0, ""
	}

	changePct = ((currentCost - prevCost) / prevCost) * 100

	switch {
	case changePct > 20:
		trend = fmt.Sprintf("▲ +%.0f%%  (was $%.2f prev period)", changePct, prevCost)
	case changePct > 5:
		trend = fmt.Sprintf("↑ +%.0f%%  (was $%.2f prev period)", changePct, prevCost)
	case changePct < -20:
		trend = fmt.Sprintf("▼ %.0f%%  (was $%.2f prev period)", changePct, prevCost)
	case changePct < -5:
		trend = fmt.Sprintf("↓ %.0f%%  (was $%.2f prev period)", changePct, prevCost)
	default:
		trend = fmt.Sprintf("→ stable  (was $%.2f prev period)", prevCost)
	}

	return prevCost, changePct, trend
}

// ---------- generic fallback ----------

func runGenericUsage(ctx context.Context, subID string, cred *azidentity.DefaultAzureCredential, resourceID, name, resourceType, rg string, days int) (*UsageReport, error) {
	endTime := time.Now().UTC()
	startTime := endTime.AddDate(0, 0, -days)

	meters, total, currency, err := queryMeterCosts(ctx, subID, cred, resourceID, days)
	if err != nil {
		return nil, err
	}

	report := &UsageReport{
		ResourceName:  name,
		ResourceType:  resourceType,
		ResourceGroup: rg,
		Period:        fmt.Sprintf("%s to %s", startTime.Format("2006-01-02"), endTime.Format("2006-01-02")),
		Days:          days,
		TotalCost:     total,
		Currency:      currency,
		Severity:      costSeverity(total),
	}

	for meterName, cost := range meters {
		report.Meters = append(report.Meters, MeterCost{
			Name:     meterName,
			Cost:     cost,
			Currency: currency,
		})
	}
	sortMetersByCost(report.Meters)

	return report, nil
}

// ---------- utilization metrics ----------

// queryResourceMetrics fetches Azure Monitor metrics for a resource averaged over the period.
// Returns a map of metric name → average value. Errors are ignored — callers treat missing data as zero.
// queryResourceMetrics fetches Azure Monitor metrics for a resource.
// aggregation must be "Count", "Total", or "Average" — callers pass the correct
// aggregation for each metric so there is no ambiguity about which field to read:
//   - "Count"   → dp.Count  (event counts: TotalRequests, Transactions, API hits)
//   - "Total"   → dp.Total  (sum metrics: TotalRequestUnits, ByteCount)
//   - "Average" → dp.Average (gauge metrics: CpuPercentage, MemoryPercentage, UsedCapacity)
//
// Count/Total results are divided by days to give a per-day average.
// Average results are averaged across all hourly data points.
func queryResourceMetrics(ctx context.Context, subID string, cred *azidentity.DefaultAzureCredential, resourceID string, metricNames []string, days int, aggregation string) map[string]float64 {
	client, err := armmonitor.NewMetricsClient(subID, cred, nil)
	if err != nil {
		return nil
	}

	end := time.Now().UTC()
	start := end.AddDate(0, 0, -days)
	timespan := fmt.Sprintf("%s/%s", start.Format(time.RFC3339), end.Format(time.RFC3339))

	result, err := client.List(ctx, resourceID, &armmonitor.MetricsClientListOptions{
		Metricnames: strPtr(strings.Join(metricNames, ",")),
		Timespan:    strPtr(timespan),
		Interval:    strPtr("PT1H"),
		Aggregation: strPtr(aggregation),
	})
	if err != nil {
		return nil
	}

	out := map[string]float64{}
	for _, m := range result.Value {
		if m.Name == nil || m.Name.Value == nil {
			continue
		}
		metricName := *m.Name.Value
		if len(m.Timeseries) == 0 {
			continue
		}
		ts := m.Timeseries[0]

		var sum float64
		var dataPoints int
		for _, dp := range ts.Data {
			switch aggregation {
			case "Count":
				if dp.Count != nil {
					sum += *dp.Count
					dataPoints++
				}
			case "Total":
				if dp.Total != nil {
					sum += *dp.Total
					dataPoints++
				}
			default: // "Average"
				if dp.Average != nil {
					sum += *dp.Average
					dataPoints++
				}
			}
		}

		if dataPoints > 0 {
			if aggregation == "Average" {
				out[metricName] = sum / float64(dataPoints)
			} else {
				// Count/Total: sum of all hourly values ÷ days = daily average
				out[metricName] = sum / float64(days)
			}
		}
	}
	return out
}

// calcWasteScore returns a waste score and human-readable reason.
// primaryPct: percentage utilization (0-100), pass -1 if not applicable.
// dailyActivity: requests/calls/etc per day, pass -1 if not applicable.
func calcWasteScore(cost, primaryPct, dailyActivity float64) (score, reason string) {
	if cost == 0 {
		return "IDLE", "Zero cost — no billable activity detected in this period"
	}
	if primaryPct == 0 && dailyActivity == 0 {
		return "IDLE", fmt.Sprintf("No utilization detected but $%.2f/month still billed — resource may be unused", cost)
	}
	if primaryPct >= 0 {
		switch {
		case primaryPct < 5 && cost > 10:
			return "HIGH", fmt.Sprintf("Only %.1f%% of provisioned capacity used at $%.2f/month — severely over-provisioned; right-size immediately", primaryPct, cost)
		case primaryPct < 10 && cost > 10:
			return "MEDIUM", fmt.Sprintf("Only %.1f%% of provisioned capacity used at $%.2f/month — consider reducing provisioned capacity", primaryPct, cost)
		case primaryPct < 35 && cost > 10:
			return "LOW", fmt.Sprintf("%.1f%% utilization at $%.2f/month — monitor trends and consider right-sizing", primaryPct, cost)
		case primaryPct >= 70:
			return "HEALTHY", fmt.Sprintf("%.1f%% utilization — resource is well-utilized", primaryPct)
		default:
			return "LOW", fmt.Sprintf("%.1f%% utilization — monitor trends and consider right-sizing if this persists", primaryPct)
		}
	}
	// Count-based metrics only
	// Zero activity with any billing cost = IDLE regardless of how small the cost is
	if dailyActivity == 0 && cost > 0 {
		return "IDLE", fmt.Sprintf("Zero activity detected but $%.2f/month still billed — resource may be unused", cost)
	}
	if dailyActivity >= 0 && dailyActivity < 10 && cost > 20 {
		return "HIGH", fmt.Sprintf("Very low activity (%.0f/day) at $%.2f/month — resource is likely idle", dailyActivity, cost)
	}
	if dailyActivity >= 0 && dailyActivity < 100 && cost > 50 {
		return "MEDIUM", fmt.Sprintf("Low activity (%.0f/day) at $%.2f/month — review whether capacity matches actual demand", dailyActivity, cost)
	}
	return "HEALTHY", "Activity within expected range"
}

// ---------- helpers ----------

func buildUtilizationString(util map[string]float64) string {
	if len(util) == 0 {
		return ""
	}
	keys := make([]string, 0, len(util))
	for k := range util {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		v := util[k]
		if v == float64(int64(v)) {
			parts = append(parts, fmt.Sprintf("%s: %.0f", k, v))
		} else {
			parts = append(parts, fmt.Sprintf("%s: %.1f", k, v))
		}
	}
	return strings.Join(parts, "  |  ")
}

func costSeverity(cost float64) Severity {
	switch {
	case cost >= 200:
		return Critical
	case cost >= 50:
		return Warning
	default:
		return Info
	}
}

func renderBar(cost, maxCost float64, width int) string {
	if maxCost == 0 || width == 0 {
		return ""
	}
	filled := int(cost / maxCost * float64(width))
	if filled > width {
		filled = width
	}
	if filled == 0 && cost > 0 {
		filled = 1
	}
	return strings.Repeat("█", filled) + strings.Repeat("░", width-filled)
}

func sortMetersByCost(meters []MeterCost) {
	for i := 1; i < len(meters); i++ {
		for j := i; j > 0 && meters[j].Cost > meters[j-1].Cost; j-- {
			meters[j], meters[j-1] = meters[j-1], meters[j]
		}
	}
}

func maxMeterCost(meters []MeterCost) float64 {
	var maxCost float64
	for _, m := range meters {
		if m.Cost > maxCost {
			maxCost = m.Cost
		}
	}
	return maxCost
}

func periodString(days int) string {
	end := time.Now().UTC()
	start := end.AddDate(0, 0, -days)
	return fmt.Sprintf("%s to %s", start.Format("2006-01-02"), end.Format("2006-01-02"))
}

// ---------- table output ----------

func printUsageReport(r *UsageReport) {
	sevIcon := map[Severity]string{
		Critical: "🔴",
		Warning:  "🟡",
		Info:     "🟢",
	}

	fmt.Println()
	fmt.Println(strings.Repeat("═", 90))
	fmt.Printf("  RESOURCE USAGE DRILL-DOWN\n")
	fmt.Printf("  %s  |  %s  |  Last %d days\n", r.ResourceName, r.ResourceType, r.Days)
	fmt.Println(strings.Repeat("═", 90))
	fmt.Println()
	trendStr := ""
	if r.CostTrend != "" {
		trendStr = "    " + r.CostTrend
	}
	fmt.Printf("  %s  Total Cost:  $%.2f %s%s\n", sevIcon[r.Severity], r.TotalCost, r.Currency, trendStr)
	if r.WasteScore != "" {
		wasteIcon := map[string]string{
			"HIGH": "⚠⚠", "MEDIUM": "⚠", "LOW": "ℹ", "IDLE": "💤", "HEALTHY": "✓",
		}
		icon := wasteIcon[r.WasteScore]
		util := buildUtilizationString(r.Utilization)
		if util != "" {
			fmt.Printf("  %s  Waste: %-8s  %s\n", icon, r.WasteScore, util)
		} else {
			fmt.Printf("  %s  Waste: %s\n", icon, r.WasteScore)
		}
		if r.WasteReason != "" {
			fmt.Printf("       → %s\n", r.WasteReason)
		}
	}
	fmt.Printf("  Period:       %s\n", r.Period)
	fmt.Println()

	// Account-level meters (shown when no sub-resources)
	if len(r.SubResources) == 0 && len(r.Meters) > 0 {
		fmt.Println("  METER BREAKDOWN")
		fmt.Println("  " + strings.Repeat("─", 60))
		printMeterTable(r.Meters, r.Currency)
	}

	// Sub-resources
	for _, sub := range r.SubResources {
		icon := sevIcon[sub.Severity]
		fmt.Printf("  %s  %-30s  $%.2f/mo", icon, sub.Name, sub.Cost)
		for k, v := range sub.Details {
			fmt.Printf("   %s: %s", k, v)
		}
		fmt.Println()

		if len(sub.Meters) > 0 {
			printMeterTable(sub.Meters, sub.Currency)
		}

		if sub.Tip != "" {
			fmt.Printf("    → %s\n", sub.Tip)
			if sub.MonthlySaving > 0 {
				fmt.Printf("      Save ~$%.0f/month\n", sub.MonthlySaving)
			}
		}
		fmt.Println()
	}

	// Saving summary
	if r.TotalSaving > 0 {
		fmt.Println(strings.Repeat("─", 90))
		fmt.Printf("  Potential Monthly Saving:  ~$%.0f\n", r.TotalSaving)
		if r.TopRecommendation != "" {
			fmt.Printf("  %s\n", r.TopRecommendation)
		}
	}

	fmt.Println(strings.Repeat("═", 90))
	fmt.Println()
}

// ---------- exported wrappers for unit testing ----------

func CalcWasteScore(cost, primaryPct, dailyActivity float64) (string, string) {
	return calcWasteScore(cost, primaryPct, dailyActivity)
}
func CostSeverity(cost float64) Severity                    { return costSeverity(cost) }
func RenderBar(cost, maxCost float64, width int) string     { return renderBar(cost, maxCost, width) }
func SortMetersByCost(meters []MeterCost)                   { sortMetersByCost(meters) }
func MaxMeterCost(meters []MeterCost) float64               { return maxMeterCost(meters) }
func BuildUtilizationString(util map[string]float64) string { return buildUtilizationString(util) }

var UsageTypeAliases = usageTypeAliases
var SupportedUsageTypes = supportedUsageTypes

// ---------- table output ----------

func printMeterTable(meters []MeterCost, currency string) {
	maxCost := maxMeterCost(meters)
	w := tabwriter.NewWriter(os.Stdout, 2, 4, 2, ' ', 0)
	for _, m := range meters {
		bar := renderBar(m.Cost, maxCost, 20)
		fmt.Fprintf(w, "    %-38s\t$%8.2f %s\t  %s\n", m.Name, m.Cost, currency, bar)
	}
	w.Flush()
}
