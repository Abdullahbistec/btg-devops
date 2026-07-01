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

type PPAppFinding struct {
	Severity       Severity `json:"severity"`
	Category       string   `json:"category"`
	AppName        string   `json:"app_name"`
	Environment    string   `json:"environment"`
	Owner          string   `json:"owner"`
	Description    string   `json:"description"`
	Recommendation string   `json:"recommendation"`
}

type PPAppSummary struct {
	TotalApps          int            `json:"total_apps"`
	TotalEnvironments  int            `json:"total_environments"`
	FindingsBySeverity map[string]int `json:"findings_by_severity"`
}

type PPAppReport struct {
	Summary  PPAppSummary   `json:"summary"`
	Findings []PPAppFinding `json:"findings"`
}

// Power Apps API types
type ppAppsResponse struct {
	Value    []ppApp `json:"value"`
	NextLink string  `json:"nextLink"`
}

type ppApp struct {
	Name       string     `json:"name"`
	ID         string     `json:"id"`
	Properties ppAppProps `json:"properties"`
}

type ppAppProps struct {
	DisplayName           string     `json:"displayName"`
	Description           string     `json:"description"`
	CreatedTime           string     `json:"createdTime"`
	LastModifiedTime      string     `json:"lastModifiedTime"`
	LastPublishTime       string     `json:"lastPublishTime"`
	SharedGroupsCount     int        `json:"sharedGroupsCount"`
	SharedUsersCount      int        `json:"sharedUsersCount"`
	UsesPremiumApi        bool       `json:"usesPremiumApi"`
	UsesCustomApi         bool       `json:"usesCustomApi"`
	AppPlanClassification string     `json:"appPlanClassification"`
	Owner                 ppAppOwner `json:"owner"`
}

type ppAppOwner struct {
	DisplayName string `json:"displayName"`
	Email       string `json:"email"`
	ID          string `json:"id"`
}

// ---------- command ----------

var ppAppsCmd = &cobra.Command{
	Use:   "pp-apps",
	Short: "Analyze Power Apps for stale, ungoverned, and premium-cost issues",
	Long: `Scans all Power Apps across every environment and checks for:
  - Apps not modified in 180+ days (stale candidates for deletion)
  - Apps deployed in the Default environment (governance risk)
  - Apps using premium connectors without a description (undocumented cost)
  - Apps shared with large numbers of users
  - Apps with no description (undiscoverable / ungoverned)

Requires: Power Platform Administrator role on the service principal.`,
	RunE: runPPApps,
}

func init() {
	analyzeCmd.AddCommand(ppAppsCmd)
	ppAppsCmd.Flags().StringVar(&flagTenantID, "tenant-id", "", "Azure Tenant ID (overrides AZURE_TENANT_ID env var)")
	ppAppsCmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
}

