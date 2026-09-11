package cmd

import (
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/cognitiveservices/armcognitiveservices"
)

func TestAnalyzeCogServicesFindings_PublicNetworkAccess(t *testing.T) {
	name := "my-openai"
	enabled := armcognitiveservices.PublicNetworkAccessEnabled
	accounts := []*armcognitiveservices.Account{
		{
			Name: &name,
			Properties: &armcognitiveservices.AccountProperties{
				PublicNetworkAccess: &enabled,
			},
		},
	}

	findings := AnalyzeCogServicesFindings(accounts)

	found := false
	for _, f := range findings {
		if f.Category == "Public Network Access" {
			found = true
		}
	}
	if !found {
		t.Error("expected a Public Network Access finding when public access is enabled, got none")
	}
}
