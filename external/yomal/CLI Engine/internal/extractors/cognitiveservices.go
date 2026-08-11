package extractors

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/cognitiveservices/armcognitiveservices"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/monitor/armmonitor"
)

// CognitiveServicesData holds the clean extracted data for all cognitive services accounts.
type CognitiveServicesData struct {
	TotalAccounts int               `json:"total_accounts"`
	Accounts      []json.RawMessage `json:"accounts"`
}

// CognitiveServicesMetrics holds 30-day call-volume metrics from Azure
// Monitor — added spec 11 round 3 to answer "is this account/tier actually
// used?" (pricing-tier fit, unused-account detection), which the account
// config alone can't answer.
type CognitiveServicesMetrics struct {
	TotalCalls      float64 `json:"total_calls"`
	SuccessfulCalls float64 `json:"successful_calls"`
	TotalErrors     float64 `json:"total_errors"`
	PeriodDays      int     `json:"period_days"`
}

// ExtractCognitiveServices fetches all cognitive services accounts and returns clean JSON.
func ExtractCognitiveServices(ctx context.Context, subID string, cred azcore.TokenCredential) (*CognitiveServicesData, error) {
	client, err := armcognitiveservices.NewAccountsClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating cognitive services client: %w", err)
	}
	metricsClient, err := armmonitor.NewMetricsClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating metrics client: %w", err)
	}

	var accounts []*armcognitiveservices.Account
	pager := client.NewListPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("listing cognitive services accounts: %w", err)
		}
		accounts = append(accounts, page.Value...)
	}

	// Each account is enriched with its diagnostic settings (spec 11 §5) and
	// call-volume metrics (spec 11 round 3) — merged into the cleaned
	// envelope, output shape unchanged.
	cleanAccounts := make([]json.RawMessage, 0, len(accounts))
	for _, account := range accounts {
		clean, err := CleanResource(account)
		if err != nil {
			return nil, fmt.Errorf("cleaning cognitive services account %s: %w", derefStr(account.Name), err)
		}
		extra := map[string]any{}
		if account.ID != nil {
			addDiagnosticSettings(ctx, cred, *account.ID, extra)
			metrics, err := fetchCognitiveServicesMetrics(ctx, metricsClient, *account.ID)
			if err != nil {
				extra["metrics_error"] = err.Error()
			} else {
				extra["metrics"] = metrics
			}
		}
		enriched, err := mergeIntoJSON(clean, extra)
		if err != nil {
			return nil, fmt.Errorf("enriching cognitive services account %s: %w", derefStr(account.Name), err)
		}
		cleanAccounts = append(cleanAccounts, enriched)
	}

	return &CognitiveServicesData{
		TotalAccounts: len(accounts),
		Accounts:      cleanAccounts,
	}, nil
}

func fetchCognitiveServicesMetrics(ctx context.Context, client *armmonitor.MetricsClient, resourceID string) (CognitiveServicesMetrics, error) {
	metrics := CognitiveServicesMetrics{PeriodDays: 30}

	endTime := time.Now().UTC()
	startTime := endTime.Add(-30 * 24 * time.Hour)
	timespan := fmt.Sprintf("%s/%s", startTime.Format(time.RFC3339), endTime.Format(time.RFC3339))
	metricNames := "TotalCalls,SuccessfulCalls,TotalErrors"
	aggregation := "Total"
	interval := "P1D"

	resp, err := client.List(ctx, resourceID, &armmonitor.MetricsClientListOptions{
		Timespan:    &timespan,
		Metricnames: &metricNames,
		Aggregation: &aggregation,
		Interval:    &interval,
	})
	if err != nil {
		return metrics, err
	}

	for _, metric := range resp.Value {
		if metric.Name == nil || metric.Name.Value == nil {
			continue
		}
		total := sumTimeseries(metric.Timeseries)
		switch *metric.Name.Value {
		case "TotalCalls":
			metrics.TotalCalls = total
		case "SuccessfulCalls":
			metrics.SuccessfulCalls = total
		case "TotalErrors":
			metrics.TotalErrors = total
		}
	}
	return metrics, nil
}
