package security_analyzers_test

import (
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/cosmos/armcosmos/v3"
	"github.com/chanbistec/btg-devops/cmd"
	"github.com/stretchr/testify/assert"
)

func cosmosAccount(name string, props *armcosmos.DatabaseAccountGetProperties) *armcosmos.DatabaseAccountGetResults {
	id := "/subscriptions/sub/resourceGroups/rg-test/providers/Microsoft.DocumentDB/databaseAccounts/" + name
	return &armcosmos.DatabaseAccountGetResults{
		Name:       strPtr(name),
		ID:         strPtr(id),
		Properties: props,
	}
}

func cosmosPublicAccess(v armcosmos.PublicNetworkAccess) *armcosmos.PublicNetworkAccess { return &v }
func cosmosConsistency(v armcosmos.DefaultConsistencyLevel) *armcosmos.DefaultConsistencyLevel {
	return &v
}

func TestAnalyzeCosmosDBFindings(t *testing.T) {
	tests := []struct {
		name          string
		accounts      []*armcosmos.DatabaseAccountGetResults
		expectedCount int
		checkFindings func(t *testing.T, findings []cmd.CosmosDBFinding)
	}{
		{
			name:          "Empty account list returns no findings",
			accounts:      []*armcosmos.DatabaseAccountGetResults{},
			expectedCount: 0,
		},
		{
			name: "Account with nil properties is skipped",
			accounts: []*armcosmos.DatabaseAccountGetResults{
				cosmosAccount("acc1", nil),
			},
			expectedCount: 0,
		},
		{
			name: "Public network access enabled is Warning",
			accounts: []*armcosmos.DatabaseAccountGetResults{
				cosmosAccount("acc1", &armcosmos.DatabaseAccountGetProperties{
					PublicNetworkAccess: cosmosPublicAccess(armcosmos.PublicNetworkAccessEnabled),
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.CosmosDBFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Public Network Access" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
						assert.Equal(t, "acc1", f.AccountName)
					}
				}
				assert.True(t, found, "expected Public Network Access finding")
			},
		},
		{
			name: "No IP firewall rules with public access is Warning",
			accounts: []*armcosmos.DatabaseAccountGetResults{
				cosmosAccount("acc1", &armcosmos.DatabaseAccountGetProperties{
					IPRules:             []*armcosmos.IPAddressOrRange{},
					PublicNetworkAccess: cosmosPublicAccess(armcosmos.PublicNetworkAccessEnabled),
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.CosmosDBFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "No IP Firewall Rules" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
					}
				}
				assert.True(t, found, "expected No IP Firewall Rules finding")
			},
		},
		{
			name: "No private endpoint is Warning",
			accounts: []*armcosmos.DatabaseAccountGetResults{
				cosmosAccount("acc1", &armcosmos.DatabaseAccountGetProperties{
					PrivateEndpointConnections: []*armcosmos.PrivateEndpointConnection{},
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.CosmosDBFinding) {
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
			name: "Strong consistency is Info",
			accounts: []*armcosmos.DatabaseAccountGetResults{
				cosmosAccount("acc1", &armcosmos.DatabaseAccountGetProperties{
					ConsistencyPolicy: &armcosmos.ConsistencyPolicy{
						DefaultConsistencyLevel: cosmosConsistency(armcosmos.DefaultConsistencyLevelStrong),
					},
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.CosmosDBFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Strong Consistency" {
						found = true
						assert.Equal(t, cmd.Info, f.Severity)
					}
				}
				assert.True(t, found, "expected Strong Consistency finding")
			},
		},
		{
			name: "Single region is Info",
			accounts: []*armcosmos.DatabaseAccountGetResults{
				cosmosAccount("acc1", &armcosmos.DatabaseAccountGetProperties{
					Locations: []*armcosmos.Location{{LocationName: strPtr("eastus")}},
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.CosmosDBFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Single Region" {
						found = true
						assert.Equal(t, cmd.Info, f.Severity)
					}
				}
				assert.True(t, found, "expected Single Region finding")
			},
		},
		{
			name: "Wildcard CORS is Warning",
			accounts: []*armcosmos.DatabaseAccountGetResults{
				cosmosAccount("acc1", &armcosmos.DatabaseAccountGetProperties{
					Cors: []*armcosmos.CorsPolicy{
						{AllowedOrigins: strPtr("*")},
					},
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.CosmosDBFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Wildcard CORS" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
					}
				}
				assert.True(t, found, "expected Wildcard CORS finding")
			},
		},
		{
			name: "Automatic failover disabled on multi-region account is Warning",
			accounts: []*armcosmos.DatabaseAccountGetResults{
				cosmosAccount("acc1", &armcosmos.DatabaseAccountGetProperties{
					EnableAutomaticFailover: boolPtr(false),
					Locations: []*armcosmos.Location{
						{LocationName: strPtr("eastus")},
						{LocationName: strPtr("westus")},
					},
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.CosmosDBFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Automatic Failover Disabled" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
					}
				}
				assert.True(t, found, "expected Automatic Failover Disabled finding")
			},
		},
		{
			name: "Finding fields are populated",
			accounts: []*armcosmos.DatabaseAccountGetResults{
				cosmosAccount("myaccount", &armcosmos.DatabaseAccountGetProperties{
					PublicNetworkAccess: cosmosPublicAccess(armcosmos.PublicNetworkAccessEnabled),
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.CosmosDBFinding) {
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
			findings := cmd.AnalyzeCosmosDBFindings(tt.accounts)
			if tt.expectedCount > 0 {
				assert.Equal(t, tt.expectedCount, len(findings))
			}
			if tt.checkFindings != nil {
				tt.checkFindings(t, findings)
			}
		})
	}
}
