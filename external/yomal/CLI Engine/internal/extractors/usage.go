package extractors

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/monitor/armmonitor"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/resources/armresources"
)

// usageWorkerCount bounds how many Azure Monitor calls run concurrently.
// Azure Monitor's default throttling limit is generous enough that this
// stays well clear of 429s while being far faster than one call at a time.
const usageWorkerCount = 8

// usageMetricsByType maps each ARM resource type (lowercase) worth sampling
// to the Azure Monitor metric names that describe its actual utilization.
// Resource types not listed here are skipped — not every resource type
// exposes meaningful runtime metrics.
var usageMetricsByType = map[string][]string{
	"microsoft.documentdb/databaseaccounts":  {"TotalRequestUnits", "NormalizedRUConsumption"},
	"microsoft.storage/storageaccounts":      {"UsedCapacity", "Transactions"},
	"microsoft.web/serverfarms":              {"CpuPercentage", "MemoryPercentage"},
	"microsoft.web/sites":                    {"CpuTime", "Requests"},
	"microsoft.keyvault/vaults":              {"ServiceApiHit"},
	"microsoft.containerregistry/registries": {"TotalPullCount", "TotalPushCount"},
	"microsoft.network/publicipaddresses":    {"BytesInDDoS", "PacketsInDDoS"},
	"microsoft.cognitiveservices/accounts":   {"TotalCalls", "TotalErrors"},
}

// ArmTypeToSlug mirrors the dashboard's ARM_TYPE_TO_SLUG (dashboard/app/api/
// utils/usage.ts) — kept in sync manually since one is Go and one is
// TypeScript. Used to tell which "usage:<slug>" analysis scopes actually
// have data after a collection run, so collect.go can auto-queue them.
var ArmTypeToSlug = map[string]string{
	"microsoft.documentdb/databaseaccounts":  "cosmosdb",
	"microsoft.storage/storageaccounts":      "storage",
	"microsoft.web/serverfarms":              "appserviceplan",
	"microsoft.web/sites":                    "appservice",
	"microsoft.keyvault/vaults":              "keyvault",
	"microsoft.containerregistry/registries": "acr",
	"microsoft.network/publicipaddresses":    "publicip",
	"microsoft.cognitiveservices/accounts":   "cognitiveservices",
}

// UsageData holds raw Azure Monitor metric values per resource. No waste
// scoring, savings estimates, or utilization judgments happen here — Claude
// interprets these numbers alongside the Cost extractor's data later.
type UsageData struct {
	TotalResourcesSampled int               `json:"total_resources_sampled"`
	PeriodFrom            string            `json:"period_from"`
	PeriodTo              string            `json:"period_to"`
	Metrics               []json.RawMessage `json:"metrics"`
}

// ExtractUsage discovers every resource of the supported types in the
// subscription and fetches Azure Monitor metrics for each. It is fully
// self-contained — it does not depend on the other 12 extractors' output,
// since CleanResource() strips the "id" field they'd otherwise need to
// reuse for a Monitor lookup.
func ExtractUsage(ctx context.Context, subID string, cred azcore.TokenCredential) (*UsageData, error) {
	resourcesClient, err := armresources.NewClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating resources client: %w", err)
	}
	metricsClient, err := armmonitor.NewMetricsClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating monitor client: %w", err)
	}

	end := time.Now().UTC()
	start := end.AddDate(0, 0, -30)
	timespan := fmt.Sprintf("%s/%s", start.Format(time.RFC3339), end.Format(time.RFC3339))

	// Build the full job list up front so all resource types can be sampled
	// concurrently, instead of processing one Monitor call at a time.
	type job struct {
		armType     string
		resourceID  string
		metricNames []string
	}
	var jobs []job

	for armType, metricNames := range usageMetricsByType {
		ids, err := listResourceIDsByType(ctx, resourcesClient, armType)
		if err != nil {
			fmt.Fprintf(os.Stderr, "  usage: listing %s failed: %v\n", armType, err)
			continue
		}
		fmt.Fprintf(os.Stderr, "  usage: %s — %d resource(s)\n", armType, len(ids))
		for _, id := range ids {
			jobs = append(jobs, job{armType, id, metricNames})
		}
	}

	jobCh := make(chan job)
	resultCh := make(chan []json.RawMessage)
	var wg sync.WaitGroup

	for w := 0; w < usageWorkerCount; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range jobCh {
				metricCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
				result, err := metricsClient.List(metricCtx, j.resourceID, &armmonitor.MetricsClientListOptions{
					Metricnames: strPtr(strings.Join(j.metricNames, ",")),
					Timespan:    strPtr(timespan),
					// Daily (not hourly) — the dashboard only ever displays a
					// period-level average/total, so 30 daily points is all
					// the resolution that's actually used. Hourly (720
					// points/metric) made usage_data over 1MB per audit and
					// took several seconds just to decompress on every page
					// load; daily cuts that ~24x while still leaving room for
					// a future day-by-day usage trend chart if one is built.
					Interval:    strPtr("P1D"),
					Aggregation: strPtr("Average,Total,Count"),
				})
				cancel()
				if err != nil {
					// One resource's metrics failing (e.g. metric not
					// supported for its SKU) shouldn't drop the others.
					resultCh <- nil
					continue
				}
				clean, err := cleanMetricResult(j.resourceID, result.Value)
				if err != nil {
					resultCh <- nil
					continue
				}
				resultCh <- clean
			}
		}()
	}

	go func() {
		for _, j := range jobs {
			jobCh <- j
		}
		close(jobCh)
	}()
	go func() {
		wg.Wait()
		close(resultCh)
	}()

	var entries []json.RawMessage
	for clean := range resultCh {
		entries = append(entries, clean...)
	}

	return &UsageData{
		TotalResourcesSampled: len(jobs),
		PeriodFrom:            start.Format("2006-01-02"),
		PeriodTo:              end.Format("2006-01-02"),
		Metrics:               entries,
	}, nil
}

