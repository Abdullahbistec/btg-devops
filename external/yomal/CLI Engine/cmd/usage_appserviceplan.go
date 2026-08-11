package cmd

import (
	"context"
	"fmt"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/appservice/armappservice/v2"
)

// BuildASPUsageTips returns plan-level optimization tips and estimated monthly saving.
func BuildASPUsageTips(sku, skuTier string, workers, maxWorkers int32, appCount, stoppedCount, _ int, totalCost float64) (tips []string, saving float64) {
	if sku == "P1v2" || sku == "P2v2" || sku == "P3v2" {
		s := totalCost * 0.40
		saving += s
		tips = append(tips, fmt.Sprintf("SKU %s is an older generation — migrate to %sv3 for ~40%% better price-performance", sku, sku[:2]))
	}
	if stoppedCount > 0 {
		tips = append(tips, fmt.Sprintf("%d stopped app(s) on this plan — remove them to free up capacity or downscale the plan", stoppedCount))
	}
	if workers > 3 && appCount <= 2 {
		s := totalCost * 0.40
		saving += s
		tips = append(tips, fmt.Sprintf("Plan has %d worker instances but only %d apps — reduce worker count to save cost", workers, appCount))
	}
	if appCount == 0 {
		saving += totalCost
		tips = append(tips, "No apps found on this plan — plan is completely idle; delete it to eliminate charges")
	}
	if appCount == 1 && (skuTier == "PremiumV2" || skuTier == "PremiumV3") && totalCost > 100 {
		s := totalCost * 0.50
		saving += s
		tips = append(tips, fmt.Sprintf("Only 1 app on %s tier plan — consider Basic or Standard tier for single low-traffic apps", skuTier))
	}
	if maxWorkers > 10 && workers < 3 {
		tips = append(tips, fmt.Sprintf("Autoscale max set to %d but current instances is %d — review max scale-out limit to control runaway cost", maxWorkers, workers))
	}
	if sku == "F1" || sku == "D1" {
		tips = append(tips, fmt.Sprintf("Plan is on %s (Free/Shared) tier — no SLA, CPU quota limits; upgrade to Basic or higher for production workloads", sku))
	}
	if skuTier == "Basic" && appCount > 2 {
		tips = append(tips, "Basic tier does not support autoscale — upgrade to Standard or Premium if traffic varies throughout the day")
	}
	return
}

