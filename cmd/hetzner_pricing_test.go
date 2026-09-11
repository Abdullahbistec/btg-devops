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
	got := loadPricingFixture(t).VolumeMonthlyPerGB()
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
