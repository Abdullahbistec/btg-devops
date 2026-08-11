package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/chanbistec/btg-devops/provider"
	"github.com/spf13/cobra"
)

// ---------- data types ----------

type PPBIFinding struct {
	Severity       Severity `json:"severity"`
	Category       string   `json:"category"`
	Workspace      string   `json:"workspace"`
	WorkspaceType  string   `json:"workspace_type"`
	Description    string   `json:"description"`
	Recommendation string   `json:"recommendation"`
}

type PPBISummary struct {
	TotalWorkspaces    int            `json:"total_workspaces"`
	TotalReports       int            `json:"total_reports"`
	TotalDatasets      int            `json:"total_datasets"`
	ByType             map[string]int `json:"by_type"`
	FindingsBySeverity map[string]int `json:"findings_by_severity"`
}

type PPBIReport struct {
	Summary  PPBISummary   `json:"summary"`
	Findings []PPBIFinding `json:"findings"`
}

// Power BI Admin API types
type pbiGroupsResponse struct {
	Value         []pbiGroup `json:"value"`
	OdataNextLink string     `json:"@odata.nextLink"`
}

type pbiGroup struct {
	ID                    string       `json:"id"`
	Name                  string       `json:"name"`
	IsReadOnly            bool         `json:"isReadOnly"`
	IsOnDedicatedCapacity bool         `json:"isOnDedicatedCapacity"`
	Type                  string       `json:"type"`
	State                 string       `json:"state"`
	Users                 []pbiUser    `json:"users"`
	Reports               []pbiReport  `json:"reports"`
	Datasets              []pbiDataset `json:"datasets"`
}

type pbiUser struct {
	GroupUserAccessRight string `json:"groupUserAccessRight"`
	EmailAddress         string `json:"emailAddress"`
	PrincipalType        string `json:"principalType"`
}

type pbiReport struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type pbiDataset struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	IsRefreshable bool   `json:"isRefreshable"`
	ConfiguredBy  string `json:"configuredBy"`
}

// ---------- command ----------

var ppPowerBICmd = &cobra.Command{
	Use:   "pp-powerbi",
	Short: "Analyze Power BI workspaces for governance, orphaned resources, and capacity issues",
	Long: `Scans all Power BI workspaces via the admin API and checks for:
  - Deleted workspaces (should be cleaned up)
  - Workspaces with no admin users (orphaned — no one owns them)
  - Empty workspaces (no reports or datasets — unused)
  - Personal workspaces (My Workspace) with content — governance risk
  - Large workspaces not on dedicated capacity (shared capacity reliability risk)
  - Datasets with no refresh configured (stale data)

Requires: Power BI Administrator role on the service principal.`,
	RunE: runPPPowerBI,
}

func init() {
	analyzeCmd.AddCommand(ppPowerBICmd)
	ppPowerBICmd.Flags().StringVar(&flagTenantID, "tenant-id", "", "Azure Tenant ID (overrides AZURE_TENANT_ID env var)")
	ppPowerBICmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
	provider.Register("powerplatform", ppPowerBIProviderAdapter{})
}

func runPPPowerBI(cmd *cobra.Command, args []string) error {
	ctx := context.Background()

	tenantID := getTenantID()
	if tenantID == "" {
		return fmt.Errorf("tenant ID required: set --tenant-id or AZURE_TENANT_ID env var")
	}

	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("azure auth failed: %w", err)
	}

	report, err := computePPPowerBIFindings(ctx, cred, tenantID)
	if err != nil {
		return err
	}

	switch flagOutput {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	default:
		printPPBITable(report)
	}
	return nil
}

