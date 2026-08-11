package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/containerregistry/armcontainerregistry"
	"github.com/spf13/cobra"
)

// ---------- data types ----------

type ACRFinding struct {
	Severity       Severity `json:"severity"`
	Category       string   `json:"category"`
	RegistryName   string   `json:"registry_name"`
	ResourceGroup  string   `json:"resource_group"`
	Description    string   `json:"description"`
	Recommendation string   `json:"recommendation"`
}

type ACRSummary struct {
	TotalRegistries    int            `json:"total_registries"`
	FindingsBySeverity map[string]int `json:"findings_by_severity"`
	BySKU              map[string]int `json:"by_sku"`
}

type ACRReport struct {
	Summary  ACRSummary   `json:"summary"`
	Findings []ACRFinding `json:"findings"`
}

// ---------- command ----------

var acrCmd = &cobra.Command{
	Use:   "acr",
	Short: "Analyze Container Registries for security misconfigurations and best practices",
	Long:  "Checks all Azure Container Registries for admin account, retention policies, public access, encryption, and network configuration.",
	RunE:  runACR,
}

func init() {
	analyzeCmd.AddCommand(acrCmd)
	acrCmd.Flags().StringVar(&flagSubscriptionID, "subscription-id", "", "Azure Subscription ID (overrides AZURE_SUBSCRIPTION_ID env var)")
	acrCmd.Flags().StringVar(&flagResourceGroup, "resource-group", "", "Filter by resource group (optional)")
	acrCmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
}

