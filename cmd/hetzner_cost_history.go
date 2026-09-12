package cmd

import "time"

// HetznerCostHistoryPoint is one reconstructed day of run rate.
//
// Reconstructed is always true for points this file produces, and the field
// exists so a consumer can never mistake a derived figure for a measured one.
type HetznerCostHistoryPoint struct {
	Day           string  `json:"day"`
	TotalMonthly  float64 `json:"total_monthly"`
	Currency      string  `json:"currency"`
	Reconstructed bool    `json:"reconstructed"`
}

// existedOn reports whether a resource with this `created` timestamp existed
// on the given day. Billing starts the day a resource is created, so the
// creation day itself counts.
//
// An unparseable or empty timestamp counts as pre-existing. That choice is
// deliberate: "we cannot tell when this appeared" is not the same as "it did
// not exist", and excluding it would invent a step increase on the first day
// of the window — growth that never happened. Treating it as always-present
// keeps the line flat instead.
func existedOn(created string, day time.Time) bool {
	t, err := time.Parse(time.RFC3339, created)
	if err != nil {
		return true
	}
	// Compare by calendar day in UTC, not by instant, so a resource created
	// at 21:00 counts for that whole day rather than only the last 3 hours.
	c := t.UTC().Truncate(24 * time.Hour)
	return !c.After(day.UTC().Truncate(24 * time.Hour))
}

// hetznerCostReportAsOf prices the fleet as it stood on a given day, using
// TODAY's list prices. See hetznerCostHistory for what that costs in accuracy.
func hetznerCostReportAsOf(servers []hetznerServer, volumes []hetznerVolume, ips []hetznerPrimaryIP, p *hetznerPricing, asOf time.Time) HetznerCostReport {
	var s []hetznerServer
	for _, x := range servers {
		if existedOn(x.Created, asOf) {
			s = append(s, x)
		}
	}
	var v []hetznerVolume
	for _, x := range volumes {
		if existedOn(x.Created, asOf) {
			v = append(v, x)
		}
	}
	var i []hetznerPrimaryIP
	for _, x := range ips {
		if existedOn(x.Created, asOf) {
			i = append(i, x)
		}
	}
	return hetznerCostReport(s, v, i, p)
}

// hetznerCostHistory reconstructs `days` days of run rate ending at `end`,
// oldest first.
//
// This is a RECONSTRUCTION, not a record, and it is wrong in two knowable
// ways that any consumer must surface:
//
//  1. Deleted resources are invisible. A server that ran in April and was
//     destroyed in June does not appear in today's inventory, so past days
//     are understated — the more churn, the bigger the gap.
//  2. Today's prices are applied to past days. If Hetzner repriced anything,
//     earlier points are wrong by that difference.
//
// It is still worth having: Hetzner exposes no spend history at all, so the
// alternative is an empty chart until enough days accumulate. Every point is
// flagged Reconstructed so the UI can draw it distinctly from measured days.
func hetznerCostHistory(servers []hetznerServer, volumes []hetznerVolume, ips []hetznerPrimaryIP, p *hetznerPricing, end time.Time, days int) []HetznerCostHistoryPoint {
	if days < 1 {
		return nil
	}
	points := make([]HetznerCostHistoryPoint, 0, days)
	for offset := days - 1; offset >= 0; offset-- {
		day := end.AddDate(0, 0, -offset)
		r := hetznerCostReportAsOf(servers, volumes, ips, p, day)
		points = append(points, HetznerCostHistoryPoint{
			Day:           day.UTC().Format("2006-01-02"),
			TotalMonthly:  r.TotalMonthly,
			Currency:      r.Currency,
			Reconstructed: true,
		})
	}
	return points
}
