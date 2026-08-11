package extractors

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/cosmos/armcosmos/v3"
)

// CosmosDBData holds the clean extracted data for all Cosmos DB accounts,
// plus public Retail Prices API pricing (spec 11 round 2 §1) so the analyzer
// can compute an actual dollar comparison for provisioned-vs-autoscale-vs-
// serverless throughput instead of only pointing in a direction.
type CosmosDBData struct {
	TotalAccounts     int                            `json:"total_accounts"`
	Accounts          []json.RawMessage              `json:"accounts"`
	RUPricingByRegion map[string]CosmosRegionPricing `json:"ru_pricing_by_region,omitempty"`
}

// ExtractCosmosDB fetches all Cosmos DB accounts and returns clean JSON.
func ExtractCosmosDB(ctx context.Context, subID string, cred azcore.TokenCredential) (*CosmosDBData, error) {
	client, err := armcosmos.NewDatabaseAccountsClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating cosmosdb client: %w", err)
	}

	var accounts []*armcosmos.DatabaseAccountGetResults
	pager := client.NewListPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("listing cosmosdb accounts: %w", err)
		}
		accounts = append(accounts, page.Value...)
	}

	clean, err := CleanResources(accounts)
	if err != nil {
		return nil, fmt.Errorf("cleaning cosmosdb accounts: %w", err)
	}

	regions := make([]string, 0, len(accounts))
	for _, a := range accounts {
		if a.Location != nil {
			regions = append(regions, *a.Location)
		}
	}

	return &CosmosDBData{
		TotalAccounts:     len(accounts),
		Accounts:          clean,
		RUPricingByRegion: FetchCosmosRUPricing(ctx, regions),
	}, nil
}
