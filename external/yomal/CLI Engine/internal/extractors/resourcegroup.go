package extractors

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/resources/armresources"
)

// ResourceGroupData holds the clean extracted data for all resource groups.
type ResourceGroupData struct {
	TotalResourceGroups int               `json:"total_resource_groups"`
	ResourceGroups      []json.RawMessage `json:"resource_groups"`
}

// ExtractResourceGroup fetches all resource groups and returns clean JSON.
func ExtractResourceGroup(ctx context.Context, subID string, cred azcore.TokenCredential) (*ResourceGroupData, error) {
	client, err := armresources.NewResourceGroupsClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating resource group client: %w", err)
	}

	var rgs []*armresources.ResourceGroup
	pager := client.NewListPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("listing resource groups: %w", err)
		}
		rgs = append(rgs, page.Value...)
	}

	clean, err := CleanResources(rgs)
	if err != nil {
		return nil, fmt.Errorf("cleaning resource groups: %w", err)
	}

	return &ResourceGroupData{
		TotalResourceGroups: len(rgs),
		ResourceGroups:      clean,
	}, nil
}
