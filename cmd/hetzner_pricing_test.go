package cmd

import (
	"os"
	"testing"
)

func loadPricingFixture(t *testing.T) *hetznerPricing {
	t.Helper()
	raw, err := os.ReadFile("testdata/hetzner_pricing.json")
	if err != nil {
		t.Fatalf("reading fixture: %v", err)
	}
	p, err := parseHetznerPricing(raw)
	if err != nil {
		t.Fatalf("parseHetznerPricing: %v", err)
	}
	return p
}

func TestHetznerPricing_Currency(t *testing.T) {
	if got := loadPricingFixture(t).Currency(); got != "USD" {
		t.Errorf("Currency() = %q, want USD", got)
	}
}

func TestHetznerPricing_VolumeMonthlyPerGB(t *testing.T) {
	// Regression guard: this was hardcoded at 0.0440 and drifted badly.
	// The point is that the number comes from the payload, not source.
	got, ok := loadPricingFixture(t).VolumeMonthlyPerGB()
	if !ok {
		t.Fatal("VolumeMonthlyPerGB() reported a miss, want found")
	}
	if got <= 0.05 || got >= 0.12 {
		t.Errorf("VolumeMonthlyPerGB() = %v, want a plausible live price", got)
	}
}

func TestHetznerPricing_ServerMonthly_KnownType(t *testing.T) {
	price, ok := loadPricingFixture(t).ServerMonthly("cpx11", "fsn1")
	if !ok {
		t.Fatal("ServerMonthly(cpx11, fsn1) not found")
	}
	if price <= 0 {
		t.Errorf("price = %v, want > 0", price)
	}
}

func TestHetznerPricing_ServerMonthly_UnknownTypeReportsMiss(t *testing.T) {
	// A miss must be reported, never returned as a silent 0 — that would
	// understate the run rate and look like a free server.
	if _, ok := loadPricingFixture(t).ServerMonthly("nonexistent-type", "fsn1"); ok {
		t.Error("ServerMonthly(nonexistent-type) reported found, want miss")
	}
}

func TestHetznerPricing_ServerMonthly_UnknownLocationFallsBack(t *testing.T) {
	// Locations price near-identically, so falling back is acceptable —
	// but it must still report found, with a real price.
	price, ok := loadPricingFixture(t).ServerMonthly("cpx11", "no-such-location")
	if !ok || price <= 0 {
		t.Errorf("got (%v, %v), want a fallback price", price, ok)
	}
}

func TestHetznerPricing_ServerMonthly_MalformedGrossReportsMiss(t *testing.T) {
	// A malformed gross string must never parse to a silent 0 — that would
	// price the server for free instead of surfacing the bad payload data.
	// Built inline rather than in the captured fixture, which must stay a
	// faithful copy of the live response.
	p := &hetznerPricing{}
	p.Pricing.Currency = "USD"
	p.Pricing.ServerTypes = []hetznerServerTypePrice{
		{
			Name: "cpx11",
			Prices: []hetznerLocationPrice{
				{Location: "fsn1", PriceMonthly: hetznerPriceAmount{Gross: "not-a-number"}},
			},
		},
	}

	if _, ok := p.ServerMonthly("cpx11", "fsn1"); ok {
		t.Error("ServerMonthly with malformed gross reported found, want miss")
	}
}

func TestHetznerPricing_ServerMonthly_UsesGrossNotNet(t *testing.T) {
	// The captured fixture has vat_rate 0, so net == gross everywhere and a
	// switch to reading Net instead of Gross would pass every other test in
	// this file undetected. Built inline (not fixture-edited, which must
	// stay a faithful capture of the live response) with net != gross so a
	// regression back to Net is caught.
	p := &hetznerPricing{}
	p.Pricing.Currency = "USD"
	p.Pricing.ServerTypes = []hetznerServerTypePrice{
		{
			Name: "cpx11",
			Prices: []hetznerLocationPrice{
				{Location: "fsn1", PriceMonthly: hetznerPriceAmount{Net: "5.00", Gross: "5.95"}},
			},
		},
	}

	price, ok := p.ServerMonthly("cpx11", "fsn1")
	if !ok {
		t.Fatal("ServerMonthly(cpx11, fsn1) reported a miss, want found")
	}
	if price != 5.95 {
		t.Errorf("ServerMonthly(cpx11, fsn1) = %v, want 5.95 (the gross price, not 5.00 net)", price)
	}
}
