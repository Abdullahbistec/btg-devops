package cmd

import (
	"testing"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/keyvault/armkeyvault"
)

// These tests exercise AnalyzeKeyVaultFindings, the pure analyzer function
// that runs Key Vault checks against pre-fetched vaults — no Azure calls,
// matching the existing acr_test.go / pp_test.go / idle_test.go style.
// Note: key/secret expiry checks are intentionally not covered here — they
// require data-plane Keys/Secrets clients and are skipped by this function.

func TestAnalyzeKeyVaultFindings_SoftDeleteDisabled(t *testing.T) {
	name := "my-vault"
	disabled := false
	vaults := []*armkeyvault.Vault{
		{
			Name: &name,
			Properties: &armkeyvault.VaultProperties{
				EnableSoftDelete: &disabled,
			},
		},
	}

	findings := AnalyzeKeyVaultFindings(vaults, time.Now())

	found := false
	for _, f := range findings {
		if f.Category == "Soft-Delete Disabled" {
			found = true
			if f.Severity != Critical {
				t.Errorf("expected Critical severity for soft-delete disabled, got %v", f.Severity)
			}
		}
	}
	if !found {
		t.Error("expected a Soft-Delete Disabled finding when EnableSoftDelete is false, got none")
	}
}

func TestAnalyzeKeyVaultFindings_AccessPoliciesNotRBAC(t *testing.T) {
	name := "my-vault"
	rbacDisabled := false
	vaults := []*armkeyvault.Vault{
		{
			Name: &name,
			Properties: &armkeyvault.VaultProperties{
				EnableRbacAuthorization: &rbacDisabled,
			},
		},
	}

	findings := AnalyzeKeyVaultFindings(vaults, time.Now())

	found := false
	for _, f := range findings {
		if f.Category == "Access Policies (Not RBAC)" {
			found = true
		}
	}
	if !found {
		t.Error("expected an Access Policies (Not RBAC) finding when EnableRbacAuthorization is false, got none")
	}
}

func TestAnalyzeKeyVaultFindings_RBACNilTreatedAsNotRBAC(t *testing.T) {
	name := "my-vault"
	vaults := []*armkeyvault.Vault{
		{
			Name:       &name,
			Properties: &armkeyvault.VaultProperties{},
		},
	}

	findings := AnalyzeKeyVaultFindings(vaults, time.Now())

	found := false
	for _, f := range findings {
		if f.Category == "Access Policies (Not RBAC)" {
			found = true
		}
	}
	if !found {
		t.Error("expected an Access Policies (Not RBAC) finding when EnableRbacAuthorization is nil, got none")
	}
}

func TestAnalyzeKeyVaultFindings_NoPurgeProtection(t *testing.T) {
	name := "my-vault"
	rbacEnabled := true
	softDeleteEnabled := true
	vaults := []*armkeyvault.Vault{
		{
			Name: &name,
			Properties: &armkeyvault.VaultProperties{
				EnableRbacAuthorization: &rbacEnabled,
				EnableSoftDelete:        &softDeleteEnabled,
			},
		},
	}

	findings := AnalyzeKeyVaultFindings(vaults, time.Now())

	found := false
	for _, f := range findings {
		if f.Category == "No Purge Protection" {
			found = true
		}
	}
	if !found {
		t.Error("expected a No Purge Protection finding when EnablePurgeProtection is nil, got none")
	}
}

func TestAnalyzeKeyVaultFindings_UnrestrictedNetworkAccess(t *testing.T) {
	name := "my-vault"
	vaults := []*armkeyvault.Vault{
		{
			Name: &name,
			Properties: &armkeyvault.VaultProperties{
				PublicNetworkAccess: strPtr("Enabled"),
			},
		},
	}

	findings := AnalyzeKeyVaultFindings(vaults, time.Now())

	found := false
	for _, f := range findings {
		if f.Category == "Unrestricted Network Access" {
			found = true
		}
	}
	if !found {
		t.Error("expected an Unrestricted Network Access finding when public access enabled with no deny rule, got none")
	}
}

func TestAnalyzeKeyVaultFindings_NoFindingForRestrictedNetworkAccess(t *testing.T) {
	name := "my-vault"
	vaults := []*armkeyvault.Vault{
		{
			Name: &name,
			Properties: &armkeyvault.VaultProperties{
				PublicNetworkAccess: strPtr("Enabled"),
				NetworkACLs: &armkeyvault.NetworkRuleSet{
					DefaultAction: (*armkeyvault.NetworkRuleAction)(strPtr(string(armkeyvault.NetworkRuleActionDeny))),
				},
			},
		},
	}

	findings := AnalyzeKeyVaultFindings(vaults, time.Now())

	for _, f := range findings {
		if f.Category == "Unrestricted Network Access" {
			t.Errorf("did not expect an Unrestricted Network Access finding when default action is Deny, got: %+v", f)
		}
	}
}

