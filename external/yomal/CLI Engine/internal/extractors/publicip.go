package extractors

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/network/armnetwork/v4"
)

// PublicIPData holds the clean extracted data for all public IP addresses.
type PublicIPData struct {
	TotalPublicIPs int               `json:"total_public_ips"`
	PublicIPs      []json.RawMessage `json:"public_ips"`
}

// ExtractPublicIP fetches all public IP addresses and returns clean JSON.
func ExtractPublicIP(ctx context.Context, subID string, cred azcore.TokenCredential) (*PublicIPData, error) {
	client, err := armnetwork.NewPublicIPAddressesClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating public ip client: %w", err)
	}

	var pips []*armnetwork.PublicIPAddress
	pager := client.NewListAllPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("listing public ips: %w", err)
		}
		pips = append(pips, page.Value...)
	}

	clean, err := CleanResources(pips)
	if err != nil {
		return nil, fmt.Errorf("cleaning public ips: %w", err)
	}

	return &PublicIPData{
		TotalPublicIPs: len(pips),
		PublicIPs:      clean,
	}, nil
}
