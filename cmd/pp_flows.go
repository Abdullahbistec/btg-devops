package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/spf13/cobra"
)

// ---------- data types ----------

type PPFlowFinding struct {
	Severity       Severity `json:"severity"`
	Category       string   `json:"category"`
	FlowName       string   `json:"flow_name"`
	Environment    string   `json:"environment"`
	State          string   `json:"state"`
	Owner          string   `json:"owner"`
	Description    string   `json:"description"`
	Recommendation string   `json:"recommendation"`
}

type PPFlowSummary struct {
	TotalFlows         int            `json:"total_flows"`
	TotalEnvironments  int            `json:"total_environments"`
	ByState            map[string]int `json:"by_state"`
	FindingsBySeverity map[string]int `json:"findings_by_severity"`
}

type PPFlowReport struct {
	Summary  PPFlowSummary   `json:"summary"`
	Findings []PPFlowFinding `json:"findings"`
}

// Power Automate API types
type ppFlowsResponse struct {
	Value    []ppFlow `json:"value"`
	NextLink string   `json:"nextLink"`
}

type ppFlow struct {
	Name       string      `json:"name"`
	ID         string      `json:"id"`
	Properties ppFlowProps `json:"properties"`
}

type ppFlowProps struct {
	DisplayName       string           `json:"displayName"`
	State             string           `json:"state"`
	CreatedTime       string           `json:"createdTime"`
	LastModifiedTime  string           `json:"lastModifiedTime"`
	Creator           ppFlowCreator    `json:"creator"`
	DefinitionSummary ppFlowDefSummary `json:"definitionSummary"`
}

type ppFlowCreator struct {
	UserDisplayName string `json:"userDisplayName"`
	Email           string `json:"email"`
}

// PP-6: Definition summary contains trigger and action connector information
type ppFlowDefSummary struct {
	Triggers []ppFlowAction `json:"triggers"`
	Actions  []ppFlowAction `json:"actions"`
}

type ppFlowAction struct {
	Type string        `json:"type"`
	API  ppFlowConnAPI `json:"api"`
}

type ppFlowConnAPI struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	ID          string `json:"id"`
}

// Single-flow detail response — the V1 "get" action (not the deprecated "list"
// action) still returns connectionReferences, keyed by connector API name
// (e.g. "shared_sql"), which the V2 list response omits.
type ppFlowDetailResponse struct {
	Properties ppFlowDetailProps `json:"properties"`
}

type ppFlowDetailProps struct {
	ConnectionReferences map[string]json.RawMessage `json:"connectionReferences"`
}

// fetchFlowConnectors returns the connector API names (e.g. "shared_sql") used by
// a single flow, via the V1 single-flow get action.
func fetchFlowConnectors(ctx context.Context, token, envName, flowName string) ([]string, error) {
	url := fmt.Sprintf("%s/providers/Microsoft.ProcessSimple/scopes/admin/environments/%s/flows/%s?api-version=2016-11-01",
		ppFlowBase, envName, flowName)
	var detail ppFlowDetailResponse
	if err := ppFetch(ctx, token, url, &detail); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(detail.Properties.ConnectionReferences))
	for name := range detail.Properties.ConnectionReferences {
		names = append(names, name)
	}
	return names, nil
}

// Flow permissions API types — best-effort, unverified against live data (see
// fetchFlowPermissions).
type ppFlowPermissionsResponse struct {
	Value []ppFlowPermission `json:"value"`
}

type ppFlowPermission struct {
	Properties ppFlowPermissionProps `json:"properties"`
}

type ppFlowPermissionProps struct {
	RoleName string `json:"roleName"`
}

// ---------- command ----------

var ppFlowsCmd = &cobra.Command{
	Use:   "pp-flows",
	Short: "Analyze Power Automate flows for suspended, stale, and governance issues",
	Long: `Scans all Power Automate flows across every environment and checks for:
  - Suspended flows (broken — need immediate attention)
  - Stopped flows (manually disabled — may be abandoned)
  - Flows not modified in 180+ days (stale)
  - Flows in the Default environment (governance risk)
  - Flows with no owner display name (orphaned)

Flow states:
  Started   = Running normally
  Suspended = Suspended by the platform (errors, quota limits)
  Stopped   = Manually turned off

Requires: Power Platform Administrator role on the service principal.`,
	RunE: runPPFlows,
}

