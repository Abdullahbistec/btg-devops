package cmd

import "testing"

// hasCategory reports whether findings contains at least one Finding with
// the given Category.
func hasCategory(findings []Finding, category string) bool {
	for _, f := range findings {
		if f.Category == category {
			return true
		}
	}
	return false
}

func TestAnalyzeIAMFindings_TooManyOwners(t *testing.T) {
	assignments := make([]ResolvedAssignment, 5)
	for i := range assignments {
		assignments[i] = ResolvedAssignment{
			RoleName:      "Owner",
			PrincipalType: "User",
			PrincipalID:   "user" + string(rune('A'+i)),
			Scope:         "/subscriptions/test-sub",
			ScopeLevel:    "subscription",
		}
	}

	findings := AnalyzeIAMFindings(assignments, nil, "test-sub")

	if !hasCategory(findings, "Too Many Owners") {
		t.Error("expected a Too Many Owners finding with 5 Owner assignments, got none")
	}
}

func TestAnalyzeIAMFindings_OverprivilegedOwnerAtSubscription(t *testing.T) {
	assignments := []ResolvedAssignment{
		{
			RoleName:      "Owner",
			PrincipalType: "User",
			PrincipalID:   "user1",
			Scope:         "/subscriptions/test-sub",
			ScopeLevel:    "subscription",
		},
	}

	findings := AnalyzeIAMFindings(assignments, nil, "test-sub")

	found := false
	for _, f := range findings {
		if f.Category == "Overprivileged" {
			found = true
			if f.Severity != Critical {
				t.Errorf("expected Critical severity for Owner overprivileged finding, got %s", f.Severity)
			}
		}
	}
	if !found {
		t.Error("expected an Overprivileged finding for Owner at subscription scope, got none")
	}
}

func TestAnalyzeIAMFindings_OverprivilegedContributorAtSubscription(t *testing.T) {
	assignments := []ResolvedAssignment{
		{
			RoleName:      "Contributor",
			PrincipalType: "User",
			PrincipalID:   "user1",
			Scope:         "/subscriptions/test-sub",
			ScopeLevel:    "subscription",
		},
	}

	findings := AnalyzeIAMFindings(assignments, nil, "test-sub")

	found := false
	for _, f := range findings {
		if f.Category == "Overprivileged" {
			found = true
			if f.Severity != Warning {
				t.Errorf("expected Warning severity for Contributor overprivileged finding, got %s", f.Severity)
			}
		}
	}
	if !found {
		t.Error("expected an Overprivileged finding for Contributor at subscription scope, got none")
	}
}

func TestAnalyzeIAMFindings_ServicePrincipalOverprivileged(t *testing.T) {
	assignments := []ResolvedAssignment{
		{
			RoleName:      "Owner",
			PrincipalType: "ServicePrincipal",
			PrincipalID:   "sp1",
			Scope:         "/subscriptions/test-sub",
			ScopeLevel:    "subscription",
		},
	}

	findings := AnalyzeIAMFindings(assignments, nil, "test-sub")

	if !hasCategory(findings, "ServicePrincipal Overprivileged") {
		t.Error("expected a ServicePrincipal Overprivileged finding, got none")
	}
}

func TestAnalyzeIAMFindings_OrphanedAssignment(t *testing.T) {
	assignments := []ResolvedAssignment{
		{
			RoleName:      "Reader",
			PrincipalType: "Unknown",
			PrincipalID:   "deleted-principal",
			Scope:         "/subscriptions/test-sub/resourceGroups/rg1",
			ScopeLevel:    "resourceGroup",
		},
	}

	findings := AnalyzeIAMFindings(assignments, nil, "test-sub")

	if !hasCategory(findings, "Orphaned Assignment") {
		t.Error("expected an Orphaned Assignment finding for Unknown principal type, got none")
	}
}

func TestAnalyzeIAMFindings_DuplicateAssignment(t *testing.T) {
	assignments := []ResolvedAssignment{
		{
			RoleName:      "Reader",
			RoleID:        "role1",
			PrincipalType: "User",
			PrincipalID:   "user1",
			Scope:         "/subscriptions/test-sub/resourceGroups/rg1",
			ScopeLevel:    "resourceGroup",
		},
		{
			RoleName:      "Reader",
			RoleID:        "role1",
			PrincipalType: "User",
			PrincipalID:   "user1",
			Scope:         "/subscriptions/test-sub/resourceGroups/rg1",
			ScopeLevel:    "resourceGroup",
		},
	}

	findings := AnalyzeIAMFindings(assignments, nil, "test-sub")

	if !hasCategory(findings, "Duplicate Assignment") {
		t.Error("expected a Duplicate Assignment finding for two identical assignments, got none")
	}
}

func TestAnalyzeIAMFindings_DirectUserAssignment(t *testing.T) {
	assignments := []ResolvedAssignment{
		{
			RoleName:      "Reader",
			PrincipalType: "User",
			PrincipalID:   "user1",
			Scope:         "/subscriptions/test-sub/resourceGroups/rg1",
			ScopeLevel:    "resourceGroup",
		},
	}

	findings := AnalyzeIAMFindings(assignments, nil, "test-sub")

	found := false
	for _, f := range findings {
		if f.Category == "Direct User Assignment" {
			found = true
			if f.Severity != Info {
				t.Errorf("expected Info severity for Direct User Assignment, got %s", f.Severity)
			}
		}
	}
	if !found {
		t.Error("expected a Direct User Assignment finding, got none")
	}
}

func TestAnalyzeIAMFindings_ClassicAdminRole(t *testing.T) {
	assignments := []ResolvedAssignment{
		{
			RoleName:      "CoAdministrator",
			PrincipalType: "User",
			PrincipalID:   "user1",
			Scope:         "/subscriptions/test-sub",
			ScopeLevel:    "subscription",
		},
	}

	findings := AnalyzeIAMFindings(assignments, nil, "test-sub")

	if !hasCategory(findings, "Classic Admin Role") {
		t.Error("expected a Classic Admin Role finding for CoAdministrator, got none")
	}
}

func TestAnalyzeIAMFindings_OverlyBroadCustomRole(t *testing.T) {
	customRoles := []CustomRole{
		{
			Name:     "MyCustomRole",
			ID:       "role-id-1",
			Actions:  []string{"*"},
			IsOverly: true,
		},
	}

	findings := AnalyzeIAMFindings(nil, customRoles, "test-sub")

	if !hasCategory(findings, "Overly Broad Custom Role") {
		t.Error("expected an Overly Broad Custom Role finding, got none")
	}
}

func TestAnalyzeIAMFindings_CleanNoFindings(t *testing.T) {
	assignments := []ResolvedAssignment{
		{
			RoleName:      "Reader",
			PrincipalType: "Group",
			PrincipalID:   "group1",
			Scope:         "/subscriptions/test-sub/resourceGroups/rg1",
			ScopeLevel:    "resourceGroup",
		},
	}
	customRoles := []CustomRole{
		{
			Name:     "SafeCustomRole",
			ID:       "role-id-2",
			Actions:  []string{"Microsoft.Compute/virtualMachines/read"},
			IsOverly: false,
		},
	}

	findings := AnalyzeIAMFindings(assignments, customRoles, "test-sub")

	if len(findings) != 0 {
		t.Errorf("expected no findings for a compliant group-based reader assignment and safe custom role, got %d: %+v", len(findings), findings)
	}
}
