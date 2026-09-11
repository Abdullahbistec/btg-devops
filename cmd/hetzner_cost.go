package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"
)

// ---------- data types ----------

// HetznerCostLine is the per-server-type (or per-category) rollup within a
// HetznerCostReport.
type HetznerCostLine struct {
	Count        int     `json:"count"`
	MonthlyTotal float64 `json:"monthly_total"`
}

// HetznerCostReport is a list-price estimate of the monthly Hetzner run
// rate, built from live pricing data plus the account's actual resources.
//
// This is explicitly NOT a bill — Hetzner exposes no invoice endpoint, so
// Estimate is always true and Note explains that. A resource whose price
// cannot be looked up (an unrecognized server type/location, e.g.) is
// recorded in Unpriced and excluded from TotalMonthly rather than silently
// counted as 0 — a pricing gap must stay visible, not understate the total.
type HetznerCostReport struct {
	Currency     string                     `json:"currency"`
	TotalMonthly float64                    `json:"total_monthly"`
	ByCategory   map[string]float64         `json:"by_category"`
	ByType       map[string]HetznerCostLine `json:"by_type"`
	Unpriced     []string                   `json:"unpriced,omitempty"`
	Estimate     bool                       `json:"estimate"`
	Note         string                     `json:"note"`
}

// Hetzner Cloud API types (GET /primary_ips)
type hetznerPrimaryIPsResponse struct {
	PrimaryIPs []hetznerPrimaryIP `json:"primary_ips"`
	Meta       hetznerMeta        `json:"meta"`
}

type hetznerPrimaryIP struct {
	ID         int               `json:"id"`
	Name       string            `json:"name"`
	Type       string            `json:"type"`
	Datacenter hetznerDatacenter `json:"datacenter"`
}

// ---------- report building ----------

// hetznerCostReport prices every server, volume, and primary IP against
// live list pricing and rolls the totals up by category and server type.
//
// Powered-off servers count toward the run rate — Hetzner bills for them
// regardless of power state, which is exactly why hetzner_servers.go
// separately flags them as "Stopped Server — Still Billed" waste. That is
// a different concern from this command's job of estimating what the
// account actually costs per month.
func hetznerCostReport(servers []hetznerServer, volumes []hetznerVolume, ips []hetznerPrimaryIP, p *hetznerPricing) HetznerCostReport {
	r := HetznerCostReport{
		Currency:   p.Currency(),
		ByCategory: map[string]float64{},
		ByType:     map[string]HetznerCostLine{},
		Estimate:   true,
		Note:       "List-price estimate from the Hetzner pricing API. Not a bill — Hetzner exposes no invoice endpoint.",
	}

	for _, s := range servers {
		cost, ok := hetznerServerMonthlyCost(s, p)
		if !ok {
			r.Unpriced = append(r.Unpriced, fmt.Sprintf("server %s (type %s)", s.Name, s.ServerType.Name))
			continue
		}
		r.ByCategory["servers"] += cost
		line := r.ByType[s.ServerType.Name]
		line.Count++
		line.MonthlyTotal += cost
		r.ByType[s.ServerType.Name] = line
	}

	perGB := p.VolumeMonthlyPerGB()
	for _, v := range volumes {
		r.ByCategory["volumes"] += float64(v.Size) * perGB
	}

	for _, ip := range ips {
		cost, ok := p.PrimaryIPMonthly(ip.Type, ip.Datacenter.Location.Name)
		if !ok {
			r.Unpriced = append(r.Unpriced, fmt.Sprintf("primary ip %s (type %s)", ip.Name, ip.Type))
			continue
		}
		r.ByCategory["primary_ips"] += cost
	}

	for _, v := range r.ByCategory {
		r.TotalMonthly += v
	}
	return r
}

// ---------- command ----------

var hetznerCostCmd = &cobra.Command{
	Use:   "hetzner-cost",
	Short: "Estimate monthly Hetzner run rate from live list pricing",
	Long: `Estimates the monthly Hetzner Cloud run rate for servers, volumes, and
primary IPs, priced from Hetzner's live pricing API.

This is a list-price ESTIMATE, not a bill — Hetzner exposes no invoice
endpoint. Any resource whose price cannot be looked up is reported in the
"unpriced" list rather than silently counted as zero.

Requires: an HCLOUD_TOKEN with Read permission on the target project.`,
	RunE: runHetznerCost,
}

