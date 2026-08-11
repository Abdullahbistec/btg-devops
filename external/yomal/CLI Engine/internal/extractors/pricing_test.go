package extractors

import (
	"context"
	"testing"
)

func TestPricingFromItems_PicksExactMeters(t *testing.T) {
	items := []retailPriceItem{
		{ProductName: "Azure Cosmos DB", MeterName: "100 RU/s", UnitPrice: 0.008, CurrencyCode: "USD"},
		{ProductName: "Azure Cosmos DB autoscale", MeterName: "AP1 100 RUs", UnitPrice: 0.012, CurrencyCode: "USD"},
		{ProductName: "Azure Cosmos DB serverless", MeterName: "1M RUs", UnitPrice: 0.285, CurrencyCode: "USD"},
		// Noise that must NOT match any of the three meters above.
		{ProductName: "Azure Cosmos DB", MeterName: "100 Multi-master RU/s", UnitPrice: 0.016, CurrencyCode: "USD"},
		{ProductName: "Azure DocumentDB", MeterName: "vCore", UnitPrice: 7.7365, CurrencyCode: "USD"},
	}

	got := pricingFromItems(items)
	want := CosmosRegionPricing{
		Currency:                "USD",
		ProvisionedPer100RUHour: 0.008,
		AutoscalePer100RUHour:   0.012,
		ServerlessPerMillionRU:  0.285,
	}
	if got != want {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func TestPricingFromItems_EmptyWhenNoMatch(t *testing.T) {
	items := []retailPriceItem{
		{ProductName: "Azure DocumentDB", MeterName: "vCore", UnitPrice: 7.7365, CurrencyCode: "USD"},
	}
	got := pricingFromItems(items)
	if got != (CosmosRegionPricing{}) {
		t.Errorf("expected zero-value pricing for no matching meters, got %+v", got)
	}
}

func TestFetchCosmosRUPricing_DedupsAndSkipsEmptyRegions(t *testing.T) {
	// No network available/expected in this test — just verifies the
	// dedup/blank-skip logic short-circuits without ever reaching HTTP for
	// duplicate or empty region names.
	out := FetchCosmosRUPricing(context.TODO(), []string{"", "  ", ""})
	if len(out) != 0 {
		t.Errorf("expected no regions queried for blank input, got %v", out)
	}
}
