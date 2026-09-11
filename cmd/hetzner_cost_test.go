package cmd

import (
	"strings"
	"testing"
)

func TestHetznerCostReport_TotalsByCategory(t *testing.T) {
	p := loadPricingFixture(t)
	servers := []hetznerServer{
		{Name: "a", ServerType: hetznerServerType{Name: "cpx11"}, Datacenter: hetznerDatacenter{Location: hetznerLocation{Name: "fsn1"}}},
		{Name: "b", ServerType: hetznerServerType{Name: "cpx11"}, Datacenter: hetznerDatacenter{Location: hetznerLocation{Name: "fsn1"}}},
	}
	volumes := []hetznerVolume{{Name: "v1", Size: 100}}

	r := hetznerCostReport(servers, volumes, nil, p)

	if r.Currency != "USD" {
		t.Errorf("Currency = %q, want USD", r.Currency)
	}
	if !r.Estimate {
		t.Error("Estimate = false, want true — this is list price, never an invoice")
	}
	if r.ByType["cpx11"].Count != 2 {
		t.Errorf("cpx11 count = %d, want 2", r.ByType["cpx11"].Count)
	}
	// servers + volumes must both contribute
	if r.ByCategory["servers"] <= 0 || r.ByCategory["volumes"] <= 0 {
		t.Errorf("ByCategory = %+v, want positive servers and volumes", r.ByCategory)
	}
	want := r.ByCategory["servers"] + r.ByCategory["volumes"]
	if diff := r.TotalMonthly - want; diff > 0.01 || diff < -0.01 {
		t.Errorf("TotalMonthly = %v, want %v", r.TotalMonthly, want)
	}
}

func TestHetznerCostReport_RecordsUnpricedResources(t *testing.T) {
	p := loadPricingFixture(t)
	servers := []hetznerServer{{Name: "mystery", ServerType: hetznerServerType{Name: "made-up"}}}

	r := hetznerCostReport(servers, nil, nil, p)

	if len(r.Unpriced) != 1 || !strings.Contains(r.Unpriced[0], "mystery") {
		t.Errorf("Unpriced = %v, want the unpriced server named", r.Unpriced)
	}
}
