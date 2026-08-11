package extractors

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/policy"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/runtime"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/costmanagement/armcostmanagement"
)

// armManagementEndpoint is Azure Resource Manager's base URL. Cost
// Management's NextLink is sometimes a full URL and sometimes a relative
// path (observed against a real subscription) — relative links need this
// prefix before they can be requested.
const armManagementEndpoint = "https://management.azure.com"

// armManagementScope is the OAuth scope for Azure Resource Manager, used to
// follow Cost Management's NextLink pages manually — the SDK's QueryClient
// exposes no pager for Usage(), only a raw NextLink URL in the response.
const armManagementScope = armManagementEndpoint + "/.default"

// CostData holds the raw daily cost rows for a subscription, both actual and
// amortized, exactly as Azure Cost Management reports them. No aggregation,
// filtering, or interpretation happens here — Claude analyzes this data later.
type CostData struct {
	TotalRows         int               `json:"total_rows"`
	PeriodFrom        string            `json:"period_from"`
	PeriodTo          string            `json:"period_to"`
	ActualCostRows    []json.RawMessage `json:"actual_cost_rows"`
	AmortizedCostRows []json.RawMessage `json:"amortized_cost_rows"`
}

// ExtractCost queries Azure Cost Management once for the subscription's
// daily actual cost and once for daily amortized cost, grouped by resource
// and service. Every row is kept as-is — including zero and negative
// (credit / refund) rows — because dropping any of them is an interpretive
// judgment, not a cleaning decision.
func ExtractCost(ctx context.Context, subID string, cred azcore.TokenCredential) (*CostData, error) {
	client, err := armcostmanagement.NewQueryClient(cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating cost management client: %w", err)
	}

	// Used only to follow NextLink pages — Usage() has no built-in pager.
	pipeline := runtime.NewPipeline("armcostmanagement-pager", "v1", runtime.PipelineOptions{}, &policy.ClientOptions{
		PerRetryPolicies: []policy.Policy{runtime.NewBearerTokenPolicy(cred, []string{armManagementScope}, nil)},
	})

	end := time.Now().UTC()
	// 90 days, not 30 (spec 11 §7) — the deep-research analyzer needs enough
	// history to tell a longstanding spend pattern from a recent change.
	start := end.AddDate(0, 0, -90)
	scope := fmt.Sprintf("/subscriptions/%s", subID)

	actualRows, err := queryCostRows(ctx, client, pipeline, scope, armcostmanagement.ExportTypeActualCost, start, end)
	if err != nil {
		return nil, fmt.Errorf("querying actual cost: %w", err)
	}

	// Amortized cost is unavailable for subscriptions with no Reservations /
	// Savings Plans, or may not be enabled for the tenant. That's expected —
	// don't fail the whole extractor over a missing supplementary series.
	amortizedRows, err := queryCostRows(ctx, client, pipeline, scope, armcostmanagement.ExportTypeAmortizedCost, start, end)
	if err != nil {
		fmt.Fprintf(os.Stderr, "  warning: amortized cost query failed, continuing with actual cost only: %v\n", err)
		amortizedRows = nil
	}

	return &CostData{
		TotalRows:         len(actualRows) + len(amortizedRows),
		PeriodFrom:        start.Format("2006-01-02"),
		PeriodTo:          end.Format("2006-01-02"),
		ActualCostRows:    actualRows,
		AmortizedCostRows: amortizedRows,
	}, nil
}

