package cmd

import (
	"testing"
	"time"
)

func atDate(s string) time.Time {
	t, _ := time.Parse("2006-01-02", s)
	return t
}

func TestHetznerCostReportAsOf_ExcludesResourcesNotYetCreated(t *testing.T) {
	p := loadPricingFixture(t)
	servers := []hetznerServer{
		{Name: "old", ServerType: hetznerServerType{Name: "cpx11"}, Created: "2026-01-01T00:00:00+00:00"},
		{Name: "new", ServerType: hetznerServerType{Name: "cpx11"}, Created: "2026-06-01T00:00:00+00:00"},
	}

	before := hetznerCostReportAsOf(servers, nil, nil, p, atDate("2026-03-01"))
	after := hetznerCostReportAsOf(servers, nil, nil, p, atDate("2026-07-01"))

	if before.ByType["cpx11"].Count != 1 {
		t.Errorf("as of 2026-03-01: count = %d, want 1 (the June server did not exist yet)", before.ByType["cpx11"].Count)
	}
	if after.ByType["cpx11"].Count != 2 {
		t.Errorf("as of 2026-07-01: count = %d, want 2", after.ByType["cpx11"].Count)
	}
	if after.TotalMonthly <= before.TotalMonthly {
		t.Errorf("total did not grow: before=%v after=%v", before.TotalMonthly, after.TotalMonthly)
	}
}

func TestHetznerCostReportAsOf_IncludesResourceCreatedExactlyOnTheDay(t *testing.T) {
	p := loadPricingFixture(t)
	servers := []hetznerServer{
		{Name: "same-day", ServerType: hetznerServerType{Name: "cpx11"}, Created: "2026-06-01T09:30:00+00:00"},
	}

	// Billing starts the day a resource is created, so the day itself counts.
	r := hetznerCostReportAsOf(servers, nil, nil, p, atDate("2026-06-01"))

	if r.ByType["cpx11"].Count != 1 {
		t.Errorf("count = %d, want 1 — a resource created during the day counts for that day", r.ByType["cpx11"].Count)
	}
}

func TestHetznerCostReportAsOf_UnparseableCreatedCountsAsPreexisting(t *testing.T) {
	p := loadPricingFixture(t)
	servers := []hetznerServer{
		{Name: "mystery", ServerType: hetznerServerType{Name: "cpx11"}, Created: ""},
	}

	// A missing timestamp means "we cannot tell when this appeared". Treating
	// it as pre-existing keeps the line flat; the alternative (excluding it)
	// invents a step increase on the day history begins, which would read as
	// growth that never happened.
	r := hetznerCostReportAsOf(servers, nil, nil, p, atDate("2020-01-01"))

	if r.ByType["cpx11"].Count != 1 {
		t.Errorf("count = %d, want 1 — undated resources are treated as pre-existing", r.ByType["cpx11"].Count)
	}
}

func TestHetznerCostHistory_ProducesOnePointPerDayOldestFirst(t *testing.T) {
	p := loadPricingFixture(t)
	servers := []hetznerServer{
		{Name: "a", ServerType: hetznerServerType{Name: "cpx11"}, Created: "2026-01-01T00:00:00+00:00"},
	}

	end := atDate("2026-06-10")
	points := hetznerCostHistory(servers, nil, nil, p, end, 5)

	if len(points) != 5 {
		t.Fatalf("got %d points, want 5", len(points))
	}
	if points[0].Day != "2026-06-06" || points[4].Day != "2026-06-10" {
		t.Errorf("range = %s..%s, want 2026-06-06..2026-06-10", points[0].Day, points[4].Day)
	}
	for _, pt := range points {
		if !pt.Reconstructed {
			t.Errorf("point %s is not marked Reconstructed — a derived figure must never be mistaken for a measurement", pt.Day)
		}
	}
}

func TestHetznerCostHistory_ShowsFleetGrowthAsAStep(t *testing.T) {
	p := loadPricingFixture(t)
	servers := []hetznerServer{
		{Name: "a", ServerType: hetznerServerType{Name: "cpx11"}, Created: "2026-01-01T00:00:00+00:00"},
		{Name: "b", ServerType: hetznerServerType{Name: "cpx11"}, Created: "2026-06-09T00:00:00+00:00"},
	}

	points := hetznerCostHistory(servers, nil, nil, p, atDate("2026-06-10"), 4)

	first, last := points[0].TotalMonthly, points[len(points)-1].TotalMonthly
	if last <= first {
		t.Errorf("expected a step up when the second server appears: first=%v last=%v", first, last)
	}
}