func computePPPowerBIFindings(ctx context.Context, cred *azidentity.DefaultAzureCredential, tenantID string) (PPBIReport, error) {
	token, err := ppToken(ctx, cred, ppBIScope)
	if err != nil {
		return PPBIReport{}, fmt.Errorf("acquiring power bi token: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Fetching Power BI workspaces for tenant %s...\n", tenantID)
	groups, err := fetchPBIWorkspaces(ctx, token)
	if err != nil {
		return PPBIReport{}, fmt.Errorf("listing workspaces: %w", err)
	}
	fmt.Fprintf(os.Stderr, "Found %d workspace(s). Analyzing...\n", len(groups))

	summary := PPBISummary{
		TotalWorkspaces:    len(groups),
		ByType:             map[string]int{},
		FindingsBySeverity: map[string]int{},
	}
	var findings []PPBIFinding

	for _, ws := range groups {
		wsName := ws.Name
		wsType := ws.Type
		if wsType == "" {
			wsType = "Workspace"
		}
		summary.ByType[wsType]++
		summary.TotalReports += len(ws.Reports)
		summary.TotalDatasets += len(ws.Datasets)

		// 1. Deleted workspace — should be removed
		if strings.EqualFold(ws.State, "Deleted") {
			findings = append(findings, PPBIFinding{
				Severity:       Warning,
				Category:       "Deleted Workspace",
				Workspace:      wsName,
				WorkspaceType:  wsType,
				Description:    fmt.Sprintf("'%s' is in Deleted state and still showing in admin view", wsName),
				Recommendation: "Permanently remove deleted workspaces to keep the tenant clean.",
			})
			continue
		}

		// 2. No admin users — orphaned workspace
		hasAdmin := false
		for _, u := range ws.Users {
			if strings.EqualFold(u.GroupUserAccessRight, "Admin") {
				hasAdmin = true
				break
			}
		}
		if !hasAdmin && !strings.EqualFold(wsType, "PersonalGroup") {
			findings = append(findings, PPBIFinding{
				Severity:       Critical,
				Category:       "No Admin — Orphaned",
				Workspace:      wsName,
				WorkspaceType:  wsType,
				Description:    fmt.Sprintf("'%s' has no admin users — no one owns or manages this workspace", wsName),
				Recommendation: "Assign an admin to this workspace or delete it if it's no longer needed.",
			})
		}

		// 3. Empty workspace — no reports and no datasets
		if len(ws.Reports) == 0 && len(ws.Datasets) == 0 && !strings.EqualFold(wsType, "PersonalGroup") {
			findings = append(findings, PPBIFinding{
				Severity:       Info,
				Category:       "Empty Workspace",
				Workspace:      wsName,
				WorkspaceType:  wsType,
				Description:    fmt.Sprintf("'%s' has no reports or datasets", wsName),
				Recommendation: "Delete empty workspaces to reduce clutter and improve governance.",
			})
		}

		// 4. Personal workspace (My Workspace) with significant content
		if strings.EqualFold(wsType, "PersonalGroup") && (len(ws.Reports) > 5 || len(ws.Datasets) > 5) {
			findings = append(findings, PPBIFinding{
				Severity:       Warning,
				Category:       "Content in Personal Workspace",
				Workspace:      wsName,
				WorkspaceType:  wsType,
				Description:    fmt.Sprintf("Personal workspace has %d reports and %d datasets — business content may be siloed", len(ws.Reports), len(ws.Datasets)),
				Recommendation: "Move business reports and datasets to a shared workspace for proper governance and collaboration.",
			})
		}

		// 5. Large workspace on shared capacity
		if !ws.IsOnDedicatedCapacity && (len(ws.Reports) > 20 || len(ws.Datasets) > 10) {
			findings = append(findings, PPBIFinding{
				Severity:       Warning,
				Category:       "Large Workspace — Shared Capacity",
				Workspace:      wsName,
				WorkspaceType:  wsType,
				Description:    fmt.Sprintf("'%s' has %d reports and %d datasets on shared capacity — performance may be inconsistent", wsName, len(ws.Reports), len(ws.Datasets)),
				Recommendation: "Assign a Premium or Embedded capacity for production workspaces with heavy usage.",
			})
		}

		// 6. Datasets without refresh configured
		nonRefreshable := 0
		for _, ds := range ws.Datasets {
			if !ds.IsRefreshable {
				nonRefreshable++
			}
		}
		if nonRefreshable > 0 && !strings.EqualFold(wsType, "PersonalGroup") {
			findings = append(findings, PPBIFinding{
				Severity:       Info,
				Category:       "Datasets Without Refresh",
				Workspace:      wsName,
				WorkspaceType:  wsType,
				Description:    fmt.Sprintf("%d dataset(s) in '%s' have no refresh configured — reports may show stale data", nonRefreshable, wsName),
				Recommendation: "Configure scheduled refresh for datasets to ensure reports reflect up-to-date data.",
			})
		}
	}

	for _, f := range findings {
		summary.FindingsBySeverity[string(f.Severity)]++
	}

	report := PPBIReport{Summary: summary, Findings: findings}
	return report, nil
}

// ---------- provider registration ----------

type ppPowerBIProviderAdapter struct{}

func (ppPowerBIProviderAdapter) Name() string { return "pp-powerbi" }

func (ppPowerBIProviderAdapter) Run(ctx context.Context) ([]provider.Finding, error) {
	tenantID := getTenantID()
	if tenantID == "" {
		return nil, fmt.Errorf("tenant ID required: set --tenant-id or AZURE_TENANT_ID env var")
	}
	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return nil, fmt.Errorf("azure auth failed: %w", err)
	}
	report, err := computePPPowerBIFindings(ctx, cred, tenantID)
	if err != nil {
		return nil, err
	}
	return ppPowerBIFindingsToProvider(report.Findings), nil
}

