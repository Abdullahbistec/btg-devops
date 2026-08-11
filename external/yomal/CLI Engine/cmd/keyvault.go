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
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/keyvault/armkeyvault"
	"github.com/spf13/cobra"
)

// ---------- data types ----------

type KeyVaultFinding struct {
	Severity       Severity `json:"severity"`
	Category       string   `json:"category"`
	VaultName      string   `json:"vault_name"`
	ResourceGrp    string   `json:"resource_group"`
	Description    string   `json:"description"`
	Recommendation string   `json:"recommendation"`
}

type KeyVaultSummary struct {
	TotalVaults        int            `json:"total_vaults"`
	FindingsBySeverity map[string]int `json:"findings_by_severity"`
	BySKU              map[string]int `json:"by_sku"`
}

type KeyVaultReport struct {
	Summary  KeyVaultSummary   `json:"summary"`
	Findings []KeyVaultFinding `json:"findings"`
}

// ---------- command ----------

var keyvaultCmd = &cobra.Command{
	Use:   "keyvault",
	Short: "Analyze Key Vaults for security misconfigurations and best practices",
	Long:  "Checks all Key Vaults for access model (RBAC vs access policies), soft-delete, purge protection, network access, expiring secrets/keys/certificates, and diagnostic settings.",
	RunE:  runKeyVault,
}

func init() {
	analyzeCmd.AddCommand(keyvaultCmd)
	keyvaultCmd.Flags().StringVar(&flagSubscriptionID, "subscription-id", "", "Azure Subscription ID (overrides AZURE_SUBSCRIPTION_ID env var)")
	keyvaultCmd.Flags().StringVar(&flagResourceGroup, "resource-group", "", "Filter by resource group (optional)")
	keyvaultCmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
}

