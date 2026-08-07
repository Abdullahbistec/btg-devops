package cmd

import (
	"context"
	"fmt"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/keyvault/armkeyvault"
)

// BuildKeyVaultUsageTips returns optimization tips and estimated saving for a Key Vault.
func BuildKeyVaultUsageTips(sku string, softDeleteEnabled, purgeProtection, rbacEnabled bool, softDeleteRetentionDays int32, networkDefaultAction, publicNetworkAccess string, totalCost float64, meters []MeterCost) (tips []string, saving float64) {
	if sku == "premium" {
		saving += totalCost * 0.50
		tips = append(tips, "Premium (HSM) SKU costs ~2x Standard — verify HSM-backed keys are required for compliance")
	}
	if !softDeleteEnabled {
		tips = append(tips, "Soft delete is disabled — enable it to protect against accidental or malicious key/secret deletion (no cost impact)")
	}
	if softDeleteRetentionDays > 30 {
		tips = append(tips, fmt.Sprintf("Soft-delete retention is %d days — 7-30 days is typically sufficient; reducing simplifies compliance", softDeleteRetentionDays))
	}
	if !purgeProtection {
		tips = append(tips, "Purge protection is disabled — enable to comply with FIPS 140-2 requirements and prevent permanent deletion during retention period")
	}
	if !rbacEnabled {
		tips = append(tips, "Using legacy Vault Access Policies instead of Azure RBAC — migrate to RBAC for fine-grained, auditable permissions")
	}
	if networkDefaultAction == "Allow" {
		tips = append(tips, "Network ACL default action is Allow (public access) — restrict to specific VNets or IPs to reduce attack surface")
	}
	if publicNetworkAccess == "Enabled" && networkDefaultAction == "Allow" {
		tips = append(tips, "Public network access is fully open — consider Private Endpoint for vault access from Azure resources")
	}
	for _, m := range meters {
		if m.Name == "Operations" && m.Cost > 5 {
			tips = append(tips, fmt.Sprintf("High operation cost ($%.2f) — cache secrets in application memory to reduce Key Vault API call frequency", m.Cost))
		}
	}
	if totalCost < 1 && totalCost > 0 {
		tips = append(tips, "Very low cost — vault may be idle; verify it is still actively used or delete to eliminate base charges")
	}
	if totalCost == 0 {
		tips = append(tips, "Zero cost in the period — vault is completely idle; delete if no longer needed")
	}
	if sku == "standard" && totalCost > 50 {
		tips = append(tips, fmt.Sprintf("High operation volume ($%.2f/mo) — review which applications are calling Key Vault and implement caching", totalCost))
	}
	return
}