// queryCostRows runs a Cost Management query at Daily granularity, grouped
// by ResourceId and ServiceName, following every NextLink page until the
// full result set is retrieved, and reshapes the columnar response
// (columns[] + rows[][]) into one named JSON object per row using the
// column names as keys. Every column returned by the API is kept — there is
// no noise to strip here the way there is on the ARM resource envelope.
func queryCostRows(ctx context.Context, client *armcostmanagement.QueryClient, pipeline runtime.Pipeline, scope string, exportType armcostmanagement.ExportType, start, end time.Time) ([]json.RawMessage, error) {
	granularity := armcostmanagement.GranularityTypeDaily
	timeframe := armcostmanagement.TimeframeTypeCustom
	costFunc := armcostmanagement.FunctionTypeSum
	dimType := armcostmanagement.QueryColumnTypeDimension

	query := armcostmanagement.QueryDefinition{
		Type:      &exportType,
		Timeframe: &timeframe,
		TimePeriod: &armcostmanagement.QueryTimePeriod{
			From: &start,
			To:   &end,
		},
		Dataset: &armcostmanagement.QueryDataset{
			Granularity: &granularity,
			Aggregation: map[string]*armcostmanagement.QueryAggregation{
				"totalCost": {
					Name:     strPtr("Cost"),
					Function: &costFunc,
				},
			},
			Grouping: []*armcostmanagement.QueryGrouping{
				{Type: &dimType, Name: strPtr("ResourceId")},
				{Type: &dimType, Name: strPtr("ServiceName")},
			},
		},
	}

	result, err := client.Usage(ctx, scope, query, nil)
	if err != nil {
		return nil, err
	}
	if result.Properties == nil {
		return nil, nil
	}

	rows := reshapeCostRows(result.Properties)

	// Follow every subsequent page — Usage() has no built-in pager, so pages
	// beyond the first are fetched with a raw authenticated POST to
	// NextLink (Cost Management's continuation is POST + the original
	// query body, unlike ARM's GET-based resource-listing pagers).
	// nextLinkStr guards against a pointer to an empty string, which the
	// API has been observed to return in place of an actual nil — treating
	// that the same as "no more pages" rather than requesting a bare
	// endpoint URL with no path or api-version.
	const maxCostPages = 50 // defensive cap — never loop forever on a malformed link
	nextLink := result.Properties.NextLink
	pageCount := 1
	for nextLink != nil && *nextLink != "" && pageCount < maxCostPages {
		pageCount++
		page, err := fetchCostPage(ctx, pipeline, resolveNextLink(*nextLink), query)
		if err != nil {
			fmt.Fprintf(os.Stderr, "  warning: cost pagination stopped at page %d: %v\n", pageCount, err)
			break
		}
		if page.Properties == nil {
			break
		}
		rows = append(rows, reshapeCostRows(page.Properties)...)
		nextLink = page.Properties.NextLink
	}
	if pageCount > 1 {
		fmt.Fprintf(os.Stderr, "  cost: followed %d page(s) for %d total row(s)\n", pageCount, len(rows))
	}

	return rows, nil
}

// resolveNextLink returns nextLink unchanged if it's already an absolute
// URL, or prefixes it with the ARM endpoint if it's a relative path.
func resolveNextLink(nextLink string) string {
	if strings.HasPrefix(nextLink, "http://") || strings.HasPrefix(nextLink, "https://") {
		return nextLink
	}
	return runtime.JoinPaths(armManagementEndpoint, nextLink)
}

// fetchCostPage issues a raw authenticated POST to a Cost Management
// NextLink URL, resending the original query body — Cost Management's
// continuation pages are POSTs, not GETs, unlike ARM resource-listing
// pagers — and decodes the response using the same generated type as the
// primary Usage() call.
func fetchCostPage(ctx context.Context, pipeline runtime.Pipeline, nextLink string, query armcostmanagement.QueryDefinition) (*armcostmanagement.QueryResult, error) {
	req, err := runtime.NewRequest(ctx, http.MethodPost, nextLink)
	if err != nil {
		return nil, err
	}
	req.Raw().Header["Accept"] = []string{"application/json"}
	if err := runtime.MarshalAsJSON(req, query); err != nil {
		return nil, err
	}
	resp, err := pipeline.Do(req)
	if err != nil {
		return nil, err
	}
	if !runtime.HasStatusCode(resp, http.StatusOK) {
		return nil, runtime.NewResponseError(resp)
	}
	var result armcostmanagement.QueryResult
	if err := runtime.UnmarshalAsJSON(resp, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// reshapeCostRows converts one page's columnar response (columns[] +
// rows[][]) into named JSON objects using the column names as keys.
func reshapeCostRows(props *armcostmanagement.QueryProperties) []json.RawMessage {
	colNames := make([]string, len(props.Columns))
	for i, col := range props.Columns {
		if col.Name != nil {
			colNames[i] = *col.Name
		}
	}

	rows := make([]json.RawMessage, 0, len(props.Rows))
	for _, row := range props.Rows {
		obj := make(map[string]any, len(colNames))
		for i, val := range row {
			if i < len(colNames) && colNames[i] != "" {
				obj[colNames[i]] = val
			}
		}
		clean, err := json.Marshal(obj)
		if err != nil {
			continue
		}
		rows = append(rows, json.RawMessage(clean))
	}
	return rows
}

func strPtr(s string) *string { return &s }
