package cmd

import (
	"context"
	"fmt"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/cognitiveservices/armcognitiveservices"
)

// BuildCogServicesAccountTips returns account-level optimization tips and estimated saving.
// depCount is the number of model deployments (for OpenAI accounts).
func BuildCogServicesAccountTips(kind, sku, publicNetworkAccess string, restrictOutboundNetwork, disableLocalAuth bool, totalCost float64, depCount int) (tips []string, saving float64) {
	if publicNetworkAccess == "Enabled" {
		tips = append(tips, "Public network access is open — restrict to specific VNets or use Private Endpoint to prevent unauthorized API access")
	}
	if !restrictOutboundNetwork {
		tips = append(tips, "Outbound network access is not restricted — enable outbound network restrictions to prevent data exfiltration")
	}
	if !disableLocalAuth {
		tips = append(tips, "Local API key authentication is enabled — disable local auth and use Azure AD / managed identity for all access")
	}
	if sku == "S0" && totalCost > 100 && kind == "OpenAI" {
		saving += totalCost * 0.20
		tips = append(tips, fmt.Sprintf("High PAYG spend ($%.2f) — evaluate Provisioned Throughput Units (PTU) for predictable workloads; can reduce cost by ~20%%", totalCost))
	}
	if totalCost == 0 {
		tips = append(tips, "Zero cost — account is completely idle; delete if no longer needed (PTU reservations still cost money even if unused)")
	}
	if kind == "OpenAI" && depCount == 0 {
		tips = append(tips, "No model deployments found on this OpenAI account — account may be idle; delete to eliminate any base costs")
	}
	if kind != "OpenAI" && totalCost > 50 {
		tips = append(tips, fmt.Sprintf("High spend ($%.2f) on %s service — review API call volume and consider caching responses to reduce per-call billing", totalCost, kind))
	}
	return
}

