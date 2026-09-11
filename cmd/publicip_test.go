package cmd

import (
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/network/armnetwork/v4"
)

func TestPublicIPWrapper_UnattachedFinding(t *testing.T) {
	name := "orphan-pip"
	pips := []*armnetwork.PublicIPAddress{
		{
			Name: &name,
			Properties: &armnetwork.PublicIPAddressPropertiesFormat{
				IPConfiguration: nil,
			},
		},
	}

	findings := AnalyzePublicIPs(pips)

	found := false
	for _, f := range findings.Findings {
		if f.Category == "Unused Resource" {
			found = true
		}
	}
	if !found {
		t.Error("expected an unattached/Unused Resource finding, got none")
	}
}