func init() {
	analyzeCmd.AddCommand(ppFlowsCmd)
	ppFlowsCmd.Flags().StringVar(&flagTenantID, "tenant-id", "", "Azure Tenant ID (overrides AZURE_TENANT_ID env var)")
	ppFlowsCmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
}

func runPPFlows(cmd *cobra.Command, args []string) error {
	ctx := context.Background()

	tenantID := getTenantID()
	if tenantID == "" {
		return fmt.Errorf("tenant ID required: set --tenant-id or AZURE_TENANT_ID env var")
	}

	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("azure auth failed: %w", err)
	}

	// Power Automate uses a different scope from Power Apps
	flowToken, err := ppToken(ctx, cred, ppFlowScope)
	if err != nil {
		return fmt.Errorf("acquiring power automate token: %w", err)
	}

	// Environments API still uses the Power Apps scope
	appsToken, err := ppToken(ctx, cred, ppAppsScope)
	if err != nil {
		return fmt.Errorf("acquiring power platform token: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Fetching Power Platform environments...\n")
	envs, err := fetchPPEnvironments(ctx, appsToken)
	if err != nil {
		return fmt.Errorf("listing environments: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Scanning Power Automate flows across %d environment(s)...\n", len(envs))

	summary := PPFlowSummary{
		TotalEnvironments:  len(envs),
		ByState:            map[string]int{},
		FindingsBySeverity: map[string]int{},
	}
	var findings []PPFlowFinding

	// Broad-sharing check (below) is best-effort: the exact admin API shape for flow
	// permissions hasn't been validated against live data. It disables itself for the
	// rest of the run on the first failure rather than erroring out the whole scan.
	sharingCheckEnabled := true

	for _, env := range envs {
		envName := ppEnvDisplayName(env)

		flows, err := fetchPPFlows(ctx, flowToken, env.Name)
		if err != nil {
			fmt.Fprintf(os.Stderr, "  Warning: could not fetch flows for '%s': %v\n", envName, err)
			continue
		}
		summary.TotalFlows += len(flows)

		for _, flow := range flows {
			flowName := flow.Properties.DisplayName
			if flowName == "" {
				flowName = flow.Name
			}
			state := flow.Properties.State
			summary.ByState[state]++

			owner := flow.Properties.Creator.Email
			if owner == "" {
				owner = flow.Properties.Creator.UserDisplayName
			}
			if owner == "" {
				owner = "(unknown)"
			}
			daysSinceMod := ppDaysSince(flow.Properties.LastModifiedTime)

			// 1. Suspended flow — platform stopped it (errors, quota)
			if strings.EqualFold(state, "Suspended") {
				findings = append(findings, PPFlowFinding{
					Severity:       Critical,
					Category:       "Suspended Flow",
					FlowName:       flowName,
					Environment:    envName,
					State:          state,
					Owner:          owner,
					Description:    fmt.Sprintf("'%s' is suspended — it is NOT running and needs attention", flowName),
					Recommendation: "Review the flow's run history for errors and fix the root cause, then re-enable.",
				})
			}

			// 2. Stopped flow — manually disabled, potentially abandoned
			if strings.EqualFold(state, "Stopped") {
				sev := Info
				if daysSinceMod >= 180 {
					sev = Warning
				}
				findings = append(findings, PPFlowFinding{
					Severity:       sev,
					Category:       "Stopped Flow",
					FlowName:       flowName,
					Environment:    envName,
					State:          state,
					Owner:          owner,
					Description:    fmt.Sprintf("'%s' is stopped (manually disabled)", flowName),
					Recommendation: "Confirm with the owner if this flow is still needed — delete if abandoned.",
				})
			}

			// 3. Stale flow — not modified in 180+ days (skip already-flagged suspended/stopped)
			if strings.EqualFold(state, "Started") {
				if daysSinceMod >= 365 {
					findings = append(findings, PPFlowFinding{
						Severity:       Warning,
						Category:       "Stale Flow",
						FlowName:       flowName,
						Environment:    envName,
						State:          state,
						Owner:          owner,
						Description:    fmt.Sprintf("Running but not modified in %d days (over 1 year)", daysSinceMod),
						Recommendation: "Verify the flow is still serving a business purpose — delete if no longer needed.",
					})
				} else if daysSinceMod >= 180 {
					findings = append(findings, PPFlowFinding{
						Severity:       Info,
						Category:       "Stale Flow",
						FlowName:       flowName,
						Environment:    envName,
						State:          state,
						Owner:          owner,
						Description:    fmt.Sprintf("Running but not modified in %d days (over 6 months)", daysSinceMod),
						Recommendation: "Check with the owner that this flow is still intentionally running.",
					})
				}
			}

			// 4. Flow in Default environment
			if env.Properties.IsDefault && strings.EqualFold(state, "Started") {
				findings = append(findings, PPFlowFinding{
					Severity:       Info,
					Category:       "Flow in Default Environment",
					FlowName:       flowName,
					Environment:    envName,
					State:          state,
					Owner:          owner,
					Description:    "Business flow running in the Default environment — no access controls or lifecycle management",
					Recommendation: "Move business-critical flows to a dedicated environment.",
				})
			}

			// 5. Unknown/no owner
			if owner == "(unknown)" && strings.EqualFold(state, "Started") {
				findings = append(findings, PPFlowFinding{
					Severity:       Warning,
					Category:       "No Owner",
					FlowName:       flowName,
					Environment:    envName,
					State:          state,
					Owner:          owner,
					Description:    fmt.Sprintf("'%s' has no identifiable owner — may be orphaned", flowName),
					Recommendation: "Identify ownership and reassign, or delete if the original owner has left.",
				})
			}

			// 6. Broad sharing — best-effort (see sharingCheckEnabled comment above)
			if sharingCheckEnabled && strings.EqualFold(state, "Started") {
				perms, permErr := fetchFlowPermissions(ctx, flowToken, env.Name, flow.Name)
				if permErr != nil {
					sharingCheckEnabled = false
					fmt.Fprintf(os.Stderr, "  Note: flow sharing data unavailable, skipping broad-sharing check (%v)\n", permErr)
				} else {
					sharedCount := 0
					for _, p := range perms {
						if !strings.EqualFold(p.Properties.RoleName, "Owner") {
							sharedCount++
						}
					}
					if sharedCount >= 10 {
						findings = append(findings, PPFlowFinding{
							Severity:       Warning,
							Category:       "Broadly Shared Flow",
							FlowName:       flowName,
							Environment:    envName,
							State:          state,
							Owner:          owner,
							Description:    fmt.Sprintf("Shared with %d users/groups beyond the owner", sharedCount),
							Recommendation: "Review sharing settings — if the owner leaves, everyone it's shared with loses access to this flow.",
						})
					} else if sharedCount >= 3 {
						findings = append(findings, PPFlowFinding{
							Severity:       Info,
							Category:       "Broadly Shared Flow",
							FlowName:       flowName,
							Environment:    envName,
							State:          state,
							Owner:          owner,
							Description:    fmt.Sprintf("Shared with %d users/groups beyond the owner", sharedCount),
							Recommendation: "Confirm the sharing scope is intentional.",
						})
					}
				}
			}

			// PP-6: Risky connector detection. The V2 flows list (used above, since the
			// V1 list-with-definition action is deprecated) doesn't include connector
			// data, so fetch each flow's connectionReferences individually.
			connectors, connErr := fetchFlowConnectors(ctx, flowToken, env.Name, flow.Name)
			if connErr != nil {
				fmt.Fprintf(os.Stderr, "  Warning: could not fetch connectors for '%s': %v\n", flowName, connErr)
			}
			for _, apiNameRaw := range connectors {
				apiName := strings.ToLower(apiNameRaw)
				if apiName == "" {
					continue
				}

				if reason, ok := ppHighRiskConnectors[apiName]; ok {
					findings = append(findings, PPFlowFinding{
						Severity:       Critical,
						Category:       "High-Risk Connector",
						FlowName:       flowName,
						Environment:    envName,
						State:          state,
						Owner:          owner,
						Description:    fmt.Sprintf("Uses %s", reason),
						Recommendation: fmt.Sprintf("Review whether '%s' needs the %s connector — block it in DLP policy if not required.", flowName, apiNameRaw),
					})
				} else if reason, ok := ppWarnConnectors[apiName]; ok {
					findings = append(findings, PPFlowFinding{
						Severity:       Warning,
						Category:       "Broad-Access Connector",
						FlowName:       flowName,
						Environment:    envName,
						State:          state,
						Owner:          owner,
						Description:    fmt.Sprintf("Uses %s", reason),
						Recommendation: fmt.Sprintf("Verify '%s' has appropriate data access scope for the %s connector.", flowName, apiNameRaw),
					})
				}

				// 7. Premium connector — undocumented licensing cost
				if friendlyConn, ok := ppPremiumConnectors[apiName]; ok {
					findings = append(findings, PPFlowFinding{
						Severity:       Info,
						Category:       "Premium Connector — Verify Licensing",
						FlowName:       flowName,
						Environment:    envName,
						State:          state,
						Owner:          owner,
						Description:    fmt.Sprintf("Uses %s — requires a premium Power Automate license", friendlyConn),
						Recommendation: fmt.Sprintf("Confirm '%s' and any users it's shared with have a premium license covering the %s connector.", flowName, apiNameRaw),
					})
				}
			}
		}
	}

	for _, f := range findings {
		summary.FindingsBySeverity[string(f.Severity)]++
	}

	report := PPFlowReport{Summary: summary, Findings: findings}

	switch flagOutput {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	default:
		printPPFlowsTable(report)
	}
	return nil
}

func fetchPPFlows(ctx context.Context, token, envName string) ([]ppFlow, error) {
	var all []ppFlow
	url := fmt.Sprintf("%s/providers/Microsoft.ProcessSimple/scopes/admin/environments/%s/v2/flows?api-version=2016-11-01",
		ppFlowBase, envName)
	for url != "" {
		var page ppFlowsResponse
		if err := ppFetch(ctx, token, url, &page); err != nil {
			return nil, err
		}
		all = append(all, page.Value...)
		url = page.NextLink
	}
	return all, nil
}

// fetchFlowPermissions is best-effort — this exact admin API shape (GET .../permissions)
// has not been validated against a live tenant. The caller disables the broad-sharing
// check for the rest of the run on the first error rather than failing the whole scan.
func fetchFlowPermissions(ctx context.Context, token, envName, flowName string) ([]ppFlowPermission, error) {
	url := fmt.Sprintf("%s/providers/Microsoft.ProcessSimple/scopes/admin/environments/%s/flows/%s/permissions?api-version=2016-11-01",
		ppFlowBase, envName, flowName)
	var page ppFlowPermissionsResponse
	if err := ppFetch(ctx, token, url, &page); err != nil {
		return nil, err
	}
	return page.Value, nil
}

func printPPFlowsTable(r PPFlowReport) {
	fmt.Println()
	fmt.Println("POWER PLATFORM — POWER AUTOMATE FLOWS ANALYSIS")
	fmt.Println(strings.Repeat("=", 100))
	fmt.Println()

	fmt.Println("SUMMARY")
	fmt.Println(strings.Repeat("-", 50))
	fmt.Printf("  Environments Scanned: %d\n", r.Summary.TotalEnvironments)
	fmt.Printf("  Total Flows Found:    %d\n", r.Summary.TotalFlows)
	fmt.Println()
	fmt.Println("  By State:")
	for state, count := range r.Summary.ByState {
		fmt.Printf("    %-15s %d\n", state, count)
	}
	fmt.Println()

	fmt.Println("FINDINGS")
	fmt.Println(strings.Repeat("-", 50))
	fmt.Printf("  Critical: %d  |  Warning: %d  |  Info: %d\n",
		r.Summary.FindingsBySeverity["Critical"],
		r.Summary.FindingsBySeverity["Warning"],
		r.Summary.FindingsBySeverity["Info"])
	fmt.Println()

	if len(r.Findings) == 0 {
		fmt.Println("  No issues found.")
		return
	}

	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "SEVERITY\tCATEGORY\tFLOW\tENVIRONMENT\tSTATE\tOWNER\tDESCRIPTION\t")
	fmt.Fprintln(w, "--------\t--------\t----\t-----------\t-----\t-----\t-----------\t")
	for _, f := range r.Findings {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t\n",
			f.Severity, f.Category, f.FlowName, f.Environment, f.State, f.Owner, f.Description)
	}
	w.Flush()

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
		icon := "ℹ️ "
		if f.Severity == Critical {
			icon = "🔴"
		} else if f.Severity == Warning {
			icon = "🟡"
		}
		fmt.Printf("  %s [%s] %s: %s\n", icon, f.Severity, f.Category, f.Recommendation)
	}
	fmt.Println()
}
