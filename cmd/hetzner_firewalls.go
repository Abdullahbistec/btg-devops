package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/chanbistec/btg-devops/provider"
	"github.com/spf13/cobra"
)

// ---------- data types ----------

type HetznerFirewallFinding struct {
	Severity       Severity `json:"severity"`
	Category       string   `json:"category"`
	FirewallName   string   `json:"firewall_name"`
	Description    string   `json:"description"`
	Recommendation string   `json:"recommendation"`
}

type HetznerFirewallSummary struct {
	TotalFirewalls     int            `json:"total_firewalls"`
	OpenSensitivePort  int            `json:"open_sensitive_port"`
	OpenOtherPort      int            `json:"open_other_port"`
	UnusedFirewalls    int            `json:"unused_firewalls"`
	FindingsBySeverity map[string]int `json:"findings_by_severity"`
}

type HetznerFirewallReport struct {
	Summary  HetznerFirewallSummary   `json:"summary"`
	Findings []HetznerFirewallFinding `json:"findings"`
}

// Hetzner Cloud API types (GET /firewalls)
type hetznerFirewallsResponse struct {
	Firewalls []hetznerFirewall `json:"firewalls"`
	Meta      hetznerMeta       `json:"meta"`
}

type hetznerFirewall struct {
	ID        int                     `json:"id"`
	Name      string                  `json:"name"`
	Rules     []hetznerFirewallRule   `json:"rules"`
	AppliedTo []hetznerFirewallTarget `json:"applied_to"`
}

type hetznerFirewallRule struct {
	Direction string   `json:"direction"`
	Protocol  string   `json:"protocol"`
	Port      string   `json:"port"`
	SourceIPs []string `json:"source_ips"`
}

type hetznerFirewallTarget struct {
	Type string `json:"type"`
}

// ---------- command ----------

var hetznerFirewallsCmd = &cobra.Command{
	Use:   "hetzner-firewalls",
	Short: "Analyze Hetzner Cloud Firewalls for overly permissive rules",
	Long: `Lists all Hetzner Cloud Firewalls in the project and checks for:
  - Inbound rules open to the entire internet (0.0.0.0/0 or ::/0) on a
    known-sensitive port (SSH, RDP, database ports, etc.)
  - Inbound rules open to the entire internet on any other port
  - Firewalls not applied to any resource (dead configuration)

Requires: an HCLOUD_TOKEN with Read permission on the target project.`,
	RunE: runHetznerFirewalls,
}

func init() {
	analyzeCmd.AddCommand(hetznerFirewallsCmd)
	hetznerFirewallsCmd.Flags().StringVar(&flagHetznerToken, "token", "", "Hetzner Cloud API token (overrides HCLOUD_TOKEN env var)")
	hetznerFirewallsCmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
	provider.Register("hetzner", hetznerFirewallsProviderAdapter{})
}

func runHetznerFirewalls(cmd *cobra.Command, args []string) error {
	ctx := context.Background()

	token := getHetznerToken()
	if token == "" {
		return fmt.Errorf("hetzner API token required: set --token or HCLOUD_TOKEN env var")
	}

	report, err := computeHetznerFirewallsFindings(ctx, token)
	if err != nil {
		return err
	}

	switch flagOutput {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	default:
		printHetznerFirewallsTable(report)
	}
	return nil
}

func computeHetznerFirewallsFindings(ctx context.Context, token string) (HetznerFirewallReport, error) {
	fmt.Fprintf(os.Stderr, "Fetching Hetzner Cloud firewalls...\n")
	firewalls, err := fetchHetznerFirewalls(ctx, token)
	if err != nil {
		return HetznerFirewallReport{}, fmt.Errorf("listing firewalls: %w", err)
	}
	fmt.Fprintf(os.Stderr, "Found %d firewall(s). Analyzing...\n", len(firewalls))

	summary := HetznerFirewallSummary{
		TotalFirewalls:     len(firewalls),
		FindingsBySeverity: map[string]int{},
	}
	findings := hetznerFirewallFindings(firewalls, &summary)

	for _, f := range findings {
		summary.FindingsBySeverity[string(f.Severity)]++
	}

	return HetznerFirewallReport{Summary: summary, Findings: findings}, nil
}

