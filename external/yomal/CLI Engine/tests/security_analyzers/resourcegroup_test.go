package security_analyzers_test

import (
	"testing"

	"github.com/chanbistec/btg-devops/cmd"
	"github.com/stretchr/testify/assert"
)

func rg(name, location string, tags map[string]*string, isEmpty, hasLock bool) cmd.RGInput {
	return cmd.RGInput{
		Name:     name,
		Location: location,
		Tags:     tags,
		IsEmpty:  isEmpty,
		HasLock:  hasLock,
	}
}

func tagMap(pairs ...string) map[string]*string {
	m := map[string]*string{}
	for i := 0; i+1 < len(pairs); i += 2 {
		v := pairs[i+1]
		m[pairs[i]] = &v
	}
	return m
}

func TestAnalyzeRGFindings(t *testing.T) {
	tests := []struct {
		name          string
		rgs           []cmd.RGInput
		expectedCount int
		checkFindings func(t *testing.T, findings []cmd.RGFinding)
	}{
		{
			name:          "Empty RG list returns no findings",
			rgs:           []cmd.RGInput{},
			expectedCount: 0,
		},
		{
			name: "Empty resource group is Warning",
			rgs: []cmd.RGInput{
				rg("rg-empty", "eastus", tagMap("environment", "dev", "owner", "team", "project", "myproject"), true, true),
			},
			checkFindings: func(t *testing.T, findings []cmd.RGFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Empty Resource Group" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
						assert.Equal(t, "rg-empty", f.ResourceGroup)
					}
				}
				assert.True(t, found, "expected Empty Resource Group finding")
			},
		},
		{
			name: "RG with no tags at all is Critical",
			rgs: []cmd.RGInput{
				rg("rg-notags", "eastus", map[string]*string{}, false, true),
			},
			checkFindings: func(t *testing.T, findings []cmd.RGFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Tag Compliance" {
						found = true
						assert.Equal(t, cmd.Critical, f.Severity)
					}
				}
				assert.True(t, found, "expected Tag Compliance Critical finding for no tags")
			},
		},
		{
			name: "RG missing some required tags is Warning",
			rgs: []cmd.RGInput{
				rg("rg-partialtags", "eastus", tagMap("environment", "dev"), false, true),
			},
			checkFindings: func(t *testing.T, findings []cmd.RGFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Tag Compliance" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
						assert.Contains(t, f.Description, "missing tags")
					}
				}
				assert.True(t, found, "expected Tag Compliance Warning finding")
			},
		},
		{
			name: "RG with all required tags has no tag finding",
			rgs: []cmd.RGInput{
				rg("rg-compliant", "eastus", tagMap("environment", "prod", "owner", "team", "project", "myproject"), false, true),
			},
			checkFindings: func(t *testing.T, findings []cmd.RGFinding) {
				for _, f := range findings {
					assert.NotEqual(t, "Tag Compliance", f.Category)
				}
			},
		},
		{
			name: "RG with uppercase naming violations is Info",
			rgs: []cmd.RGInput{
				rg("MyResourceGroup_With_Underscores_123!", "eastus",
					tagMap("environment", "dev", "owner", "t", "project", "p"), false, true),
			},
			checkFindings: func(t *testing.T, findings []cmd.RGFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Naming Convention" {
						found = true
						assert.Equal(t, cmd.Info, f.Severity)
					}
				}
				assert.True(t, found, "expected Naming Convention finding")
			},
		},
		{
			name: "RG with lowercase hyphen name has no naming finding",
			rgs: []cmd.RGInput{
				rg("rg-my-project-dev", "eastus",
					tagMap("environment", "dev", "owner", "team", "project", "proj"), false, true),
			},
			checkFindings: func(t *testing.T, findings []cmd.RGFinding) {
				for _, f := range findings {
					assert.NotEqual(t, "Naming Convention", f.Category)
				}
			},
		},
		{
			name: "Non-empty RG without lock is Info",
			rgs: []cmd.RGInput{
				rg("rg-nolock", "eastus",
					tagMap("environment", "dev", "owner", "t", "project", "p"), false, false),
			},
			checkFindings: func(t *testing.T, findings []cmd.RGFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Missing Lock" {
						found = true
						assert.Equal(t, cmd.Info, f.Severity)
					}
				}
				assert.True(t, found, "expected Missing Lock finding")
			},
		},
		{
			name: "Empty RG without lock does not flag Missing Lock",
			rgs: []cmd.RGInput{
				rg("rg-empty-nolock", "eastus",
					tagMap("environment", "dev", "owner", "t", "project", "p"), true, false),
			},
			checkFindings: func(t *testing.T, findings []cmd.RGFinding) {
				for _, f := range findings {
					assert.NotEqual(t, "Missing Lock", f.Category, "empty RG should not require a lock")
				}
			},
		},
		{
			name: "Finding fields are populated",
			rgs: []cmd.RGInput{
				rg("rg-test", "westus", map[string]*string{}, false, true),
			},
			checkFindings: func(t *testing.T, findings []cmd.RGFinding) {
				assert.Greater(t, len(findings), 0)
				f := findings[0]
				assert.Equal(t, "rg-test", f.ResourceGroup)
				assert.NotEmpty(t, f.Description)
				assert.NotEmpty(t, f.Recommendation)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			findings := cmd.AnalyzeRGFindings(tt.rgs)
			if tt.expectedCount > 0 {
				assert.Equal(t, tt.expectedCount, len(findings))
			}
			if tt.checkFindings != nil {
				tt.checkFindings(t, findings)
			}
		})
	}
}