func runKeyVault(_ *cobra.Command, _ []string) error {
	ctx := context.Background()
	subID := getSubscriptionID()
	if subID == "" {
		return fmt.Errorf("subscription ID required: set --subscription-id or AZURE_SUBSCRIPTION_ID env var")
	}

	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("azure auth failed: %w", err)
	}

	vaultsClient, err := armkeyvault.NewVaultsClient(subID, cred, nil)
	if err != nil {
		return fmt.Errorf("creating keyvault client: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Fetching Key Vaults for subscription %s...\n", subID)
	var vaults []*armkeyvault.Vault
	// Use ListBySubscription to get full vault properties
	pager := vaultsClient.NewListBySubscriptionPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("listing key vaults: %w", err)
		}
		vaults = append(vaults, page.Value...)
	}

	if flagResourceGroup != "" {
		var filtered []*armkeyvault.Vault
		for _, v := range vaults {
			if v.ID != nil {
				rg := extractResourceGroup(*v.ID)
				if strings.EqualFold(rg, flagResourceGroup) {
					filtered = append(filtered, v)
				}
			}
		}
		vaults = filtered
	}

	fmt.Fprintf(os.Stderr, "Found %d Key Vault(s). Analyzing...\n", len(vaults))

	summary := KeyVaultSummary{
		TotalVaults:        len(vaults),
		FindingsBySeverity: map[string]int{},
		BySKU:              map[string]int{},
	}
	var findings []KeyVaultFinding

	now := time.Now()
	nowUnix := now.Unix()
	thirtyDaysUnix := now.Add(30 * 24 * time.Hour).Unix()
	thirtyDaysT := now.Add(30 * 24 * time.Hour)

	for _, vault := range vaults {
		name := deref(vault.Name)
		rg := extractResourceGroup(deref(vault.ID))
		props := vault.Properties
		if props == nil {
			continue
		}

		if props.SKU != nil && props.SKU.Name != nil {
			summary.BySKU[string(*props.SKU.Name)]++
		}

		// 1. Access model: access policies vs RBAC
		if props.EnableRbacAuthorization == nil || !*props.EnableRbacAuthorization {
			findings = append(findings, KeyVaultFinding{
				Severity:       Warning,
				Category:       "Access Policies (Not RBAC)",
				VaultName:      name,
				ResourceGrp:    rg,
				Description:    "Vault uses legacy access policies instead of Azure RBAC",
				Recommendation: "Migrate to Azure RBAC authorization model for finer-grained, centralized access control.",
			})
		}

		// 2. Soft-delete not enabled
		if props.EnableSoftDelete != nil && !*props.EnableSoftDelete {
			findings = append(findings, KeyVaultFinding{
				Severity:       Critical,
				Category:       "Soft-Delete Disabled",
				VaultName:      name,
				ResourceGrp:    rg,
				Description:    "Soft-delete is disabled — deleted secrets/keys/certificates are permanently lost",
				Recommendation: "Enable soft-delete (now mandatory for new vaults) to allow recovery of deleted items.",
			})
		}

		// 3. Purge protection not enabled
		if props.EnablePurgeProtection == nil || !*props.EnablePurgeProtection {
			findings = append(findings, KeyVaultFinding{
				Severity:       Warning,
				Category:       "No Purge Protection",
				VaultName:      name,
				ResourceGrp:    rg,
				Description:    "Purge protection is not enabled — soft-deleted items can be permanently purged before retention period",
				Recommendation: "Enable purge protection to prevent permanent deletion of soft-deleted items.",
			})
		}

		// 4. Public network access
		if props.PublicNetworkAccess == nil || strings.EqualFold(deref(props.PublicNetworkAccess), "enabled") {
			hasRules := props.NetworkACLs != nil && props.NetworkACLs.DefaultAction != nil &&
				*props.NetworkACLs.DefaultAction == armkeyvault.NetworkRuleActionDeny
			if !hasRules {
				findings = append(findings, KeyVaultFinding{
					Severity:       Warning,
					Category:       "Unrestricted Network Access",
					VaultName:      name,
					ResourceGrp:    rg,
					Description:    "Public network access enabled with no firewall rules (default action: Allow)",
					Recommendation: "Configure firewall rules or use private endpoints to restrict access.",
				})
			}
		}

		// 5. Check access policies for overly broad permissions
		if props.AccessPolicies != nil {
			for _, ap := range props.AccessPolicies {
				if ap.Permissions != nil {
					if ap.Permissions.Keys != nil {
						for _, k := range ap.Permissions.Keys {
							if k != nil && strings.EqualFold(string(*k), "all") {
								findings = append(findings, KeyVaultFinding{
									Severity:       Warning,
									Category:       "Overly Broad Key Permissions",
									VaultName:      name,
									ResourceGrp:    rg,
									Description:    fmt.Sprintf("Access policy grants 'All' key permissions to principal %s", deref(ap.ObjectID)),
									Recommendation: "Follow least-privilege: grant only specific key permissions needed.",
								})
								break
							}
						}
					}
					if ap.Permissions.Secrets != nil {
						for _, s := range ap.Permissions.Secrets {
							if s != nil && strings.EqualFold(string(*s), "all") {
								findings = append(findings, KeyVaultFinding{
									Severity:       Warning,
									Category:       "Overly Broad Secret Permissions",
									VaultName:      name,
									ResourceGrp:    rg,
									Description:    fmt.Sprintf("Access policy grants 'All' secret permissions to principal %s", deref(ap.ObjectID)),
									Recommendation: "Follow least-privilege: grant only specific secret permissions needed.",
								})
								break
							}
						}
					}
				}
			}
		}

		// 6. Check secrets/keys/certs for expiry (need keyvault data plane — use mgmt plane secret list)
		// Use the Keys client and Secrets client from mgmt plane
		keysClient, err := armkeyvault.NewKeysClient(subID, cred, nil)
		if err == nil {
			keysPager := keysClient.NewListPager(rg, name, nil)
			for keysPager.More() {
				page, err := keysPager.NextPage(ctx)
				if err != nil {
					break
				}
				for _, key := range page.Value {
					keyName := deref(key.Name)
					if key.Properties != nil && key.Properties.Attributes != nil {
						attrs := key.Properties.Attributes
						if attrs.Expires != nil {
							expUnix := *attrs.Expires
							expStr := time.Unix(expUnix, 0).Format("2006-01-02")
							if expUnix < nowUnix {
								findings = append(findings, KeyVaultFinding{
									Severity:       Critical,
									Category:       "Expired Key",
									VaultName:      name,
									ResourceGrp:    rg,
									Description:    fmt.Sprintf("Key '%s' expired on %s", keyName, expStr),
									Recommendation: "Rotate or remove expired keys immediately.",
								})
							} else if expUnix < thirtyDaysUnix {
								findings = append(findings, KeyVaultFinding{
									Severity:       Warning,
									Category:       "Key Expiring Soon",
									VaultName:      name,
									ResourceGrp:    rg,
									Description:    fmt.Sprintf("Key '%s' expires on %s (within 30 days)", keyName, expStr),
									Recommendation: "Plan key rotation before expiry.",
								})
							}
						}
					}
				}
			}
		}

		secretsClient, err := armkeyvault.NewSecretsClient(subID, cred, nil)
		if err == nil {
			secretsPager := secretsClient.NewListPager(rg, name, nil)
			for secretsPager.More() {
				page, err := secretsPager.NextPage(ctx)
				if err != nil {
					break
				}
				for _, secret := range page.Value {
					secretName := deref(secret.Name)
					if secret.Properties != nil && secret.Properties.Attributes != nil {
						attrs := secret.Properties.Attributes
						if attrs.Expires != nil {
							exp := *attrs.Expires
							if exp.Before(now) {
								findings = append(findings, KeyVaultFinding{
									Severity:       Critical,
									Category:       "Expired Secret",
									VaultName:      name,
									ResourceGrp:    rg,
									Description:    fmt.Sprintf("Secret '%s' expired on %s", secretName, exp.Format("2006-01-02")),
									Recommendation: "Rotate or remove expired secrets immediately.",
								})
							} else if exp.Before(thirtyDaysT) {
								findings = append(findings, KeyVaultFinding{
									Severity:       Warning,
									Category:       "Secret Expiring Soon",
									VaultName:      name,
									ResourceGrp:    rg,
									Description:    fmt.Sprintf("Secret '%s' expires on %s (within 30 days)", secretName, exp.Format("2006-01-02")),
									Recommendation: "Plan secret rotation before expiry.",
								})
							}
						}
					}
				}
			}
		}

		// 7. No private endpoint connections
		if len(props.PrivateEndpointConnections) == 0 {
			findings = append(findings, KeyVaultFinding{
				Severity:       Info,
				Category:       "No Private Endpoints",
				VaultName:      name,
				ResourceGrp:    rg,
				Description:    "No private endpoint connections configured",
				Recommendation: "Consider using private endpoints for secure access from virtual networks.",
			})
		}

		// 8. Soft-delete retention too short
		if props.SoftDeleteRetentionInDays != nil && *props.SoftDeleteRetentionInDays < 90 {
			findings = append(findings, KeyVaultFinding{
				Severity:       Info,
				Category:       "Short Retention Period",
				VaultName:      name,
				ResourceGrp:    rg,
				Description:    fmt.Sprintf("Soft-delete retention is %d days (recommended: 90)", *props.SoftDeleteRetentionInDays),
				Recommendation: "Increase soft-delete retention period to 90 days for better recovery options.",
			})
		}
	}

	for _, f := range findings {
		summary.FindingsBySeverity[string(f.Severity)]++
	}

	report := KeyVaultReport{
		Summary:  summary,
		Findings: findings,
	}

	switch flagOutput {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	default:
		printKeyVaultTable(report)
	}

	return nil
}

