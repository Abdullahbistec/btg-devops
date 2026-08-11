package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/authorization/armauthorization/v2"
	"github.com/spf13/cobra"
)

// ---------- data types ----------

type Severity string

const (
	Critical Severity = "Critical"
	Warning  Severity = "Warning"
	Info     Severity = "Info"
)

type Finding struct {
	Severity       Severity `json:"severity"`
	Category       string   `json:"category"`
	Description    string   `json:"description"`
	Principal      string   `json:"principal,omitempty"`
	PrincipalType  string   `json:"principal_type,omitempty"`
	Role           string   `json:"role,omitempty"`
	Scope          string   `json:"scope,omitempty"`
	Recommendation string   `json:"recommendation"`
}

type IAMSummary struct {
	TotalAssignments   int            `json:"total_assignments"`
	ByRoleType         map[string]int `json:"by_role_type"`
	ByScopeLevel       map[string]int `json:"by_scope_level"`
	CustomRolesCount   int            `json:"custom_roles_count"`
	FindingsBySeverity map[string]int `json:"findings_by_severity"`
}

type IAMReport struct {
	Summary     IAMSummary   `json:"summary"`
	Findings    []Finding    `json:"findings"`
	CustomRoles []CustomRole `json:"custom_roles,omitempty"`
}

type CustomRole struct {
	Name        string   `json:"name"`
	ID          string   `json:"id"`
	Actions     []string `json:"actions,omitempty"`
	DataActions []string `json:"data_actions,omitempty"`
	IsOverly    bool     `json:"is_overly_broad"`
}

// ---------- resolved assignment ----------

type resolvedAssignment = ResolvedAssignment

// ResolvedAssignment is an exported alias used for testing.
type ResolvedAssignment struct {
	AssignmentID  string
	PrincipalID   string
	PrincipalType string
	RoleName      string
	RoleID        string
	Scope         string
	ScopeLevel    string // "subscription", "resourceGroup", "resource", "managementGroup"
}

// ---------- command ----------

var iamCmd = &cobra.Command{
	Use:   "iam",
	Short: "Analyze IAM (RBAC) role assignments for security issues and best practices",
	Long:  "Lists all role assignments in the subscription and identifies overprivileged, orphaned, duplicate, and misconfigured assignments.",
	RunE:  runIAM,
}

func init() {
	analyzeCmd.AddCommand(iamCmd)
	iamCmd.Flags().StringVar(&flagSubscriptionID, "subscription-id", "", "Azure Subscription ID (overrides AZURE_SUBSCRIPTION_ID env var)")
	iamCmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
}

