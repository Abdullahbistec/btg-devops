package extractors

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/keyvault/armkeyvault"
)

// KeyVaultData holds the clean extracted data for all key vaults.
type KeyVaultData struct {
	TotalVaults int               `json:"total_vaults"`
	Vaults      []json.RawMessage `json:"vaults"`
}

// ExtractKeyVault fetches all key vaults and returns clean JSON.
func ExtractKeyVault(ctx context.Context, subID string, cred azcore.TokenCredential) (*KeyVaultData, error) {
	client, err := armkeyvault.NewVaultsClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating keyvault client: %w", err)
	}

	var vaults []*armkeyvault.Vault
	pager := client.NewListBySubscriptionPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("listing key vaults: %w", err)
		}
		vaults = append(vaults, page.Value...)
	}

	// Each vault is enriched with its diagnostic settings (spec 11 §5) —
	// merged into the cleaned envelope, output shape unchanged.
	cleanVaults := make([]json.RawMessage, 0, len(vaults))
	for _, vault := range vaults {
		clean, err := CleanResource(vault)
		if err != nil {
			return nil, fmt.Errorf("cleaning key vault %s: %w", derefStr(vault.Name), err)
		}
		extra := map[string]any{}
		if vault.ID != nil {
			addDiagnosticSettings(ctx, cred, *vault.ID, extra)
		}
		enriched, err := mergeIntoJSON(clean, extra)
		if err != nil {
			return nil, fmt.Errorf("enriching key vault %s: %w", derefStr(vault.Name), err)
		}
		cleanVaults = append(cleanVaults, enriched)
	}

	return &KeyVaultData{
		TotalVaults: len(vaults),
		Vaults:      cleanVaults,
	}, nil
}