func runPPApps(cmd *cobra.Command, args []string) error {
	ctx := context.Background()

	tenantID := getTenantID()
	if tenantID == "" {
		return fmt.Errorf("tenant ID required: set --tenant-id or AZURE_TENANT_ID env var")
	}

	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("azure auth failed: %w", err)
	}

	token, err := ppToken(ctx, cred, ppAppsScope)
	if err != nil {
		return fmt.Errorf("acquiring power platform token: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Fetching Power Platform environments...\n")
	envs, err := fetchPPEnvironments(ctx, token)
	if err != nil {
		return fmt.Errorf("listing environments: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Scanning Power Apps across %d environment(s)...\n", len(envs))

	summary := PPAppSummary{
		TotalEnvironments:  len(envs),
		FindingsBySeverity: map[string]int{},
	}
	var findings []PPAppFinding

	for _, env := range envs {
		envName := ppEnvDisplayName(env)

		apps, err := fetchPPApps(ctx, token, env.Name)
		if err != nil {
			fmt.Fprintf(os.Stderr, "  Warning: could not fetch apps for '%s': %v\n", envName, err)
			continue
		}
		summary.TotalApps += len(apps)

		for _, app := range apps {
			appName := app.Properties.DisplayName
			if appName == "" {
				appName = app.Name
			}
			owner := app.Properties.Owner.Email
			if owner == "" {
				owner = app.Properties.Owner.DisplayName
			}
			if owner == "" {
				owner = "(unknown)"
			}
			daysSinceMod := ppDaysSince(app.Properties.LastModifiedTime)

			// 1. Stale app — not modified in 180+ days
			if daysSinceMod >= 365 {
				findings = append(findings, PPAppFinding{
					Severity:       Warning,
					Category:       "Stale App",
					AppName:        appName,
					Environment:    envName,
					Owner:          owner,
					Description:    fmt.Sprintf("Not modified in %d days (over 1 year)", daysSinceMod),
					Recommendation: "Contact the owner and archive or delete if no longer in use.",
				})
			} else if daysSinceMod >= 180 {
				findings = append(findings, PPAppFinding{
					Severity:       Info,
					Category:       "Stale App",
					AppName:        appName,
					Environment:    envName,
					Owner:          owner,
					Description:    fmt.Sprintf("Not modified in %d days (over 6 months)", daysSinceMod),
					Recommendation: "Review with owner — consider archiving if no longer active.",
				})
			}

			// 2. App in Default environment
			if env.Properties.IsDefault {
				findings = append(findings, PPAppFinding{
					Severity:       Info,
					Category:       "App in Default Environment",
					AppName:        appName,
					Environment:    envName,
					Owner:          owner,
					Description:    "Deployed in the Default environment — accessible to all licensed users by default",
					Recommendation: "Move business apps to a dedicated environment with proper access controls.",
				})
			}

			// 3. Premium connectors with no description — undocumented cost
			if app.Properties.UsesPremiumApi && app.Properties.Description == "" {
				findings = append(findings, PPAppFinding{
					Severity:       Warning,
					Category:       "Premium App — No Description",
					AppName:        appName,
					Environment:    envName,
					Owner:          owner,
					Description:    "Uses premium connectors but has no description — licensing cost is undocumented",
					Recommendation: "Add a business justification description and verify all users have premium licenses.",
				})
			}

			// 4. No description (non-premium)
			if app.Properties.Description == "" && !app.Properties.UsesPremiumApi {
				findings = append(findings, PPAppFinding{
					Severity:       Info,
					Category:       "No Description",
					AppName:        appName,
					Environment:    envName,
					Owner:          owner,
					Description:    "App has no description — hard to discover purpose or ownership",
					Recommendation: "Add a description explaining the app's purpose and intended users.",
				})
			}

			// 5. Broadly shared
			if app.Properties.SharedUsersCount > 50 {
				findings = append(findings, PPAppFinding{
					Severity:       Warning,
					Category:       "Broadly Shared",
					AppName:        appName,
					Environment:    envName,
					Owner:          owner,
					Description:    fmt.Sprintf("Shared with %d users — verify this is intentional", app.Properties.SharedUsersCount),
					Recommendation: "Review sharing settings and ensure only intended users have access.",
				})
			} else if app.Properties.SharedUsersCount > 20 {
				findings = append(findings, PPAppFinding{
					Severity:       Info,
					Category:       "Broadly Shared",
					AppName:        appName,
					Environment:    envName,
					Owner:          owner,
					Description:    fmt.Sprintf("Shared with %d users", app.Properties.SharedUsersCount),
					Recommendation: "Confirm that the sharing scope is intentional and appropriate.",
				})
			}
		}
	}

	for _, f := range findings {
		summary.FindingsBySeverity[string(f.Severity)]++
	}

	report := PPAppReport{Summary: summary, Findings: findings}

	switch flagOutput {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	default:
		printPPAppsTable(report)
	}
	return nil
}

func fetchPPApps(ctx context.Context, token, envName string) ([]ppApp, error) {
	var all []ppApp
	url := fmt.Sprintf("%s/providers/Microsoft.PowerApps/scopes/admin/environments/%s/apps?api-version=2016-11-01",
		ppAppsBase, envName)
	for url != "" {
		var page ppAppsResponse
		if err := ppFetch(ctx, token, url, &page); err != nil {
			return nil, err
		}
		all = append(all, page.Value...)
		url = page.NextLink
	}
	return all, nil
}

func printPPAppsTable(r PPAppReport) {
	fmt.Println()
	fmt.Println("POWER PLATFORM — POWER APPS ANALYSIS")
	fmt.Println(strings.Repeat("=", 100))
	fmt.Println()

	fmt.Println("SUMMARY")
	fmt.Println(strings.Repeat("-", 50))
	fmt.Printf("  Environments Scanned: %d\n", r.Summary.TotalEnvironments)
	fmt.Printf("  Total Apps Found:     %d\n", r.Summary.TotalApps)
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
	fmt.Fprintln(w, "SEVERITY\tCATEGORY\tAPP\tENVIRONMENT\tOWNER\tDESCRIPTION\t")
	fmt.Fprintln(w, "--------\t--------\t---\t-----------\t-----\t-----------\t")
	for _, f := range r.Findings {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\t\n",
			f.Severity, f.Category, f.AppName, f.Environment, f.Owner, f.Description)
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
