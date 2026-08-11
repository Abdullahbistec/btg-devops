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

var (
	flagSubscriptionID string
	flagResourceGroup  string
	flagOutput         string
)

type AppTrafficReport struct {
	Name           string  `json:"name"`
	ResourceGroup  string  `json:"resource_group"`
	Kind           string  `json:"kind"`
	State          string  `json:"state"`
	TotalRequests  float64 `json:"total_requests"`
	BytesReceived  float64 `json:"bytes_received"`
	BytesSent      float64 `json:"bytes_sent"`
	HTTP2xx        float64 `json:"http_2xx"`
	HTTP4xx        float64 `json:"http_4xx"`
	HTTP5xx        float64 `json:"http_5xx"`
	Status         string  `json:"status"`
	Recommendation string  `json:"recommendation"`
}

var appserviceTrafficCmd = &cobra.Command{
	Use:   "appservice-traffic",
	Short: "Analyze App Service network traffic over the last 14 days",
	Long:  "Queries Azure Monitor metrics for all App Services to classify them as Active, Low Traffic, or Idle/Unused.",
	RunE:  runAppServiceTraffic,
}

func init() {
	analyzeCmd.AddCommand(appserviceTrafficCmd)
	appserviceTrafficCmd.Flags().StringVar(&flagSubscriptionID, "subscription-id", "", "Azure Subscription ID (overrides AZURE_SUBSCRIPTION_ID env var)")
	appserviceTrafficCmd.Flags().StringVar(&flagResourceGroup, "resource-group", "", "Filter by resource group (optional)")
	appserviceTrafficCmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
}

func getSubscriptionID() string {
	if flagSubscriptionID != "" {
		return flagSubscriptionID
	}
	return os.Getenv("AZURE_SUBSCRIPTION_ID")
}

func runAppServiceTraffic(_ *cobra.Command, _ []string) error {
	ctx := context.Background()
	subID := getSubscriptionID()
	if subID == "" {
		return fmt.Errorf("subscription ID required: set --subscription-id or AZURE_SUBSCRIPTION_ID env var")
	}

	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("azure auth failed: %w", err)
	}

	// List App Services
	webClient, err := armappservice.NewWebAppsClient(subID, cred, nil)
	if err != nil {
		return fmt.Errorf("creating web apps client: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Listing App Services in subscription %s...\n", subID)

	type appInfo struct {
		Name          string
		ResourceGroup string
		ResourceID    string
		Kind          string
		State         string
	}

	var apps []appInfo
	pager := webClient.NewListPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("listing web apps: %w", err)
		}
		for _, site := range page.Value {
			if site.Name == nil || site.ID == nil {
				continue
			}
			rg := extractResourceGroup(*site.ID)
			if flagResourceGroup != "" && !strings.EqualFold(rg, flagResourceGroup) {
				continue
			}
			kind := ""
			if site.Kind != nil {
				kind = *site.Kind
			}
			state := ""
			if site.Properties != nil && site.Properties.State != nil {
				state = *site.Properties.State
			}
			apps = append(apps, appInfo{
				Name:          *site.Name,
				ResourceGroup: rg,
				ResourceID:    *site.ID,
				Kind:          kind,
				State:         state,
			})
		}
	}

	if len(apps) == 0 {
		fmt.Println("No App Services found.")
		return nil
	}

	fmt.Fprintf(os.Stderr, "Found %d App Service(s). Querying metrics...\n", len(apps))

	// Query metrics for each app
	metricsClient, err := armmonitor.NewMetricsClient(subID, cred, nil)
	if err != nil {
		return fmt.Errorf("creating metrics client: %w", err)
	}

	endTime := time.Now().UTC()
	startTime := endTime.Add(-14 * 24 * time.Hour)
	timespan := fmt.Sprintf("%s/%s", startTime.Format(time.RFC3339), endTime.Format(time.RFC3339))
	metricNames := "Requests,BytesReceived,BytesSent,Http2xx,Http4xx,Http5xx"
	aggregation := "Total"

	var reports []AppTrafficReport

	for i, app := range apps {
		fmt.Fprintf(os.Stderr, "  [%d/%d] %s...\n", i+1, len(apps), app.Name)

		report := AppTrafficReport{
			Name:          app.Name,
			ResourceGroup: app.ResourceGroup,
			Kind:          app.Kind,
			State:         app.State,
		}

		resp, err := metricsClient.List(ctx, app.ResourceID, &armmonitor.MetricsClientListOptions{
			Timespan:    &timespan,
			Metricnames: &metricNames,
			Aggregation: &aggregation,
		})
		if err != nil {
			fmt.Fprintf(os.Stderr, "    Warning: failed to get metrics for %s: %v\n", app.Name, err)
			report.Status = "Unknown"
			report.Recommendation = "Could not retrieve metrics"
			reports = append(reports, report)
			continue
		}

		for _, metric := range resp.Value {
			if metric.Name == nil || metric.Name.Value == nil {
				continue
			}
			total := sumMetricTimeseries(metric.Timeseries)
			switch *metric.Name.Value {
			case "Requests":
				report.TotalRequests = total
			case "BytesReceived":
				report.BytesReceived = total
			case "BytesSent":
				report.BytesSent = total
			case "Http2xx":
				report.HTTP2xx = total
			case "Http4xx":
				report.HTTP4xx = total
			case "Http5xx":
				report.HTTP5xx = total
			}
		}

		// Classify
		switch {
		case report.TotalRequests == 0 && report.BytesReceived == 0 && report.BytesSent == 0:
			report.Status = "Idle/Unused"
			report.Recommendation = "No traffic in 14 days. Consider shutting down or deleting to save costs."
		case report.TotalRequests < 100:
			report.Status = "Low Traffic"
			report.Recommendation = "Very low traffic. Consider scaling down or consolidating."
		case report.TotalRequests < 1000:
			report.Status = "Low Traffic"
			report.Recommendation = "Low traffic. Review if this app is still needed at current scale."
		default:
			report.Status = "Active"
			report.Recommendation = "Normal traffic levels."
		}

		// Check error rate
		if report.TotalRequests > 0 {
			errorRate := report.HTTP5xx / report.TotalRequests * 100
			if errorRate > 10 {
				report.Recommendation += fmt.Sprintf(" ⚠️  High 5xx error rate (%.1f%%).", errorRate)
			}
		}

		reports = append(reports, report)
	}

	// Output
	switch flagOutput {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(reports)
	default:
		printTable(reports)
	}

	return nil
}

