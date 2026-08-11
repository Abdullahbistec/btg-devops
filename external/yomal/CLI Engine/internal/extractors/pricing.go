package extractors

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// retailPricesEndpoint is the Azure Retail Prices API — public, unauthenticated,
// no subscription or credential required (spec 11 round 2, gap: Cosmos DB
// RU/s pricing lookup was previously unavailable to the analyzer).
const retailPricesEndpoint = "https://prices.azure.com/api/retail/prices"

// CosmosRegionPricing holds the hourly/monthly unit prices relevant to
// judging whether a Cosmos DB account's throughput mode is cost-efficient
// for its region. Zero-value fields mean the corresponding meter wasn't
// found in that region's catalog (some SKUs aren't offered everywhere).
type CosmosRegionPricing struct {
	Currency                string  `json:"currency"`
	ProvisionedPer100RUHour float64 `json:"provisioned_per_100_ru_hour"`
	AutoscalePer100RUHour   float64 `json:"autoscale_per_100_ru_hour"`
	ServerlessPerMillionRU  float64 `json:"serverless_per_million_ru"`
}

type retailPriceItem struct {
	MeterName    string  `json:"meterName"`
	ProductName  string  `json:"productName"`
	UnitPrice    float64 `json:"unitPrice"`
	CurrencyCode string  `json:"currencyCode"`
}

type retailPriceResponse struct {
	Items    []retailPriceItem `json:"Items"`
	NextLink string            `json:"NextPageLink"`
}

// FetchCosmosRUPricing queries the Retail Prices API once per distinct
// region and returns the provisioned/autoscale/serverless RU/s unit prices
// for each. Best-effort per region: a failed region is simply omitted from
// the result map rather than failing the whole audit — callers should treat
// a missing region as "pricing not available", not an error.
func FetchCosmosRUPricing(ctx context.Context, regions []string) map[string]CosmosRegionPricing {
	seen := map[string]bool{}
	out := map[string]CosmosRegionPricing{}
	client := &http.Client{Timeout: 15 * time.Second}

	for _, region := range regions {
		region = strings.ToLower(strings.TrimSpace(region))
		if region == "" || seen[region] {
			continue
		}
		seen[region] = true

		items, err := fetchRetailPrices(ctx, client, region)
		if err != nil || len(items) == 0 {
			continue
		}

		if pricing := pricingFromItems(items); pricing != (CosmosRegionPricing{}) {
			out[region] = pricing
		}
	}

	return out
}

// pricingFromItems picks the provisioned/autoscale/serverless per-100-RU
// (or per-million-RU) meters out of a region's full Cosmos DB retail catalog
// — a pure function so the exact meter/product names to match can be unit
// tested without a live API call.
func pricingFromItems(items []retailPriceItem) CosmosRegionPricing {
	pricing := CosmosRegionPricing{}
	for _, item := range items {
		switch {
		case item.ProductName == "Azure Cosmos DB" && item.MeterName == "100 RU/s":
			pricing.ProvisionedPer100RUHour = item.UnitPrice
			pricing.Currency = item.CurrencyCode
		case item.ProductName == "Azure Cosmos DB autoscale" && item.MeterName == "AP1 100 RUs":
			pricing.AutoscalePer100RUHour = item.UnitPrice
			pricing.Currency = item.CurrencyCode
		case item.ProductName == "Azure Cosmos DB serverless" && item.MeterName == "1M RUs":
			pricing.ServerlessPerMillionRU = item.UnitPrice
			pricing.Currency = item.CurrencyCode
		}
	}
	return pricing
}

// fetchRetailPrices runs one filtered query against the Retail Prices API
// for Azure Cosmos DB consumption pricing in a single region.
func fetchRetailPrices(ctx context.Context, client *http.Client, region string) ([]retailPriceItem, error) {
	filter := fmt.Sprintf("serviceName eq 'Azure Cosmos DB' and armRegionName eq '%s' and priceType eq 'Consumption'", region)
	reqURL := retailPricesEndpoint + "?$filter=" + url.QueryEscape(filter)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, fmt.Errorf("building retail prices request: %w", err)
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("calling retail prices API: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("retail prices API returned status %d", resp.StatusCode)
	}

	var result retailPriceResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decoding retail prices response: %w", err)
	}
	return result.Items, nil
}
