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

type HetznerFloatingIPFinding struct {
	Severity       Severity `json:"severity"`
	Category       string   `json:"category"`
	Name           string   `json:"name"`
	IP             string   `json:"ip"`
	HomeLocation   string   `json:"home_location"`
	Description    string   `json:"description"`
	Recommendation string   `json:"recommendation"`
}

type HetznerFloatingIPSummary struct {
	TotalFloatingIPs      int            `json:"total_floating_ips"`
	UnassignedFloatingIPs int            `json:"unassigned_floating_ips"`
	FindingsBySeverity    map[string]int `json:"findings_by_severity"`
}

type HetznerFloatingIPReport struct {
	Summary  HetznerFloatingIPSummary   `json:"summary"`
	Findings []HetznerFloatingIPFinding `json:"findings"`
}

// Hetzner Cloud API types (GET /floating_ips)
type hetznerFloatingIPsResponse struct {
	FloatingIPs []hetznerFloatingIP `json:"floating_ips"`
	Meta        hetznerMeta         `json:"meta"`
}

type hetznerFloatingIP struct {
	ID           int             `json:"id"`
	Name         string          `json:"name"`
	IP           string          `json:"ip"`
	Server       *int            `json:"server"`
	HomeLocation hetznerLocation `json:"home_location"`
}

// ---------- command ----------

var hetznerFloatingIPsCmd = &cobra.Command{
	Use:   "hetzner-floatingips",
	Short: "Analyze Hetzner Cloud Floating IPs for unassigned, billed addresses",
	Long: `Lists all Hetzner Cloud Floating IPs in the project and flags ones with no
server assigned — they are still billed regardless of assignment.

Requires: an HCLOUD_TOKEN with Read permission on the target project.`,
	RunE: runHetznerFloatingIPs,
}

func init() {
	analyzeCmd.AddCommand(hetznerFloatingIPsCmd)
	hetznerFloatingIPsCmd.Flags().StringVar(&flagHetznerToken, "token", "", "Hetzner Cloud API token (overrides HCLOUD_TOKEN env var)")
	hetznerFloatingIPsCmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
	provider.Register("hetzner", hetznerFloatingIPsProviderAdapter{})
}

func runHetznerFloatingIPs(cmd *cobra.Command, args []string) error {
	ctx := context.Background()

	token := getHetznerToken()
	if token == "" {
		return fmt.Errorf("hetzner API token required: set --token or HCLOUD_TOKEN env var")
	}

	report, err := computeHetznerFloatingIPsFindings(ctx, token)
	if err != nil {
		return err
	}

	switch flagOutput {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	default:
		printHetznerFloatingIPsTable(report)
	}
	return nil
}

func computeHetznerFloatingIPsFindings(ctx context.Context, token string) (HetznerFloatingIPReport, error) {
	fmt.Fprintf(os.Stderr, "Fetching Hetzner Cloud Floating IPs...\n")
	ips, err := fetchHetznerFloatingIPs(ctx, token)
	if err != nil {
		return HetznerFloatingIPReport{}, fmt.Errorf("listing floating ips: %w", err)
	}
	fmt.Fprintf(os.Stderr, "Found %d floating IP(s). Analyzing...\n", len(ips))

	summary := HetznerFloatingIPSummary{
		TotalFloatingIPs:   len(ips),
		FindingsBySeverity: map[string]int{},
	}
	findings := hetznerFloatingIPFindings(ips, &summary)

	for _, f := range findings {
		summary.FindingsBySeverity[string(f.Severity)]++
	}

	return HetznerFloatingIPReport{Summary: summary, Findings: findings}, nil
}

// hetznerFloatingIPFindings is split out from computeHetznerFloatingIPsFindings
// so the detection logic is testable against in-memory fixtures, with no
// network involved.
func hetznerFloatingIPFindings(ips []hetznerFloatingIP, summary *HetznerFloatingIPSummary) []HetznerFloatingIPFinding {
	var findings []HetznerFloatingIPFinding

	for _, ip := range ips {
		if ip.Server != nil {
			continue
		}

		summary.UnassignedFloatingIPs++
		findings = append(findings, HetznerFloatingIPFinding{
			Severity:       Warning,
			Category:       "Unassigned Floating IP",
			Name:           ip.Name,
			IP:             ip.IP,
			HomeLocation:   ip.HomeLocation.Name,
			Description:    fmt.Sprintf("'%s' (%s) is not assigned to any server", ip.Name, ip.IP),
			Recommendation: "Assign the Floating IP to a server, or delete it if it's no longer needed.",
		})
	}

	return findings
}

// ---------- provider registration ----------

type hetznerFloatingIPsProviderAdapter struct{}

func (hetznerFloatingIPsProviderAdapter) Name() string { return "hetzner-floatingips" }

func (hetznerFloatingIPsProviderAdapter) Run(ctx context.Context) ([]provider.Finding, error) {
	token := getHetznerToken()
	if token == "" {
		return nil, fmt.Errorf("hetzner API token required: set --token or HCLOUD_TOKEN env var")
	}
	report, err := computeHetznerFloatingIPsFindings(ctx, token)
	if err != nil {
		return nil, err
	}
	return hetznerFloatingIPsFindingsToProvider(report.Findings), nil
}

// hetznerFloatingIPsFindingsToProvider is split out from Run() so the
// conversion is testable without live credentials.
func hetznerFloatingIPsFindingsToProvider(findings []HetznerFloatingIPFinding) []provider.Finding {
	out := make([]provider.Finding, len(findings))
	for i, f := range findings {
		out[i] = provider.Finding{
			Provider:       "hetzner",
			Service:        "Hetzner Floating IPs",
			Severity:       provider.Severity(f.Severity),
			Category:       f.Category,
			Resource:       f.Name,
			Description:    f.Description,
			Recommendation: f.Recommendation,
		}
	}
	return out
}

// ---------- API access ----------

func fetchHetznerFloatingIPs(ctx context.Context, token string) ([]hetznerFloatingIP, error) {
	var all []hetznerFloatingIP
	page := 1
	for {
		url := fmt.Sprintf("%s/floating_ips?page=%d&per_page=50", hetznerAPIBase, page)
		var resp hetznerFloatingIPsResponse
		if err := hetznerFetch(ctx, token, url, &resp); err != nil {
			return nil, err
		}
		all = append(all, resp.FloatingIPs...)
		if resp.Meta.Pagination.NextPage == nil {
			break
		}
		page = *resp.Meta.Pagination.NextPage
	}
	return all, nil
}

func printHetznerFloatingIPsTable(r HetznerFloatingIPReport) {
	fmt.Println()
	fmt.Println("HETZNER CLOUD — FLOATING IP ANALYSIS")
	fmt.Println(strings.Repeat("=", 100))
	fmt.Println()

	fmt.Println("SUMMARY")
	fmt.Println(strings.Repeat("-", 50))
	fmt.Printf("  Total Floating IPs:   %d\n", r.Summary.TotalFloatingIPs)
	fmt.Printf("  Unassigned:           %d\n", r.Summary.UnassignedFloatingIPs)
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
	fmt.Fprintln(w, "SEVERITY\tCATEGORY\tNAME\tIP\tLOCATION\tDESCRIPTION\t")
	fmt.Fprintln(w, "--------\t--------\t----\t--\t--------\t-----------\t")
	for _, f := range r.Findings {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\t\n",
			f.Severity, f.Category, f.Name, f.IP, f.HomeLocation, f.Description)
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
