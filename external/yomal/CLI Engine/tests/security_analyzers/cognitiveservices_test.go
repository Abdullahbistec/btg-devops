package security_analyzers_test

import (
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/cognitiveservices/armcognitiveservices"
	"github.com/chanbistec/btg-devops/cmd"
	"github.com/stretchr/testify/assert"
)

func cogAccount(name, kind string, props *armcognitiveservices.AccountProperties) *armcognitiveservices.Account {
	id := "/subscriptions/sub/resourceGroups/rg-test/providers/Microsoft.CognitiveServices/accounts/" + name
	return &armcognitiveservices.Account{
		Name:       strPtr(name),
		ID:         strPtr(id),
		Kind:       strPtr(kind),
		Properties: props,
	}
}

func cogPublicAccess(v armcognitiveservices.PublicNetworkAccess) *armcognitiveservices.PublicNetworkAccess {
	return &v
}
func cogNetworkAction(v armcognitiveservices.NetworkRuleAction) *armcognitiveservices.NetworkRuleAction {
	return &v
}
func cogProvisioningState(v armcognitiveservices.ProvisioningState) *armcognitiveservices.ProvisioningState {
	return &v
}

func TestAnalyzeCogServicesFindings(t *testing.T) {
	tests := []struct {
		name          string
		accounts      []*armcognitiveservices.Account
		expectedCount int
		checkFindings func(t *testing.T, findings []cmd.CognitiveServicesFinding)
	}{
		{
			name:          "Empty account list returns no findings",
			accounts:      []*armcognitiveservices.Account{},
			expectedCount: 0,
		},
		{
			name: "Account with nil properties is skipped",
			accounts: []*armcognitiveservices.Account{
				cogAccount("cog1", "OpenAI", nil),
			},
			expectedCount: 0,
		},
		{
			name: "Public network access enabled is Warning",
			accounts: []*armcognitiveservices.Account{
				cogAccount("cog1", "TextAnalytics", &armcognitiveservices.AccountProperties{
					PublicNetworkAccess: cogPublicAccess(armcognitiveservices.PublicNetworkAccessEnabled),
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.CognitiveServicesFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Public Network Access" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
						assert.Equal(t, "cog1", f.AccountName)
					}
				}
				assert.True(t, found, "expected Public Network Access finding")
			},
		},
		{
			name: "No private endpoint is Warning",
			accounts: []*armcognitiveservices.Account{
				cogAccount("cog1", "TextAnalytics", &armcognitiveservices.AccountProperties{
					PrivateEndpointConnections: []*armcognitiveservices.PrivateEndpointConnection{},
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.CognitiveServicesFinding) {
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
			name: "No managed identity is Warning",
			accounts: []*armcognitiveservices.Account{
				cogAccount("cog1", "TextAnalytics", &armcognitiveservices.AccountProperties{}),
			},
			checkFindings: func(t *testing.T, findings []cmd.CognitiveServicesFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "No Managed Identity" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
					}
				}
				assert.True(t, found, "expected No Managed Identity finding")
			},
		},
		{
			name: "No network ACL rules is Warning",
			accounts: []*armcognitiveservices.Account{
				cogAccount("cog1", "TextAnalytics", &armcognitiveservices.AccountProperties{
					NetworkACLs: nil,
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.CognitiveServicesFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "No Network Rules" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
					}
				}
				assert.True(t, found, "expected No Network Rules finding")
			},
		},
		{
			name: "Permissive network default action is Warning",
			accounts: []*armcognitiveservices.Account{
				cogAccount("cog1", "TextAnalytics", &armcognitiveservices.AccountProperties{
					NetworkACLs: &armcognitiveservices.NetworkRuleSet{
						DefaultAction: cogNetworkAction(armcognitiveservices.NetworkRuleActionAllow),
					},
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.CognitiveServicesFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Permissive Network Default" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
					}
				}
				assert.True(t, found, "expected Permissive Network Default finding")
			},
		},
		{
			name: "Failed provisioning state is Critical",
			accounts: []*armcognitiveservices.Account{
				cogAccount("cog1", "TextAnalytics", &armcognitiveservices.AccountProperties{
					ProvisioningState: cogProvisioningState(armcognitiveservices.ProvisioningStateFailed),
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.CognitiveServicesFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Provisioning Issue" {
						found = true
						assert.Equal(t, cmd.Critical, f.Severity)
					}
				}
				assert.True(t, found, "expected Provisioning Issue finding")
			},
		},
		{
			name: "Free tier SKU (F0) is Info",
			accounts: []*armcognitiveservices.Account{
				func() *armcognitiveservices.Account {
					a := cogAccount("cog1", "TextAnalytics", &armcognitiveservices.AccountProperties{})
					a.SKU = &armcognitiveservices.SKU{Name: strPtr("F0")}
					return a
				}(),
			},
			checkFindings: func(t *testing.T, findings []cmd.CognitiveServicesFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Free Tier" {
						found = true
						assert.Equal(t, cmd.Info, f.Severity)
					}
				}
				assert.True(t, found, "expected Free Tier finding")
			},
		},
		{
			name: "Local auth enabled is Info",
			accounts: []*armcognitiveservices.Account{
				cogAccount("cog1", "TextAnalytics", &armcognitiveservices.AccountProperties{
					DisableLocalAuth: boolPtr(false),
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.CognitiveServicesFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Local Auth Enabled" {
						found = true
						assert.Equal(t, cmd.Info, f.Severity)
					}
				}
				assert.True(t, found, "expected Local Auth Enabled finding")
			},
		},
		{
			name: "Finding fields are populated",
			accounts: []*armcognitiveservices.Account{
				cogAccount("myaccount", "OpenAI", &armcognitiveservices.AccountProperties{
					PublicNetworkAccess: cogPublicAccess(armcognitiveservices.PublicNetworkAccessEnabled),
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.CognitiveServicesFinding) {
				f := findings[0]
				assert.Equal(t, "myaccount", f.AccountName)
				assert.Equal(t, "rg-test", f.ResourceGroup)
				assert.NotEmpty(t, f.Description)
				assert.NotEmpty(t, f.Recommendation)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			findings := cmd.AnalyzeCogServicesFindings(tt.accounts)
			if tt.expectedCount > 0 {
				assert.Equal(t, tt.expectedCount, len(findings))
			}
			if tt.checkFindings != nil {
				tt.checkFindings(t, findings)
			}
		})
	}
}
