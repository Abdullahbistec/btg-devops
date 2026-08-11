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

type HetznerServerFinding struct {
	Severity       Severity `json:"severity"`
	Category       string   `json:"category"`
	ServerName     string   `json:"server_name"`
	Datacenter     string   `json:"datacenter"`
	Description    string   `json:"description"`
	Recommendation string   `json:"recommendation"`
}

type HetznerServerSummary struct {
	TotalServers       int            `json:"total_servers"`
	StoppedServers     int            `json:"stopped_servers"`
	NoFirewall         int            `json:"no_firewall"`
	DeprecatedImage    int            `json:"deprecated_image"`
	NoBackups          int            `json:"no_backups"`
	FindingsBySeverity map[string]int `json:"findings_by_severity"`
}

type HetznerServerReport struct {
	Summary  HetznerServerSummary   `json:"summary"`
	Findings []HetznerServerFinding `json:"findings"`
}

// Hetzner Cloud API types (GET /servers)
type hetznerServersResponse struct {
	Servers []hetznerServer `json:"servers"`
	Meta    hetznerMeta     `json:"meta"`
}

type hetznerServer struct {
	ID           int               `json:"id"`
	Name         string            `json:"name"`
	Status       string            `json:"status"`
	Created      string            `json:"created"`
	BackupWindow string            `json:"backup_window"`
	Datacenter   hetznerDatacenter `json:"datacenter"`
	Image        *hetznerImage     `json:"image"`
	PublicNet    hetznerPublicNet  `json:"public_net"`
}

type hetznerDatacenter struct {
	Name     string          `json:"name"`
	Location hetznerLocation `json:"location"`
}

type hetznerLocation struct {
	Name string `json:"name"`
}

type hetznerImage struct {
	ID         int    `json:"id"`
	Name       string `json:"name"`
	Deprecated string `json:"deprecated"`
}

type hetznerPublicNet struct {
	Firewalls []hetznerAppliedFirewall `json:"firewalls"`
}

type hetznerAppliedFirewall struct {
	ID     int    `json:"id"`
	Status string `json:"status"`
}

// ---------- command ----------

var hetznerServersCmd = &cobra.Command{
	Use:   "hetzner-servers",
	Short: "Analyze Hetzner Cloud servers for cost waste, missing firewalls, and stale images",
	Long: `Lists all Hetzner Cloud servers in the project and checks for:
  - Stopped servers (still billed while powered off)
  - Servers with no Firewall attached at all
  - Servers booted from a deprecated Image
  - Servers with no backup window configured

Requires: an HCLOUD_TOKEN with Read permission on the target project.`,
	RunE: runHetznerServers,
}

func init() {
	analyzeCmd.AddCommand(hetznerServersCmd)
	hetznerServersCmd.Flags().StringVar(&flagHetznerToken, "token", "", "Hetzner Cloud API token (overrides HCLOUD_TOKEN env var)")
	hetznerServersCmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
	provider.Register("hetzner", hetznerServersProviderAdapter{})
}

func runHetznerServers(cmd *cobra.Command, args []string) error {
	ctx := context.Background()

	token := getHetznerToken()
	if token == "" {
		return fmt.Errorf("hetzner API token required: set --token or HCLOUD_TOKEN env var")
	}

	report, err := computeHetznerServersFindings(ctx, token)
	if err != nil {
		return err
	}

	switch flagOutput {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	default:
		printHetznerServersTable(report)
	}
	return nil
}

func computeHetznerServersFindings(ctx context.Context, token string) (HetznerServerReport, error) {
	fmt.Fprintf(os.Stderr, "Fetching Hetzner Cloud servers...\n")
	servers, err := fetchHetznerServers(ctx, token)
	if err != nil {
		return HetznerServerReport{}, fmt.Errorf("listing servers: %w", err)
	}
	fmt.Fprintf(os.Stderr, "Found %d server(s). Analyzing...\n", len(servers))

	summary := HetznerServerSummary{
		TotalServers:       len(servers),
		FindingsBySeverity: map[string]int{},
	}
	findings := hetznerServerFindings(servers, &summary)

	for _, f := range findings {
		summary.FindingsBySeverity[string(f.Severity)]++
	}

	return HetznerServerReport{Summary: summary, Findings: findings}, nil
}

