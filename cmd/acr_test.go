package cmd

import (
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/containerregistry/armcontainerregistry"
)

// These tests exercise AnalyzeACRFindings, the pure analyzer function that
// runs ACR checks against pre-fetched data — no Azure calls, matching the
// existing pp_test.go / idle_test.go / hetzner_findings_test.go style.

func boolPtr(b bool) *bool { return &b }

func TestAnalyzeACRFindings_AdminAccountEnabled(t *testing.T) {
	name := "myregistry"
	registries := []*armcontainerregistry.Registry{
		{
			Name: &name,
			Properties: &armcontainerregistry.RegistryProperties{
				AdminUserEnabled: boolPtr(true),
			},
		},
	}

	findings := AnalyzeACRFindings(registries)

	found := false
	for _, f := range findings {
		if f.Category == "Admin Account Enabled" {
			found = true
			if f.Severity != Critical {
				t.Errorf("expected Critical severity for admin account enabled, got %v", f.Severity)
			}
		}
	}
	if !found {
		t.Error("expected an Admin Account Enabled finding when AdminUserEnabled is true, got none")
	}
}

func TestAnalyzeACRFindings_NoFindingsForHardenedRegistry(t *testing.T) {
	name := "hardened-registry"
	registries := []*armcontainerregistry.Registry{
		{
			Name: &name,
			Properties: &armcontainerregistry.RegistryProperties{
				AdminUserEnabled: boolPtr(false),
			},
		},
	}

	findings := AnalyzeACRFindings(registries)

	for _, f := range findings {
		if f.Category == "Admin Account Enabled" {
			t.Errorf("did not expect an Admin Account Enabled finding when AdminUserEnabled is false, got: %+v", f)
		}
	}
}