func init() {
	analyzeCmd.AddCommand(hetznerCostCmd)
	hetznerCostCmd.Flags().StringVar(&flagHetznerToken, "token", "", "Hetzner Cloud API token (overrides HCLOUD_TOKEN env var)")
	hetznerCostCmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
}

func runHetznerCost(cmd *cobra.Command, args []string) error {
	ctx := context.Background()

	token := getHetznerToken()
	if token == "" {
		return fmt.Errorf("hetzner API token required: set --token or HCLOUD_TOKEN env var")
	}

	report, err := computeHetznerCostReport(ctx, token)
	if err != nil {
		return err
	}

	switch flagOutput {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	default:
		printHetznerCostTable(report)
	}
	return nil
}

func computeHetznerCostReport(ctx context.Context, token string) (HetznerCostReport, error) {
	fmt.Fprintf(os.Stderr, "Fetching Hetzner Cloud pricing...\n")
	pricing, err := fetchHetznerPricing(ctx, token)
	if err != nil {
		return HetznerCostReport{}, fmt.Errorf("fetching hetzner pricing: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Fetching Hetzner Cloud servers...\n")
	servers, err := fetchHetznerServers(ctx, token)
	if err != nil {
		return HetznerCostReport{}, fmt.Errorf("listing servers: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Fetching Hetzner Cloud volumes...\n")
	volumes, err := fetchHetznerVolumes(ctx, token)
	if err != nil {
		return HetznerCostReport{}, fmt.Errorf("listing volumes: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Fetching Hetzner Cloud primary IPs...\n")
	ips, err := fetchHetznerPrimaryIPs(ctx, token)
	if err != nil {
		return HetznerCostReport{}, fmt.Errorf("listing primary ips: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Pricing %d server(s), %d volume(s), %d primary IP(s)...\n", len(servers), len(volumes), len(ips))
	return hetznerCostReport(servers, volumes, ips, pricing), nil
}

// ---------- API access ----------

func fetchHetznerPrimaryIPs(ctx context.Context, token string) ([]hetznerPrimaryIP, error) {
	var all []hetznerPrimaryIP
	page := 1
	for {
		url := fmt.Sprintf("%s/primary_ips?page=%d&per_page=50", hetznerAPIBase, page)
		var resp hetznerPrimaryIPsResponse
		if err := hetznerFetch(ctx, token, url, &resp); err != nil {
			return nil, err
		}
		all = append(all, resp.PrimaryIPs...)
		if resp.Meta.Pagination.NextPage == nil {
			break
		}
		page = *resp.Meta.Pagination.NextPage
	}
	return all, nil
}

// ---------- output ----------

func printHetznerCostTable(r HetznerCostReport) {
	fmt.Println()
	fmt.Println("HETZNER CLOUD — MONTHLY RUN-RATE ESTIMATE")
	fmt.Println(strings.Repeat("=", 100))
	fmt.Println()
	fmt.Println("This is a list-price ESTIMATE, not a bill — Hetzner exposes no invoice endpoint.")
	fmt.Println()

	fmt.Println("BY CATEGORY")
	fmt.Println(strings.Repeat("-", 50))
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	for _, cat := range []string{"servers", "volumes", "primary_ips"} {
		if v, ok := r.ByCategory[cat]; ok {
			fmt.Fprintf(w, "  %s\t%.2f %s\n", cat, v, r.Currency)
		}
	}
	w.Flush()
	fmt.Println()

	if len(r.ByType) > 0 {
		fmt.Println("BY SERVER TYPE")
		fmt.Println(strings.Repeat("-", 50))
		w2 := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(w2, "TYPE\tCOUNT\tMONTHLY TOTAL\t")
		fmt.Fprintln(w2, "----\t-----\t-------------\t")
		for name, line := range r.ByType {
			fmt.Fprintf(w2, "%s\t%d\t%.2f %s\t\n", name, line.Count, line.MonthlyTotal, r.Currency)
		}
		w2.Flush()
		fmt.Println()
	}

	if len(r.Unpriced) > 0 {
		fmt.Println("UNPRICED (excluded from total — pricing lookup missed)")
		fmt.Println(strings.Repeat("-", 50))
		for _, u := range r.Unpriced {
			fmt.Printf("  - %s\n", u)
		}
		fmt.Println()
	}

	fmt.Printf("TOTAL ESTIMATED MONTHLY RUN RATE: %.2f %s\n", r.TotalMonthly, r.Currency)
	fmt.Println()
}
