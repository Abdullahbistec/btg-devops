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

type PPEnvFinding struct {
	Severity       Severity `json:"severity"`
	Category       string   `json:"category"`
	Environment    string   `json:"environment"`
	EnvironmentSku string   `json:"environment_sku"`
	Description    string   `json:"description"`
	Recommendation string   `json:"recommendation"`
}

type PPEnvSummary struct {
	TotalEnvironments  int            `json:"total_environments"`
	BySku              map[string]int `json:"by_sku"`
	FindingsBySeverity map[string]int `json:"findings_by_severity"`
}

type PPEnvReport struct {
	Summary  PPEnvSummary   `json:"summary"`
	Findings []PPEnvFinding `json:"findings"`
}

// ---------- command ----------

var ppEnvironmentsCmd = &cobra.Command{
	Use:   "pp-environments",
	Short: "Analyze Power Platform environments for governance and DLP issues",
	Long: `Lists all Power Platform environments and checks for:
  - Missing Data Loss Prevention (DLP) policies
  - Trial environments that risk losing business data
  - Default environment governance risks
  - Disabled or expiring environments
  - Environment sprawl (too many ungoverned environments)

Requires: Power Platform Administrator role on the service principal.`,
	RunE: runPPEnvironments,
}

func init() {
	analyzeCmd.AddCommand(ppEnvironmentsCmd)
	ppEnvironmentsCmd.Flags().StringVar(&flagTenantID, "tenant-id", "", "Azure Tenant ID (overrides AZURE_TENANT_ID env var)")
	ppEnvironmentsCmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
}

func runPPEnvironments(cmd *cobra.Command, args []string) error {
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

	fmt.Fprintf(os.Stderr, "Fetching Power Platform environments for tenant %s...\n", tenantID)
	envs, err := fetchPPEnvironments(ctx, token)
	if err != nil {
		return fmt.Errorf("listing environments: %w", err)
	}
	fmt.Fprintf(os.Stderr, "Found %d environment(s). Analyzing...\n", len(envs))

	summary := PPEnvSummary{
		TotalEnvironments:  len(envs),
		BySku:              map[string]int{},
		FindingsBySeverity: map[string]int{},
	}
	var findings []PPEnvFinding

	for _, env := range envs {
		name := ppEnvDisplayName(env)
		sku := env.Properties.EnvironmentSku
		summary.BySku[sku]++

		dlpCount := env.Properties.EnvironmentPolicies.DataLossPreventionPolicies.Count

		// 1. No DLP policies — critical for default env, warning for others
		if dlpCount == 0 {
			sev := Warning
			if env.Properties.IsDefault {
				sev = Critical
			}
			findings = append(findings, PPEnvFinding{
				Severity:       sev,
				Category:       "No DLP Policy",
				Environment:    name,
				EnvironmentSku: sku,
				Description:    fmt.Sprintf("'%s' has no DLP policies — connectors are unrestricted", name),
				Recommendation: "Create a DLP policy to control which connectors can share data across business and non-business groups.",
			})
		}

		// 2. Default environment — open to all licensed users
		if env.Properties.IsDefault {
			findings = append(findings, PPEnvFinding{
				Severity:       Warning,
				Category:       "Default Environment Risk",
				Environment:    name,
				EnvironmentSku: sku,
				Description:    "Default environment is accessible to all licensed users — not suitable for business-critical apps",
				Recommendation: "Move business apps and flows to dedicated production environments with restricted access.",
			})
		}

		// 3. Trial environment — will expire
		if strings.EqualFold(sku, "Trial") {
			findings = append(findings, PPEnvFinding{
				Severity:       Warning,
				Category:       "Trial Environment",
				Environment:    name,
				EnvironmentSku: sku,
				Description:    fmt.Sprintf("'%s' is a trial environment — it will expire and any data/apps inside will be lost", name),
				Recommendation: "Convert to a production or sandbox environment, or delete if not needed.",
			})
		}

		// 4. Disabled environment
		if env.Properties.IsDisabled {
			findings = append(findings, PPEnvFinding{
				Severity:       Info,
				Category:       "Disabled Environment",
				Environment:    name,
				EnvironmentSku: sku,
				Description:    fmt.Sprintf("'%s' is disabled — all apps and flows are inactive", name),
				Recommendation: "Re-enable the environment if it's still needed, or delete it to avoid clutter.",
			})
		}

		// 5. Expiring environment
		if env.Properties.ExpirationTime != nil && *env.Properties.ExpirationTime != "" {
			days := ppDaysSince(*env.Properties.ExpirationTime)
			if days >= 0 && days <= 30 {
				findings = append(findings, PPEnvFinding{
					Severity:       Warning,
					Category:       "Expiring Soon",
					Environment:    name,
					EnvironmentSku: sku,
					Description:    fmt.Sprintf("'%s' expires within 30 days — apps and flows will stop working", name),
					Recommendation: "Renew the environment or migrate workloads to a permanent environment before expiry.",
				})
			}
		}
	}

	// 6. Environment sprawl
	if len(envs) > 15 {
		findings = append(findings, PPEnvFinding{
			Severity:       Info,
			Category:       "Environment Sprawl",
			Environment:    "(tenant-wide)",
			EnvironmentSku: "—",
			Description:    fmt.Sprintf("%d environments detected — risk of ungoverned sprawl and wasted capacity", len(envs)),
			Recommendation: "Audit all environments. Delete unused ones and enforce an environment request/approval process.",
		})
	}

	for _, f := range findings {
		summary.FindingsBySeverity[string(f.Severity)]++
	}

	report := PPEnvReport{Summary: summary, Findings: findings}

	switch flagOutput {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	default:
		printPPEnvTable(report)
	}
	return nil
}

func printPPEnvTable(r PPEnvReport) {
	fmt.Println()
	fmt.Println("POWER PLATFORM — ENVIRONMENT ANALYSIS")
	fmt.Println(strings.Repeat("=", 100))
	fmt.Println()

	fmt.Println("SUMMARY")
	fmt.Println(strings.Repeat("-", 50))
	fmt.Printf("  Total Environments: %d\n", r.Summary.TotalEnvironments)
	fmt.Println()
	fmt.Println("  By Type:")
	for sku, count := range r.Summary.BySku {
		fmt.Printf("    %-20s %d\n", sku, count)
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
	fmt.Fprintln(w, "SEVERITY\tCATEGORY\tENVIRONMENT\tTYPE\tDESCRIPTION\t")
	fmt.Fprintln(w, "--------\t--------\t-----------\t----\t-----------\t")
	for _, f := range r.Findings {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t\n",
			f.Severity, f.Category, f.Environment, f.EnvironmentSku, f.Description)
	}
	w.Flush()

	fmt.Println()
	fmt.Println("RECOMMENDATIONS")
	fmt.Println(strings.Repeat("-", 50))
	for _, f := range r.Findings {
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