func runACR(_ *cobra.Command, _ []string) error {
	ctx := context.Background()
	subID := getSubscriptionID()
	if subID == "" {
		return fmt.Errorf("subscription ID required: set --subscription-id or AZURE_SUBSCRIPTION_ID env var")
	}

	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("azure auth failed: %w", err)
	}

	registriesClient, err := armcontainerregistry.NewRegistriesClient(subID, cred, nil)
	if err != nil {
		return fmt.Errorf("creating registries client: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Fetching container registries for subscription %s...\n", subID)
	var registries []*armcontainerregistry.Registry
	pager := registriesClient.NewListPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("listing container registries: %w", err)
		}
		registries = append(registries, page.Value...)
	}

	// Filter by resource group if specified
	if flagResourceGroup != "" {
		var filtered []*armcontainerregistry.Registry
		for _, r := range registries {
			if r.ID != nil {
				rg := extractResourceGroup(*r.ID)
				if strings.EqualFold(rg, flagResourceGroup) {
					filtered = append(filtered, r)
				}
			}
		}
		registries = filtered
	}

	fmt.Fprintf(os.Stderr, "Found %d container registr(y/ies). Analyzing...\n", len(registries))

	summary := ACRSummary{
		TotalRegistries:    len(registries),
		FindingsBySeverity: map[string]int{},
		BySKU:              map[string]int{},
	}
	var findings []ACRFinding

	// Replications client for geo-replication check
	replicationsClient, err := armcontainerregistry.NewReplicationsClient(subID, cred, nil)
	if err != nil {
		replicationsClient = nil
	}

	for _, reg := range registries {
		name := deref(reg.Name)
		rg := extractResourceGroup(deref(reg.ID))
		props := reg.Properties

		if reg.SKU != nil && reg.SKU.Name != nil {
			summary.BySKU[string(*reg.SKU.Name)]++
		}

		if props == nil {
			continue
		}

		// 1. Admin account enabled
		if props.AdminUserEnabled != nil && *props.AdminUserEnabled {
			findings = append(findings, ACRFinding{
				Severity:       Critical,
				Category:       "Admin Account Enabled",
				RegistryName:   name,
				ResourceGroup:  rg,
				Description:    "Admin user account is enabled â€” allows username/password authentication",
				Recommendation: "Disable admin account and use Azure AD service principals or managed identities for authentication.",
			})
		}

		// 2. Public network access enabled
		if props.PublicNetworkAccess != nil && *props.PublicNetworkAccess == armcontainerregistry.PublicNetworkAccessEnabled {
			findings = append(findings, ACRFinding{
				Severity:       Warning,
				Category:       "Public Network Access",
				RegistryName:   name,
				ResourceGroup:  rg,
				Description:    "Public network access is enabled â€” registry is accessible from the internet",
				Recommendation: "Disable public network access and use private endpoints for secure connectivity.",
			})
		}

		// 3. No private endpoint connections
		if len(props.PrivateEndpointConnections) == 0 {
			findings = append(findings, ACRFinding{
				Severity:       Warning,
				Category:       "No Private Endpoint",
				RegistryName:   name,
				ResourceGroup:  rg,
				Description:    "No private endpoint connections configured",
				Recommendation: "Configure private endpoints to restrict registry access to your virtual network.",
			})
		}

		// 4. No retention policy (only available on Premium SKU)
		if reg.SKU != nil && reg.SKU.Name != nil && *reg.SKU.Name == armcontainerregistry.SKUNamePremium {
			if props.Policies != nil && props.Policies.RetentionPolicy != nil {
				if props.Policies.RetentionPolicy.Status != nil && *props.Policies.RetentionPolicy.Status == armcontainerregistry.PolicyStatusDisabled {
					findings = append(findings, ACRFinding{
						Severity:       Warning,
						Category:       "Retention Policy Disabled",
						RegistryName:   name,
						ResourceGroup:  rg,
						Description:    "Retention policy is disabled â€” untagged manifests will accumulate indefinitely",
						Recommendation: "Enable retention policy to automatically purge untagged manifests and reduce storage costs.",
					})
				}
			} else {
				findings = append(findings, ACRFinding{
					Severity:       Warning,
					Category:       "No Retention Policy",
					RegistryName:   name,
					ResourceGroup:  rg,
					Description:    "No retention policy configured â€” untagged manifests will accumulate indefinitely",
					Recommendation: "Configure a retention policy to automatically purge untagged manifests.",
				})
			}
		}

		// 5. No encryption with customer-managed key (Premium only)
		if reg.SKU != nil && reg.SKU.Name != nil && *reg.SKU.Name == armcontainerregistry.SKUNamePremium {
			if props.Encryption == nil || props.Encryption.Status == nil || *props.Encryption.Status == armcontainerregistry.EncryptionStatusDisabled {
				findings = append(findings, ACRFinding{
					Severity:       Info,
					Category:       "No Customer-Managed Key",
					RegistryName:   name,
					ResourceGroup:  rg,
					Description:    "Encryption with customer-managed key is not enabled (using platform-managed key)",
					Recommendation: "Consider enabling encryption with a customer-managed key for enhanced control over encryption.",
				})
			}
		}

		// 6. Anonymous pull access â€” check via NetworkRuleBypassOptions or skip if field unavailable

		// 7. Content trust / trust policy not enabled (Premium only)
		if reg.SKU != nil && reg.SKU.Name != nil && *reg.SKU.Name == armcontainerregistry.SKUNamePremium {
			if props.Policies != nil && props.Policies.TrustPolicy != nil {
				if props.Policies.TrustPolicy.Status != nil && *props.Policies.TrustPolicy.Status == armcontainerregistry.PolicyStatusDisabled {
					findings = append(findings, ACRFinding{
						Severity:       Info,
						Category:       "Content Trust Disabled",
						RegistryName:   name,
						ResourceGroup:  rg,
						Description:    "Content trust (image signing) is not enabled",
						Recommendation: "Enable content trust to ensure only signed images can be deployed.",
					})
				}
			}
		}

		// 8. Export policy not disabled (Premium only â€” prevents data exfiltration)
		if reg.SKU != nil && reg.SKU.Name != nil && *reg.SKU.Name == armcontainerregistry.SKUNamePremium {
			if props.Policies != nil && props.Policies.ExportPolicy != nil {
				if props.Policies.ExportPolicy.Status != nil && *props.Policies.ExportPolicy.Status == armcontainerregistry.ExportPolicyStatusEnabled {
					findings = append(findings, ACRFinding{
						Severity:       Info,
						Category:       "Export Policy Enabled",
						RegistryName:   name,
						ResourceGroup:  rg,
						Description:    "Export policy is enabled â€” images can be exported out of the registry",
						Recommendation: "Consider disabling export policy to prevent data exfiltration via image export.",
					})
				}
			}
		}

		// 9. Basic/Standard SKU â€” suggest Premium for production
		if reg.SKU != nil && reg.SKU.Name != nil {
			skuName := *reg.SKU.Name
			if skuName == armcontainerregistry.SKUNameBasic {
				findings = append(findings, ACRFinding{
					Severity:       Info,
					Category:       "Basic SKU",
					RegistryName:   name,
					ResourceGroup:  rg,
					Description:    "Using Basic SKU â€” limited storage, throughput, and no geo-replication or private endpoints",
					Recommendation: "Upgrade to Standard or Premium SKU for production workloads.",
				})
			}
		}

		// 10. Zone redundancy not enabled (Premium only)
		if reg.SKU != nil && reg.SKU.Name != nil && *reg.SKU.Name == armcontainerregistry.SKUNamePremium {
			if props.ZoneRedundancy != nil && *props.ZoneRedundancy == armcontainerregistry.ZoneRedundancyDisabled {
				findings = append(findings, ACRFinding{
					Severity:       Info,
					Category:       "No Zone Redundancy",
					RegistryName:   name,
					ResourceGroup:  rg,
					Description:    "Zone redundancy is not enabled for this Premium registry",
					Recommendation: "Enable zone redundancy for higher availability within a region.",
				})
			}
		}

		// 11. Check geo-replication (Premium only)
		if reg.SKU != nil && reg.SKU.Name != nil && *reg.SKU.Name == armcontainerregistry.SKUNamePremium && replicationsClient != nil {
			repPager := replicationsClient.NewListPager(rg, name, nil)
			repCount := 0
			for repPager.More() {
				repPage, err := repPager.NextPage(ctx)
				if err != nil {
					break
				}
				repCount += len(repPage.Value)
			}
			if repCount <= 1 {
				findings = append(findings, ACRFinding{
					Severity:       Info,
					Category:       "No Geo-Replication",
					RegistryName:   name,
					ResourceGroup:  rg,
					Description:    "Premium registry has no geo-replication configured (single region only)",
					Recommendation: "Configure geo-replication for disaster recovery and reduced pull latency across regions.",
				})
			}
		}
	}

	// Severity counts
	for _, f := range findings {
		summary.FindingsBySeverity[string(f.Severity)]++
	}

	report := ACRReport{
		Summary:  summary,
		Findings: findings,
	}

	switch flagOutput {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	default:
		printACRTable(report)
	}

	return nil
}

