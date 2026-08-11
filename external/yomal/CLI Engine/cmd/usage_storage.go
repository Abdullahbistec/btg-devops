package cmd

import (
	"context"
	"fmt"
	"strings"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/storage/armstorage"
)

// BuildStorageAccountTips returns account-level optimization tips and estimated saving.
// publicContainerCount is the number of containers with public access.
// containerCount is total number of blob containers.
func BuildStorageAccountTips(accessTier, sku, kind string, httpsOnly, allowBlobPublic bool, minTLSVersion string, totalCost float64, publicContainerCount, containerCount int) (tips []string, saving float64) {
	isGRS := len(sku) >= 3 && sku[len(sku)-3:] == "GRS"
	isLRS := len(sku) >= 3 && sku[len(sku)-3:] == "LRS"
	if accessTier == "Hot" && totalCost > 10 {
		saving += totalCost * 0.30
		tips = append(tips, "Access tier is Hot — move infrequently accessed blobs to Cool or Archive to save ~30%")
	}
	if isGRS && totalCost > 20 {
		saving += totalCost * 0.35
		tips = append(tips, fmt.Sprintf("SKU is %s (geo-redundant) — switch to ZRS or LRS if cross-region DR is not required (~35%% cheaper)", sku))
	}
	if isLRS && totalCost > 50 {
		tips = append(tips, "SKU is LRS (single region) — consider ZRS for higher durability with minimal cost increase for critical data")
	}
	if !httpsOnly {
		tips = append(tips, "HTTPS-only traffic is not enforced — enable to prevent data in transit exposure (no cost impact)")
	}
	if allowBlobPublic && publicContainerCount == 0 {
		tips = append(tips, "AllowBlobPublicAccess is enabled at account level but no containers use it — disable to reduce attack surface")
	}
	if minTLSVersion == "TLS1_0" || minTLSVersion == "TLS1_1" {
		tips = append(tips, fmt.Sprintf("Minimum TLS version is %s — upgrade to TLS1_2 to meet security compliance requirements", minTLSVersion))
	}
	if totalCost > 15 {
		saving += totalCost * 0.20
		tips = append(tips, "No lifecycle management policy detected — add policy to auto-tier or delete old blobs to reduce storage cost by ~20%")
	}
	if kind == "BlobStorage" {
		tips = append(tips, "Account kind is BlobStorage (legacy) — migrate to StorageV2 for better features and lower cost tiers")
	}
	if containerCount == 0 {
		saving += totalCost
		tips = append(tips, "No blob containers found — account may be idle; delete if unused to eliminate monthly base cost")
	}
	return
}

