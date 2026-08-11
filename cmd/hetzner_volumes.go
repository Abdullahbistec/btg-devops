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

// hetznerVolumeGBMonthlyEUR is Hetzner's published list price per GB/month
// for Volumes (as of this writing). There is no per-resource historical
// billing API (see docs/provider-extension-plan.md §6.3), so waste is
// reported as a list-price estimate, not an actual spend trend.
const hetznerVolumeGBMonthlyEUR = 0.0440

type HetznerVolumeFinding struct {
	Severity        Severity `json:"severity"`
	Category        string   `json:"category"`
	VolumeName      string   `json:"volume_name"`
	SizeGB          int      `json:"size_gb"`
	DaysUnattached  int      `json:"days_unattached"`
	EstMonthlyWaste float64  `json:"est_monthly_waste_eur"`
	Description     string   `json:"description"`
	Recommendation  string   `json:"recommendation"`
}

type HetznerVolumeSummary struct {
	TotalVolumes       int            `json:"total_volumes"`
	UnattachedVolumes  int            `json:"unattached_volumes"`
	UnattachedGB       int            `json:"unattached_gb"`
	EstMonthlyWasteEUR float64        `json:"est_monthly_waste_eur"`
	FindingsBySeverity map[string]int `json:"findings_by_severity"`
}

type HetznerVolumeReport struct {
	Summary  HetznerVolumeSummary   `json:"summary"`
	Findings []HetznerVolumeFinding `json:"findings"`
}

// Hetzner Cloud API types (GET /volumes)
type hetznerVolumesResponse struct {
	Volumes []hetznerVolume `json:"volumes"`
	Meta    hetznerMeta     `json:"meta"`
}

type hetznerVolume struct {
	ID      int    `json:"id"`
	Name    string `json:"name"`
	Size    int    `json:"size"`
	Server  *int   `json:"server"`
	Created string `json:"created"`
}

// ---------- command ----------

var hetznerVolumesCmd = &cobra.Command{
	Use:   "hetzner-volumes",
	Short: "Analyze Hetzner Cloud volumes for unattached, billed capacity",
	Long: `Lists all Hetzner Cloud volumes in the project and flags ones with no
server attached — they are still billed by size regardless of attachment.

Requires: an HCLOUD_TOKEN with Read permission on the target project.`,
	RunE: runHetznerVolumes,
}

func init() {
	analyzeCmd.AddCommand(hetznerVolumesCmd)
	hetznerVolumesCmd.Flags().StringVar(&flagHetznerToken, "token", "", "Hetzner Cloud API token (overrides HCLOUD_TOKEN env var)")
	hetznerVolumesCmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
	provider.Register("hetzner", hetznerVolumesProviderAdapter{})
}

func runHetznerVolumes(cmd *cobra.Command, args []string) error {
	ctx := context.Background()

	token := getHetznerToken()
	if token == "" {
		return fmt.Errorf("hetzner API token required: set --token or HCLOUD_TOKEN env var")
	}

	report, err := computeHetznerVolumesFindings(ctx, token)
	if err != nil {
		return err
	}

	switch flagOutput {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	default:
		printHetznerVolumesTable(report)
	}
	return nil
}

func computeHetznerVolumesFindings(ctx context.Context, token string) (HetznerVolumeReport, error) {
	fmt.Fprintf(os.Stderr, "Fetching Hetzner Cloud volumes...\n")
	volumes, err := fetchHetznerVolumes(ctx, token)
	if err != nil {
		return HetznerVolumeReport{}, fmt.Errorf("listing volumes: %w", err)
	}
	fmt.Fprintf(os.Stderr, "Found %d volume(s). Analyzing...\n", len(volumes))

	summary := HetznerVolumeSummary{
		TotalVolumes:       len(volumes),
		FindingsBySeverity: map[string]int{},
	}
	findings := hetznerVolumeFindings(volumes, &summary)

	for _, f := range findings {
		summary.FindingsBySeverity[string(f.Severity)]++
	}

	return HetznerVolumeReport{Summary: summary, Findings: findings}, nil
}