func runIAM(_ *cobra.Command, _ []string) error {
	ctx := context.Background()
	subID := getSubscriptionID()
	if subID == "" {
		return fmt.Errorf("subscription ID required: set --subscription-id or AZURE_SUBSCRIPTION_ID env var")
	}

	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("azure auth failed: %w", err)
	}

	// Clients
	raClient, err := armauthorization.NewRoleAssignmentsClient(subID, cred, nil)
	if err != nil {
		return fmt.Errorf("creating role assignments client: %w", err)
	}
	rdClient, err := armauthorization.NewRoleDefinitionsClient(cred, nil)
	if err != nil {
		return fmt.Errorf("creating role definitions client: %w", err)
	}

	subScope := fmt.Sprintf("/subscriptions/%s", subID)

	// 1. Fetch all role assignments
	fmt.Fprintf(os.Stderr, "Fetching role assignments for subscription %s...\n", subID)
	var rawAssignments []*armauthorization.RoleAssignment
	pager := raClient.NewListForSubscriptionPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("listing role assignments: %w", err)
		}
		rawAssignments = append(rawAssignments, page.Value...)
	}
	fmt.Fprintf(os.Stderr, "Found %d role assignment(s). Resolving role names...\n", len(rawAssignments))

	// 2. Build role definition cache
	roleCache := map[string]string{} // roleDefID -> roleName
	rdPager := rdClient.NewListPager(subScope, nil)
	for rdPager.More() {
		page, err := rdPager.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("listing role definitions: %w", err)
		}
		for _, rd := range page.Value {
			if rd.ID != nil && rd.Properties != nil && rd.Properties.RoleName != nil {
				roleCache[*rd.ID] = *rd.Properties.RoleName
			}
		}
	}

	// 3. Fetch custom role definitions for analysis
	fmt.Fprintf(os.Stderr, "Checking custom role definitions...\n")
	var customRoles []CustomRole
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
			cr := CustomRole{
				Name: deref(rd.Properties.RoleName),
				ID:   deref(rd.ID),
			}
			if rd.Properties.Permissions != nil {
				for _, p := range rd.Properties.Permissions {
					if p.Actions != nil {
						for _, a := range p.Actions {
							if a != nil {
								cr.Actions = append(cr.Actions, *a)
							}
						}
					}
					if p.DataActions != nil {
						for _, a := range p.DataActions {
							if a != nil {
								cr.DataActions = append(cr.DataActions, *a)
							}
						}
					}
				}
			}
			// Check if overly broad
			for _, a := range cr.Actions {
				if a == "*" {
					cr.IsOverly = true
				}
			}
			customRoles = append(customRoles, cr)
		}
	}

	// 4. Resolve assignments
	var assignments []resolvedAssignment
	for _, ra := range rawAssignments {
		if ra.Properties == nil {
			continue
		}
		roleDefID := deref(ra.Properties.RoleDefinitionID)
		roleName := roleCache[roleDefID]
		if roleName == "" {
			roleName = lastSegment(roleDefID)
		}
		scope := deref(ra.Properties.Scope)
		a := resolvedAssignment{
			AssignmentID:  deref(ra.ID),
			PrincipalID:   deref(ra.Properties.PrincipalID),
			PrincipalType: string(derefPT(ra.Properties.PrincipalType)),
			RoleName:      roleName,
			RoleID:        roleDefID,
			Scope:         scope,
			ScopeLevel:    classifyScope(scope, subScope),
		}
		assignments = append(assignments, a)
	}

	// 5. Analyze
	var findings []Finding

	// Track counts
	summary := IAMSummary{
		TotalAssignments:   len(assignments),
		ByRoleType:         map[string]int{},
		ByScopeLevel:       map[string]int{},
		CustomRolesCount:   len(customRoles),
		FindingsBySeverity: map[string]int{},
	}
	for _, a := range assignments {
		summary.ByRoleType[a.RoleName]++
		summary.ByScopeLevel[a.ScopeLevel]++
	}

	// --- Checks ---

	// 5a. Overprivileged: Owner/Contributor at subscription level
	subOwnerCount := 0
	for _, a := range assignments {
		if a.ScopeLevel != "subscription" {
			continue
		}
		if a.RoleName == "Owner" || a.RoleName == "Contributor" {
			sev := Warning
			if a.RoleName == "Owner" {
				sev = Critical
				subOwnerCount++
			}
			findings = append(findings, Finding{
				Severity:       sev,
				Category:       "Overprivileged",
				Description:    fmt.Sprintf("%s role assigned at subscription scope", a.RoleName),
				Principal:      a.PrincipalID,
				PrincipalType:  a.PrincipalType,
				Role:           a.RoleName,
				Scope:          a.Scope,
				Recommendation: fmt.Sprintf("Reduce scope to resource group level or use PIM/JIT for %s access.", a.RoleName),
			})
		}
		// SP with Owner/Contributor at sub level
		if (a.RoleName == "Owner" || a.RoleName == "Contributor") && a.PrincipalType == "ServicePrincipal" {
			findings = append(findings, Finding{
				Severity:       Critical,
				Category:       "ServicePrincipal Overprivileged",
				Description:    fmt.Sprintf("Service Principal has %s at subscription scope", a.RoleName),
				Principal:      a.PrincipalID,
				PrincipalType:  a.PrincipalType,
				Role:           a.RoleName,
				Scope:          a.Scope,
				Recommendation: "Limit Service Principal roles to least-privilege at resource group scope.",
			})
		}
	}

	// Too many Owners
	if subOwnerCount > 3 {
		findings = append(findings, Finding{
			Severity:       Critical,
			Category:       "Too Many Owners",
			Description:    fmt.Sprintf("%d Owner assignments at subscription scope (recommended max: 3)", subOwnerCount),
			Recommendation: "Reduce the number of Owner assignments. Use Contributor or custom roles with JIT elevation.",
		})
	}

	// 5b. Orphaned assignments (Unknown principal type)
	for _, a := range assignments {
		if a.PrincipalType == "Unknown" || a.PrincipalType == "" {
			findings = append(findings, Finding{
				Severity:       Warning,
				Category:       "Orphaned Assignment",
				Description:    "Role assignment references a principal that no longer exists (deleted user/SP/group)",
				Principal:      a.PrincipalID,
				PrincipalType:  a.PrincipalType,
				Role:           a.RoleName,
				Scope:          a.Scope,
				Recommendation: "Remove this orphaned role assignment.",
			})
		}
	}

	// 5c. Duplicate assignments
	type dupKey struct {
		PrincipalID string
		RoleID      string
		Scope       string
	}
	seen := map[dupKey]int{}
	for _, a := range assignments {
		k := dupKey{a.PrincipalID, a.RoleID, a.Scope}
		seen[k]++
	}
	for k, count := range seen {
		if count > 1 {
			findings = append(findings, Finding{
				Severity:       Warning,
				Category:       "Duplicate Assignment",
				Description:    fmt.Sprintf("Principal %s has %d identical role assignments at same scope", k.PrincipalID, count),
				Principal:      k.PrincipalID,
				Scope:          k.Scope,
				Recommendation: "Remove duplicate role assignments.",
			})
		}
	}

	// 5d. Direct user assignments (should use groups)
	for _, a := range assignments {
		if a.PrincipalType == "User" {
			findings = append(findings, Finding{
				Severity:       Info,
				Category:       "Direct User Assignment",
				Description:    "Role assigned directly to a user instead of a group",
				Principal:      a.PrincipalID,
				PrincipalType:  a.PrincipalType,
				Role:           a.RoleName,
				Scope:          a.Scope,
				Recommendation: "Use Azure AD groups for role assignments to simplify management.",
			})
		}
	}

	// 5e. Classic admin roles
	classicRoles := map[string]bool{
		"CoAdministrator":       true,
		"Service Administrator": true,
		"Account Administrator": true,
	}
	for _, a := range assignments {
		if classicRoles[a.RoleName] {
			findings = append(findings, Finding{
				Severity:       Warning,
				Category:       "Classic Admin Role",
				Description:    fmt.Sprintf("Classic admin role '%s' still in use", a.RoleName),
				Principal:      a.PrincipalID,
				PrincipalType:  a.PrincipalType,
				Role:           a.RoleName,
				Scope:          a.Scope,
				Recommendation: "Migrate from classic admin roles to Azure RBAC roles.",
			})
		}
	}

	// 5f. Custom roles that are overly broad
	for _, cr := range customRoles {
		if cr.IsOverly {
			findings = append(findings, Finding{
				Severity:       Warning,
				Category:       "Overly Broad Custom Role",
				Description:    fmt.Sprintf("Custom role '%s' has wildcard (*) actions", cr.Name),
				Role:           cr.Name,
				Recommendation: "Restrict custom role permissions to specific actions needed.",
			})
		}
	}

	// Severity counts
	for _, f := range findings {
		summary.FindingsBySeverity[string(f.Severity)]++
	}

	report := IAMReport{
		Summary:     summary,
		Findings:    findings,
		CustomRoles: customRoles,
	}

	// Output
	switch flagOutput {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	default:
		printIAMTable(report)
	}

	return nil
}

