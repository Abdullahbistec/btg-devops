package security_analyzers_test

import (
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/containerregistry/armcontainerregistry"
	"github.com/chanbistec/btg-devops/cmd"
	"github.com/stretchr/testify/assert"
)

func acrRegistry(name string, sku armcontainerregistry.SKUName, props *armcontainerregistry.RegistryProperties) *armcontainerregistry.Registry {
	id := "/subscriptions/sub/resourceGroups/rg-test/providers/Microsoft.ContainerRegistry/registries/" + name
	skuVal := sku
	return &armcontainerregistry.Registry{
		Name:       strPtr(name),
		ID:         strPtr(id),
		SKU:        &armcontainerregistry.SKU{Name: &skuVal},
		Properties: props,
	}
}

func acrPublicAccess(v armcontainerregistry.PublicNetworkAccess) *armcontainerregistry.PublicNetworkAccess {
	return &v
}

func TestAnalyzeACRFindings(t *testing.T) {
	tests := []struct {
		name          string
		registries    []*armcontainerregistry.Registry
		expectedCount int
		checkFindings func(t *testing.T, findings []cmd.ACRFinding)
	}{
		{
			name:          "Empty registry list returns no findings",
			registries:    []*armcontainerregistry.Registry{},
			expectedCount: 0,
		},
		{
			name: "Registry with nil properties is skipped",
			registries: []*armcontainerregistry.Registry{
				acrRegistry("reg1", armcontainerregistry.SKUNameBasic, nil),
			},
			expectedCount: 0,
		},
		{
			name: "Admin account enabled is Critical",
			registries: []*armcontainerregistry.Registry{
				acrRegistry("reg1", armcontainerregistry.SKUNameStandard, &armcontainerregistry.RegistryProperties{
					AdminUserEnabled: boolPtr(true),
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.ACRFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Admin Account Enabled" {
						found = true
						assert.Equal(t, cmd.Critical, f.Severity)
						assert.Equal(t, "reg1", f.RegistryName)
					}
				}
				assert.True(t, found, "expected Admin Account Enabled finding")
			},
		},
		{
			name: "Admin account disabled does not flag admin finding",
			registries: []*armcontainerregistry.Registry{
				acrRegistry("reg1", armcontainerregistry.SKUNameStandard, &armcontainerregistry.RegistryProperties{
					AdminUserEnabled: boolPtr(false),
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.ACRFinding) {
				for _, f := range findings {
					assert.NotEqual(t, "Admin Account Enabled", f.Category)
				}
			},
		},
		{
			name: "Public network access enabled is Warning",
			registries: []*armcontainerregistry.Registry{
				acrRegistry("reg1", armcontainerregistry.SKUNameStandard, &armcontainerregistry.RegistryProperties{
					PublicNetworkAccess: acrPublicAccess(armcontainerregistry.PublicNetworkAccessEnabled),
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.ACRFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Public Network Access" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
					}
				}
				assert.True(t, found, "expected Public Network Access finding")
			},
		},
		{
			name: "No private endpoint is Warning",
			registries: []*armcontainerregistry.Registry{
				acrRegistry("reg1", armcontainerregistry.SKUNameStandard, &armcontainerregistry.RegistryProperties{
					PrivateEndpointConnections: []*armcontainerregistry.PrivateEndpointConnection{},
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.ACRFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "No Private Endpoint" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
					}
				}
				assert.True(t, found, "expected No Private Endpoint finding")
			},
		},
		{
			name: "Basic SKU is Info",
			registries: []*armcontainerregistry.Registry{
				acrRegistry("reg1", armcontainerregistry.SKUNameBasic, &armcontainerregistry.RegistryProperties{}),
			},
			checkFindings: func(t *testing.T, findings []cmd.ACRFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Basic SKU" {
						found = true
						assert.Equal(t, cmd.Info, f.Severity)
					}
				}
				assert.True(t, found, "expected Basic SKU finding")
			},
		},
		{
			name: "Premium SKU with disabled retention policy is Warning",
			registries: []*armcontainerregistry.Registry{
				acrRegistry("reg1", armcontainerregistry.SKUNamePremium, &armcontainerregistry.RegistryProperties{
					Policies: &armcontainerregistry.Policies{
						RetentionPolicy: &armcontainerregistry.RetentionPolicy{
							Status: retentionStatus(armcontainerregistry.PolicyStatusDisabled),
						},
					},
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.ACRFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Retention Policy Disabled" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
					}
				}
				assert.True(t, found, "expected Retention Policy Disabled finding")
			},
		},
		{
			name: "Finding fields are populated",
			registries: []*armcontainerregistry.Registry{
				acrRegistry("myregistry", armcontainerregistry.SKUNameStandard, &armcontainerregistry.RegistryProperties{
					AdminUserEnabled: boolPtr(true),
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.ACRFinding) {
				f := findings[0]
				assert.Equal(t, "myregistry", f.RegistryName)
				assert.Equal(t, "rg-test", f.ResourceGroup)
				assert.NotEmpty(t, f.Description)
				assert.NotEmpty(t, f.Recommendation)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			findings := cmd.AnalyzeACRFindings(tt.registries)
			if tt.expectedCount > 0 {
				assert.Equal(t, tt.expectedCount, len(findings))
			}
			if tt.checkFindings != nil {
				tt.checkFindings(t, findings)
			}
		})
	}
}

func retentionStatus(v armcontainerregistry.PolicyStatus) *armcontainerregistry.PolicyStatus {
	return &v
}