// hetznerVolumeFindings is split out from computeHetznerVolumesFindings so
// the detection logic is testable against in-memory fixtures, with no
// network involved.
func hetznerVolumeFindings(volumes []hetznerVolume, summary *HetznerVolumeSummary) []HetznerVolumeFinding {
	var findings []HetznerVolumeFinding

	for _, v := range volumes {
		if v.Server != nil {
			continue
		}

		days := hetznerDaysSince(v.Created)
		waste := float64(v.Size) * hetznerVolumeGBMonthlyEUR

		summary.UnattachedVolumes++
		summary.UnattachedGB += v.Size
		summary.EstMonthlyWasteEUR += waste

		// Freshly-created (still being provisioned) volumes get a lower
		// severity than ones that have clearly sat unattached for a while.
		sev := Warning
		if days >= 7 {
			sev = Critical
		}

		findings = append(findings, HetznerVolumeFinding{
			Severity:        sev,
			Category:        "Unattached Volume",
			VolumeName:      v.Name,
			SizeGB:          v.Size,
			DaysUnattached:  days,
			EstMonthlyWaste: waste,
			Description:     fmt.Sprintf("'%s' (%dGB) is not attached to any server — est. €%.2f/month at list price", v.Name, v.Size, waste),
			Recommendation:  "Attach the volume to a server, or delete it if it's no longer needed.",
		})
	}

	return findings
}

// ---------- provider registration ----------

type hetznerVolumesProviderAdapter struct{}

func (hetznerVolumesProviderAdapter) Name() string { return "hetzner-volumes" }

func (hetznerVolumesProviderAdapter) Run(ctx context.Context) ([]provider.Finding, error) {
	token := getHetznerToken()
	if token == "" {
		return nil, fmt.Errorf("hetzner API token required: set --token or HCLOUD_TOKEN env var")
	}
	report, err := computeHetznerVolumesFindings(ctx, token)
	if err != nil {
		return nil, err
	}
	return hetznerVolumesFindingsToProvider(report.Findings), nil
}

// hetznerVolumesFindingsToProvider is split out from Run() so the
// conversion is testable without live credentials.
func hetznerVolumesFindingsToProvider(findings []HetznerVolumeFinding) []provider.Finding {
	out := make([]provider.Finding, len(findings))
	for i, f := range findings {
		out[i] = provider.Finding{
			Provider:       "hetzner",
			Service:        "Hetzner Volumes",
			Severity:       provider.Severity(f.Severity),
			Category:       f.Category,
			Resource:       f.VolumeName,
			Description:    f.Description,
			Recommendation: f.Recommendation,
		}
	}
	return out
}

// ---------- API access ----------

func fetchHetznerVolumes(ctx context.Context, token string) ([]hetznerVolume, error) {
	var all []hetznerVolume
	page := 1
	for {
		url := fmt.Sprintf("%s/volumes?page=%d&per_page=50", hetznerAPIBase, page)
		var resp hetznerVolumesResponse
		if err := hetznerFetch(ctx, token, url, &resp); err != nil {
			return nil, err
		}
		all = append(all, resp.Volumes...)
		if resp.Meta.Pagination.NextPage == nil {
			break
		}
		page = *resp.Meta.Pagination.NextPage
	}
	return all, nil
}

func printHetznerVolumesTable(r HetznerVolumeReport) {
	fmt.Println()
	fmt.Println("HETZNER CLOUD — VOLUME ANALYSIS")
	fmt.Println(strings.Repeat("=", 100))
	fmt.Println()

	fmt.Println("SUMMARY")
	fmt.Println(strings.Repeat("-", 50))
	fmt.Printf("  Total Volumes:        %d\n", r.Summary.TotalVolumes)
	fmt.Printf("  Unattached:           %d (%dGB)\n", r.Summary.UnattachedVolumes, r.Summary.UnattachedGB)
	if r.Summary.EstMonthlyWasteEUR > 0 {
		fmt.Printf("  Est. Monthly Waste:   €%.2f (list price)\n", r.Summary.EstMonthlyWasteEUR)
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
	fmt.Fprintln(w, "SEVERITY\tCATEGORY\tVOLUME\tSIZE\tDAYS UNATTACHED\tDESCRIPTION\t")
	fmt.Fprintln(w, "--------\t--------\t------\t----\t---------------\t-----------\t")
	for _, f := range r.Findings {
		fmt.Fprintf(w, "%s\t%s\t%s\t%dGB\t%d\t%s\t\n",
			f.Severity, f.Category, f.VolumeName, f.SizeGB, f.DaysUnattached, f.Description)
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