func printIAMTable(r IAMReport) {
	fmt.Println()
	fmt.Println("IAM (RBAC) ANALYSIS")
	fmt.Println(strings.Repeat("=", 100))
	fmt.Println()

	// Summary
	fmt.Println("SUMMARY")
	fmt.Println(strings.Repeat("-", 50))
	fmt.Printf("  Total Role Assignments: %d\n", r.Summary.TotalAssignments)
	fmt.Println()
	fmt.Println("  By Role:")
	for role, count := range r.Summary.ByRoleType {
		fmt.Printf("    %-30s %d\n", role, count)
	}
	fmt.Println()
	fmt.Println("  By Scope Level:")
	for scope, count := range r.Summary.ByScopeLevel {
		fmt.Printf("    %-20s %d\n", scope, count)
	}
	fmt.Printf("\n  Custom Roles: %d\n", r.Summary.CustomRolesCount)
	fmt.Println()

	// Custom Roles
	if len(r.CustomRoles) > 0 {
		fmt.Println("CUSTOM ROLES")
		fmt.Println(strings.Repeat("-", 50))
		for _, cr := range r.CustomRoles {
			broad := ""
			if cr.IsOverly {
				broad = " ⚠️  OVERLY BROAD"
			}
			fmt.Printf("  • %s%s\n", cr.Name, broad)
			if len(cr.Actions) > 0 {
				fmt.Printf("    Actions: %s\n", strings.Join(cr.Actions, ", "))
			}
		}
		fmt.Println()
	}

	// Findings by severity
	fmt.Println("FINDINGS")
	fmt.Println(strings.Repeat("-", 50))
	fmt.Printf("  Critical: %d  |  Warning: %d  |  Info: %d\n",
		r.Summary.FindingsBySeverity["Critical"],
		r.Summary.FindingsBySeverity["Warning"],
		r.Summary.FindingsBySeverity["Info"])
	fmt.Println()

	if len(r.Findings) == 0 {
		fmt.Println("  No issues found. 🎉")
		return
	}

	// Table of findings
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "SEVERITY\tCATEGORY\tROLE\tPRINCIPAL TYPE\tPRINCIPAL ID\tDESCRIPTION\t")
	fmt.Fprintln(w, "--------\t--------\t----\t--------------\t------------\t-----------\t")
	for _, f := range r.Findings {
		pid := f.Principal
		if len(pid) > 12 {
			pid = pid[:12] + "..."
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\t\n",
			f.Severity, f.Category, f.Role, f.PrincipalType, pid, f.Description)
	}
	w.Flush()

	// Recommendations
	fmt.Println()
	fmt.Println("RECOMMENDATIONS")
	fmt.Println(strings.Repeat("-", 50))
	printed := map[string]bool{}
	for _, f := range r.Findings {
		key := f.Category + f.Recommendation
		if printed[key] {
			continue
		}
		printed[key] = true
		icon := "ℹ️"
		switch f.Severity {
		case Critical:
			icon = "🔴"
		case Warning:
			icon = "🟡"
		}
		fmt.Printf("  %s [%s] %s: %s\n", icon, f.Severity, f.Category, f.Recommendation)
	}
	fmt.Println()
}

