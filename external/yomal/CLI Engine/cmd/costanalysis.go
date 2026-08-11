package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/costmanagement/armcostmanagement"
	"github.com/spf13/cobra"
)

// ---------- data types ----------

type ServiceCostEntry struct {
	ServiceName string  `json:"service_name"`
	Cost        float64 `json:"cost"`
	Currency    string  `json:"currency"`
}

type ResourceCostEntry struct {
	ResourceName  string  `json:"resource_name"`
	ResourceID    string  `json:"resource_id"`
	ResourceGroup string  `json:"resource_group"`
	ServiceName   string  `json:"service_name"`
	Cost          float64 `json:"cost"`
	Currency      string  `json:"currency"`
}

type CostReport struct {
	Period       string              `json:"period"`
	Days         int                 `json:"days"`
	TotalCost    float64             `json:"total_cost"`
	Currency     string              `json:"currency"`
	ByService    []ServiceCostEntry  `json:"by_service"`
	TopResources []ResourceCostEntry `json:"top_resources"`
}

// ---------- command ----------

var flagCostDays int

var costAnalysisCmd = &cobra.Command{
	Use:   "cost",
	Short: "Show actual Azure spend by service and resource for a time period",
	Long:  "Queries Azure Cost Management API for real billing data and shows total spend, breakdown by service, and top resources by cost.",
	RunE:  runCostAnalysis,
}

func init() {
	analyzeCmd.AddCommand(costAnalysisCmd)
	costAnalysisCmd.Flags().StringVar(&flagSubscriptionID, "subscription-id", "", "Azure Subscription ID (overrides AZURE_SUBSCRIPTION_ID env var)")
	costAnalysisCmd.Flags().StringVar(&flagResourceGroup, "resource-group", "", "Filter by resource group (optional)")
	costAnalysisCmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
	costAnalysisCmd.Flags().IntVar(&flagCostDays, "days", 30, "Number of past days to include (e.g. 7, 30, 90)")
}

// ---------- run ----------

func runCostAnalysis(_ *cobra.Command, _ []string) error {
	ctx := context.Background()
	subID := getSubscriptionID()
	if subID == "" {
		return fmt.Errorf("subscription ID required: set --subscription-id or AZURE_SUBSCRIPTION_ID env var")
	}

	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("azure auth failed: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Querying Azure Cost Management for last %d days...\n", flagCostDays)

	report, err := buildCostReport(ctx, subID, cred, flagCostDays)
	if err != nil {
		return fmt.Errorf("cost query failed (ensure the Service Principal has 'Cost Management Reader' role on the subscription): %w", err)
	}

	switch flagOutput {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	default:
		printCostTable(report)
	}
	return nil
}

// ---------- query ----------

func buildCostReport(ctx context.Context, subID string, cred *azidentity.DefaultAzureCredential, days int) (*CostReport, error) {
	client, err := armcostmanagement.NewQueryClient(cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating cost management client: %w", err)
	}

	endTime := time.Now().UTC()
	startTime := endTime.AddDate(0, 0, -days)
	scope := fmt.Sprintf("/subscriptions/%s", subID)

	exportType := armcostmanagement.ExportTypeActualCost
	timeframe := armcostmanagement.TimeframeTypeCustom
	costFunc := armcostmanagement.FunctionTypeSum
	dimType := armcostmanagement.QueryColumnTypeDimension

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
				{Type: &dimType, Name: strPtr("ServiceName")},
				{Type: &dimType, Name: strPtr("ResourceId")},
			},
		},
	}

	// Narrow to a specific resource group if requested
	if flagResourceGroup != "" {
		opType := armcostmanagement.QueryOperatorTypeIn
		rg := flagResourceGroup
		query.Dataset.Filter = &armcostmanagement.QueryFilter{
			Dimensions: &armcostmanagement.QueryComparisonExpression{
				Name:     strPtr("ResourceGroupName"),
				Operator: &opType,
				Values:   []*string{&rg},
			},
		}
	}

	result, err := client.Usage(ctx, scope, query, nil)
	if err != nil {
		return nil, err
	}

	return parseCostQueryResult(result.QueryResult, startTime, endTime, days), nil
}

// ---------- parse ----------