func runKeyVaultUsage(ctx context.Context, subID string, cred *azidentity.DefaultAzureCredential, resourceID, name, rg string, days int) (*UsageReport, error) {
	kvClient, err := armkeyvault.NewVaultsClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating keyvault client: %w", err)
	}

	vault, err := kvClient.Get(ctx, rg, name, nil)
	if err != nil {
		return nil, fmt.Errorf("getting key vault: %w", err)
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

	// Vault properties
	sku := ""
	if vault.Properties != nil && vault.Properties.SKU != nil && vault.Properties.SKU.Name != nil {
		sku = string(*vault.Properties.SKU.Name)
	}
	softDeleteEnabled := true
	softDeleteRetention := int32(90)
	if vault.Properties != nil {
		if vault.Properties.EnableSoftDelete != nil {
			softDeleteEnabled = *vault.Properties.EnableSoftDelete
		}
		if vault.Properties.SoftDeleteRetentionInDays != nil {
			softDeleteRetention = *vault.Properties.SoftDeleteRetentionInDays
		}
	}
	purgeProtection := false
	if vault.Properties != nil && vault.Properties.EnablePurgeProtection != nil {
		purgeProtection = *vault.Properties.EnablePurgeProtection
	}
	rbacEnabled := false
	if vault.Properties != nil && vault.Properties.EnableRbacAuthorization != nil {
		rbacEnabled = *vault.Properties.EnableRbacAuthorization
	}
	networkDefaultAction := "Allow"
	if vault.Properties != nil && vault.Properties.NetworkACLs != nil && vault.Properties.NetworkACLs.DefaultAction != nil {
		networkDefaultAction = string(*vault.Properties.NetworkACLs.DefaultAction)
	}
	publicNetworkAccess := "Enabled"
	if vault.Properties != nil && vault.Properties.PublicNetworkAccess != nil {
		publicNetworkAccess = *vault.Properties.PublicNetworkAccess
	}

	var tips []string
	totalSaving := 0.0

	// Rule 1 — Premium (HSM) SKU verification
	if sku == "premium" {
		saving := totalCost * 0.50
		totalSaving += saving
		tips = append(tips, "Premium (HSM) SKU costs ~2x Standard — verify HSM-backed keys are required for compliance")
	}

	// Rule 2 — Soft delete disabled (security risk)
	if !softDeleteEnabled {
		tips = append(tips, "Soft delete is disabled — enable it to protect against accidental or malicious key/secret deletion (no cost impact)")
	}

	// Rule 3 — Retention too long
	if softDeleteRetention > 30 {
		tips = append(tips, fmt.Sprintf("Soft-delete retention is %d days — 7-30 days is typically sufficient; reducing simplifies compliance", softDeleteRetention))
	}

	// Rule 4 — No purge protection
	if !purgeProtection {
		tips = append(tips, "Purge protection is disabled — enable to comply with FIPS 140-2 requirements and prevent permanent deletion during retention period")
	}

	// Rule 5 — Using legacy access policies instead of RBAC
	if !rbacEnabled {
		tips = append(tips, "Using legacy Vault Access Policies instead of Azure RBAC — migrate to RBAC for fine-grained, auditable permissions")
	}

	// Rule 6 — Network firewall open to all
	if networkDefaultAction == "Allow" {
		tips = append(tips, "Network ACL default action is Allow (public access) — restrict to specific VNets or IPs to reduce attack surface")
	}

	// Rule 7 — Public network access enabled
	if publicNetworkAccess == "Enabled" && networkDefaultAction == "Allow" {
		tips = append(tips, "Public network access is fully open — consider Private Endpoint for vault access from Azure resources")
	}

	// Rule 8 — High operation cost (many API calls)
	for _, m := range meters {
		if m.Name == "Operations" && m.Cost > 5 {
			tips = append(tips, fmt.Sprintf("High operation cost ($%.2f) — cache secrets in application memory to reduce Key Vault API call frequency", m.Cost))
		}
	}

	// Rule 9 — Very low cost (possibly idle)
	if totalCost < 1 && totalCost > 0 {
		tips = append(tips, "Very low cost — vault may be idle; verify it is still actively used or delete to eliminate base charges")
	}

	// Rule 10 — Zero cost (definitely idle)
	if totalCost == 0 {
		tips = append(tips, "Zero cost in the period — vault is completely idle; delete if no longer needed")
	}

	// Rule 11 — SKU standard with high cost
	if sku == "standard" && totalCost > 50 {
		tips = append(tips, fmt.Sprintf("High operation volume ($%.2f/mo) — review which applications are calling Key Vault and implement caching", totalCost))
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
			Name:     "Vault: " + name,
			Cost:     totalCost,
			Currency: currency,
			Severity: costSeverity(totalCost),
			Details: map[string]string{
				"SKU":              sku,
				"soft_delete":      fmt.Sprintf("%v (%d days)", softDeleteEnabled, softDeleteRetention),
				"purge_protection": fmt.Sprintf("%v", purgeProtection),
				"rbac":             fmt.Sprintf("%v", rbacEnabled),
				"network":          networkDefaultAction,
			},
			Tip:           tip,
			MonthlySaving: totalSaving,
		},
	}

	topRec := ""
	if len(tips) > 0 {
		topRec = tips[0]
	}

	utilMetrics := queryResourceMetrics(ctx, subID, cred, resourceID, []string{"ServiceApiHit"}, days, "Count")
	apiHitsPerDay := utilMetrics["ServiceApiHit"]
	wasteScore, wasteReason := calcWasteScore(totalCost, -1, apiHitsPerDay)

	return &UsageReport{
		ResourceName:      name,
		ResourceType:      "microsoft.keyvault/vaults",
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
		Utilization:       map[string]float64{"API Hits/day": apiHitsPerDay},
		WasteScore:        wasteScore,
		WasteReason:       wasteReason,
	}, nil
}
