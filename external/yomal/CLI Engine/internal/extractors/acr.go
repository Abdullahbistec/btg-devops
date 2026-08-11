package extractors

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/containerregistry/armcontainerregistry"
)

// ACRData holds the clean extracted data for all container registries.
type ACRData struct {
	TotalRegistries int               `json:"total_registries"`
	Registries      []json.RawMessage `json:"registries"`
}

// ExtractACR fetches all container registries and returns clean JSON.
func ExtractACR(ctx context.Context, subID string, cred azcore.TokenCredential) (*ACRData, error) {
	client, err := armcontainerregistry.NewRegistriesClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating acr client: %w", err)
	}

	var registries []*armcontainerregistry.Registry
	pager := client.NewListPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("listing registries: %w", err)
		}
		registries = append(registries, page.Value...)
	}

	clean, err := CleanResources(registries)
	if err != nil {
		return nil, fmt.Errorf("cleaning registries: %w", err)
	}

	return &ACRData{
		TotalRegistries: len(registries),
		Registries:      clean,
	}, nil
}
