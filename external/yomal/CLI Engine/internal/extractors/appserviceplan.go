package extractors

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/appservice/armappservice/v2"
)

// AppServicePlanData holds the clean extracted data for all app service plans.
type AppServicePlanData struct {
	TotalPlans int               `json:"total_plans"`
	Plans      []json.RawMessage `json:"plans"`
}

// maxHostedSiteNames caps how many hosted site names are stored per plan —
// the count is always exact, the name list is illustrative.
const maxHostedSiteNames = 20

// ExtractAppServicePlan fetches all app service plans and returns clean JSON.
// ARM's plan list returns numberOfSites=0 unreliably (observed 0 for all 22
// plans that each host real apps — spec 11 §4), so the real count is derived
// here by listing sites once and grouping by serverFarmId. The raw
// numberOfSites field is kept as-is for comparison.
func ExtractAppServicePlan(ctx context.Context, subID string, cred azcore.TokenCredential) (*AppServicePlanData, error) {
	client, err := armappservice.NewPlansClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating app service plan client: %w", err)
	}

	var plans []*armappservice.Plan
	pager := client.NewListPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("listing app service plans: %w", err)
		}
		plans = append(plans, page.Value...)
	}

	// One sites pass (web + function apps) to derive real per-plan counts.
	// Best-effort: if it fails, plans still ship, with sites_lookup_error set.
	sitesByPlan, sitesErr := sitesByServerFarm(ctx, subID, cred)

	cleanPlans := make([]json.RawMessage, 0, len(plans))
	for _, plan := range plans {
		clean, err := CleanResource(plan)
		if err != nil {
			return nil, fmt.Errorf("cleaning app service plan %s: %w", derefStr(plan.Name), err)
		}
		extra := map[string]any{}
		if sitesErr != nil {
			extra["sites_lookup_error"] = sitesErr.Error()
		} else {
			hosted := []string{}
			if plan.ID != nil {
				hosted = sitesByPlan[strings.ToLower(*plan.ID)]
			}
			extra["sites_hosted"] = len(hosted)
			if len(hosted) > maxHostedSiteNames {
				hosted = hosted[:maxHostedSiteNames]
			}
			extra["hosted_site_names"] = hosted
		}
		enriched, err := mergeIntoJSON(clean, extra)
		if err != nil {
			return nil, fmt.Errorf("enriching app service plan %s: %w", derefStr(plan.Name), err)
		}
		cleanPlans = append(cleanPlans, enriched)
	}

	return &AppServicePlanData{
		TotalPlans: len(plans),
		Plans:      cleanPlans,
	}, nil
}

// sitesByServerFarm lists every site in the subscription and groups site
// names by lowercased serverFarmId (ARM resource IDs vary in casing between
// APIs, so exact matching would silently miss).
func sitesByServerFarm(ctx context.Context, subID string, cred azcore.TokenCredential) (map[string][]string, error) {
	webClient, err := armappservice.NewWebAppsClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating web apps client: %w", err)
	}

	byPlan := map[string][]string{}
	pager := webClient.NewListPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("listing sites: %w", err)
		}
		for _, site := range page.Value {
			if site == nil || site.Properties == nil || site.Properties.ServerFarmID == nil || site.Name == nil {
				continue
			}
			key := strings.ToLower(*site.Properties.ServerFarmID)
			byPlan[key] = append(byPlan[key], *site.Name)
		}
	}
	for _, names := range byPlan {
		sort.Strings(names)
	}
	return byPlan, nil
}
