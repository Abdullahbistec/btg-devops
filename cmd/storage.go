package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/storage/armstorage"
	"github.com/chanbistec/btg-devops/provider"
	"github.com/spf13/cobra"
)

// ---------- data types ----------

type StorageFinding struct {
	Severity       Severity `json:"severity"`
	Category       string   `json:"category"`
	StorageAccount string   `json:"storage_account"`
	ResourceGroup  string   `json:"resource_group"`
	Description    string   `json:"description"`
	Recommendation string   `json:"recommendation"`
	Confidence     float64  `json:"confidence,omitempty"`
	Reasoning      string   `json:"reasoning,omitempty"`
}

type StorageSummary struct {
	TotalAccounts      int            `json:"total_accounts"`
	FindingsBySeverity map[string]int `json:"findings_by_severity"`
	ByKind             map[string]int `json:"by_kind"`
	ByReplication      map[string]int `json:"by_replication"`
}

type StorageReport struct {
	Summary  StorageSummary   `json:"summary"`
	Findings []StorageFinding `json:"findings"`
}

// ---------- command ----------

var storageCmd = &cobra.Command{
	Use:   "storage",
	Short: "Analyze Storage Accounts for security misconfigurations and best practices",
	Long:  "Checks all Storage Accounts for public access, HTTPS enforcement, lifecycle policies, TLS version, and blob public access settings.",
	RunE:  runStorage,
}

func init() {
	analyzeCmd.AddCommand(storageCmd)
	storageCmd.Flags().StringVar(&flagSubscriptionID, "subscription-id", "", "Azure Subscription ID (overrides AZURE_SUBSCRIPTION_ID env var)")
	storageCmd.Flags().StringVar(&flagResourceGroup, "resource-group", "", "Filter by resource group (optional)")
	storageCmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
	provider.Register("azure", storageProviderAdapter{})
}

func runStorage(cmd *cobra.Command, args []string) error {
	ctx := context.Background()
	subID := getSubscriptionID()
	if subID == "" {
		return fmt.Errorf("subscription ID required: set --subscription-id or AZURE_SUBSCRIPTION_ID env var")
	}

	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("azure auth failed: %w", err)
	}

	var report StorageReport
	if flagEngine == "rules" {
		report, err = computeStorageFindings(ctx, cred, subID)
	} else {
		report, err = runStorageAnalysis(ctx, cred, subID, defaultClaudeSpawn)
	}
	if err != nil {
		return err
	}

	switch flagOutput {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	default:
		printStorageTable(report)
	}

	return nil
}

func fetchStorageAccounts(ctx context.Context, cred *azidentity.DefaultAzureCredential, subID, resourceGroupFilter string) ([]*armstorage.Account, *armstorage.ManagementPoliciesClient, error) {
	accountsClient, err := armstorage.NewAccountsClient(subID, cred, nil)
	if err != nil {
		return nil, nil, fmt.Errorf("creating storage accounts client: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Fetching storage accounts for subscription %s...\n", subID)
	var accounts []*armstorage.Account
	pager := accountsClient.NewListPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, nil, fmt.Errorf("listing storage accounts: %w", err)
		}
		accounts = append(accounts, page.Value...)
	}

	if resourceGroupFilter != "" {
		var filtered []*armstorage.Account
		for _, a := range accounts {
			if a.ID != nil {
				rg := extractResourceGroup(*a.ID)
				if strings.EqualFold(rg, resourceGroupFilter) {
					filtered = append(filtered, a)
				}
			}
		}
		accounts = filtered
	}
	fmt.Fprintf(os.Stderr, "Found %d storage account(s).\n", len(accounts))

	mgmtPolicyClient, err := armstorage.NewManagementPoliciesClient(subID, cred, nil)
	if err != nil {
		mgmtPolicyClient = nil
	}
	return accounts, mgmtPolicyClient, nil
}