// listResourceIDsByType lists every resource ARM ID of one resource type in
// the subscription.
func listResourceIDsByType(ctx context.Context, client *armresources.Client, armType string) ([]string, error) {
	filter := fmt.Sprintf("resourceType eq '%s'", armType)
	var ids []string

	pager := client.NewListPager(&armresources.ClientListOptions{Filter: &filter})
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return ids, err
		}
		for _, r := range page.Value {
			if r.ID != nil {
				ids = append(ids, *r.ID)
			}
		}
	}
	return ids, nil
}

// cleanMetricResult reshapes Azure Monitor's per-metric response into one
// flat JSON object per metric, keeping every real datapoint (timestamp +
// average/total/count/min/max) exactly as returned. No thresholds, scores,
// or savings estimates are computed here.
func cleanMetricResult(resourceID string, metrics []*armmonitor.Metric) ([]json.RawMessage, error) {
	out := make([]json.RawMessage, 0, len(metrics))
	for _, m := range metrics {
		if m == nil {
			continue
		}

		name := ""
		if m.Name != nil && m.Name.Value != nil {
			name = *m.Name.Value
		}

		unit := ""
		if m.Unit != nil {
			unit = string(*m.Unit)
		}

		var dataPoints []map[string]any
		for _, ts := range m.Timeseries {
			if ts == nil {
				continue
			}
			for _, dp := range ts.Data {
				if dp == nil {
					continue
				}
				point := map[string]any{}
				if dp.TimeStamp != nil {
					point["timestamp"] = dp.TimeStamp.Format(time.RFC3339)
				}
				if dp.Average != nil {
					point["average"] = *dp.Average
				}
				if dp.Total != nil {
					point["total"] = *dp.Total
				}
				if dp.Count != nil {
					point["count"] = *dp.Count
				}
				if dp.Minimum != nil {
					point["minimum"] = *dp.Minimum
				}
				if dp.Maximum != nil {
					point["maximum"] = *dp.Maximum
				}
				dataPoints = append(dataPoints, point)
			}
		}

		// Pre-computed once here so every dashboard page load doesn't have to
		// re-loop over data_points just to get the same average/total.
		var avgSum float64
		var avgCount int
		var totalSum float64
		var totalCount int
		for _, p := range dataPoints {
			if v, ok := p["average"].(float64); ok {
				avgSum += v
				avgCount++
			}
			if v, ok := p["total"].(float64); ok {
				totalSum += v
				totalCount++
			}
		}
		summary := map[string]any{"avg": nil, "total": nil}
		if avgCount > 0 {
			summary["avg"] = avgSum / float64(avgCount)
		}
		if totalCount > 0 {
			summary["total"] = totalSum
		}

		entry := map[string]any{
			"resource_id": resourceID,
			"metric_name": name,
			"unit":        unit,
			"data_points": dataPoints,
			"summary":     summary,
		}
		clean, err := json.Marshal(entry)
		if err != nil {
			return nil, fmt.Errorf("marshaling metric entry: %w", err)
		}
		out = append(out, json.RawMessage(clean))
	}
	return out, nil
}

// armTypeFromResourceID recovers the ARM resource type from a full resource
// ID's "/providers/{Namespace}/{Type}/" segment — mirrors resourceTypeSlug in
// dashboard/app/api/utils/usage.ts, since Monitor metrics only carry the full
// resource ID, not a clean type field.
var armTypeSegment = regexp.MustCompile(`(?i)/providers/([^/]+)/([^/]+)/`)

func armTypeFromResourceID(resourceID string) string {
	m := armTypeSegment.FindStringSubmatch(resourceID)
	if m == nil {
		return ""
	}
	return strings.ToLower(m[1]) + "/" + strings.ToLower(m[2])
}

// UsageTypeSlugs returns the distinct dashboard resource-type slugs (e.g.
// "cosmosdb", "storage") that actually have metric data in a UsageData
// result — used by collect.go to auto-queue one "usage:<slug>" analysis
// request per type with real data, instead of every configured type
// regardless of whether Monitor returned anything.
func UsageTypeSlugs(data *UsageData) []string {
	if data == nil {
		return nil
	}
	seen := map[string]bool{}
	var slugs []string
	for _, raw := range data.Metrics {
		var entry struct {
			ResourceID string `json:"resource_id"`
		}
		if err := json.Unmarshal(raw, &entry); err != nil {
			continue
		}
		slug := ArmTypeToSlug[armTypeFromResourceID(entry.ResourceID)]
		if slug == "" || seen[slug] {
			continue
		}
		seen[slug] = true
		slugs = append(slugs, slug)
	}
	return slugs
}