// ClassifyTrafficStatus applies the traffic classification rules to a pre-populated report.
func ClassifyTrafficStatus(report *AppTrafficReport) {
	switch {
	case report.TotalRequests == 0 && report.BytesReceived == 0 && report.BytesSent == 0:
		report.Status = "Idle/Unused"
		report.Recommendation = "No traffic in 14 days. Consider shutting down or deleting to save costs."
	case report.TotalRequests < 100:
		report.Status = "Low Traffic"
		report.Recommendation = "Very low traffic. Consider scaling down or consolidating."
	case report.TotalRequests < 1000:
		report.Status = "Low Traffic"
		report.Recommendation = "Low traffic. Review if this app is still needed at current scale."
	default:
		report.Status = "Active"
		report.Recommendation = "Normal traffic levels."
	}
	if report.TotalRequests > 0 {
		errorRate := report.HTTP5xx / report.TotalRequests * 100
		if errorRate > 10 {
			report.Recommendation += fmt.Sprintf(" ⚠️  High 5xx error rate (%.1f%%).", errorRate)
		}
	}
}

func sumMetricTimeseries(timeseries []*armmonitor.TimeSeriesElement) float64 {
	var total float64
	for _, ts := range timeseries {
		for _, dp := range ts.Data {
			if dp.Total != nil {
				total += *dp.Total
			}
		}
	}
	return total
}

func extractResourceGroup(resourceID string) string {
	parts := strings.Split(resourceID, "/")
	for i, p := range parts {
		if strings.EqualFold(p, "resourceGroups") && i+1 < len(parts) {
			return parts[i+1]
		}
	}
	return ""
}

func formatBytes(b float64) string {
	switch {
	case b >= 1<<30:
		return fmt.Sprintf("%.1f GB", b/float64(1<<30))
	case b >= 1<<20:
		return fmt.Sprintf("%.1f MB", b/float64(1<<20))
	case b >= 1<<10:
		return fmt.Sprintf("%.1f KB", b/float64(1<<10))
	default:
		return fmt.Sprintf("%.0f B", b)
	}
}

func printTable(reports []AppTrafficReport) {
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "")
	fmt.Fprintln(w, "APP SERVICE TRAFFIC ANALYSIS (Last 14 Days)")
	fmt.Fprintln(w, strings.Repeat("=", 120))
	fmt.Fprintln(w, "NAME\tRESOURCE GROUP\tSTATE\tREQUESTS\tRX\tTX\t2xx\t4xx\t5xx\tSTATUS\t")
	fmt.Fprintln(w, "----\t--------------\t-----\t--------\t--\t--\t---\t---\t---\t------\t")

	idleCount, lowCount, activeCount := 0, 0, 0
	for _, r := range reports {
		fmt.Fprintf(w, "%s\t%s\t%s\t%.0f\t%s\t%s\t%.0f\t%.0f\t%.0f\t%s\t\n",
			r.Name, r.ResourceGroup, r.State,
			r.TotalRequests, formatBytes(r.BytesReceived), formatBytes(r.BytesSent),
			r.HTTP2xx, r.HTTP4xx, r.HTTP5xx, r.Status)
		switch r.Status {
		case "Idle/Unused":
			idleCount++
		case "Low Traffic":
			lowCount++
		case "Active":
			activeCount++
		}
	}
	w.Flush()

	fmt.Println()
	fmt.Println("SUMMARY")
	fmt.Println(strings.Repeat("-", 40))
	fmt.Printf("  Total App Services: %d\n", len(reports))
	fmt.Printf("  Active:             %d\n", activeCount)
	fmt.Printf("  Low Traffic:        %d\n", lowCount)
	fmt.Printf("  Idle/Unused:        %d\n", idleCount)
	fmt.Println()

	if idleCount > 0 || lowCount > 0 {
		fmt.Println("RECOMMENDATIONS")
		fmt.Println(strings.Repeat("-", 40))
		for _, r := range reports {
			if r.Status != "Active" {
				fmt.Printf("  â€¢ %s: %s\n", r.Name, r.Recommendation)
			}
		}
		fmt.Println()
	}
}
