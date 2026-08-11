package extractors

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/network/armnetwork/v4"
)

// NSGData holds the clean extracted data for all network security groups.
type NSGData struct {
	TotalNSGs int               `json:"total_nsgs"`
	NSGs      []json.RawMessage `json:"nsgs"`
}

// ExtractNSG fetches all NSGs for the subscription and returns clean JSON.
func ExtractNSG(ctx context.Context, subID string, cred azcore.TokenCredential) (*NSGData, error) {
	client, err := armnetwork.NewSecurityGroupsClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating nsg client: %w", err)
	}

	var nsgs []*armnetwork.SecurityGroup
	pager := client.NewListAllPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("listing nsgs: %w", err)
		}
		nsgs = append(nsgs, page.Value...)
	}

	clean, err := CleanResources(nsgs)
	if err != nil {
		return nil, fmt.Errorf("cleaning nsgs: %w", err)
	}

	return &NSGData{
		TotalNSGs: len(nsgs),
		NSGs:      clean,
	}, nil
}
