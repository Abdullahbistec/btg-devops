package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/chanbistec/btg-devops/provider"
	"github.com/spf13/cobra"
)

// ---------- data types ----------

type SPExpiryFinding struct {
	Severity       Severity `json:"severity"`
	Category       string   `json:"category"`
	AppName        string   `json:"app_name"`
	AppID          string   `json:"app_id"`
	CredentialName string   `json:"credential_name"`
	CredentialType string   `json:"credential_type"` // "Secret" or "Certificate"
	ExpiresOn      string   `json:"expires_on"`
	DaysRemaining  int      `json:"days_remaining"` // negative = already expired
	Recommendation string   `json:"recommendation"`
}

type SPExpirySummary struct {
	TotalApps          int            `json:"total_apps"`
	TotalCredentials   int            `json:"total_credentials"`
	Expired            int            `json:"expired"`
	ExpiringWithin30   int            `json:"expiring_within_30_days"`
	ExpiringWithin60   int            `json:"expiring_within_60_days"`
	ExpiringWithin90   int            `json:"expiring_within_90_days"`
	FindingsBySeverity map[string]int `json:"findings_by_severity"`
}

type SPExpiryReport struct {
	Summary  SPExpirySummary   `json:"summary"`
	Findings []SPExpiryFinding `json:"findings"`
}

// Graph API types for app registrations
type graphAppsResponse struct {
	Value    []graphApp `json:"value"`
	NextLink string     `json:"@odata.nextLink"`
}

type graphApp struct {
	DisplayName         string            `json:"displayName"`
	AppID               string            `json:"appId"`
	PasswordCredentials []graphPassCred   `json:"passwordCredentials"`
	KeyCredentials      []graphKeyCred    `json:"keyCredentials"`
}

type graphPassCred struct {
	KeyID         string `json:"keyId"`
	DisplayName   string `json:"displayName"`
	EndDateTime   string `json:"endDateTime"`
}

type graphKeyCred struct {
	KeyID         string `json:"keyId"`
	DisplayName   string `json:"displayName"`
	Type          string `json:"type"`
	Usage         string `json:"usage"`
	EndDateTime   string `json:"endDateTime"`
}

// ---------- command ----------

var spExpiryCmd = &cobra.Command{
	Use:   "sp-expiry",
	Short: "Scan app registrations for expiring or expired secrets and certificates",
	Long: `Scans all Azure AD app registrations and flags credentials expiring within 90 days:
  - Already expired secrets/certificates (Critical)
  - Expiring within 30 days (Critical)
  - Expiring within 60 days (Warning)
  - Expiring within 90 days (Info)

Expired secrets cause silent auth failures and production outages.

Requires: Application.Read.All permission on the service principal (Microsoft Graph).`,
	RunE: runSPExpiry,
}

func init() {
	analyzeCmd.AddCommand(spExpiryCmd)
	spExpiryCmd.Flags().StringVar(&flagTenantID, "tenant-id", "", "Azure Tenant ID (overrides AZURE_TENANT_ID env var)")
	spExpiryCmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
	provider.Register("azure", spExpiryProviderAdapter{})
}

func runSPExpiry(cmd *cobra.Command, args []string) error {
	ctx := context.Background()

	tenantID := getTenantID()
	if tenantID == "" {
		return fmt.Errorf("tenant ID required: set --tenant-id or AZURE_TENANT_ID env var")
	}

	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("azure auth failed: %w", err)
	}

	report, err := computeSPExpiryFindings(ctx, cred, tenantID)
	if err != nil {
		return err
	}

	switch flagOutput {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	default:
		printSPExpiryTable(report)
	}
	return nil
}

