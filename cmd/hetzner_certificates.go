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

type HetznerCertificateFinding struct {
	Severity       Severity `json:"severity"`
	Category       string   `json:"category"`
	CertName       string   `json:"cert_name"`
	ExpiresOn      string   `json:"expires_on"`
	DaysRemaining  int      `json:"days_remaining"` // negative = already expired
	Recommendation string   `json:"recommendation"`
}

type HetznerCertificateSummary struct {
	TotalCertificates  int            `json:"total_certificates"`
	Expired            int            `json:"expired"`
	ExpiringWithin30   int            `json:"expiring_within_30_days"`
	ExpiringWithin60   int            `json:"expiring_within_60_days"`
	ExpiringWithin90   int            `json:"expiring_within_90_days"`
	IssuanceFailed     int            `json:"issuance_failed"`
	RenewalFailed      int            `json:"renewal_failed"`
	FindingsBySeverity map[string]int `json:"findings_by_severity"`
}

type HetznerCertificateReport struct {
	Summary  HetznerCertificateSummary   `json:"summary"`
	Findings []HetznerCertificateFinding `json:"findings"`
}

// Hetzner Cloud API types (GET /certificates)
type hetznerCertificatesResponse struct {
	Certificates []hetznerCertificate `json:"certificates"`
	Meta         hetznerMeta          `json:"meta"`
}

type hetznerCertificate struct {
	ID            int                `json:"id"`
	Name          string             `json:"name"`
	Type          string             `json:"type"` // "uploaded" or "managed"
	NotValidAfter string             `json:"not_valid_after"`
	Status        *hetznerCertStatus `json:"status"` // only present for "managed" certs
}

type hetznerCertStatus struct {
	Issuance string `json:"issuance"` // pending, completed, failed
	Renewal  string `json:"renewal"`  // scheduled, pending, completed, failed
}

// ---------- command ----------

var hetznerCertificatesCmd = &cobra.Command{
	Use:   "hetzner-certificates",
	Short: "Scan Hetzner Cloud certificates for expiring or failed TLS certificates",
	Long: `Scans all Hetzner Cloud certificates (uploaded and Hetzner-managed) and flags:
  - Already expired certificates (Critical)
  - Expiring within 30 days (Critical)
  - Expiring within 60 days (Warning)
  - Expiring within 90 days (Info)
  - Managed certificates that failed issuance or auto-renewal

Requires: an HCLOUD_TOKEN with Read permission on the target project.`,
	RunE: runHetznerCertificates,
}

func init() {
	analyzeCmd.AddCommand(hetznerCertificatesCmd)
	hetznerCertificatesCmd.Flags().StringVar(&flagHetznerToken, "token", "", "Hetzner Cloud API token (overrides HCLOUD_TOKEN env var)")
	hetznerCertificatesCmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
	provider.Register("hetzner", hetznerCertificatesProviderAdapter{})
}

func runHetznerCertificates(cmd *cobra.Command, args []string) error {
	ctx := context.Background()

	token := getHetznerToken()
	if token == "" {
		return fmt.Errorf("hetzner API token required: set --token or HCLOUD_TOKEN env var")
	}

	report, err := computeHetznerCertificatesFindings(ctx, token)
	if err != nil {
		return err
	}

	switch flagOutput {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	default:
		printHetznerCertificatesTable(report)
	}
	return nil
}

func computeHetznerCertificatesFindings(ctx context.Context, token string) (HetznerCertificateReport, error) {
	fmt.Fprintf(os.Stderr, "Fetching Hetzner Cloud certificates...\n")
	certs, err := fetchHetznerCertificates(ctx, token)
	if err != nil {
		return HetznerCertificateReport{}, fmt.Errorf("listing certificates: %w", err)
	}
	fmt.Fprintf(os.Stderr, "Found %d certificate(s). Analyzing...\n", len(certs))

	summary := HetznerCertificateSummary{
		TotalCertificates:  len(certs),
		FindingsBySeverity: map[string]int{},
	}
	findings := hetznerCertificateFindings(certs, &summary)

	for _, f := range findings {
		summary.FindingsBySeverity[string(f.Severity)]++
	}

	return HetznerCertificateReport{Summary: summary, Findings: findings}, nil
}

// hetznerCertificateFindings is split out from computeHetznerCertificatesFindings
// so the detection logic is testable against in-memory fixtures, with no
// network involved.
func hetznerCertificateFindings(certs []hetznerCertificate, summary *HetznerCertificateSummary) []HetznerCertificateFinding {
	var findings []HetznerCertificateFinding

	for _, c := range certs {
		if f := hetznerEvalCertExpiry(c, summary); f != nil {
			findings = append(findings, *f)
		}

		if c.Status == nil {
			continue
		}
		if c.Status.Issuance == "failed" {
			summary.IssuanceFailed++
			findings = append(findings, HetznerCertificateFinding{
				Severity:       Critical,
				Category:       "Certificate Issuance Failed",
				CertName:       c.Name,
				ExpiresOn:      c.NotValidAfter,
				Recommendation: "Check the certificate's domain validation (DNS/HTTP challenge) and re-trigger issuance.",
			})
		} else if c.Status.Renewal == "failed" {
			summary.RenewalFailed++
			findings = append(findings, HetznerCertificateFinding{
				Severity:       Warning,
				Category:       "Certificate Renewal Failed",
				CertName:       c.Name,
				ExpiresOn:      c.NotValidAfter,
				Recommendation: "Check the certificate's domain validation — automatic renewal will keep failing until it's resolved.",
			})
		}
	}

	return findings
}