// analyzeStorageAccounts is the unmodified analysis loop previously inline
// in computeStorageFindings — byte-for-byte identical detection logic,
// only the function boundary moved.
func analyzeStorageAccounts(accounts []*armstorage.Account, mgmtPolicyClient *armstorage.ManagementPoliciesClient, ctx context.Context) StorageReport {
	summary := StorageSummary{
		TotalAccounts:      len(accounts),
		FindingsBySeverity: map[string]int{},
		ByKind:             map[string]int{},
		ByReplication:      map[string]int{},
	}
	var findings []StorageFinding

	for _, acct := range accounts {
		name := deref(acct.Name)
		rg := extractResourceGroup(deref(acct.ID))
		props := acct.Properties

		if acct.Kind != nil {
			summary.ByKind[string(*acct.Kind)]++
		}
		if acct.SKU != nil && acct.SKU.Name != nil {
			summary.ByReplication[string(*acct.SKU.Name)]++
		}

		if props == nil {
			continue
		}

		// 1. HTTPS-only not enforced
		if props.EnableHTTPSTrafficOnly != nil && !*props.EnableHTTPSTrafficOnly {
			findings = append(findings, StorageFinding{
				Severity:       Critical,
				Category:       "HTTPS Not Enforced",
				StorageAccount: name,
				ResourceGroup:  rg,
				Description:    "Storage account allows non-HTTPS traffic",
				Recommendation: "Enable 'Secure transfer required' to enforce HTTPS-only access.",
			})
		}

		// 2. Blob public access enabled at account level
		if props.AllowBlobPublicAccess != nil && *props.AllowBlobPublicAccess {
			findings = append(findings, StorageFinding{
				Severity:       Critical,
				Category:       "Blob Public Access Enabled",
				StorageAccount: name,
				ResourceGroup:  rg,
				Description:    "Account-level blob public access is enabled — containers can be made publicly accessible",
				Recommendation: "Disable 'Allow Blob public access' unless explicitly required.",
			})
		}

		// 3. Minimum TLS version check
		if props.MinimumTLSVersion != nil {
			tlsVer := string(*props.MinimumTLSVersion)
			if tlsVer != string(armstorage.MinimumTLSVersionTLS12) {
				sev := Warning
				if tlsVer == string(armstorage.MinimumTLSVersionTLS10) {
					sev = Critical
				}
				findings = append(findings, StorageFinding{
					Severity:       sev,
					Category:       "Weak TLS Version",
					StorageAccount: name,
					ResourceGroup:  rg,
					Description:    fmt.Sprintf("Minimum TLS version is %s (should be TLS 1.2)", tlsVer),
					Recommendation: "Set minimum TLS version to TLS 1.2.",
				})
			}
		}

		// 4. Public network access
		if props.PublicNetworkAccess != nil && *props.PublicNetworkAccess == armstorage.PublicNetworkAccessEnabled {
			// Only flag if there are no network rules restricting access
			if props.NetworkRuleSet == nil || (props.NetworkRuleSet.DefaultAction != nil && *props.NetworkRuleSet.DefaultAction == armstorage.DefaultActionAllow) {
				findings = append(findings, StorageFinding{
					Severity:       Warning,
					Category:       "Unrestricted Network Access",
					StorageAccount: name,
					ResourceGroup:  rg,
					Description:    "Public network access enabled with no firewall rules (default action: Allow)",
					Recommendation: "Configure firewall rules or use private endpoints to restrict access.",
				})
			}
		}

		// 5. Shared key access enabled (best practice is to disable)
		if props.AllowSharedKeyAccess == nil || *props.AllowSharedKeyAccess {
			findings = append(findings, StorageFinding{
				Severity:       Info,
				Category:       "Shared Key Access Enabled",
				StorageAccount: name,
				ResourceGroup:  rg,
				Description:    "Shared key (storage account key) access is enabled",
				Recommendation: "Consider disabling shared key access and using Azure AD authentication instead.",
			})
		}

		// 6. No lifecycle management policy
		if mgmtPolicyClient != nil {
			_, err := mgmtPolicyClient.Get(ctx, rg, name, armstorage.ManagementPolicyNameDefault, nil)
			if err != nil {
				// No lifecycle policy found
				if acct.Kind != nil && (*acct.Kind == armstorage.KindStorageV2 || *acct.Kind == armstorage.KindBlobStorage) {
					findings = append(findings, StorageFinding{
						Severity:       Warning,
						Category:       "No Lifecycle Policy",
						StorageAccount: name,
						ResourceGroup:  rg,
						Description:    "No lifecycle management policy configured — blobs may accumulate indefinitely",
						Recommendation: "Create a lifecycle management policy to automatically tier or delete old blobs.",
					})
				}
			}
		}

		// 7. Infrastructure encryption not enabled
		if props.Encryption != nil && (props.Encryption.RequireInfrastructureEncryption == nil || !*props.Encryption.RequireInfrastructureEncryption) {
			findings = append(findings, StorageFinding{
				Severity:       Info,
				Category:       "No Infrastructure Encryption",
				StorageAccount: name,
				ResourceGroup:  rg,
				Description:    "Infrastructure (double) encryption is not enabled",
				Recommendation: "Enable infrastructure encryption for an additional layer of encryption at rest.",
			})
		}
	}

	for _, f := range findings {
		summary.FindingsBySeverity[string(f.Severity)]++
	}
	return StorageReport{Summary: summary, Findings: findings}
}