// AnalyzeACRFindings runs ACR checks on pre-fetched data â€” no Azure calls.
// Skips geo-replication check (requires Azure client).
func AnalyzeACRFindings(registries []*armcontainerregistry.Registry) []ACRFinding {
	var findings []ACRFinding
	for _, reg := range registries {
		name := deref(reg.Name)
		rg := extractResourceGroup(deref(reg.ID))
		props := reg.Properties
		if props == nil {
			continue
		}

		if props.AdminUserEnabled != nil && *props.AdminUserEnabled {
			findings = append(findings, ACRFinding{
				Severity: Critical, Category: "Admin Account Enabled",
				RegistryName: name, ResourceGroup: rg,
				Description:    "Admin user account is enabled â€” allows username/password authentication",
				Recommendation: "Disable admin account and use Azure AD service principals or managed identities for authentication.",
			})
		}

		if props.PublicNetworkAccess != nil && *props.PublicNetworkAccess == armcontainerregistry.PublicNetworkAccessEnabled {
			findings = append(findings, ACRFinding{
				Severity: Warning, Category: "Public Network Access",
				RegistryName: name, ResourceGroup: rg,
				Description:    "Public network access is enabled â€” registry is accessible from the internet",
				Recommendation: "Disable public network access and use private endpoints for secure connectivity.",
			})
		}

		if len(props.PrivateEndpointConnections) == 0 {
			findings = append(findings, ACRFinding{
				Severity: Warning, Category: "No Private Endpoint",
				RegistryName: name, ResourceGroup: rg,
				Description:    "No private endpoint connections configured",
				Recommendation: "Configure private endpoints to restrict registry access to your virtual network.",
			})
		}

		if reg.SKU != nil && reg.SKU.Name != nil && *reg.SKU.Name == armcontainerregistry.SKUNamePremium {
			if props.Policies != nil && props.Policies.RetentionPolicy != nil {
				if props.Policies.RetentionPolicy.Status != nil && *props.Policies.RetentionPolicy.Status == armcontainerregistry.PolicyStatusDisabled {
					findings = append(findings, ACRFinding{
						Severity: Warning, Category: "Retention Policy Disabled",
						RegistryName: name, ResourceGroup: rg,
						Description:    "Retention policy is disabled â€” untagged manifests will accumulate indefinitely",
						Recommendation: "Enable retention policy to automatically purge untagged manifests and reduce storage costs.",
					})
				}
			} else {
				findings = append(findings, ACRFinding{
					Severity: Warning, Category: "No Retention Policy",
					RegistryName: name, ResourceGroup: rg,
					Description:    "No retention policy configured â€” untagged manifests will accumulate indefinitely",
					Recommendation: "Configure a retention policy to automatically purge untagged manifests.",
				})
			}

			if props.Encryption == nil || props.Encryption.Status == nil || *props.Encryption.Status == armcontainerregistry.EncryptionStatusDisabled {
				findings = append(findings, ACRFinding{
					Severity: Info, Category: "No Customer-Managed Key",
					RegistryName: name, ResourceGroup: rg,
					Description:    "Encryption with customer-managed key is not enabled (using platform-managed key)",
					Recommendation: "Consider enabling encryption with a customer-managed key for enhanced control over encryption.",
				})
			}

			if props.Policies != nil && props.Policies.TrustPolicy != nil {
				if props.Policies.TrustPolicy.Status != nil && *props.Policies.TrustPolicy.Status == armcontainerregistry.PolicyStatusDisabled {
					findings = append(findings, ACRFinding{
						Severity: Info, Category: "Content Trust Disabled",
						RegistryName: name, ResourceGroup: rg,
						Description:    "Content trust (image signing) is not enabled",
						Recommendation: "Enable content trust to ensure only signed images can be deployed.",
					})
				}
			}

			if props.Policies != nil && props.Policies.ExportPolicy != nil {
				if props.Policies.ExportPolicy.Status != nil && *props.Policies.ExportPolicy.Status == armcontainerregistry.ExportPolicyStatusEnabled {
					findings = append(findings, ACRFinding{
						Severity: Info, Category: "Export Policy Enabled",
						RegistryName: name, ResourceGroup: rg,
						Description:    "Export policy is enabled â€” images can be exported out of the registry",
						Recommendation: "Consider disabling export policy to prevent data exfiltration via image export.",
					})
				}
			}

			if props.ZoneRedundancy != nil && *props.ZoneRedundancy == armcontainerregistry.ZoneRedundancyDisabled {
				findings = append(findings, ACRFinding{
					Severity: Info, Category: "No Zone Redundancy",
					RegistryName: name, ResourceGroup: rg,
					Description:    "Zone redundancy is not enabled for this Premium registry",
					Recommendation: "Enable zone redundancy for higher availability within a region.",
				})
			}
		}

		if reg.SKU != nil && reg.SKU.Name != nil && *reg.SKU.Name == armcontainerregistry.SKUNameBasic {
			findings = append(findings, ACRFinding{
				Severity: Info, Category: "Basic SKU",
				RegistryName: name, ResourceGroup: rg,
				Description:    "Using Basic SKU â€” limited storage, throughput, and no geo-replication or private endpoints",
				Recommendation: "Upgrade to Standard or Premium SKU for production workloads.",
			})
		}
	}
	return findings
}

func printACRTable(r ACRReport) {
	fmt.Println()
	fmt.Println("CONTAINER REGISTRY (ACR) ANALYSIS")
	fmt.Println(strings.Repeat("=", 100))
	fmt.Println()

	fmt.Println("SUMMARY")
	fmt.Println(strings.Repeat("-", 50))
	fmt.Printf("  Total Registries: %d\n", r.Summary.TotalRegistries)
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
		fmt.Println("  No issues found. ðŸŽ‰")
		return
	}

	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "SEVERITY\tCATEGORY\tREGISTRY\tRESOURCE GROUP\tDESCRIPTION\t")
	fmt.Fprintln(w, "--------\t--------\t--------\t--------------\t-----------\t")
	for _, f := range r.Findings {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t\n",
			f.Severity, f.Category, f.RegistryName, f.ResourceGroup, f.Description)
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