func computeSPExpiryFindings(ctx context.Context, cred *azidentity.DefaultAzureCredential, tenantID string) (SPExpiryReport, error) {
	token, err := ppToken(ctx, cred, "https://graph.microsoft.com/.default")
	if err != nil {
		return SPExpiryReport{}, fmt.Errorf("acquiring graph token: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Fetching app registrations...\n")
	apps, err := fetchAppsForExpiry(ctx, token)
	if err != nil {
		return SPExpiryReport{}, fmt.Errorf("listing app registrations: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Scanning credentials across %d app(s)...\n", len(apps))

	summary := SPExpirySummary{
		TotalApps:          len(apps),
		FindingsBySeverity: map[string]int{},
	}
	var findings []SPExpiryFinding
	now := time.Now()

	for _, app := range apps {
		summary.TotalCredentials += len(app.PasswordCredentials) + len(app.KeyCredentials)

		for _, pc := range app.PasswordCredentials {
			name := pc.DisplayName
			if name == "" {
				name = "(unnamed secret)"
			}
			if f := evalCredExpiry(app.DisplayName, app.AppID, name, "Secret", pc.EndDateTime, &summary, now); f != nil {
				findings = append(findings, *f)
			}
		}

		for _, kc := range app.KeyCredentials {
			// Skip Encrypt/Decrypt key creds — only Sign/Verify are client-facing
			if kc.Usage != "Sign" && kc.Usage != "Verify" {
				continue
			}
			name := kc.DisplayName
			if name == "" {
				name = kc.Type
			}
			if name == "" {
				name = "(unnamed certificate)"
			}
			if f := evalCredExpiry(app.DisplayName, app.AppID, name, "Certificate", kc.EndDateTime, &summary, now); f != nil {
				findings = append(findings, *f)
			}
		}
	}

	for _, f := range findings {
		summary.FindingsBySeverity[string(f.Severity)]++
	}

	report := SPExpiryReport{Summary: summary, Findings: findings}
	return report, nil
}

// ---------- provider registration ----------

type spExpiryProviderAdapter struct{}

func (spExpiryProviderAdapter) Name() string { return "sp-expiry" }

func (spExpiryProviderAdapter) Run(ctx context.Context) ([]provider.Finding, error) {
	tenantID := getTenantID()
	if tenantID == "" {
		return nil, fmt.Errorf("tenant ID required: set --tenant-id or AZURE_TENANT_ID env var")
	}
	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return nil, fmt.Errorf("azure auth failed: %w", err)
	}
	report, err := computeSPExpiryFindings(ctx, cred, tenantID)
	if err != nil {
		return nil, err
	}
	out := make([]provider.Finding, len(report.Findings))
	for i, f := range report.Findings {
		out[i] = provider.Finding{
			Provider:       "azure",
			Service:        "SP Expiry",
			Severity:       provider.Severity(f.Severity),
			Category:       f.Category,
			Resource:       f.CredentialName,
			Description:    fmt.Sprintf("%s — %s", f.AppName, f.ExpiresOn),
			Recommendation: f.Recommendation,
		}
	}
	return out, nil
}

func evalCredExpiry(appName, appID, credName, credType, endDateTime string, summary *SPExpirySummary, now time.Time) *SPExpiryFinding {
	if endDateTime == "" {
		return nil
	}
	var expiry time.Time
	var err error
	for _, f := range []string{time.RFC3339, "2006-01-02T15:04:05Z", "2006-01-02T15:04:05.0000000Z"} {
		if expiry, err = time.Parse(f, endDateTime); err == nil {
			break
		}
	}
	if err != nil {
		return nil
	}

	daysRemaining := int(expiry.Sub(now).Hours() / 24)
	formattedExpiry := expiry.Format("2006-01-02")
	typeLower := strings.ToLower(credType)

	var severity Severity
	var category string

	switch {
	case daysRemaining < 0:
		severity = Critical
		category = "Expired " + credType
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
		rec = fmt.Sprintf("Rotate this %s immediately — it expired %d days ago and is likely causing auth failures.", typeLower, -daysRemaining)
	} else {
		rec = fmt.Sprintf("Rotate this %s before %s (%d days remaining) to avoid service disruption.", typeLower, formattedExpiry, daysRemaining)
	}

	return &SPExpiryFinding{
		Severity:       severity,
		Category:       category,
		AppName:        appName,
		AppID:          appID,
		CredentialName: credName,
		CredentialType: credType,
		ExpiresOn:      formattedExpiry,
		DaysRemaining:  daysRemaining,
		Recommendation: rec,
	}
}

func fetchAppsForExpiry(ctx context.Context, token string) ([]graphApp, error) {
	var all []graphApp
	url := "https://graph.microsoft.com/v1.0/applications?$select=displayName,appId,passwordCredentials,keyCredentials&$top=999"
	for url != "" {
		var page graphAppsResponse
		if err := ppFetch(ctx, token, url, &page); err != nil {
			return nil, err
		}
		all = append(all, page.Value...)
		url = page.NextLink
	}
	return all, nil
}

func printSPExpiryTable(r SPExpiryReport) {
	fmt.Println()
	fmt.Println("AZURE — SERVICE PRINCIPAL SECRET & CERTIFICATE EXPIRY")
	fmt.Println(strings.Repeat("=", 100))
	fmt.Println()

	fmt.Println("SUMMARY")
	fmt.Println(strings.Repeat("-", 50))
	fmt.Printf("  App Registrations Scanned: %d\n", r.Summary.TotalApps)
	fmt.Printf("  Total Credentials:         %d\n", r.Summary.TotalCredentials)
	fmt.Printf("  Already Expired:           %d\n", r.Summary.Expired)
	fmt.Printf("  Expiring Within 30 Days:   %d\n", r.Summary.ExpiringWithin30)
	fmt.Printf("  Expiring Within 60 Days:   %d\n", r.Summary.ExpiringWithin60)
	fmt.Printf("  Expiring Within 90 Days:   %d\n", r.Summary.ExpiringWithin90)
	fmt.Println()

	fmt.Println("FINDINGS")
	fmt.Println(strings.Repeat("-", 50))
	fmt.Printf("  Critical: %d  |  Warning: %d  |  Info: %d\n",
		r.Summary.FindingsBySeverity["Critical"],
		r.Summary.FindingsBySeverity["Warning"],
		r.Summary.FindingsBySeverity["Info"])
	fmt.Println()

	if len(r.Findings) == 0 {
		fmt.Println("  No expiring credentials found within 90 days.")
		return
	}

	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "SEVERITY\tCATEGORY\tAPP NAME\tCREDENTIAL\tTYPE\tEXPIRES ON\tDAYS\t")
	fmt.Fprintln(w, "--------\t--------\t--------\t----------\t----\t----------\t----\t")
	for _, f := range r.Findings {
		days := fmt.Sprintf("%d", f.DaysRemaining)
		if f.DaysRemaining < 0 {
			days = fmt.Sprintf("%d (EXPIRED)", f.DaysRemaining)
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t\n",
			f.Severity, f.Category, f.AppName, f.CredentialName, f.CredentialType, f.ExpiresOn, days)
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
		fmt.Printf("  %s [%s] %s — %s: %s\n", icon, f.Severity, f.AppName, f.CredentialName, f.Recommendation)
	}
	fmt.Println()
}