func hetznerEvalCertExpiry(c hetznerCertificate, summary *HetznerCertificateSummary) *HetznerCertificateFinding {
	daysRemaining, ok := hetznerDaysUntil(c.NotValidAfter)
	if !ok {
		return nil
	}

	var severity Severity
	var category string

	switch {
	case daysRemaining < 0:
		severity = Critical
		category = "Expired Certificate"
		summary.Expired++
	case daysRemaining <= 30:
		severity = Critical
		category = "Expiring Within 30 Days"
		summary.ExpiringWithin30++
	case daysRemaining <= 60:
		severity = Warning
		category = "Expiring Within 60 Days"
		summary.ExpiringWithin60++
	case daysRemaining <= 90:
		severity = Info
		category = "Expiring Within 90 Days"
		summary.ExpiringWithin90++
	default:
		return nil
	}

	var rec string
	if daysRemaining < 0 {
		rec = fmt.Sprintf("Renew this certificate immediately — it expired %d days ago.", -daysRemaining)
	} else {
		rec = fmt.Sprintf("Renew this certificate before it expires in %d days.", daysRemaining)
	}

	return &HetznerCertificateFinding{
		Severity:       severity,
		Category:       category,
		CertName:       c.Name,
		ExpiresOn:      c.NotValidAfter,
		DaysRemaining:  daysRemaining,
		Recommendation: rec,
	}
}

// ---------- provider registration ----------

type hetznerCertificatesProviderAdapter struct{}

func (hetznerCertificatesProviderAdapter) Name() string { return "hetzner-certificates" }

func (hetznerCertificatesProviderAdapter) Run(ctx context.Context) ([]provider.Finding, error) {
	token := getHetznerToken()
	if token == "" {
		return nil, fmt.Errorf("hetzner API token required: set --token or HCLOUD_TOKEN env var")
	}
	report, err := computeHetznerCertificatesFindings(ctx, token)
	if err != nil {
		return nil, err
	}
	return hetznerCertificatesFindingsToProvider(report.Findings), nil
}

// hetznerCertificatesFindingsToProvider is split out from Run() so the
// conversion is testable without live credentials.
func hetznerCertificatesFindingsToProvider(findings []HetznerCertificateFinding) []provider.Finding {
	out := make([]provider.Finding, len(findings))
	for i, f := range findings {
		out[i] = provider.Finding{
			Provider:       "hetzner",
			Service:        "Hetzner Certificates",
			Severity:       provider.Severity(f.Severity),
			Category:       f.Category,
			Resource:       f.CertName,
			Description:    fmt.Sprintf("%s — expires %s", f.CertName, f.ExpiresOn),
			Recommendation: f.Recommendation,
		}
	}
	return out
}

// ---------- API access ----------

func fetchHetznerCertificates(ctx context.Context, token string) ([]hetznerCertificate, error) {
	var all []hetznerCertificate
	page := 1
	for {
		url := fmt.Sprintf("%s/certificates?page=%d&per_page=50", hetznerAPIBase, page)
		var resp hetznerCertificatesResponse
		if err := hetznerFetch(ctx, token, url, &resp); err != nil {
			return nil, err
		}
		all = append(all, resp.Certificates...)
		if resp.Meta.Pagination.NextPage == nil {
			break
		}
		page = *resp.Meta.Pagination.NextPage
	}
	return all, nil
}

func printHetznerCertificatesTable(r HetznerCertificateReport) {
	fmt.Println()
	fmt.Println("HETZNER CLOUD — CERTIFICATE EXPIRY")
	fmt.Println(strings.Repeat("=", 100))
	fmt.Println()

	fmt.Println("SUMMARY")
	fmt.Println(strings.Repeat("-", 50))
	fmt.Printf("  Certificates Scanned:     %d\n", r.Summary.TotalCertificates)
	fmt.Printf("  Already Expired:          %d\n", r.Summary.Expired)
	fmt.Printf("  Expiring Within 30 Days:  %d\n", r.Summary.ExpiringWithin30)
	fmt.Printf("  Expiring Within 60 Days:  %d\n", r.Summary.ExpiringWithin60)
	fmt.Printf("  Expiring Within 90 Days:  %d\n", r.Summary.ExpiringWithin90)
	fmt.Printf("  Issuance Failed:          %d\n", r.Summary.IssuanceFailed)
	fmt.Printf("  Renewal Failed:           %d\n", r.Summary.RenewalFailed)
	fmt.Println()

	fmt.Println("FINDINGS")
	fmt.Println(strings.Repeat("-", 50))
	fmt.Printf("  Critical: %d  |  Warning: %d  |  Info: %d\n",
		r.Summary.FindingsBySeverity["Critical"],
		r.Summary.FindingsBySeverity["Warning"],
		r.Summary.FindingsBySeverity["Info"])
	fmt.Println()

	if len(r.Findings) == 0 {
		fmt.Println("  No expiring or failed certificates found within 90 days.")
		return
	}

	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "SEVERITY\tCATEGORY\tCERTIFICATE\tEXPIRES ON\tDAYS\t")
	fmt.Fprintln(w, "--------\t--------\t-----------\t----------\t----\t")
	for _, f := range r.Findings {
		days := fmt.Sprintf("%d", f.DaysRemaining)
		if f.DaysRemaining < 0 {
			days = fmt.Sprintf("%d (EXPIRED)", f.DaysRemaining)
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t\n",
			f.Severity, f.Category, f.CertName, f.ExpiresOn, days)
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
		fmt.Printf("  %s [%s] %s: %s\n", icon, f.Severity, f.CertName, f.Recommendation)
	}
	fmt.Println()
}