// helpers

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func derefPT(pt *armauthorization.PrincipalType) armauthorization.PrincipalType {
	if pt == nil {
		return ""
	}
	return *pt
}

func lastSegment(s string) string {
	parts := strings.Split(s, "/")
	return parts[len(parts)-1]
}

// AnalyzeIAMFindings runs the IAM checks on pre-fetched data — no Azure calls.
func AnalyzeIAMFindings(assignments []ResolvedAssignment, customRoles []CustomRole, _ string) []Finding {
	var findings []Finding

	subOwnerCount := 0
	for _, a := range assignments {
		if a.ScopeLevel != "subscription" {
			continue
		}
		if a.RoleName == "Owner" || a.RoleName == "Contributor" {
			sev := Warning
			if a.RoleName == "Owner" {
				sev = Critical
				subOwnerCount++
			}
			findings = append(findings, Finding{
				Severity:       sev,
				Category:       "Overprivileged",
				Description:    fmt.Sprintf("%s role assigned at subscription scope", a.RoleName),
				Principal:      a.PrincipalID,
				PrincipalType:  a.PrincipalType,
				Role:           a.RoleName,
				Scope:          a.Scope,
				Recommendation: fmt.Sprintf("Reduce scope to resource group level or use PIM/JIT for %s access.", a.RoleName),
			})
		}
		if (a.RoleName == "Owner" || a.RoleName == "Contributor") && a.PrincipalType == "ServicePrincipal" {
			findings = append(findings, Finding{
				Severity:       Critical,
				Category:       "ServicePrincipal Overprivileged",
				Description:    fmt.Sprintf("Service Principal has %s at subscription scope", a.RoleName),
				Principal:      a.PrincipalID,
				PrincipalType:  a.PrincipalType,
				Role:           a.RoleName,
				Scope:          a.Scope,
				Recommendation: "Limit Service Principal roles to least-privilege at resource group scope.",
			})
		}
	}

	if subOwnerCount > 3 {
		findings = append(findings, Finding{
			Severity:       Critical,
			Category:       "Too Many Owners",
			Description:    fmt.Sprintf("%d Owner assignments at subscription scope (recommended max: 3)", subOwnerCount),
			Recommendation: "Reduce the number of Owner assignments. Use Contributor or custom roles with JIT elevation.",
		})
	}

	for _, a := range assignments {
		if a.PrincipalType == "Unknown" || a.PrincipalType == "" {
			findings = append(findings, Finding{
				Severity:       Warning,
				Category:       "Orphaned Assignment",
				Description:    "Role assignment references a principal that no longer exists (deleted user/SP/group)",
				Principal:      a.PrincipalID,
				PrincipalType:  a.PrincipalType,
				Role:           a.RoleName,
				Scope:          a.Scope,
				Recommendation: "Remove this orphaned role assignment.",
			})
		}
	}

	type dupKey struct {
		PrincipalID string
		RoleID      string
		Scope       string
	}
	seen := map[dupKey]int{}
	for _, a := range assignments {
		k := dupKey{a.PrincipalID, a.RoleID, a.Scope}
		seen[k]++
	}
	for k, count := range seen {
		if count > 1 {
			findings = append(findings, Finding{
				Severity:       Warning,
				Category:       "Duplicate Assignment",
				Description:    fmt.Sprintf("Principal %s has %d identical role assignments at same scope", k.PrincipalID, count),
				Principal:      k.PrincipalID,
				Scope:          k.Scope,
				Recommendation: "Remove duplicate role assignments.",
			})
		}
	}

	for _, a := range assignments {
		if a.PrincipalType == "User" {
			findings = append(findings, Finding{
				Severity:       Info,
				Category:       "Direct User Assignment",
				Description:    "Role assigned directly to a user instead of a group",
				Principal:      a.PrincipalID,
				PrincipalType:  a.PrincipalType,
				Role:           a.RoleName,
				Scope:          a.Scope,
				Recommendation: "Use Azure AD groups for role assignments to simplify management.",
			})
		}
	}

	classicRoles := map[string]bool{
		"CoAdministrator":       true,
		"Service Administrator": true,
		"Account Administrator": true,
	}
	for _, a := range assignments {
		if classicRoles[a.RoleName] {
			findings = append(findings, Finding{
				Severity:       Warning,
				Category:       "Classic Admin Role",
				Description:    fmt.Sprintf("Classic admin role '%s' still in use", a.RoleName),
				Principal:      a.PrincipalID,
				PrincipalType:  a.PrincipalType,
				Role:           a.RoleName,
				Scope:          a.Scope,
				Recommendation: "Migrate from classic admin roles to Azure RBAC roles.",
			})
		}
	}

	for _, cr := range customRoles {
		if cr.IsOverly {
			findings = append(findings, Finding{
				Severity:       Warning,
				Category:       "Overly Broad Custom Role",
				Description:    fmt.Sprintf("Custom role '%s' has wildcard (*) actions", cr.Name),
				Role:           cr.Name,
				Recommendation: "Restrict custom role permissions to specific actions needed.",
			})
		}
	}

	return findings
}

func classifyScope(scope, subScope string) string {
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
