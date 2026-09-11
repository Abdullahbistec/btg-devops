package cmd

import (
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/cosmos/armcosmos/v3"
)

func TestAnalyzeCosmosDBFindings_PublicNetworkAccess(t *testing.T) {
	name := "my-cosmos"
	enabled := armcosmos.PublicNetworkAccessEnabled
	accounts := []*armcosmos.DatabaseAccountGetResults{
		{
			Name: &name,
			Properties: &armcosmos.DatabaseAccountGetProperties{
				PublicNetworkAccess: &enabled,
			},
		},
	}

	findings := AnalyzeCosmosDBFindings(accounts)

	found := false
	for _, f := range findings {
		if f.Category == "Public Network Access" {
			found = true
		}
	}
	if !found {
		t.Error("expected a Public Network Access finding when enabled, got none")
	}
}