// AnalyzeKeyVaultFindings runs Key Vault checks on pre-fetched vaults — no Azure calls.
// Skips key/secret expiry checks (require data-plane client).
func AnalyzeKeyVaultFindings(vaults []*armkeyvault.Vault, _ time.Time) []KeyVaultFinding {
	var findings []KeyVaultFinding
	for _, vault := range vaults {
		name := deref(vault.Name)
		rg := extractResourceGroup(deref(vault.ID))
		props := vault.Properties
		if props == nil {
			continue
		}

		if props.EnableRbacAuthorization == nil || !*props.EnableRbacAuthorization {
			findings = append(findings, KeyVaultFinding{
				Severity: Warning, Category: "Access Policies (Not RBAC)",
				VaultName: name, ResourceGrp: rg,
				Description:    "Vault uses legacy access policies instead of Azure RBAC",
				Recommendation: "Migrate to Azure RBAC authorization model for finer-grained, centralized access control.",
			})
		}

		if props.EnableSoftDelete != nil && !*props.EnableSoftDelete {
			findings = append(findings, KeyVaultFinding{
				Severity: Critical, Category: "Soft-Delete Disabled",
				VaultName: name, ResourceGrp: rg,
				Description:    "Soft-delete is disabled — deleted secrets/keys/certificates are permanently lost",
				Recommendation: "Enable soft-delete (now mandatory for new vaults) to allow recovery of deleted items.",
			})
		}

		if props.EnablePurgeProtection == nil || !*props.EnablePurgeProtection {
			findings = append(findings, KeyVaultFinding{
				Severity: Warning, Category: "No Purge Protection",
				VaultName: name, ResourceGrp: rg,
				Description:    "Purge protection is not enabled — soft-deleted items can be permanently purged before retention period",
				Recommendation: "Enable purge protection to prevent permanent deletion of soft-deleted items.",
			})
		}

		if props.PublicNetworkAccess == nil || strings.EqualFold(deref(props.PublicNetworkAccess), "enabled") {
			hasRules := props.NetworkACLs != nil && props.NetworkACLs.DefaultAction != nil &&
				*props.NetworkACLs.DefaultAction == armkeyvault.NetworkRuleActionDeny
			if !hasRules {
				findings = append(findings, KeyVaultFinding{
					Severity: Warning, Category: "Unrestricted Network Access",
					VaultName: name, ResourceGrp: rg,
					Description:    "Public network access enabled with no firewall rules (default action: Allow)",
					Recommendation: "Configure firewall rules or use private endpoints to restrict access.",
				})
			}
		}

		if props.AccessPolicies != nil {
			for _, ap := range props.AccessPolicies {
				if ap.Permissions == nil {
					continue
				}
				for _, k := range ap.Permissions.Keys {
					if k != nil && strings.EqualFold(string(*k), "all") {
						findings = append(findings, KeyVaultFinding{
							Severity: Warning, Category: "Overly Broad Key Permissions",
							VaultName: name, ResourceGrp: rg,
							Description:    fmt.Sprintf("Access policy grants 'All' key permissions to principal %s", deref(ap.ObjectID)),
							Recommendation: "Follow least-privilege: grant only specific key permissions needed.",
						})
						break
					}
				}
				for _, s := range ap.Permissions.Secrets {
					if s != nil && strings.EqualFold(string(*s), "all") {
						findings = append(findings, KeyVaultFinding{
							Severity: Warning, Category: "Overly Broad Secret Permissions",
							VaultName: name, ResourceGrp: rg,
							Description:    fmt.Sprintf("Access policy grants 'All' secret permissions to principal %s", deref(ap.ObjectID)),
							Recommendation: "Follow least-privilege: grant only specific secret permissions needed.",
						})
						break
					}
				}
			}
		}

		if len(props.PrivateEndpointConnections) == 0 {
			findings = append(findings, KeyVaultFinding{
				Severity: Info, Category: "No Private Endpoints",
				VaultName: name, ResourceGrp: rg,
				Description:    "No private endpoint connections configured",
				Recommendation: "Consider using private endpoints for secure access from virtual networks.",
			})
		}

		if props.SoftDeleteRetentionInDays != nil && *props.SoftDeleteRetentionInDays < 90 {
			findings = append(findings, KeyVaultFinding{
				Severity: Info, Category: "Short Retention Period",
				VaultName: name, ResourceGrp: rg,
				Description:    fmt.Sprintf("Soft-delete retention is %d days (recommended: 90)", *props.SoftDeleteRetentionInDays),
				Recommendation: "Increase soft-delete retention period to 90 days for better recovery options.",
			})
		}
	}
	return findings
}

func printKeyVaultTable(r KeyVaultReport) {
	fmt.Println()
	fmt.Println("KEY VAULT ANALYSIS")
	fmt.Println(strings.Repeat("=", 100))
	fmt.Println()

	fmt.Println("SUMMARY")
	fmt.Println(strings.Repeat("-", 50))
	fmt.Printf("  Total Key Vaults: %d\n", r.Summary.TotalVaults)
	fmt.Println()
	fmt.Println("  By SKU:")
	for sku, count := range r.Summary.BySKU {
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
	fmt.Fprintln(w, "SEVERITY\tCATEGORY\tVAULT NAME\tRESOURCE GROUP\tDESCRIPTION\t")
	fmt.Fprintln(w, "--------\t--------\t----------\t--------------\t-----------\t")
	for _, f := range r.Findings {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t\n",
			f.Severity, f.Category, f.VaultName, f.ResourceGrp, f.Description)
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
		switch f.Severity {
		case Critical:
			icon = "🔴"
		case Warning:
			icon = "🟡"
		}
		fmt.Printf("  %s [%s] %s: %s\n", icon, f.Severity, f.Category, f.Recommendation)
	}
	fmt.Println()
}
