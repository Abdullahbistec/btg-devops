package cmd

import (
	"context"
	"fmt"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/containerregistry/armcontainerregistry"
)

// BuildACRUsageTips returns optimization tips and estimated monthly saving for an ACR registry.
// Pure function — no Azure calls. Mirrors the business rules in runACRUsage.
func BuildACRUsageTips(sku string, adminEnabled bool, publicAccess, zoneRedundancy string, replicationCount int, totalCost float64, meters []MeterCost) (tips []string, saving float64) {
	if sku == "Premium" && totalCost < 50 {
		saving += totalCost * 0.45
		tips = append(tips, "Premium SKU at low cost — downgrade to Standard (~45% cheaper) unless geo-replication or private endpoints are required")
	}
	if sku == "Basic" && totalCost > 10 {
		tips = append(tips, "Basic SKU has limited storage (10 GB) and no SLA for geo-redundancy — upgrade to Standard for production use")
	}
	if adminEnabled {
		tips = append(tips, "Admin user is enabled — disable it and use Azure AD service principals or managed identities for authentication")
	}
	if publicAccess == "Enabled" {
		tips = append(tips, "Public network access is open — restrict to specific VNets or use Private Endpoint to limit registry exposure")
	}
	if sku == "Premium" && replicationCount <= 1 {
		saving += totalCost * 0.40
		tips = append(tips, "Premium SKU with no geo-replications — geo-replication is a key Premium feature; downgrade to Standard if not needed")
	}
	if sku == "Premium" && zoneRedundancy == "Disabled" {
		tips = append(tips, "Zone redundancy is disabled on Premium SKU — enable for higher availability at no extra cost if in a supported region")
	}
	for _, m := range meters {
		if m.Name == "Storage" && m.Cost > 20 {
			tips = append(tips, fmt.Sprintf("High storage cost ($%.2f) — enable retention policies to auto-delete old untagged images and reduce storage", m.Cost))
		}
	}
	for _, m := range meters {
		if m.Name == "Build" && m.Cost > 10 {
			tips = append(tips, fmt.Sprintf("ACR Tasks build cost is $%.2f — consider moving image builds to GitHub Actions or Azure DevOps pipelines", m.Cost))
		}
	}
	if totalCost == 0 {
		tips = append(tips, "Zero cost — registry is idle (no pushes or pulls); delete if no longer needed to eliminate base tier cost")
	}
	if sku == "Premium" && totalCost > 0 && totalCost < 5 {
		saving += totalCost * 0.60
		tips = append(tips, "Premium SKU with near-zero activity — strongly consider Basic or Standard tier")
	}
	return
}

