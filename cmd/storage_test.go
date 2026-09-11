package cmd

import (
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/storage/armstorage"
)

func TestAnalyzeStorageFindings_HTTPSNotEnforced(t *testing.T) {
	name := "mystorageacct"
	disabled := false
	accounts := []*armstorage.Account{
		{
			Name: &name,
			Properties: &armstorage.AccountProperties{
				EnableHTTPSTrafficOnly: &disabled,
			},
		},
	}

	findings := AnalyzeStorageFindings(accounts)

	found := false
	for _, f := range findings {
		if f.Category == "HTTPS Not Enforced" {
			found = true
		}
	}
	if !found {
		t.Error("expected an HTTPS Not Enforced finding when EnableHTTPSTrafficOnly is false, got none")
	}
}

func TestAnalyzeStorageFindings_NilPropertiesSkipped(t *testing.T) {
	name := "mystorageacct"
	accounts := []*armstorage.Account{
		{
			Name: &name,
		},
	}

	findings := AnalyzeStorageFindings(accounts)

	if len(findings) != 0 {
		t.Errorf("expected no findings for account with nil Properties, got %d", len(findings))
	}
}