// ppPowerBIFindingsToProvider is split out from Run() so the conversion is
// testable without live credentials.
func ppPowerBIFindingsToProvider(findings []PPBIFinding) []provider.Finding {
	out := make([]provider.Finding, len(findings))
	for i, f := range findings {
		out[i] = provider.Finding{
			Provider:       "powerplatform",
			Service:        "Power BI",
			Severity:       provider.Severity(f.Severity),
			Category:       f.Category,
			Resource:       f.Workspace,
			Description:    f.Description,
			Recommendation: f.Recommendation,
		}
	}
	return out
}

func fetchPBIWorkspaces(ctx context.Context, token string) ([]pbiGroup, error) {
	var all []pbiGroup
	url := ppBIBase + "/v1.0/myorg/admin/groups?$top=200&$expand=users,reports,datasets"
	for url != "" {
		var page pbiGroupsResponse
		if err := ppFetch(ctx, token, url, &page); err != nil {
			return nil, err
		}
		all = append(all, page.Value...)
		url = page.OdataNextLink
	}
	return all, nil
}

func printPPBITable(r PPBIReport) {
	fmt.Println()
	fmt.Println("POWER PLATFORM — POWER BI ANALYSIS")
	fmt.Println(strings.Repeat("=", 100))
	fmt.Println()

	fmt.Println("SUMMARY")
	fmt.Println(strings.Repeat("-", 50))
	fmt.Printf("  Total Workspaces: %d\n", r.Summary.TotalWorkspaces)
	fmt.Printf("  Total Reports:    %d\n", r.Summary.TotalReports)
	fmt.Printf("  Total Datasets:   %d\n", r.Summary.TotalDatasets)
	fmt.Println()
	fmt.Println("  By Type:")
	for t, count := range r.Summary.ByType {
		fmt.Printf("    %-20s %d\n", t, count)
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
	fmt.Fprintln(w, "SEVERITY\tCATEGORY\tWORKSPACE\tTYPE\tDESCRIPTION\t")
	fmt.Fprintln(w, "--------\t--------\t---------\t----\t-----------\t")
	for _, f := range r.Findings {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t\n",
			f.Severity, f.Category, f.Workspace, f.WorkspaceType, f.Description)
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
