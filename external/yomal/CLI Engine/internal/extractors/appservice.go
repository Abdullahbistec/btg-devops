package extractors

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/appservice/armappservice/v2"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/monitor/armmonitor"
)

// AppServiceMetrics holds 30-day traffic metrics from Azure Monitor.
type AppServiceMetrics struct {
	TotalRequests float64 `json:"total_requests"`
	BytesReceived float64 `json:"bytes_received"`
	BytesSent     float64 `json:"bytes_sent"`
	HTTP2xx       float64 `json:"http_2xx"`
	HTTP4xx       float64 `json:"http_4xx"`
	HTTP5xx       float64 `json:"http_5xx"`
	PeriodDays    int     `json:"period_days"`
}

// AppServiceEntry combines clean config JSON with traffic metrics and
// per-site security enrichment (spec 11 §1) for one app.
type AppServiceEntry struct {
	Config json.RawMessage `json:"config"`
	SiteEnrichment
	Metrics AppServiceMetrics `json:"metrics"`
	// Set when the Azure Monitor call failed — metrics values are then
	// unknown, NOT genuinely zero. Analyzers must treat zeros with this
	// field present as "not collected" (spec 11 §3).
	MetricsError string `json:"metrics_error,omitempty"`
}

// AppServiceData holds clean extracted data for all app services.
type AppServiceData struct {
	TotalApps int               `json:"total_apps"`
	Apps      []AppServiceEntry `json:"apps"`
}

// ExtractAppService fetches all web apps (excluding function apps), cleans
// their config, and merges 30-day Azure Monitor traffic metrics into each entry.
func ExtractAppService(ctx context.Context, subID string, cred azcore.TokenCredential) (*AppServiceData, error) {
	webClient, err := armappservice.NewWebAppsClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating web apps client: %w", err)
	}

	metricsClient, err := armmonitor.NewMetricsClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating metrics client: %w", err)
	}

	// Collect all web apps — exclude function apps (handled by functions extractor)
	type siteInfo struct {
		site       *armappservice.Site
		resourceID string
	}
	var sites []siteInfo

	pager := webClient.NewListPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("listing web apps: %w", err)
		}
		for _, site := range page.Value {
			if site.ID == nil {
				continue
			}
			if site.Kind != nil && strings.Contains(strings.ToLower(*site.Kind), "functionapp") {
				continue
			}
			sites = append(sites, siteInfo{site: site, resourceID: *site.ID})
		}
	}

	// Build metrics timespan — last 30 days
	endTime := time.Now().UTC()
	startTime := endTime.Add(-30 * 24 * time.Hour)
	timespan := fmt.Sprintf("%s/%s", startTime.Format(time.RFC3339), endTime.Format(time.RFC3339))
	metricNames := "Requests,BytesReceived,BytesSent,Http2xx,Http4xx,Http5xx"
	aggregation := "Total"
	// Without an explicit interval, a 30-day timespan exceeds Azure
	// Monitor's data-point limit and the call fails — which used to be
	// swallowed silently, reporting fake zeros for every app (the exact
	// unreliable-metrics gap the analyzer flagged, spec 11 §3).
	interval := "P1D"

	var entries []AppServiceEntry

	for _, s := range sites {
		// Clean the site config
		cleanConfig, err := CleanResource(s.site)
		if err != nil {
			return nil, fmt.Errorf("cleaning app service %s: %w", derefStr(s.site.Name), err)
		}

		// Fetch metrics from Azure Monitor
		metrics := AppServiceMetrics{PeriodDays: 30}
		metricsError := ""
		resp, err := metricsClient.List(ctx, s.resourceID, &armmonitor.MetricsClientListOptions{
			Timespan:    &timespan,
			Metricnames: &metricNames,
			Aggregation: &aggregation,
			Interval:    &interval,
		})
		if err != nil {
			metricsError = err.Error()
		} else {
			for _, metric := range resp.Value {
				if metric.Name == nil || metric.Name.Value == nil {
					continue
				}
				total := sumTimeseries(metric.Timeseries)
				switch *metric.Name.Value {
				case "Requests":
					metrics.TotalRequests = total
				case "BytesReceived":
					metrics.BytesReceived = total
				case "BytesSent":
					metrics.BytesSent = total
				case "Http2xx":
					metrics.HTTP2xx = total
				case "Http4xx":
					metrics.HTTP4xx = total
				case "Http5xx":
					metrics.HTTP5xx = total
				}
			}
		}

		entries = append(entries, AppServiceEntry{
			Config:         json.RawMessage(cleanConfig),
			SiteEnrichment: EnrichSite(ctx, webClient, extractResourceGroup(s.resourceID), derefStr(s.site.Name)),
			Metrics:        metrics,
			MetricsError:   metricsError,
		})
	}

	return &AppServiceData{
		TotalApps: len(entries),
		Apps:      entries,
	}, nil
}

func sumTimeseries(timeseries []*armmonitor.TimeSeriesElement) float64 {
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
