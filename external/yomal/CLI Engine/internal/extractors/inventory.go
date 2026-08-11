package extractors

import (
	"context"
	"fmt"
	"strings"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/resources/armresources"
)

// maxInventoryResources caps the stored per-resource list — by_type counts
// stay exact regardless.
const maxInventoryResources = 500

// InventoryResource is the envelope-only view of one resource: identity and
// placement, no properties.
type InventoryResource struct {
	Name          string            `json:"name"`
	Type          string            `json:"type"`
	Location      string            `json:"location,omitempty"`
	ResourceGroup string            `json:"resourceGroup,omitempty"`
	Tags          map[string]string `json:"tags,omitempty"`
}

// InventoryData is a complete envelope-only listing of every resource in the
// subscription (spec 11 §6). It exists because the per-type extractors only
// cover 12 resource types, while the cost data references many more (Front
// Door, DNS zones, VNets, Log Analytics, ...) — without this, "resource
// group is empty" conclusions are unreliable.
type InventoryData struct {
	TotalResources int                 `json:"total_resources"`
	ByType         map[string]int      `json:"by_type"`
	Truncated      bool                `json:"truncated,omitempty"`
	Resources      []InventoryResource `json:"resources"`
}

// ExtractInventory lists every resource in the subscription — envelope only
// (name/type/location/resourceGroup/tags), never properties.
func ExtractInventory(ctx context.Context, subID string, cred azcore.TokenCredential) (*InventoryData, error) {
	client, err := armresources.NewClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating resources client: %w", err)
	}

	data := &InventoryData{
		ByType:    map[string]int{},
		Resources: []InventoryResource{},
	}

	pager := client.NewListPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("listing resources: %w", err)
		}
		for _, r := range page.Value {
			if r == nil {
				continue
			}
			data.TotalResources++
			resType := strings.ToLower(derefStr(r.Type))
			data.ByType[resType]++

			if len(data.Resources) >= maxInventoryResources {
				data.Truncated = true
				continue
			}
			item := InventoryResource{
				Name:          derefStr(r.Name),
				Type:          resType,
				Location:      derefStr(r.Location),
				ResourceGroup: extractResourceGroup(derefStr(r.ID)),
			}
			if len(r.Tags) > 0 {
				item.Tags = map[string]string{}
				for k, v := range r.Tags {
					item.Tags[k] = derefStr(v)
				}
			}
			data.Resources = append(data.Resources, item)
		}
	}

	return data, nil
}
