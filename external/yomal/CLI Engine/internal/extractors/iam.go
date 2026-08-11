package extractors

import (
	"context"
	"fmt"
	"strings"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/authorization/armauthorization/v2"
)

// IAMAssignment is a clean, resolved role assignment — principal ID, role name,
// scope, and scope level are all human-readable without the raw ARM noise.
type IAMAssignment struct {
	PrincipalID   string `json:"principal_id"`
	PrincipalType string `json:"principal_type"`
	RoleName      string `json:"role_name"`
	RoleID        string `json:"role_id"`
	Scope         string `json:"scope"`
	ScopeLevel    string `json:"scope_level"` // subscription | resourceGroup | resource | managementGroup
}

// IAMCustomRole is a clean representation of a custom role definition.
type IAMCustomRole struct {
	Name        string   `json:"name"`
	RoleID      string   `json:"role_id"`
	Actions     []string `json:"actions,omitempty"`
	DataActions []string `json:"data_actions,omitempty"`
	OverlyBroad bool     `json:"overly_broad"`
}

// IAMData holds all clean IAM data for the subscription.
type IAMData struct {
	TotalAssignments int             `json:"total_assignments"`
	Assignments      []IAMAssignment `json:"assignments"`
	CustomRoles      []IAMCustomRole `json:"custom_roles"`
}

// ExtractIAM fetches all role assignments and custom role definitions,
// resolves role names, and returns clean structured data.
func ExtractIAM(ctx context.Context, subID string, cred azcore.TokenCredential) (*IAMData, error) {
	raClient, err := armauthorization.NewRoleAssignmentsClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating role assignments client: %w", err)
	}

	rdClient, err := armauthorization.NewRoleDefinitionsClient(cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating role definitions client: %w", err)
	}

	subScope := fmt.Sprintf("/subscriptions/%s", subID)

	// 1. Fetch all raw role assignments
	var rawAssignments []*armauthorization.RoleAssignment
	pager := raClient.NewListForSubscriptionPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("listing role assignments: %w", err)
		}
		rawAssignments = append(rawAssignments, page.Value...)
	}

	// 2. Build role name cache (roleDefID → roleName)
	roleCache := map[string]string{}
	rdPager := rdClient.NewListPager(subScope, nil)
	for rdPager.More() {
		page, err := rdPager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("listing role definitions: %w", err)
		}
		for _, rd := range page.Value {
			if rd.ID != nil && rd.Properties != nil && rd.Properties.RoleName != nil {
				roleCache[*rd.ID] = *rd.Properties.RoleName
			}
		}
	}

	// 3. Fetch custom roles
	var customRoles []IAMCustomRole
	rdPager2 := rdClient.NewListPager(subScope, nil)
	for rdPager2.More() {
		page, err := rdPager2.NextPage(ctx)
		if err != nil {
			break
		}
		for _, rd := range page.Value {
			if rd.Properties == nil || rd.Properties.RoleType == nil {
				continue
			}
			if *rd.Properties.RoleType != "CustomRole" {
				continue
			}
			cr := IAMCustomRole{
				Name:   derefStr(rd.Properties.RoleName),
				RoleID: derefStr(rd.ID),
			}
			for _, p := range rd.Properties.Permissions {
				for _, a := range p.Actions {
					if a != nil {
						cr.Actions = append(cr.Actions, *a)
						if *a == "*" {
							cr.OverlyBroad = true
						}
					}
				}
				for _, a := range p.DataActions {
					if a != nil {
						cr.DataActions = append(cr.DataActions, *a)
					}
				}
			}
			customRoles = append(customRoles, cr)
		}
	}

	// 4. Resolve assignments to clean structs
	assignments := make([]IAMAssignment, 0, len(rawAssignments))
	for _, ra := range rawAssignments {
		if ra.Properties == nil {
			continue
		}
		roleDefID := derefStr(ra.Properties.RoleDefinitionID)
		roleName := roleCache[roleDefID]
		if roleName == "" {
			roleName = lastPart(roleDefID)
		}
		scope := derefStr(ra.Properties.Scope)
		principalType := ""
		if ra.Properties.PrincipalType != nil {
			principalType = string(*ra.Properties.PrincipalType)
		}
		assignments = append(assignments, IAMAssignment{
			PrincipalID:   derefStr(ra.Properties.PrincipalID),
			PrincipalType: principalType,
			RoleName:      roleName,
			RoleID:        roleDefID,
			Scope:         scope,
			ScopeLevel:    classifyScopeLevel(scope, subScope),
		})
	}

	return &IAMData{
		TotalAssignments: len(assignments),
		Assignments:      assignments,
		CustomRoles:      customRoles,
	}, nil
}

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func lastPart(s string) string {
	parts := strings.Split(s, "/")
	return parts[len(parts)-1]
}

func classifyScopeLevel(scope, subScope string) string {
	s := strings.ToLower(scope)
	sub := strings.ToLower(subScope)
	switch {
	case s == sub:
		return "subscription"
	case strings.Contains(s, "/resourcegroups/") && strings.Count(s, "/") <= 5:
		return "resourceGroup"
	case strings.Contains(s, "/providers/microsoft.management/managementgroups/"):
		return "managementGroup"
	case strings.Contains(s, "/resourcegroups/"):
		return "resource"
	default:
		return "other"
	}
}
