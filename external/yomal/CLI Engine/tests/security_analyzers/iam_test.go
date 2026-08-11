package security_analyzers_test

import (
	"testing"

	"github.com/chanbistec/btg-devops/cmd"
	"github.com/stretchr/testify/assert"
)

func TestAnalyzeIAMFindings(t *testing.T) {
	subScope := "/subscriptions/test-sub-123"

	tests := []struct {
		name          string
		assignments   []cmd.ResolvedAssignment
		customRoles   []cmd.CustomRole
		expectedCount int
		checkFindings func(t *testing.T, findings []cmd.Finding)
	}{
		{
			name: "Owner at subscription scope is Critical",
			assignments: []cmd.ResolvedAssignment{
				{RoleName: "Owner", Scope: subScope, ScopeLevel: "subscription", PrincipalType: "User"},
			},
			checkFindings: func(t *testing.T, findings []cmd.Finding) {
				found := false
				for _, f := range findings {
					if f.Category == "Overprivileged" {
						found = true
						assert.Equal(t, cmd.Critical, f.Severity)
					}
				}
				assert.True(t, found, "expected Overprivileged Critical finding")
			},
		},
		{
			name: "Contributor at subscription scope is Warning",
			assignments: []cmd.ResolvedAssignment{
				{RoleName: "Contributor", Scope: subScope, ScopeLevel: "subscription", PrincipalType: "User"},
			},
			checkFindings: func(t *testing.T, findings []cmd.Finding) {
				found := false
				for _, f := range findings {
					if f.Category == "Overprivileged" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
					}
				}
				assert.True(t, found, "expected Overprivileged Warning finding")
			},
		},
		{
			name: "Reader at subscription scope has no findings",
			assignments: []cmd.ResolvedAssignment{
				{RoleName: "Reader", Scope: subScope, ScopeLevel: "subscription", PrincipalType: "User"},
			},
			// Reader is not overprivileged but User type triggers Direct User Assignment (Info)
			checkFindings: func(t *testing.T, findings []cmd.Finding) {
				for _, f := range findings {
					assert.NotEqual(t, cmd.Critical, f.Severity, "Reader should not produce Critical findings")
					assert.NotEqual(t, cmd.Warning, f.Severity, "Reader should not produce Warning findings")
				}
			},
		},
		{
			name: "ServicePrincipal with Owner at subscription scope produces extra Critical finding",
			assignments: []cmd.ResolvedAssignment{
				{RoleName: "Owner", Scope: subScope, ScopeLevel: "subscription", PrincipalType: "ServicePrincipal"},
			},
			// Overprivileged (Critical) + ServicePrincipal Overprivileged (Critical)
			expectedCount: 2,
			checkFindings: func(t *testing.T, findings []cmd.Finding) {
				assert.Equal(t, cmd.Critical, findings[0].Severity)
				assert.Equal(t, cmd.Critical, findings[1].Severity)
			},
		},
		{
			name: "More than 3 Owners at subscription scope triggers Too Many Owners Critical",
			assignments: []cmd.ResolvedAssignment{
				{RoleName: "Owner", Scope: subScope, ScopeLevel: "subscription", PrincipalType: "User", PrincipalID: "u1"},
				{RoleName: "Owner", Scope: subScope, ScopeLevel: "subscription", PrincipalType: "User", PrincipalID: "u2"},
				{RoleName: "Owner", Scope: subScope, ScopeLevel: "subscription", PrincipalType: "User", PrincipalID: "u3"},
				{RoleName: "Owner", Scope: subScope, ScopeLevel: "subscription", PrincipalType: "User", PrincipalID: "u4"},
			},
			checkFindings: func(t *testing.T, findings []cmd.Finding) {
				found := false
				for _, f := range findings {
					if f.Category == "Too Many Owners" {
						found = true
						assert.Equal(t, cmd.Critical, f.Severity)
					}
				}
				assert.True(t, found, "expected Too Many Owners finding")
			},
		},
		{
			name: "Orphaned assignment (empty PrincipalType) is Warning",
			assignments: []cmd.ResolvedAssignment{
				{RoleName: "Reader", Scope: subScope, ScopeLevel: "subscription", PrincipalType: ""},
			},
			checkFindings: func(t *testing.T, findings []cmd.Finding) {
				found := false
				for _, f := range findings {
					if f.Category == "Orphaned Assignment" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
					}
				}
				assert.True(t, found, "expected Orphaned Assignment finding")
			},
		},
		{
			name: "Direct User assignment is Info",
			assignments: []cmd.ResolvedAssignment{
				{RoleName: "Reader", Scope: subScope, ScopeLevel: "subscription", PrincipalType: "User"},
			},
			checkFindings: func(t *testing.T, findings []cmd.Finding) {
				found := false
				for _, f := range findings {
					if f.Category == "Direct User Assignment" {
						found = true
						assert.Equal(t, cmd.Info, f.Severity)
					}
				}
				assert.True(t, found, "expected Direct User Assignment finding")
			},
		},
		{
			name: "Classic admin role is Warning",
			assignments: []cmd.ResolvedAssignment{
				{RoleName: "CoAdministrator", Scope: subScope, ScopeLevel: "subscription", PrincipalType: "User"},
			},
			checkFindings: func(t *testing.T, findings []cmd.Finding) {
				found := false
				for _, f := range findings {
					if f.Category == "Classic Admin Role" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
					}
				}
				assert.True(t, found, "expected Classic Admin Role finding")
			},
		},
		{
			name:        "Overly broad custom role with wildcard is Warning",
			assignments: []cmd.ResolvedAssignment{},
			customRoles: []cmd.CustomRole{
				{Name: "SuperRole", Actions: []string{"*"}, IsOverly: true},
			},
			expectedCount: 1,
			checkFindings: func(t *testing.T, findings []cmd.Finding) {
				assert.Equal(t, cmd.Warning, findings[0].Severity)
				assert.Equal(t, "Overly Broad Custom Role", findings[0].Category)
			},
		},
		{
			name:          "Empty assignment list returns no findings",
			assignments:   []cmd.ResolvedAssignment{},
			customRoles:   []cmd.CustomRole{},
			expectedCount: 0,
		},
		{
			name: "Duplicate assignment produces Warning",
			assignments: []cmd.ResolvedAssignment{
				{PrincipalID: "pid1", RoleID: "rid1", Scope: subScope, ScopeLevel: "subscription", PrincipalType: "User", RoleName: "Reader"},
				{PrincipalID: "pid1", RoleID: "rid1", Scope: subScope, ScopeLevel: "subscription", PrincipalType: "User", RoleName: "Reader"},
			},
			checkFindings: func(t *testing.T, findings []cmd.Finding) {
				found := false
				for _, f := range findings {
					if f.Category == "Duplicate Assignment" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
					}
				}
				assert.True(t, found, "expected Duplicate Assignment finding")
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			findings := cmd.AnalyzeIAMFindings(tt.assignments, tt.customRoles, subScope)
			if tt.expectedCount > 0 {
				assert.Equal(t, tt.expectedCount, len(findings))
			}
			if tt.checkFindings != nil {
				tt.checkFindings(t, findings)
			}
		})
	}
}

func TestIAMFindingFields(t *testing.T) {
	subScope := "/subscriptions/test-sub-123"
	findings := cmd.AnalyzeIAMFindings([]cmd.ResolvedAssignment{
		{RoleName: "Owner", Scope: subScope, ScopeLevel: "subscription", PrincipalType: "User", PrincipalID: "pid-abc"},
	}, nil, subScope)

	assert.Greater(t, len(findings), 0)
	f := findings[0]
	assert.NotEmpty(t, f.Category)
	assert.NotEmpty(t, f.Description)
	assert.NotEmpty(t, f.Recommendation)
	assert.NotEmpty(t, f.Severity)
}
