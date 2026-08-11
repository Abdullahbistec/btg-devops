package security_analyzers_test

import (
	"testing"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/keyvault/armkeyvault"
	"github.com/chanbistec/btg-devops/cmd"
	"github.com/stretchr/testify/assert"
)

func kvVault(name string, props *armkeyvault.VaultProperties) *armkeyvault.Vault {
	id := "/subscriptions/sub/resourceGroups/rg-test/providers/Microsoft.KeyVault/vaults/" + name
	return &armkeyvault.Vault{
		Name:       strPtr(name),
		ID:         strPtr(id),
		Properties: props,
	}
}

var testNow = time.Date(2026, 6, 18, 0, 0, 0, 0, time.UTC)

func TestAnalyzeKeyVaultFindings(t *testing.T) {
	tests := []struct {
		name          string
		vaults        []*armkeyvault.Vault
		expectedCount int
		checkFindings func(t *testing.T, findings []cmd.KeyVaultFinding)
	}{
		{
			name:          "Empty vault list returns no findings",
			vaults:        []*armkeyvault.Vault{},
			expectedCount: 0,
		},
		{
			name: "Vault with nil properties is skipped",
			vaults: []*armkeyvault.Vault{
				kvVault("kv1", nil),
			},
			expectedCount: 0,
		},
		{
			name: "Vault not using RBAC is Warning",
			vaults: []*armkeyvault.Vault{
				kvVault("kv1", &armkeyvault.VaultProperties{
					EnableRbacAuthorization: boolPtr(false),
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.KeyVaultFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Access Policies (Not RBAC)" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
						assert.Equal(t, "kv1", f.VaultName)
					}
				}
				assert.True(t, found, "expected Access Policies (Not RBAC) finding")
			},
		},
		{
			name: "Soft-delete disabled is Critical",
			vaults: []*armkeyvault.Vault{
				kvVault("kv1", &armkeyvault.VaultProperties{
					EnableSoftDelete: boolPtr(false),
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.KeyVaultFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Soft-Delete Disabled" {
						found = true
						assert.Equal(t, cmd.Critical, f.Severity)
					}
				}
				assert.True(t, found, "expected Soft-Delete Disabled finding")
			},
		},
		{
			name: "No purge protection is Warning",
			vaults: []*armkeyvault.Vault{
				kvVault("kv1", &armkeyvault.VaultProperties{
					EnablePurgeProtection: boolPtr(false),
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.KeyVaultFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "No Purge Protection" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
					}
				}
				assert.True(t, found, "expected No Purge Protection finding")
			},
		},
		{
			name: "Public network access with no firewall is Warning",
			vaults: []*armkeyvault.Vault{
				kvVault("kv1", &armkeyvault.VaultProperties{
					PublicNetworkAccess: strPtr("enabled"),
					NetworkACLs:         nil,
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.KeyVaultFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Unrestricted Network Access" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
					}
				}
				assert.True(t, found, "expected Unrestricted Network Access finding")
			},
		},
		{
			name: "Overly broad key permissions is Warning",
			vaults: []*armkeyvault.Vault{
				kvVault("kv1", &armkeyvault.VaultProperties{
					AccessPolicies: []*armkeyvault.AccessPolicyEntry{
						{
							ObjectID: strPtr("obj1"),
							Permissions: &armkeyvault.Permissions{
								Keys: []*armkeyvault.KeyPermissions{kvKeyPerm(armkeyvault.KeyPermissionsAll)},
							},
						},
					},
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.KeyVaultFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Overly Broad Key Permissions" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
					}
				}
				assert.True(t, found, "expected Overly Broad Key Permissions finding")
			},
		},
		{
			name: "No private endpoints is Info",
			vaults: []*armkeyvault.Vault{
				kvVault("kv1", &armkeyvault.VaultProperties{
					PrivateEndpointConnections: []*armkeyvault.PrivateEndpointConnectionItem{},
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.KeyVaultFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "No Private Endpoints" {
						found = true
						assert.Equal(t, cmd.Info, f.Severity)
					}
				}
				assert.True(t, found, "expected No Private Endpoints finding")
			},
		},
		{
			name: "Short retention period under 90 days is Info",
			vaults: []*armkeyvault.Vault{
				kvVault("kv1", &armkeyvault.VaultProperties{
					SoftDeleteRetentionInDays: int32Ptr(30),
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.KeyVaultFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Short Retention Period" {
						found = true
						assert.Equal(t, cmd.Info, f.Severity)
					}
				}
				assert.True(t, found, "expected Short Retention Period finding")
			},
		},
		{
			name: "Finding fields are populated",
			vaults: []*armkeyvault.Vault{
				kvVault("myvault", &armkeyvault.VaultProperties{
					EnableSoftDelete: boolPtr(false),
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.KeyVaultFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Soft-Delete Disabled" {
						found = true
						assert.Equal(t, "myvault", f.VaultName)
						assert.Equal(t, "rg-test", f.ResourceGrp)
						assert.NotEmpty(t, f.Description)
						assert.NotEmpty(t, f.Recommendation)
					}
				}
				assert.True(t, found)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			findings := cmd.AnalyzeKeyVaultFindings(tt.vaults, testNow)
			if tt.expectedCount > 0 {
				assert.Equal(t, tt.expectedCount, len(findings))
			}
			if tt.checkFindings != nil {
				tt.checkFindings(t, findings)
			}
		})
	}
}

func kvKeyPerm(p armkeyvault.KeyPermissions) *armkeyvault.KeyPermissions { return &p }