func parseCostQueryResult(qr armcostmanagement.QueryResult, start, end time.Time, days int) *CostReport {
	report := &CostReport{
		Period:   fmt.Sprintf("%s to %s", start.Format("2006-01-02"), end.Format("2006-01-02")),
		Days:     days,
		Currency: "USD",
	}

	if qr.Properties == nil || len(qr.Properties.Columns) == 0 {
		return report
	}

	// Map column name → index (case-insensitive)
	colIdx := make(map[string]int, len(qr.Properties.Columns))
	for i, col := range qr.Properties.Columns {
		if col.Name != nil {
			colIdx[strings.ToLower(*col.Name)] = i
		}
	}

	costIdx, hasCost := colIdx["cost"]
	svcIdx, hasSvc := colIdx["servicename"]
	ridIdx, hasRID := colIdx["resourceid"]
	curIdx, hasCur := colIdx["currency"]

	if !hasCost {
		return report
	}

	serviceMap := map[string]float64{}
	resourceMap := map[string]*ResourceCostEntry{}

	for _, row := range qr.Properties.Rows {
		if costIdx >= len(row) {
			continue
		}

		cost := anyToFloat64(row[costIdx])
		if cost == 0 {
			continue
		}

		currency := "USD"
		if hasCur && curIdx < len(row) {
			currency = fmt.Sprintf("%v", row[curIdx])
		}
		report.Currency = currency

		svcName := "Other"
		if hasSvc && svcIdx < len(row) {
			if s := fmt.Sprintf("%v", row[svcIdx]); s != "" && s != "<nil>" {
				svcName = s
			}
		}

		rid := ""
		if hasRID && ridIdx < len(row) {
			rid = fmt.Sprintf("%v", row[ridIdx])
		}

		serviceMap[svcName] += cost
		report.TotalCost += cost

		if rid != "" && rid != "<nil>" {
			if entry, ok := resourceMap[rid]; ok {
				entry.Cost += cost
			} else {
				rg := extractResourceGroup(rid)
				name := extractLastSegment(rid)
				resourceMap[rid] = &ResourceCostEntry{
					ResourceName:  name,
					ResourceID:    rid,
					ResourceGroup: rg,
					ServiceName:   svcName,
					Cost:          cost,
					Currency:      currency,
				}
			}
		}
	}

	// Sort services by cost descending
	for svc, cost := range serviceMap {
		report.ByService = append(report.ByService, ServiceCostEntry{
			ServiceName: svc,
			Cost:        cost,
			Currency:    report.Currency,
		})
	}
	sort.Slice(report.ByService, func(i, j int) bool {
		return report.ByService[i].Cost > report.ByService[j].Cost
	})

	// Top 15 resources by cost
	resources := make([]ResourceCostEntry, 0, len(resourceMap))
	for _, r := range resourceMap {
		resources = append(resources, *r)
	}
	sort.Slice(resources, func(i, j int) bool {
		return resources[i].Cost > resources[j].Cost
	})
	if len(resources) > 15 {
		resources = resources[:15]
	}
	report.TopResources = resources

	return report
}

func anyToFloat64(v any) float64 {
	switch val := v.(type) {
	case float64:
		return val
	case float32:
		return float64(val)
	case int:
		return float64(val)
	case int64:
		return float64(val)
	case int32:
		return float64(val)
	default:
		var f float64
		_, _ = fmt.Sscanf(fmt.Sprintf("%v", val), "%f", &f)
		return f
	}
}

// ---------- output ----------

func printCostTable(r *CostReport) {
	fmt.Println()
	fmt.Println("╔══════════════════════════════════════════════════════════════════╗")
	fmt.Println("║            AZURE SUBSCRIPTION COST REPORT                        ║")
	fmt.Println("╚══════════════════════════════════════════════════════════════════╝")
	fmt.Println()
	fmt.Printf("  Period:       %s  (%d days)\n", r.Period, r.Days)
	fmt.Printf("  Total Spend:  $%.2f %s\n", r.TotalCost, r.Currency)
	fmt.Println()

	if len(r.ByService) == 0 {
		fmt.Println("  No cost data returned.")
		fmt.Println("  Ensure the Service Principal has 'Cost Management Reader' role on the subscription.")
		fmt.Println()
		return
	}

	// By service
	fmt.Println("  BY SERVICE")
	fmt.Println("  " + strings.Repeat("─", 55))
	w := tabwriter.NewWriter(os.Stdout, 2, 4, 2, ' ', 0)
	for _, s := range r.ByService {
		if s.Cost > 0 {
			fmt.Fprintf(w, "  %-42s  $%9.2f %s\n", s.ServiceName, s.Cost, s.Currency)
		}
	}
	w.Flush()
	fmt.Println()

	// Top resources
	if len(r.TopResources) > 0 {
		fmt.Printf("  TOP %d RESOURCES BY COST\n", len(r.TopResources))
		fmt.Println("  " + strings.Repeat("─", 90))
		w2 := tabwriter.NewWriter(os.Stdout, 2, 4, 2, ' ', 0)
		fmt.Fprintf(w2, "  %-36s\t%-32s\t%-22s\t%s\n", "RESOURCE", "SERVICE", "RESOURCE GROUP", "COST")
		fmt.Fprintf(w2, "  %-36s\t%-32s\t%-22s\t%s\n",
			strings.Repeat("─", 36), strings.Repeat("─", 32), strings.Repeat("─", 22), strings.Repeat("─", 10))
		for _, res := range r.TopResources {
			if res.Cost == 0 {
				continue
			}
			name := res.ResourceName
			if len(name) > 36 {
				name = name[:33] + "..."
			}
			svc := res.ServiceName
			if len(svc) > 32 {
				svc = svc[:29] + "..."
			}
			rg := res.ResourceGroup
			if len(rg) > 22 {
				rg = rg[:19] + "..."
			}
			fmt.Fprintf(w2, "  %-36s\t%-32s\t%-22s\t$%.2f %s\n", name, svc, rg, res.Cost, res.Currency)
		}
		w2.Flush()
		fmt.Println()
	}
}