func runCognitiveServicesUsage(ctx context.Context, subID string, cred *azidentity.DefaultAzureCredential, resourceID, name, rg string, days int) (*UsageReport, error) {
	csClient, err := armcognitiveservices.NewAccountsClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating cognitive services client: %w", err)
	}

	account, err := csClient.Get(ctx, rg, name, nil)
	if err != nil {
		return nil, fmt.Errorf("getting cognitive services account: %w", err)
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

	// Account properties
	kind := ""
	if account.Kind != nil {
		kind = *account.Kind
	}
	sku := ""
	if account.SKU != nil && account.SKU.Name != nil {
		sku = *account.SKU.Name
	}
	publicNetworkAccess := "Enabled"
	if account.Properties != nil && account.Properties.PublicNetworkAccess != nil {
		publicNetworkAccess = string(*account.Properties.PublicNetworkAccess)
	}
	restrictOutboundNetwork := false
	if account.Properties != nil && account.Properties.RestrictOutboundNetworkAccess != nil {
		restrictOutboundNetwork = *account.Properties.RestrictOutboundNetworkAccess
	}
	disableLocalAuth := false
	if account.Properties != nil && account.Properties.DisableLocalAuth != nil {
		disableLocalAuth = *account.Properties.DisableLocalAuth
	}

	var subResources []UsageSubResource
	var accountTips []string
	totalSaving := 0.0

	// Get deployments for OpenAI accounts
	if kind == "OpenAI" {
		depClient, err := armcognitiveservices.NewDeploymentsClient(subID, cred, nil)
		if err == nil {
			depPager := depClient.NewListPager(rg, name, nil)
			for depPager.More() {
				page, err := depPager.NextPage(ctx)
				if err != nil {
					break
				}
				for _, dep := range page.Value {
					depName := deref(dep.Name)
					modelName := ""
					modelVersion := ""
					depSKU := ""
					ptuCapacity := int32(0)

					if dep.Properties != nil && dep.Properties.Model != nil {
						if dep.Properties.Model.Name != nil {
							modelName = *dep.Properties.Model.Name
						}
						if dep.Properties.Model.Version != nil {
							modelVersion = *dep.Properties.Model.Version
						}
					}
					if dep.SKU != nil {
						if dep.SKU.Name != nil {
							depSKU = *dep.SKU.Name
						}
						if dep.SKU.Capacity != nil {
							ptuCapacity = *dep.SKU.Capacity
						}
					}

					var depTips []string
					saving := 0.0

					// Rule 1 — PTU deployment (fixed cost, needs utilization check)
					if depSKU == "ProvisionedManaged" && ptuCapacity > 0 {
						saving = totalCost * 0.30
						totalSaving += saving
						depTips = append(depTips, fmt.Sprintf("PTU deployment with %d PTUs — monitor utilization; underused PTUs waste reserved capacity cost", ptuCapacity))
					}

					// Rule 2 — Large PTU capacity
					if ptuCapacity > 100 {
						depTips = append(depTips, fmt.Sprintf("High PTU capacity (%d) — verify peak utilization justifies this reservation; reduce if average utilization < 60%%", ptuCapacity))
						saving += totalCost * 0.20
						totalSaving += totalCost * 0.20
					}

					// Rule 3 — Old model version
					if modelVersion != "" && modelVersion < "0106" {
						depTips = append(depTips, fmt.Sprintf("Model %s version %s may be outdated — newer versions often have lower per-token cost and better performance", modelName, modelVersion))
					}

					// Rule 4 — PAYG with high cost
					if depSKU == "Standard" && totalCost > 100 {
						depTips = append(depTips, fmt.Sprintf("High PAYG cost ($%.2f) on model %s — evaluate PTU (provisioned throughput) for predictable workloads to reduce per-token cost", totalCost, modelName))
					}

					depTip := ""
					if len(depTips) > 0 {
						depTip = depTips[0]
						if len(depTips) > 1 {
							depTip += fmt.Sprintf(" (+%d more)", len(depTips)-1)
						}
					}

					subResources = append(subResources, UsageSubResource{
						Name:     depName,
						Cost:     0,
						Currency: currency,
						Severity: Info,
						Details: map[string]string{
							"model":   modelName,
							"version": modelVersion,
							"sku":     depSKU,
							"PTUs":    fmt.Sprintf("%d", ptuCapacity),
						},
						Tip:           depTip,
						MonthlySaving: saving,
					})
				}
			}
		}
	}

	// Account-level rules

	// Rule 5 — Public network access open
	if publicNetworkAccess == "Enabled" {
		accountTips = append(accountTips, "Public network access is open — restrict to specific VNets or use Private Endpoint to prevent unauthorized API access")
	}

	// Rule 6 — Outbound network not restricted
	if !restrictOutboundNetwork {
		accountTips = append(accountTips, "Outbound network access is not restricted — enable outbound network restrictions to prevent data exfiltration")
	}

	// Rule 7 — Local auth (API key) not disabled
	if !disableLocalAuth {
		accountTips = append(accountTips, "Local API key authentication is enabled — disable local auth and use Azure AD / managed identity for all access")
	}

	// Rule 8 — High PAYG cost, should consider PTU
	if sku == "S0" && totalCost > 100 && kind == "OpenAI" {
		saving := totalCost * 0.20
		totalSaving += saving
		accountTips = append(accountTips, fmt.Sprintf("High PAYG spend ($%.2f) — evaluate Provisioned Throughput Units (PTU) for predictable workloads; can reduce cost by ~20%%", totalCost))
	}

	// Rule 9 — Zero cost (idle account)
	if totalCost == 0 {
		accountTips = append(accountTips, "Zero cost — account is completely idle; delete if no longer needed (PTU reservations still cost money even if unused)")
	}

	// Rule 10 — No deployments found on OpenAI
	if kind == "OpenAI" && len(subResources) == 0 {
		accountTips = append(accountTips, "No model deployments found on this OpenAI account — account may be idle; delete to eliminate any base costs")
	}

	// Rule 11 — Non-OpenAI with high cost
	if kind != "OpenAI" && totalCost > 50 {
		accountTips = append(accountTips, fmt.Sprintf("High spend ($%.2f) on %s service — review API call volume and consider caching responses to reduce per-call billing", totalCost, kind))
	}

	topRec := ""
	if len(accountTips) > 0 {
		topRec = accountTips[0]
	} else if totalSaving > 0 {
		topRec = fmt.Sprintf("Right-size PTU deployments in %s to reduce reserved throughput cost by ~30%%", name)
	}

	utilMetrics := queryResourceMetrics(ctx, subID, cred, resourceID, []string{"TotalCalls", "TotalErrors"}, days, "Count")
	callsPerDay := utilMetrics["TotalCalls"]
	errorsPerDay := utilMetrics["TotalErrors"]
	wasteScore, wasteReason := calcWasteScore(totalCost, -1, callsPerDay)

	return &UsageReport{
		ResourceName:      name,
		ResourceType:      "microsoft.cognitiveservices/accounts",
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
		Utilization:       map[string]float64{"API Calls/day": callsPerDay, "Errors/day": errorsPerDay},
		WasteScore:        wasteScore,
		WasteReason:       wasteReason,
	}, nil
}