func runACRUsage(ctx context.Context, subID string, cred *azidentity.DefaultAzureCredential, resourceID, name, rg string, days int) (*UsageReport, error) {
	acrClient, err := armcontainerregistry.NewRegistriesClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating acr client: %w", err)
	}

	registry, err := acrClient.Get(ctx, rg, name, nil)
	if err != nil {
		return nil, fmt.Errorf("getting acr registry: %w", err)
	}

	meterMap, totalCost, currency, err := queryMeterCosts(ctx, subID, cred, resourceID, days)
	if err != nil {
		return nil, fmt.Errorf("querying meter costs: %w", err)
	}

	var meters []MeterCost
	for meterName, cost := range meterMap {
		meters = append(meters, MeterCost{Name: meterName, Cost: cost, Currency: currency})
	}
	sortMetersByCost(meters)

	// Registry properties
	sku := ""
	if registry.SKU != nil && registry.SKU.Name != nil {
		sku = string(*registry.SKU.Name)
	}
	adminUserEnabled := false
	if registry.Properties != nil && registry.Properties.AdminUserEnabled != nil {
		adminUserEnabled = *registry.Properties.AdminUserEnabled
	}
	publicNetworkAccess := "Enabled"
	if registry.Properties != nil && registry.Properties.PublicNetworkAccess != nil {
		publicNetworkAccess = string(*registry.Properties.PublicNetworkAccess)
	}
	zoneRedundancy := "Disabled"
	if registry.Properties != nil && registry.Properties.ZoneRedundancy != nil {
		zoneRedundancy = string(*registry.Properties.ZoneRedundancy)
	}
	anonymousPull := false
	_ = anonymousPull // AnonymousPullEnabled not available in this SDK version

	// Count replications
	replicationCount := 0
	repoClient, err := armcontainerregistry.NewReplicationsClient(subID, cred, nil)
	if err == nil {
		repoPager := repoClient.NewListPager(rg, name, nil)
		for repoPager.More() {
			page, err := repoPager.NextPage(ctx)
			if err != nil {
				break
			}
			replicationCount += len(page.Value)
		}
	}

	var tips []string
	totalSaving := 0.0

	// Rule 1 — Premium SKU at low usage
	if sku == "Premium" && totalCost < 50 {
		saving := totalCost * 0.45
		totalSaving += saving
		tips = append(tips, "Premium SKU at low cost — downgrade to Standard (~45% cheaper) unless geo-replication or private endpoints are required")
	}

	// Rule 2 — Basic SKU in production with cost
	if sku == "Basic" && totalCost > 10 {
		tips = append(tips, "Basic SKU has limited storage (10 GB) and no SLA for geo-redundancy — upgrade to Standard for production use")
	}

	// Rule 3 — Admin user enabled (security risk)
	if adminUserEnabled {
		tips = append(tips, "Admin user is enabled — disable it and use Azure AD service principals or managed identities for authentication")
	}

	// Rule 4 — Public network access open
	if publicNetworkAccess == "Enabled" {
		tips = append(tips, "Public network access is open — restrict to specific VNets or use Private Endpoint to limit registry exposure")
	}

	// Rule 5 — Anonymous pull enabled
	if anonymousPull {
		tips = append(tips, "Anonymous pull is enabled — anyone can pull images without authentication; disable unless intentional for public images")
	}

	// Rule 6 — Premium without replications (not using premium features)
	if sku == "Premium" && replicationCount <= 1 {
		saving := totalCost * 0.40
		totalSaving += saving
		tips = append(tips, "Premium SKU with no geo-replications — geo-replication is a key Premium feature; downgrade to Standard if not needed")
	}

	// Rule 7 — Zone redundancy disabled on premium
	if sku == "Premium" && zoneRedundancy == "Disabled" {
		tips = append(tips, "Zone redundancy is disabled on Premium SKU — enable for higher availability at no extra cost if in a supported region")
	}

	// Rule 8 — High storage meter cost
	for _, m := range meters {
		if m.Name == "Storage" && m.Cost > 20 {
			tips = append(tips, fmt.Sprintf("High storage cost ($%.2f) — enable retention policies to auto-delete old untagged images and reduce storage", m.Cost))
		}
	}

	// Rule 9 — High build/task cost
	for _, m := range meters {
		if m.Name == "Build" && m.Cost > 10 {
			tips = append(tips, fmt.Sprintf("ACR Tasks build cost is $%.2f — consider moving image builds to GitHub Actions or Azure DevOps pipelines", m.Cost))
		}
	}

	// Rule 10 — Zero cost (idle registry)
	if totalCost == 0 {
		tips = append(tips, "Zero cost — registry is idle (no pushes or pulls); delete if no longer needed to eliminate base tier cost")
	}

	// Rule 11 — Very low cost but premium SKU
	if sku == "Premium" && totalCost > 0 && totalCost < 5 {
		saving := totalCost * 0.60
		totalSaving += saving
		tips = append(tips, "Premium SKU with near-zero activity ($%.2f) — strongly consider Basic or Standard tier")
	}

	tip := ""
	if len(tips) > 0 {
		tip = tips[0]
		if len(tips) > 1 {
			tip += fmt.Sprintf(" (+%d more findings)", len(tips)-1)
		}
	}

	subResources := []UsageSubResource{
		{
			Name:     "Registry: " + name,
			Cost:     totalCost,
			Currency: currency,
			Severity: costSeverity(totalCost),
			Details: map[string]string{
				"SKU":              sku,
				"admin_user":       fmt.Sprintf("%v", adminUserEnabled),
				"public_access":    publicNetworkAccess,
				"anonymous_pull":   fmt.Sprintf("%v", anonymousPull),
				"geo_replications": fmt.Sprintf("%d", replicationCount),
			},
			Tip:           tip,
			MonthlySaving: totalSaving,
		},
	}

	topRec := ""
	if len(tips) > 0 {
		topRec = tips[0]
	}

	gaugeMetrics := queryResourceMetrics(ctx, subID, cred, resourceID, []string{"StorageUsed"}, days, "Average")
	countMetrics := queryResourceMetrics(ctx, subID, cred, resourceID, []string{"SuccessfulPullCount", "SuccessfulPushCount"}, days, "Count")
	storageGB := gaugeMetrics["StorageUsed"] / (1024 * 1024 * 1024)
	pullsPerDay := countMetrics["SuccessfulPullCount"]
	pushesPerDay := countMetrics["SuccessfulPushCount"]
	activityPerDay := pullsPerDay + pushesPerDay
	wasteScore, wasteReason := calcWasteScore(totalCost, -1, activityPerDay)

	return &UsageReport{
		ResourceName:      name,
		ResourceType:      "microsoft.containerregistry/registries",
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
		Utilization:       map[string]float64{"Storage GB": storageGB, "Pulls/day": pullsPerDay, "Pushes/day": pushesPerDay},
		WasteScore:        wasteScore,
		WasteReason:       wasteReason,
	}, nil
}