func TestAnalyzeKeyVaultFindings_OverlyBroadKeyPermissions(t *testing.T) {
	name := "my-vault"
	objectID := "principal-123"
	allKeys := armkeyvault.KeyPermissionsAll
	vaults := []*armkeyvault.Vault{
		{
			Name: &name,
			Properties: &armkeyvault.VaultProperties{
				AccessPolicies: []*armkeyvault.AccessPolicyEntry{
					{
						ObjectID: &objectID,
						Permissions: &armkeyvault.Permissions{
							Keys: []*armkeyvault.KeyPermissions{&allKeys},
						},
					},
				},
			},
		},
	}

	findings := AnalyzeKeyVaultFindings(vaults, time.Now())

	found := false
	for _, f := range findings {
		if f.Category == "Overly Broad Key Permissions" {
			found = true
		}
	}
	if !found {
		t.Error("expected an Overly Broad Key Permissions finding when a policy grants 'all' key permissions, got none")
	}
}

func TestAnalyzeKeyVaultFindings_OverlyBroadSecretPermissions(t *testing.T) {
	name := "my-vault"
	objectID := "principal-456"
	allSecrets := armkeyvault.SecretPermissionsAll
	vaults := []*armkeyvault.Vault{
		{
			Name: &name,
			Properties: &armkeyvault.VaultProperties{
				AccessPolicies: []*armkeyvault.AccessPolicyEntry{
					{
						ObjectID: &objectID,
						Permissions: &armkeyvault.Permissions{
							Secrets: []*armkeyvault.SecretPermissions{&allSecrets},
						},
					},
				},
			},
		},
	}

	findings := AnalyzeKeyVaultFindings(vaults, time.Now())

	found := false
	for _, f := range findings {
		if f.Category == "Overly Broad Secret Permissions" {
			found = true
		}
	}
	if !found {
		t.Error("expected an Overly Broad Secret Permissions finding when a policy grants 'all' secret permissions, got none")
	}
}

func TestAnalyzeKeyVaultFindings_NoPrivateEndpoints(t *testing.T) {
	name := "my-vault"
	vaults := []*armkeyvault.Vault{
		{
			Name:       &name,
			Properties: &armkeyvault.VaultProperties{},
		},
	}

	findings := AnalyzeKeyVaultFindings(vaults, time.Now())

	found := false
	for _, f := range findings {
		if f.Category == "No Private Endpoints" {
			found = true
			if f.Severity != Info {
				t.Errorf("expected Info severity for no private endpoints, got %v", f.Severity)
			}
		}
	}
	if !found {
		t.Error("expected a No Private Endpoints finding when PrivateEndpointConnections is empty, got none")
	}
}

func TestAnalyzeKeyVaultFindings_ShortRetentionPeriod(t *testing.T) {
	name := "my-vault"
	retention := int32(30)
	vaults := []*armkeyvault.Vault{
		{
			Name: &name,
			Properties: &armkeyvault.VaultProperties{
				SoftDeleteRetentionInDays: &retention,
			},
		},
	}

	findings := AnalyzeKeyVaultFindings(vaults, time.Now())

	found := false
	for _, f := range findings {
		if f.Category == "Short Retention Period" {
			found = true
		}
	}
	if !found {
		t.Error("expected a Short Retention Period finding when retention is below 90 days, got none")
	}
}

func TestAnalyzeKeyVaultFindings_NoShortRetentionFindingAt90Days(t *testing.T) {
	name := "my-vault"
	retention := int32(90)
	vaults := []*armkeyvault.Vault{
		{
			Name: &name,
			Properties: &armkeyvault.VaultProperties{
				SoftDeleteRetentionInDays: &retention,
			},
		},
	}

	findings := AnalyzeKeyVaultFindings(vaults, time.Now())

	for _, f := range findings {
		if f.Category == "Short Retention Period" {
			t.Errorf("did not expect a Short Retention Period finding when retention is 90 days, got: %+v", f)
		}
	}
}

func TestAnalyzeKeyVaultFindings_NilPropertiesSkipped(t *testing.T) {
	name := "my-vault"
	vaults := []*armkeyvault.Vault{
		{
			Name:       &name,
			Properties: nil,
		},
	}

	findings := AnalyzeKeyVaultFindings(vaults, time.Now())

	if len(findings) != 0 {
		t.Errorf("expected no findings for a vault with nil Properties, got: %+v", findings)
	}
}

func TestAnalyzeKeyVaultFindings_NoFindingsForHardenedVault(t *testing.T) {
	name := "hardened-vault"
	rbacEnabled := true
	softDeleteEnabled := true
	purgeProtectionEnabled := true
	retention := int32(90)
	vaults := []*armkeyvault.Vault{
		{
			Name: &name,
			Properties: &armkeyvault.VaultProperties{
				EnableRbacAuthorization:    &rbacEnabled,
				EnableSoftDelete:           &softDeleteEnabled,
				EnablePurgeProtection:      &purgeProtectionEnabled,
				PublicNetworkAccess:        strPtr("Disabled"),
				SoftDeleteRetentionInDays:  &retention,
				PrivateEndpointConnections: []*armkeyvault.PrivateEndpointConnectionItem{{}},
			},
		},
	}

	findings := AnalyzeKeyVaultFindings(vaults, time.Now())

	if len(findings) != 0 {
		t.Errorf("expected no findings for a fully hardened vault, got: %+v", findings)
	}
}