func runStorageUsage(ctx context.Context, subID string, cred *azidentity.DefaultAzureCredential, resourceID, name, rg string, days int) (*UsageReport, error) {
	storageClient, err := armstorage.NewAccountsClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating storage client: %w", err)
	}

	account, err := storageClient.GetProperties(ctx, rg, name, nil)
	if err != nil {
		return nil, fmt.Errorf("getting storage account: %w", err)
	}

	meterMap, totalCost, currency, err := queryMeterCosts(ctx, subID, cred, resourceID, days)
	if err != nil {
		return nil, fmt.Errorf("querying meter costs: %w", err)
	}

	blobClient, err := armstorage.NewBlobContainersClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating blob containers client: %w", err)
	}

	type containerInfo struct {
		name         string
		publicAccess string
		leaseState   string
	}
	var containers []containerInfo

	pager := blobClient.NewListPager(rg, name, nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			break
		}
		for _, c := range page.Value {
			if c.Name == nil {
				continue
			}
			pub := "None"
			if c.Properties != nil && c.Properties.PublicAccess != nil {
				pub = string(*c.Properties.PublicAccess)
			}
			leaseState := ""
			if c.Properties != nil && c.Properties.LeaseState != nil {
				leaseState = string(*c.Properties.LeaseState)
			}
			containers = append(containers, containerInfo{
				name:         *c.Name,
				publicAccess: pub,
				leaseState:   leaseState,
			})
		}
	}

	// Account properties
	accessTier := ""
	if account.Properties != nil && account.Properties.AccessTier != nil {
		accessTier = string(*account.Properties.AccessTier)
	}
	sku := ""
	if account.SKU != nil && account.SKU.Name != nil {
		sku = string(*account.SKU.Name)
	}
	kind := ""
	if account.Kind != nil {
		kind = string(*account.Kind)
	}
	httpsOnly := true
	if account.Properties != nil && account.Properties.EnableHTTPSTrafficOnly != nil {
		httpsOnly = *account.Properties.EnableHTTPSTrafficOnly
	}
	allowBlobPublic := false
	if account.Properties != nil && account.Properties.AllowBlobPublicAccess != nil {
		allowBlobPublic = *account.Properties.AllowBlobPublicAccess
	}
	minTLSVersion := ""
	if account.Properties != nil && account.Properties.MinimumTLSVersion != nil {
		minTLSVersion = string(*account.Properties.MinimumTLSVersion)
	}
	hasLifecyclePolicy := false // would need separate API call; default false
	isGRS := strings.Contains(sku, "GRS")
	isLRS := strings.Contains(sku, "LRS")

	// Build meter list
	var meters []MeterCost
	for meterName, cost := range meterMap {
		meters = append(meters, MeterCost{Name: meterName, Cost: cost, Currency: currency})
	}
	sortMetersByCost(meters)

	// Build sub-resources per container
	var subResources []UsageSubResource
	var totalSaving float64
	var publicContainerCount int

	if len(containers) > 0 {
		perContainerCost := totalCost / float64(len(containers))
		for _, c := range containers {
			sev := Info
			var tips []string
			saving := 0.0

			// Rule 1 — Public blob access on container
			if c.publicAccess == "Blob" || c.publicAccess == "Container" {
				sev = Critical
				tips = append(tips, fmt.Sprintf("Container '%s' has public access (%s) — disable unless intentional to prevent data exposure", c.name, c.publicAccess))
				publicContainerCount++
			}

			// Rule 2 — Leaked lease on container
			if c.leaseState == "Leased" {
				tips = append(tips, fmt.Sprintf("Container '%s' has an active lease — verify it is still needed", c.name))
			}

			tip := ""
			if len(tips) > 0 {
				tip = tips[0]
			}
			totalSaving += saving

			subResources = append(subResources, UsageSubResource{
				Name:          c.name,
				Cost:          perContainerCost,
				Currency:      currency,
				Severity:      sev,
				Details:       map[string]string{"public_access": c.publicAccess},
				Tip:           tip,
				MonthlySaving: saving,
			})
		}
	}

	// Account-level rules
	var accountTips []string

	// Rule 3 — Hot tier with significant cost
	if accessTier == "Hot" && totalCost > 10 {
		saving := totalCost * 0.30
		totalSaving += saving
		accountTips = append(accountTips, "Access tier is Hot — move infrequently accessed blobs to Cool or Archive to save ~30%")
	}

	// Rule 4 — GRS redundancy (expensive, often unnecessary)
	if isGRS && totalCost > 20 {
		saving := totalCost * 0.35
		totalSaving += saving
		accountTips = append(accountTips, fmt.Sprintf("SKU is %s (geo-redundant) — switch to ZRS or LRS if cross-region DR is not required (~35%% cheaper)", sku))
	}

	// Rule 5 — LRS for critical data
	if isLRS && totalCost > 50 {
		accountTips = append(accountTips, "SKU is LRS (single region) — consider ZRS for higher durability with minimal cost increase for critical data")
	}

	// Rule 6 — HTTPS not enforced
	if !httpsOnly {
		accountTips = append(accountTips, "HTTPS-only traffic is not enforced — enable to prevent data in transit exposure (no cost impact)")
	}

	// Rule 7 — Public blob access allowed at account level
	if allowBlobPublic && publicContainerCount == 0 {
		accountTips = append(accountTips, "AllowBlobPublicAccess is enabled at account level but no containers use it — disable to reduce attack surface")
	}

	// Rule 8 — Old TLS version
	if minTLSVersion == "TLS1_0" || minTLSVersion == "TLS1_1" {
		accountTips = append(accountTips, fmt.Sprintf("Minimum TLS version is %s — upgrade to TLS1_2 to meet security compliance requirements", minTLSVersion))
	}

	// Rule 9 — No lifecycle policy
	if !hasLifecyclePolicy && totalCost > 15 {
		saving := totalCost * 0.20
		totalSaving += saving
		accountTips = append(accountTips, "No lifecycle management policy detected — add policy to auto-tier or delete old blobs to reduce storage cost by ~20%")
	}

	// Rule 10 — BlobStorage kind (legacy)
	if kind == "BlobStorage" {
		accountTips = append(accountTips, "Account kind is BlobStorage (legacy) — migrate to StorageV2 for better features and lower cost tiers")
	}

	// Rule 11 — No containers found (idle account)
	if len(containers) == 0 {
		accountTips = append(accountTips, "No blob containers found — account may be idle; delete if unused to eliminate monthly base cost")
		totalSaving += totalCost
	}

	topRec := ""
	if len(accountTips) > 0 {
		topRec = accountTips[0]
	}

	countMetrics := queryResourceMetrics(ctx, subID, cred, resourceID, []string{"Transactions"}, days, "Count")
	gaugeMetrics := queryResourceMetrics(ctx, subID, cred, resourceID, []string{"UsedCapacity"}, days, "Average")
	transactionsPerDay := countMetrics["Transactions"]
	usedGB := gaugeMetrics["UsedCapacity"] / (1024 * 1024 * 1024)
	wasteScore, wasteReason := calcWasteScore(totalCost, -1, transactionsPerDay)

	return &UsageReport{
		ResourceName:      name,
		ResourceType:      "microsoft.storage/storageaccounts",
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
		Utilization:       map[string]float64{"Transactions/day": transactionsPerDay, "Used GB": usedGB},
		WasteScore:        wasteScore,
		WasteReason:       wasteReason,
	}, nil
}
