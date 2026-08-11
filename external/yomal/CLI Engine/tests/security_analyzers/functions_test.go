package security_analyzers_test

import (
	"testing"

	"github.com/chanbistec/btg-devops/cmd"
	"github.com/stretchr/testify/assert"
)

func funcApp(name string) cmd.FunctionAppInput {
	return cmd.FunctionAppInput{
		Name:               name,
		ResourceGroup:      "rg-test",
		State:              "Running",
		HTTPSOnly:          true,
		HasManagedIdentity: true,
		ExtensionVersion:   "~4",
	}
}

func TestAnalyzeFunctionsData(t *testing.T) {
	tests := []struct {
		name          string
		apps          []cmd.FunctionAppInput
		expectedCount int
		checkFindings func(t *testing.T, findings []cmd.FunctionsFinding)
	}{
		{
			name:          "Empty app list returns no findings",
			apps:          []cmd.FunctionAppInput{},
			expectedCount: 0,
		},
		{
			name: "HTTPS not enabled is Warning",
			apps: []cmd.FunctionAppInput{
				{Name: "fn1", ResourceGroup: "rg", State: "Running", HTTPSOnly: false, HasManagedIdentity: true, ExtensionVersion: "~4"},
			},
			checkFindings: func(t *testing.T, findings []cmd.FunctionsFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "HTTPS Not Enforced" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
						assert.Equal(t, "fn1", f.FunctionApp)
					}
				}
				assert.True(t, found, "expected HTTPS Not Enforced finding")
			},
		},
		{
			name: "No managed identity is Warning",
			apps: []cmd.FunctionAppInput{
				{Name: "fn1", ResourceGroup: "rg", State: "Running", HTTPSOnly: true, HasManagedIdentity: false, ExtensionVersion: "~4"},
			},
			checkFindings: func(t *testing.T, findings []cmd.FunctionsFinding) {
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
			name: "Extension version v1 is Critical",
			apps: []cmd.FunctionAppInput{
				{Name: "fn1", ResourceGroup: "rg", State: "Running", HTTPSOnly: true, HasManagedIdentity: true, ExtensionVersion: "~1"},
			},
			checkFindings: func(t *testing.T, findings []cmd.FunctionsFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Outdated Runtime Version" {
						found = true
						assert.Equal(t, cmd.Critical, f.Severity)
					}
				}
				assert.True(t, found, "expected Outdated Runtime Version Critical finding")
			},
		},
		{
			name: "Extension version v3 is Warning",
			apps: []cmd.FunctionAppInput{
				{Name: "fn1", ResourceGroup: "rg", State: "Running", HTTPSOnly: true, HasManagedIdentity: true, ExtensionVersion: "~3"},
			},
			checkFindings: func(t *testing.T, findings []cmd.FunctionsFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Outdated Runtime Version" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
					}
				}
				assert.True(t, found, "expected Outdated Runtime Version Warning finding")
			},
		},
		{
			name: "Extension version v4 does not flag outdated runtime",
			apps: []cmd.FunctionAppInput{
				funcApp("fn1"),
			},
			checkFindings: func(t *testing.T, findings []cmd.FunctionsFinding) {
				for _, f := range findings {
					assert.NotEqual(t, "Outdated Runtime Version", f.Category)
				}
			},
		},
		{
			name: "Remote debugging enabled is Critical",
			apps: []cmd.FunctionAppInput{
				{Name: "fn1", ResourceGroup: "rg", State: "Running", HTTPSOnly: true, HasManagedIdentity: true, ExtensionVersion: "~4", RemoteDebuggingEnabled: true},
			},
			checkFindings: func(t *testing.T, findings []cmd.FunctionsFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Remote Debugging Enabled" {
						found = true
						assert.Equal(t, cmd.Critical, f.Severity)
					}
				}
				assert.True(t, found, "expected Remote Debugging Enabled finding")
			},
		},
		{
			name: "FTP allowed is Warning",
			apps: []cmd.FunctionAppInput{
				{Name: "fn1", ResourceGroup: "rg", State: "Running", HTTPSOnly: true, HasManagedIdentity: true, ExtensionVersion: "~4", FtpsState: "AllAllowed"},
			},
			checkFindings: func(t *testing.T, findings []cmd.FunctionsFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "FTP Allowed" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
					}
				}
				assert.True(t, found, "expected FTP Allowed finding")
			},
		},
		{
			name: "Consumption plan is Info",
			apps: []cmd.FunctionAppInput{
				{Name: "fn1", ResourceGroup: "rg", State: "Running", HTTPSOnly: true, HasManagedIdentity: true, ExtensionVersion: "~4", IsConsumptionPlan: true},
			},
			checkFindings: func(t *testing.T, findings []cmd.FunctionsFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Consumption Plan" {
						found = true
						assert.Equal(t, cmd.Info, f.Severity)
					}
				}
				assert.True(t, found, "expected Consumption Plan finding")
			},
		},
		{
			name: "Dedicated plan without AlwaysOn is Warning",
			apps: []cmd.FunctionAppInput{
				{Name: "fn1", ResourceGroup: "rg", State: "Running", HTTPSOnly: true, HasManagedIdentity: true, ExtensionVersion: "~4", IsConsumptionPlan: false, AlwaysOn: false},
			},
			checkFindings: func(t *testing.T, findings []cmd.FunctionsFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Always-On Disabled" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
					}
				}
				assert.True(t, found, "expected Always-On Disabled finding")
			},
		},
		{
			name: "App not running is Info",
			apps: []cmd.FunctionAppInput{
				{Name: "fn1", ResourceGroup: "rg", State: "Stopped", HTTPSOnly: true, HasManagedIdentity: true, ExtensionVersion: "~4"},
			},
			checkFindings: func(t *testing.T, findings []cmd.FunctionsFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Not Running" {
						found = true
						assert.Equal(t, cmd.Info, f.Severity)
					}
				}
				assert.True(t, found, "expected Not Running finding")
			},
		},
		{
			name: "TLS below 1.2 is Warning",
			apps: []cmd.FunctionAppInput{
				{Name: "fn1", ResourceGroup: "rg", State: "Running", HTTPSOnly: true, HasManagedIdentity: true, ExtensionVersion: "~4", MinTLSVersion: "1.0"},
			},
			checkFindings: func(t *testing.T, findings []cmd.FunctionsFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Outdated TLS Version" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
					}
				}
				assert.True(t, found, "expected Outdated TLS Version finding")
			},
		},
		{
			name: "Finding fields are populated",
			apps: []cmd.FunctionAppInput{
				{Name: "myfunc", ResourceGroup: "rg-test", State: "Running", HTTPSOnly: false, HasManagedIdentity: true, ExtensionVersion: "~4"},
			},
			checkFindings: func(t *testing.T, findings []cmd.FunctionsFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "HTTPS Not Enforced" {
						found = true
						assert.Equal(t, "myfunc", f.FunctionApp)
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
			findings := cmd.AnalyzeFunctionsData(tt.apps)
			if tt.expectedCount > 0 {
				assert.Equal(t, tt.expectedCount, len(findings))
			}
			if tt.checkFindings != nil {
				tt.checkFindings(t, findings)
			}
		})
	}
}
