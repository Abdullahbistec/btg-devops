package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
)

// Hetzner pricing client.
//
// Wraps the Hetzner Cloud /v1/pricing endpoint so server, volume, and
// primary-IP costs can be looked up from live data instead of a hardcoded
// constant that drifts from reality over time.
//
// All amounts use "gross" (VAT-inclusive) prices, never "net" — see the
// package-level pricing convention. They are numerically equal while
// vat_rate is 0, but gross stays correct if that changes.

type hetznerPriceAmount struct {
	Net   string `json:"net"`
	Gross string `json:"gross"`
}

type hetznerLocationPrice struct {
	Location     string             `json:"location"`
	PriceMonthly hetznerPriceAmount `json:"price_monthly"`
}

type hetznerServerTypePrice struct {
	Name   string                 `json:"name"`
	Prices []hetznerLocationPrice `json:"prices"`
}

type hetznerPrimaryIPPrice struct {
	Type   string                 `json:"type"`
	Prices []hetznerLocationPrice `json:"prices"`
}

type hetznerPricing struct {
	Pricing struct {
		Currency string `json:"currency"`
		VATRate  string `json:"vat_rate"`
		Volume   struct {
			PricePerGBMonth hetznerPriceAmount `json:"price_per_gb_month"`
		} `json:"volume"`
		ServerTypes []hetznerServerTypePrice `json:"server_types"`
		PrimaryIPs  []hetznerPrimaryIPPrice  `json:"primary_ips"`
	} `json:"pricing"`
}

func parseHetznerPricing(raw []byte) (*hetznerPricing, error) {
	var p hetznerPricing
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("parsing hetzner pricing: %w", err)
	}
	if p.Pricing.Currency == "" {
		return nil, fmt.Errorf("hetzner pricing payload has no currency")
	}
	return &p, nil
}

func fetchHetznerPricing(ctx context.Context, token string) (*hetznerPricing, error) {
	var p hetznerPricing
	if err := hetznerFetch(ctx, token, hetznerAPIBase+"/pricing", &p); err != nil {
		return nil, err
	}
	if p.Pricing.Currency == "" {
		return nil, fmt.Errorf("hetzner pricing payload has no currency")
	}
	return &p, nil
}

func (p *hetznerPricing) Currency() string { return p.Pricing.Currency }

func parseAmount(a hetznerPriceAmount) float64 {
	v, err := strconv.ParseFloat(a.Gross, 64)
	if err != nil {
		return 0
	}
	return v
}

// pickLocation returns the price for loc, falling back to the first entry
// when the location is absent. Locations price near-identically, so the
// fallback is sound — returning 0 would not be.
func pickLocation(prices []hetznerLocationPrice, loc string) (float64, bool) {
	if len(prices) == 0 {
		return 0, false
	}
	for _, pr := range prices {
		if pr.Location == loc {
			return parseAmount(pr.PriceMonthly), true
		}
	}
	return parseAmount(prices[0].PriceMonthly), true
}

func (p *hetznerPricing) ServerMonthly(typeName, location string) (float64, bool) {
	for _, st := range p.Pricing.ServerTypes {
		if st.Name == typeName {
			return pickLocation(st.Prices, location)
		}
	}
	return 0, false
}

func (p *hetznerPricing) VolumeMonthlyPerGB() float64 {
	return parseAmount(p.Pricing.Volume.PricePerGBMonth)
}

func (p *hetznerPricing) PrimaryIPMonthly(ipType, location string) (float64, bool) {
	for _, ip := range p.Pricing.PrimaryIPs {
		if ip.Type == ipType {
			return pickLocation(ip.Prices, location)
		}
	}
	return 0, false
}