// hetznerFirewallFindings is split out from computeHetznerFirewallsFindings
// so the detection logic is testable against in-memory fixtures, with no
// network involved.
func hetznerFirewallFindings(firewalls []hetznerFirewall, summary *HetznerFirewallSummary) []HetznerFirewallFinding {
	var findings []HetznerFirewallFinding

	for _, fw := range firewalls {
		for _, rule := range fw.Rules {
			if rule.Direction != "in" || !hetznerIsOpenToInternet(rule.SourceIPs) {
				continue
			}

			if svc, ok := hetznerRuleSensitivePort(rule.Port); ok {
				summary.OpenSensitivePort++
				findings = append(findings, HetznerFirewallFinding{
					Severity:       Critical,
					Category:       "Sensitive Port Open to Internet",
					FirewallName:   fw.Name,
					Description:    fmt.Sprintf("'%s' allows %s/%s (%s) from 0.0.0.0/0 — anyone on the internet can attempt to connect", fw.Name, rule.Protocol, rule.Port, svc),
					Recommendation: fmt.Sprintf("Restrict the source IP range for port %s to known, trusted addresses.", rule.Port),
				})
			} else {
				summary.OpenOtherPort++
				findings = append(findings, HetznerFirewallFinding{
					Severity:       Warning,
					Category:       "Port Open to Internet",
					FirewallName:   fw.Name,
					Description:    fmt.Sprintf("'%s' allows %s/%s from 0.0.0.0/0", fw.Name, rule.Protocol, rule.Port),
					Recommendation: fmt.Sprintf("Restrict the source IP range for port %s if it does not need to be public.", rule.Port),
				})
			}
		}

		if len(fw.AppliedTo) == 0 {
			summary.UnusedFirewalls++
			findings = append(findings, HetznerFirewallFinding{
				Severity:       Info,
				Category:       "Unused Firewall",
				FirewallName:   fw.Name,
				Description:    fmt.Sprintf("'%s' is not applied to any server or label selector", fw.Name),
				Recommendation: "Apply the firewall to a resource, or delete it if it's no longer needed.",
			})
		}
	}

	return findings
}

// ---------- provider registration ----------

type hetznerFirewallsProviderAdapter struct{}

func (hetznerFirewallsProviderAdapter) Name() string { return "hetzner-firewalls" }

func (hetznerFirewallsProviderAdapter) Run(ctx context.Context) ([]provider.Finding, error) {
	token := getHetznerToken()
	if token == "" {
		return nil, fmt.Errorf("hetzner API token required: set --token or HCLOUD_TOKEN env var")
	}
	report, err := computeHetznerFirewallsFindings(ctx, token)
	if err != nil {
		return nil, err
	}
	return hetznerFirewallsFindingsToProvider(report.Findings), nil
}

// hetznerFirewallsFindingsToProvider is split out from Run() so the
// conversion is testable without live credentials.
func hetznerFirewallsFindingsToProvider(findings []HetznerFirewallFinding) []provider.Finding {
	out := make([]provider.Finding, len(findings))
	for i, f := range findings {
		out[i] = provider.Finding{
			Provider:       "hetzner",
			Service:        "Hetzner Firewalls",
			Severity:       provider.Severity(f.Severity),
			Category:       f.Category,
			Resource:       f.FirewallName,
			Description:    f.Description,
			Recommendation: f.Recommendation,
		}
	}
	return out
}

// ---------- API access ----------

func fetchHetznerFirewalls(ctx context.Context, token string) ([]hetznerFirewall, error) {
	var all []hetznerFirewall
	page := 1
	for {
		url := fmt.Sprintf("%s/firewalls?page=%d&per_page=50", hetznerAPIBase, page)
		var resp hetznerFirewallsResponse
		if err := hetznerFetch(ctx, token, url, &resp); err != nil {
			return nil, err
		}
		all = append(all, resp.Firewalls...)
		if resp.Meta.Pagination.NextPage == nil {
			break
		}
		page = *resp.Meta.Pagination.NextPage
	}
	return all, nil
}

func printHetznerFirewallsTable(r HetznerFirewallReport) {
	fmt.Println()
	fmt.Println("HETZNER CLOUD — FIREWALL ANALYSIS")
	fmt.Println(strings.Repeat("=", 100))
	fmt.Println()

	fmt.Println("SUMMARY")
	fmt.Println(strings.Repeat("-", 50))
	fmt.Printf("  Total Firewalls:          %d\n", r.Summary.TotalFirewalls)
	fmt.Printf("  Sensitive Port Open:      %d\n", r.Summary.OpenSensitivePort)
	fmt.Printf("  Other Port Open:          %d\n", r.Summary.OpenOtherPort)
	fmt.Printf("  Unused Firewalls:         %d\n", r.Summary.UnusedFirewalls)
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
	fmt.Fprintln(w, "SEVERITY\tCATEGORY\tFIREWALL\tDESCRIPTION\t")
	fmt.Fprintln(w, "--------\t--------\t--------\t-----------\t")
	for _, f := range r.Findings {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t\n",
			f.Severity, f.Category, f.FirewallName, f.Description)
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
