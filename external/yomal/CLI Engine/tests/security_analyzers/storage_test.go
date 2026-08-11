package security_analyzers_test

import (
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/storage/armstorage"
	"github.com/chanbistec/btg-devops/cmd"
	"github.com/stretchr/testify/assert"
)

func storageAccount(name string, props *armstorage.AccountProperties) *armstorage.Account {
	id := "/subscriptions/sub/resourceGroups/rg-test/providers/Microsoft.Storage/storageAccounts/" + name
	return &armstorage.Account{
		Name:       strPtr(name),
		ID:         strPtr(id),
		Properties: props,
	}
}

func TestAnalyzeStorageFindings(t *testing.T) {
	tests := []struct {
		name          string
		accounts      []*armstorage.Account
		expectedCount int
		checkFindings func(t *testing.T, findings []cmd.StorageFinding)
	}{
		{
			name:          "Empty account list returns no findings",
			accounts:      []*armstorage.Account{},
			expectedCount: 0,
		},
		{
			name: "Account with nil properties is skipped",
			accounts: []*armstorage.Account{
				storageAccount("sa1", nil),
			},
			expectedCount: 0,
		},
		{
			name: "HTTPS not enforced is Critical",
			accounts: []*armstorage.Account{
				storageAccount("sa1", &armstorage.AccountProperties{
					EnableHTTPSTrafficOnly: boolPtr(false),
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.StorageFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "HTTPS Not Enforced" {
						found = true
						assert.Equal(t, cmd.Critical, f.Severity)
						assert.Equal(t, "sa1", f.StorageAccount)
					}
				}
				assert.True(t, found, "expected HTTPS Not Enforced finding")
			},
		},
		{
			name: "Blob public access enabled is Critical",
			accounts: []*armstorage.Account{
				storageAccount("sa1", &armstorage.AccountProperties{
					AllowBlobPublicAccess: boolPtr(true),
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.StorageFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Blob Public Access Enabled" {
						found = true
						assert.Equal(t, cmd.Critical, f.Severity)
					}
				}
				assert.True(t, found, "expected Blob Public Access Enabled finding")
			},
		},
		{
			name: "TLS 1.0 is Critical",
			accounts: []*armstorage.Account{
				storageAccount("sa1", &armstorage.AccountProperties{
					MinimumTLSVersion: tlsVersion(armstorage.MinimumTLSVersionTLS10),
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.StorageFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Weak TLS Version" {
						found = true
						assert.Equal(t, cmd.Critical, f.Severity)
					}
				}
				assert.True(t, found, "expected Weak TLS Version Critical finding")
			},
		},
		{
			name: "TLS 1.1 is Warning",
			accounts: []*armstorage.Account{
				storageAccount("sa1", &armstorage.AccountProperties{
					MinimumTLSVersion: tlsVersion(armstorage.MinimumTLSVersionTLS11),
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.StorageFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Weak TLS Version" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
					}
				}
				assert.True(t, found, "expected Weak TLS Version Warning finding")
			},
		},
		{
			name: "TLS 1.2 does not flag TLS finding",
			accounts: []*armstorage.Account{
				storageAccount("sa1", &armstorage.AccountProperties{
					MinimumTLSVersion: tlsVersion(armstorage.MinimumTLSVersionTLS12),
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.StorageFinding) {
				for _, f := range findings {
					assert.NotEqual(t, "Weak TLS Version", f.Category)
				}
			},
		},
		{
			name: "Unrestricted network access with no firewall is Warning",
			accounts: []*armstorage.Account{
				storageAccount("sa1", &armstorage.AccountProperties{
					PublicNetworkAccess: networkAccess(armstorage.PublicNetworkAccessEnabled),
					NetworkRuleSet: &armstorage.NetworkRuleSet{
						DefaultAction: defaultAction(armstorage.DefaultActionAllow),
					},
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.StorageFinding) {
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
			name: "Shared key access enabled is Info",
			accounts: []*armstorage.Account{
				storageAccount("sa1", &armstorage.AccountProperties{
					AllowSharedKeyAccess: boolPtr(true),
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.StorageFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Shared Key Access Enabled" {
						found = true
						assert.Equal(t, cmd.Info, f.Severity)
					}
				}
				assert.True(t, found, "expected Shared Key Access Enabled finding")
			},
		},
		{
			name: "Finding fields are populated",
			accounts: []*armstorage.Account{
				storageAccount("myaccount", &armstorage.AccountProperties{
					EnableHTTPSTrafficOnly: boolPtr(false),
				}),
			},
			checkFindings: func(t *testing.T, findings []cmd.StorageFinding) {
				f := findings[0]
				assert.NotEmpty(t, f.Category)
				assert.NotEmpty(t, f.Description)
				assert.NotEmpty(t, f.Recommendation)
				assert.Equal(t, "myaccount", f.StorageAccount)
				assert.Equal(t, "rg-test", f.ResourceGroup)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			findings := cmd.AnalyzeStorageFindings(tt.accounts)
			if tt.expectedCount > 0 {
				assert.Equal(t, tt.expectedCount, len(findings))
			}
			if tt.checkFindings != nil {
				tt.checkFindings(t, findings)
			}
		})
	}
}

func tlsVersion(v armstorage.MinimumTLSVersion) *armstorage.MinimumTLSVersion        { return &v }
func networkAccess(v armstorage.PublicNetworkAccess) *armstorage.PublicNetworkAccess { return &v }
func defaultAction(v armstorage.DefaultAction) *armstorage.DefaultAction             { return &v }