func runASPUsage(ctx context.Context, subID string, cred *azidentity.DefaultAzureCredential, resourceID, name, rg string, days int) (*UsageReport, error) {
	aspClient, err := armappservice.NewPlansClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating asp client: %w", err)
	}

	plan, err := aspClient.Get(ctx, rg, name, nil)
	if err != nil {
		return nil, fmt.Errorf("getting app service plan: %w", err)
	}

	meterMap, totalCost, currency, err := queryMeterCosts(ctx, subID, cred, resourceID, days)
	if err != nil {
		return nil, fmt.Errorf("querying meter costs: %w", err)
	}

	type appInfo struct {
		name    string
		state   string
		kind    string
		enabled bool
	}
	var apps []appInfo

	appsPager := aspClient.NewListWebAppsPager(rg, name, nil)
	for appsPager.More() {
		page, err := appsPager.NextPage(ctx)
		if err != nil {
			break
		}
		for _, app := range page.Value {
			n := deref(app.Name)
			s := ""
			k := deref(app.Kind)
			enabled := true
			if app.Properties != nil {
				if app.Properties.State != nil {
					s = *app.Properties.State
				}
				if app.Properties.Enabled != nil {
					enabled = *app.Properties.Enabled
				}
			}
			apps = append(apps, appInfo{name: n, state: s, kind: k, enabled: enabled})
		}
	}

	// Plan properties
	sku := ""
	skuTier := ""
	workers := int32(1)
	maxWorkers := int32(1)
	if plan.SKU != nil {
		if plan.SKU.Name != nil {
			sku = string(*plan.SKU.Name)
		}
		if plan.SKU.Tier != nil {
			skuTier = string(*plan.SKU.Tier)
		}
		if plan.SKU.Capacity != nil {
			workers = *plan.SKU.Capacity
		}
	}
	if plan.Properties != nil && plan.Properties.MaximumNumberOfWorkers != nil {
		maxWorkers = *plan.Properties.MaximumNumberOfWorkers
	}
	isLinux := false
	if plan.Kind != nil {
		isLinux = deref(plan.Kind) == "linux"
	}
	_ = isLinux

	// Build meter list
	var meters []MeterCost
	for meterName, cost := range meterMap {
		meters = append(meters, MeterCost{Name: meterName, Cost: cost, Currency: currency})
	}
	sortMetersByCost(meters)

	var subResources []UsageSubResource
	var totalSaving float64
	stoppedCount := 0
	disabledCount := 0

	if len(apps) > 0 {
		perAppCost := totalCost / float64(len(apps))
		for _, app := range apps {
			sev := Info
			var tips []string
			saving := 0.0
			details := map[string]string{
				"state": app.state,
				"kind":  app.kind,
			}

			// Rule 1 — Stopped app
			if app.state == "Stopped" {
				sev = Warning
				tips = append(tips, "App is stopped but still consuming plan capacity — remove if no longer needed")
				saving = perAppCost
				stoppedCount++
			}

			// Rule 2 — Disabled app
			if !app.enabled {
				sev = Warning
				tips = append(tips, "App is disabled — verify it should remain on this plan or remove to free up capacity")
				saving = perAppCost * 0.5
				disabledCount++
			}

			tip := ""
			if len(tips) > 0 {
				tip = tips[0]
			}
			totalSaving += saving

			subResources = append(subResources, UsageSubResource{
				Name:          app.name,
				Cost:          perAppCost,
				Currency:      currency,
				Severity:      sev,
				Details:       details,
				Tip:           tip,
				MonthlySaving: saving,
			})
		}
	}

	// Plan-level rules
	var planTips []string

	// Rule 3 — Old Pv2 SKU
	if sku == "P1v2" || sku == "P2v2" || sku == "P3v2" {
		saving := totalCost * 0.40
		totalSaving += saving
		planTips = append(planTips, fmt.Sprintf("SKU %s is an older generation — migrate to %sv3 for ~40%% better price-performance", sku, sku[:2]))
	}

	// Rule 4 — Stopped apps wasting plan capacity
	if stoppedCount > 0 {
		planTips = append(planTips, fmt.Sprintf("%d stopped app(s) on this plan — remove them to free up capacity or downscale the plan", stoppedCount))
	}

	// Rule 5 — Over-scaled workers
	if workers > 3 && len(apps) <= 2 {
		saving := totalCost * 0.40
		totalSaving += saving
		planTips = append(planTips, fmt.Sprintf("Plan has %d worker instances but only %d apps — reduce worker count to save cost", workers, len(apps)))
	}

	// Rule 6 — No apps on plan (completely idle)
	if len(apps) == 0 {
		totalSaving += totalCost
		planTips = append(planTips, "No apps found on this plan — plan is completely idle; delete it to eliminate charges")
	}

	// Rule 7 — Single app on high-tier plan
	if len(apps) == 1 && (skuTier == "PremiumV2" || skuTier == "PremiumV3") && totalCost > 100 {
		saving := totalCost * 0.50
		totalSaving += saving
		planTips = append(planTips, fmt.Sprintf("Only 1 app on %s tier plan — consider Basic or Standard tier for single low-traffic apps", skuTier))
	}

	// Rule 8 — Max workers too high (autoscale ceiling)
	if maxWorkers > 10 && workers < 3 {
		planTips = append(planTips, fmt.Sprintf("Autoscale max set to %d but current instances is %d — review max scale-out limit to control runaway cost", maxWorkers, workers))
	}

	// Rule 9 — Free or Shared tier in production
	if sku == "F1" || sku == "D1" {
		planTips = append(planTips, fmt.Sprintf("Plan is on %s (Free/Shared) tier — no SLA, CPU quota limits; upgrade to Basic or higher for production workloads", sku))
	}

	// Rule 10 — Basic tier with multiple apps (no autoscale)
	if skuTier == "Basic" && len(apps) > 2 {
		planTips = append(planTips, "Basic tier does not support autoscale — upgrade to Standard or Premium if traffic varies throughout the day")
	}

	topRec := ""
	if len(planTips) > 0 {
		topRec = planTips[0]
	}

	utilMetrics := queryResourceMetrics(ctx, subID, cred, resourceID, []string{"CpuPercentage", "MemoryPercentage"}, days, "Average")
	cpuPct := utilMetrics["CpuPercentage"]
	memPct := utilMetrics["MemoryPercentage"]
	wasteScore, wasteReason := calcWasteScore(totalCost, cpuPct, -1)

	return &UsageReport{
		ResourceName:      name,
		ResourceType:      "microsoft.web/serverfarms",
		ResourceGroup:     rg,
		Period:            periodString(days),
		Days:              days,
		TotalCost:         totalCost,
		Currency:          currency,
		Severity:          costSeverity(totalCost),
		Meters:            meters,
		SubResources:      subResources,
		TotalSaving:       totalSaving,
		TopRecommendation: topRec,
		Utilization:       map[string]float64{"CPU %": cpuPct, "Memory %": memPct},
		WasteScore:        wasteScore,
		WasteReason:       wasteReason,
	}, nil
}