// hetznerServerFindings is split out from computeHetznerServersFindings so
// the detection logic is testable against in-memory fixtures, with no
// network involved.
func hetznerServerFindings(servers []hetznerServer, summary *HetznerServerSummary) []HetznerServerFinding {
	var findings []HetznerServerFinding

	for _, s := range servers {
		dc := s.Datacenter.Name

		// 1. Stopped server — Hetzner bills reserved compute/storage
		// regardless of power state, so "off" is pure wasted spend.
		if s.Status == "off" {
			summary.StoppedServers++
			findings = append(findings, HetznerServerFinding{
				Severity:       Warning,
				Category:       "Stopped Server — Still Billed",
				ServerName:     s.Name,
				Datacenter:     dc,
				Description:    fmt.Sprintf("'%s' is powered off but still billed at the full server rate", s.Name),
				Recommendation: "Delete the server if it's no longer needed, or power it back on if it is.",
			})
		}

		// 2. No firewall attached at all.
		if len(s.PublicNet.Firewalls) == 0 {
			summary.NoFirewall++
			findings = append(findings, HetznerServerFinding{
				Severity:       Warning,
				Category:       "No Firewall Attached",
				ServerName:     s.Name,
				Datacenter:     dc,
				Description:    fmt.Sprintf("'%s' has no Firewall applied — all ports are reachable from the internet unless filtered elsewhere", s.Name),
				Recommendation: "Attach a Firewall restricting inbound traffic to only the ports this server needs to expose.",
			})
		}

		// 3. Deprecated image — deprecated images are removed ~3 months
		// after deprecation, breaking future rebuilds/rescues.
		if s.Image != nil && s.Image.Deprecated != "" {
			summary.DeprecatedImage++
			findings = append(findings, HetznerServerFinding{
				Severity:       Info,
				Category:       "Deprecated Image",
				ServerName:     s.Name,
				Datacenter:     dc,
				Description:    fmt.Sprintf("'%s' was created from image '%s', deprecated on %s", s.Name, s.Image.Name, s.Image.Deprecated[:10]),
				Recommendation: "Rebuild or snapshot onto a current image before the deprecated one is removed.",
			})
		}

		// 4. No backup window configured.
		if s.BackupWindow == "" {
			summary.NoBackups++
			findings = append(findings, HetznerServerFinding{
				Severity:       Info,
				Category:       "Backups Disabled",
				ServerName:     s.Name,
				Datacenter:     dc,
				Description:    fmt.Sprintf("'%s' has no backup window configured — no automatic recovery point exists", s.Name),
				Recommendation: "Enable Backups (adds ~20%% to the server's price) or take Snapshots on a regular schedule.",
			})
		}
	}

	return findings
}

// ---------- provider registration ----------

type hetznerServersProviderAdapter struct{}

func (hetznerServersProviderAdapter) Name() string { return "hetzner-servers" }

func (hetznerServersProviderAdapter) Run(ctx context.Context) ([]provider.Finding, error) {
	token := getHetznerToken()
	if token == "" {
		return nil, fmt.Errorf("hetzner API token required: set --token or HCLOUD_TOKEN env var")
	}
	report, err := computeHetznerServersFindings(ctx, token)
	if err != nil {
		return nil, err
	}
	return hetznerServersFindingsToProvider(report.Findings), nil
}

// hetznerServersFindingsToProvider is split out from Run() so the conversion
// is testable without live credentials.
func hetznerServersFindingsToProvider(findings []HetznerServerFinding) []provider.Finding {
	out := make([]provider.Finding, len(findings))
	for i, f := range findings {
		out[i] = provider.Finding{
			Provider:       "hetzner",
			Service:        "Hetzner Servers",
			Severity:       provider.Severity(f.Severity),
			Category:       f.Category,
			Resource:       f.ServerName,
			Description:    f.Description,
			Recommendation: f.Recommendation,
		}
	}
	return out
}

// ---------- API access ----------

func fetchHetznerServers(ctx context.Context, token string) ([]hetznerServer, error) {
	var all []hetznerServer
	page := 1
	for {
		url := fmt.Sprintf("%s/servers?page=%d&per_page=50", hetznerAPIBase, page)
		var resp hetznerServersResponse
		if err := hetznerFetch(ctx, token, url, &resp); err != nil {
			return nil, err
		}
		all = append(all, resp.Servers...)
		if resp.Meta.Pagination.NextPage == nil {
			break
		}
		page = *resp.Meta.Pagination.NextPage
	}
	return all, nil
}

func printHetznerServersTable(r HetznerServerReport) {
	fmt.Println()
	fmt.Println("HETZNER CLOUD — SERVER ANALYSIS")
	fmt.Println(strings.Repeat("=", 100))
	fmt.Println()

	fmt.Println("SUMMARY")
	fmt.Println(strings.Repeat("-", 50))
	fmt.Printf("  Total Servers:        %d\n", r.Summary.TotalServers)
	fmt.Printf("  Stopped (billed):     %d\n", r.Summary.StoppedServers)
	fmt.Printf("  No Firewall:          %d\n", r.Summary.NoFirewall)
	fmt.Printf("  Deprecated Image:     %d\n", r.Summary.DeprecatedImage)
	fmt.Printf("  No Backups:           %d\n", r.Summary.NoBackups)
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
	fmt.Fprintln(w, "SEVERITY\tCATEGORY\tSERVER\tDATACENTER\tDESCRIPTION\t")
	fmt.Fprintln(w, "--------\t--------\t------\t----------\t-----------\t")
	for _, f := range r.Findings {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t\n",
			f.Severity, f.Category, f.ServerName, f.Datacenter, f.Description)
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