// computeStorageFindings composes fetch + analyze, preserving today's exact
// public behavior for the two existing callers (runStorage, storageProviderAdapter.Run).
func computeStorageFindings(ctx context.Context, cred *azidentity.DefaultAzureCredential, subID string) (StorageReport, error) {
	accounts, mgmtPolicyClient, err := fetchStorageAccounts(ctx, cred, subID, flagResourceGroup)
	if err != nil {
		return StorageReport{}, err
	}
	return analyzeStorageAccounts(accounts, mgmtPolicyClient, ctx), nil
}

// ---------- provider registration ----------

type storageProviderAdapter struct{}

func (storageProviderAdapter) Name() string { return "storage" }

func (storageProviderAdapter) Run(ctx context.Context) ([]provider.Finding, error) {
	subID := getSubscriptionID()
	if subID == "" {
		return nil, fmt.Errorf("subscription ID required: set --subscription-id or AZURE_SUBSCRIPTION_ID env var")
	}
	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return nil, fmt.Errorf("azure auth failed: %w", err)
	}
	report, err := computeStorageFindings(ctx, cred, subID)
	if err != nil {
		return nil, err
	}
	return storageFindingsToProvider(report.Findings), nil
}

// storageFindingsToProvider is split out from Run() so the conversion
// (the actual new logic in this file) is testable without live Azure
// credentials, per docs/superpowers/specs/2026-08-06-unified-analyzer-interface-design.md's
// testing approach.
func storageFindingsToProvider(findings []StorageFinding) []provider.Finding {
	out := make([]provider.Finding, len(findings))
	for i, f := range findings {
		out[i] = provider.Finding{
			Provider:       "azure",
			Service:        "Storage",
			Severity:       provider.Severity(f.Severity),
			Category:       f.Category,
			Resource:       f.StorageAccount,
			Description:    f.Description,
			Recommendation: f.Recommendation,
		}
	}
	return out
}

func printStorageTable(r StorageReport) {
	fmt.Println()
	fmt.Println("STORAGE ACCOUNT ANALYSIS")
	fmt.Println(strings.Repeat("=", 100))
	fmt.Println()

	fmt.Println("SUMMARY")
	fmt.Println(strings.Repeat("-", 50))
	fmt.Printf("  Total Storage Accounts: %d\n", r.Summary.TotalAccounts)
	fmt.Println()
	fmt.Println("  By Kind:")
	for kind, count := range r.Summary.ByKind {
		fmt.Printf("    %-30s %d\n", kind, count)
	}
	fmt.Println()
	fmt.Println("  By Replication:")
	for sku, count := range r.Summary.ByReplication {
		fmt.Printf("    %-30s %d\n", sku, count)
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
		fmt.Println("  No issues found. 🎉")
		return
	}

	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "SEVERITY\tCATEGORY\tSTORAGE ACCOUNT\tRESOURCE GROUP\tDESCRIPTION\t")
	fmt.Fprintln(w, "--------\t--------\t---------------\t--------------\t-----------\t")
	for _, f := range r.Findings {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t\n",
			f.Severity, f.Category, f.StorageAccount, f.ResourceGroup, f.Description)
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
		icon := "ℹ️"
		if f.Severity == Critical {
			icon = "🔴"
		} else if f.Severity == Warning {
			icon = "🟡"
		}
		fmt.Printf("  %s [%s] %s: %s\n", icon, f.Severity, f.Category, f.Recommendation)
	}
	fmt.Println()
}

// extractResourceGroup and getSubscriptionID are defined in appservice_traffic.go
