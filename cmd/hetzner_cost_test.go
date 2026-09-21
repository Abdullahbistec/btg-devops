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

func TestHetznerCostReport_ResourcesCarryPerLineDetail(t *testing.T) {
	p := loadPricingFixture(t)
	servers := []hetznerServer{
		{Name: "a", ServerType: hetznerServerType{Name: "cpx11"}, Datacenter: hetznerDatacenter{Location: hetznerLocation{Name: "fsn1"}}},
	}
	volumes := []hetznerVolume{{Name: "v1", Size: 100}}
	ips := []hetznerPrimaryIP{{Name: "ip1", Type: "ipv4", Datacenter: hetznerDatacenter{Location: hetznerLocation{Name: "fsn1"}}}}

	r := hetznerCostReport(servers, volumes, ips, p)

	if len(r.Resources) != 3 {
		t.Fatalf("len(Resources) = %d, want 3 (server, volume, ip)", len(r.Resources))
	}
	var server, volume, ip *HetznerCostResourceLine
	for i := range r.Resources {
		switch r.Resources[i].Name {
		case "a":
			server = &r.Resources[i]
		case "v1":
			volume = &r.Resources[i]
		case "ip1":
			ip = &r.Resources[i]
		}
	}
	if server == nil || server.Type != "cpx11" || server.Monthly <= 0 {
		t.Errorf("server resource line = %+v, want type cpx11 with positive Monthly", server)
	}
	if volume == nil || volume.Unit != "GB" || volume.Count != 100 || volume.Monthly <= 0 {
		t.Errorf("volume resource line = %+v, want Unit GB, Count 100, positive Monthly", volume)
	}
	if ip == nil || ip.Monthly <= 0 {
		t.Errorf("ip resource line = %+v, want positive Monthly", ip)
	}
	// Every line's own Monthly must sum to the report total — the
	// reconciliation table is only trustworthy if it foots to the headline.
	var sum float64
	for _, res := range r.Resources {
		sum += res.Monthly
	}
	if diff := sum - r.TotalMonthly; diff > 0.01 || diff < -0.01 {
		t.Errorf("sum(Resources.Monthly) = %v, want %v (TotalMonthly)", sum, r.TotalMonthly)
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

func TestHetznerCostReport_MissingVolumePriceIsUnpricedNotZero(t *testing.T) {
	// Built inline with a malformed volume price rather than editing the
	// captured fixture, which must stay a faithful copy of the live
	// response.
	p := &hetznerPricing{}
	p.Pricing.Currency = "USD"
	p.Pricing.Volume.PricePerGBMonth = hetznerPriceAmount{Gross: "not-a-number"}

	volumes := []hetznerVolume{{Name: "v1", Size: 100}, {Name: "v2", Size: 50}}

	r := hetznerCostReport(nil, volumes, nil, p)

	if r.ByCategory["volumes"] != 0 {
		t.Errorf("ByCategory[volumes] = %v, want 0 (excluded, not silently priced)", r.ByCategory["volumes"])
	}
	if r.TotalMonthly != 0 {
		t.Errorf("TotalMonthly = %v, want 0", r.TotalMonthly)
	}
	if len(r.Unpriced) != 1 || !strings.Contains(r.Unpriced[0], "2 volumes") {
		t.Errorf("Unpriced = %v, want a single entry naming the 2 volumes as a group", r.Unpriced)
	}
}

func TestHetznerCostReport_IPv6PrimaryIPIsFreeNotUnpriced(t *testing.T) {
	p := loadPricingFixture(t)
	ips := []hetznerPrimaryIP{
		{Name: "ip-v6", Type: "ipv6", Datacenter: hetznerDatacenter{Location: hetznerLocation{Name: "fsn1"}}},
	}

	r := hetznerCostReport(nil, nil, ips, p)

	if len(r.Unpriced) != 0 {
		t.Errorf("Unpriced = %v, want empty — IPv6 primary IPs are free by design, not a lookup miss", r.Unpriced)
	}
	if r.ByCategory["primary_ips"] != 0 {
		t.Errorf("ByCategory[primary_ips] = %v, want 0", r.ByCategory["primary_ips"])
	}
	if r.TotalMonthly != 0 {
		t.Errorf("TotalMonthly = %v, want 0", r.TotalMonthly)
	}
}
