package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/cognitiveservices/armcognitiveservices"
	"github.com/spf13/cobra"
)

// ---------- data types ----------

type CognitiveServicesFinding struct {
	Severity       Severity `json:"severity"`
	Category       string   `json:"category"`
	AccountName    string   `json:"account_name"`
	ResourceGroup  string   `json:"resource_group"`
	Description    string   `json:"description"`
	Recommendation string   `json:"recommendation"`
}

type CognitiveServicesSummary struct {
	TotalAccounts      int            `json:"total_accounts"`
	FindingsBySeverity map[string]int `json:"findings_by_severity"`
	ByKind             map[string]int `json:"by_kind"`
	BySKU              map[string]int `json:"by_sku"`
}

type CognitiveServicesReport struct {
	Summary  CognitiveServicesSummary   `json:"summary"`
	Findings []CognitiveServicesFinding `json:"findings"`
}

// ---------- command ----------

var cognitiveservicesCmd = &cobra.Command{
	Use:   "cognitiveservices",
	Short: "Analyze Azure AI / Cognitive Services accounts for misconfigurations and best practices",
	Long:  "Checks all Azure Cognitive Services accounts for network security, managed identity, key rotation, unused deployments, and configuration best practices.",
	RunE:  runCognitiveServices,
}

func init() {
	analyzeCmd.AddCommand(cognitiveservicesCmd)
	cognitiveservicesCmd.Flags().StringVar(&flagSubscriptionID, "subscription-id", "", "Azure Subscription ID (overrides AZURE_SUBSCRIPTION_ID env var)")
	cognitiveservicesCmd.Flags().StringVar(&flagResourceGroup, "resource-group", "", "Filter by resource group (optional)")
	cognitiveservicesCmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
}

func runCognitiveServices(_ *cobra.Command, _ []string) error {
	ctx := context.Background()
	subID := getSubscriptionID()
	if subID == "" {
		return fmt.Errorf("subscription ID required: set --subscription-id or AZURE_SUBSCRIPTION_ID env var")
	}

	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("azure auth failed: %w", err)
	}

	accountsClient, err := armcognitiveservices.NewAccountsClient(subID, cred, nil)
	if err != nil {
		return fmt.Errorf("creating cognitive services client: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Fetching Cognitive Services accounts for subscription %s...\n", subID)
	var accounts []*armcognitiveservices.Account
	pager := accountsClient.NewListPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("listing cognitive services accounts: %w", err)
		}
		accounts = append(accounts, page.Value...)
	}

	// Filter by resource group if specified
	if flagResourceGroup != "" {
		var filtered []*armcognitiveservices.Account
		for _, a := range accounts {
			if a.ID != nil {
				rg := extractResourceGroup(*a.ID)
				if strings.EqualFold(rg, flagResourceGroup) {
					filtered = append(filtered, a)
				}
			}
		}
		accounts = filtered
	}

	fmt.Fprintf(os.Stderr, "Found %d Cognitive Services account(s). Analyzing...\n", len(accounts))

	summary := CognitiveServicesSummary{
		TotalAccounts:      len(accounts),
		FindingsBySeverity: map[string]int{},
		ByKind:             map[string]int{},
		BySKU:              map[string]int{},
	}
	var findings []CognitiveServicesFinding

	// Deployments client for OpenAI model deployments
	deploymentsClient, err := armcognitiveservices.NewDeploymentsClient(subID, cred, nil)
	if err != nil {
		deploymentsClient = nil
	}

	for _, acct := range accounts {
		name := deref(acct.Name)
		rg := extractResourceGroup(deref(acct.ID))
		props := acct.Properties

		if acct.Kind != nil {
			summary.ByKind[*acct.Kind]++
		}
		if acct.SKU != nil && acct.SKU.Name != nil {
			summary.BySKU[*acct.SKU.Name]++
		}

		if props == nil {
			continue
		}

		kind := ""
		if acct.Kind != nil {
			kind = *acct.Kind
		}

		// 1. Public network access enabled
		if props.PublicNetworkAccess != nil && *props.PublicNetworkAccess == armcognitiveservices.PublicNetworkAccessEnabled {
			findings = append(findings, CognitiveServicesFinding{
				Severity:       Warning,
				Category:       "Public Network Access",
				AccountName:    name,
				ResourceGroup:  rg,
				Description:    fmt.Sprintf("Public network access is enabled on %s account", kind),
				Recommendation: "Disable public network access and use private endpoints for secure connectivity.",
			})
		}

		// 2. No private endpoint connections
		if len(props.PrivateEndpointConnections) == 0 {
			findings = append(findings, CognitiveServicesFinding{
				Severity:       Warning,
				Category:       "No Private Endpoint",
				AccountName:    name,
				ResourceGroup:  rg,
				Description:    "No private endpoint connections configured",
				Recommendation: "Configure private endpoints to restrict access to your virtual network.",
			})
		}

		// 3. No managed identity
		if acct.Identity == nil || acct.Identity.Type == nil {
			findings = append(findings, CognitiveServicesFinding{
				Severity:       Warning,
				Category:       "No Managed Identity",
				AccountName:    name,
				ResourceGroup:  rg,
				Description:    "No managed identity configured — using key-based auth only",
				Recommendation: "Enable system-assigned or user-assigned managed identity for secure, keyless authentication.",
			})
		}

		// 4. Customer-managed key not configured
		if props.Encryption == nil || props.Encryption.KeySource == nil ||
			*props.Encryption.KeySource == armcognitiveservices.KeySourceMicrosoftCognitiveServices {
			findings = append(findings, CognitiveServicesFinding{
				Severity:       Info,
				Category:       "No Customer-Managed Key",
				AccountName:    name,
				ResourceGroup:  rg,
				Description:    "Using platform-managed encryption key (not customer-managed)",
				Recommendation: "Consider using customer-managed keys in Azure Key Vault for enhanced control over data encryption.",
			})
		}

		// 5. Network rules — check if IP/VNET rules are configured
		if props.NetworkACLs == nil {
			findings = append(findings, CognitiveServicesFinding{
				Severity:       Warning,
				Category:       "No Network Rules",
				AccountName:    name,
				ResourceGroup:  rg,
				Description:    "No network ACL rules configured — default access from all networks",
				Recommendation: "Configure network rules to restrict access to specific IP ranges or virtual networks.",
			})
		} else if props.NetworkACLs.DefaultAction != nil && *props.NetworkACLs.DefaultAction == armcognitiveservices.NetworkRuleActionAllow {
			findings = append(findings, CognitiveServicesFinding{
				Severity:       Warning,
				Category:       "Permissive Network Default",
				AccountName:    name,
				ResourceGroup:  rg,
				Description:    "Network default action is Allow — all networks can access this account",
				Recommendation: "Set the default network action to Deny and add specific allow rules for trusted networks.",
			})
		}

		// 6. Restrict outbound network access
		if props.RestrictOutboundNetworkAccess != nil && !*props.RestrictOutboundNetworkAccess {
			findings = append(findings, CognitiveServicesFinding{
				Severity:       Info,
				Category:       "Outbound Access Not Restricted",
				AccountName:    name,
				ResourceGroup:  rg,
				Description:    "Outbound network access is not restricted",
				Recommendation: "Restrict outbound network access to prevent data exfiltration.",
			})
		}

		// 7. Local auth (key-based) not disabled
		if props.DisableLocalAuth == nil || !*props.DisableLocalAuth {
			findings = append(findings, CognitiveServicesFinding{
				Severity:       Info,
				Category:       "Local Auth Enabled",
				AccountName:    name,
				ResourceGroup:  rg,
				Description:    "Key-based (local) authentication is enabled",
				Recommendation: "Disable local authentication and use Azure AD for all access to reduce key exposure risk.",
			})
		}

		// 8. Check deployments for OpenAI accounts
		if deploymentsClient != nil && (strings.EqualFold(kind, "OpenAI") || strings.EqualFold(kind, "AIServices")) {
			depPager := deploymentsClient.NewListPager(rg, name, nil)
			deploymentCount := 0
			for depPager.More() {
				depPage, err := depPager.NextPage(ctx)
				if err != nil {
					fmt.Fprintf(os.Stderr, "  Warning: could not list deployments for %s: %v\n", name, err)
					break
				}
				for _, dep := range depPage.Value {
					deploymentCount++
					depName := deref(dep.Name)

					// Check for provisioned capacity with potential waste
					if dep.Properties != nil && dep.Properties.Model != nil {
						modelName := deref(dep.Properties.Model.Name)
						modelVersion := deref(dep.Properties.Model.Version)
						if modelVersion != "" {
							// Flag older model versions as informational
							findings = append(findings, CognitiveServicesFinding{
								Severity:       Info,
								Category:       "Model Deployment",
								AccountName:    name,
								ResourceGroup:  rg,
								Description:    fmt.Sprintf("Deployment '%s': model=%s version=%s — verify this is the latest version", depName, modelName, modelVersion),
								Recommendation: "Review model versions periodically and upgrade to latest for improved performance and features.",
							})
						}
					}

					// Check SKU/capacity on deployment
					if dep.SKU != nil && dep.SKU.Capacity != nil && *dep.SKU.Capacity > 0 {
						skuName := ""
						if dep.SKU.Name != nil {
							skuName = *dep.SKU.Name
						}
						if strings.EqualFold(skuName, "ProvisionedManaged") || strings.EqualFold(skuName, "Provisioned") {
							findings = append(findings, CognitiveServicesFinding{
								Severity:       Warning,
								Category:       "Provisioned Capacity",
								AccountName:    name,
								ResourceGroup:  rg,
								Description:    fmt.Sprintf("Deployment '%s' uses provisioned capacity (SKU=%s, capacity=%d) — verify utilization justifies cost", depName, skuName, *dep.SKU.Capacity),
								Recommendation: "Monitor PTU utilization; switch to pay-as-you-go (Standard) if utilization is consistently low.",
							})
						}
					}
				}
			}

			if deploymentCount == 0 {
				findings = append(findings, CognitiveServicesFinding{
					Severity:       Warning,
					Category:       "No Deployments",
					AccountName:    name,
					ResourceGroup:  rg,
					Description:    "OpenAI/AI Services account has no model deployments — may be unused",
					Recommendation: "Delete unused accounts to avoid unnecessary costs and reduce attack surface.",
				})
			}
		}

		// 9. Provisioning state check
		if props.ProvisioningState != nil && *props.ProvisioningState != armcognitiveservices.ProvisioningStateSucceeded {
			findings = append(findings, CognitiveServicesFinding{
				Severity:       Critical,
				Category:       "Provisioning Issue",
				AccountName:    name,
				ResourceGroup:  rg,
				Description:    fmt.Sprintf("Account provisioning state is '%s' (not Succeeded)", *props.ProvisioningState),
				Recommendation: "Investigate the provisioning issue; the account may not be functional.",
			})
		}

		// 10. Free tier detection
		if acct.SKU != nil && acct.SKU.Name != nil && strings.EqualFold(*acct.SKU.Name, "F0") {
			findings = append(findings, CognitiveServicesFinding{
				Severity:       Info,
				Category:       "Free Tier",
				AccountName:    name,
				ResourceGroup:  rg,
				Description:    "Account is on Free (F0) tier — limited throughput and features",
				Recommendation: "Upgrade to a paid tier (S0+) for production workloads to ensure SLA coverage and higher limits.",
			})
		}
	}

	// Severity counts
	for _, f := range findings {
		summary.FindingsBySeverity[string(f.Severity)]++
	}

	report := CognitiveServicesReport{
		Summary:  summary,
		Findings: findings,
	}

	switch flagOutput {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	default:
		printCognitiveServicesTable(report)
	}

	return nil
}

// AnalyzeCogServicesFindings runs cognitive services checks — no Azure calls.
// Skips deployment checks (require Azure client).
func AnalyzeCogServicesFindings(accounts []*armcognitiveservices.Account) []CognitiveServicesFinding {
	var findings []CognitiveServicesFinding
	for _, acct := range accounts {
		name := deref(acct.Name)
		rg := extractResourceGroup(deref(acct.ID))
		props := acct.Properties
		kind := ""
		if acct.Kind != nil {
			kind = *acct.Kind
		}
		if props == nil {
			continue
		}

		if props.PublicNetworkAccess != nil && *props.PublicNetworkAccess == armcognitiveservices.PublicNetworkAccessEnabled {
			findings = append(findings, CognitiveServicesFinding{
				Severity: Warning, Category: "Public Network Access",
				AccountName: name, ResourceGroup: rg,
				Description:    fmt.Sprintf("Public network access is enabled on %s account", kind),
				Recommendation: "Disable public network access and use private endpoints for secure connectivity.",
			})
		}

		if len(props.PrivateEndpointConnections) == 0 {
			findings = append(findings, CognitiveServicesFinding{
				Severity: Warning, Category: "No Private Endpoint",
				AccountName: name, ResourceGroup: rg,
				Description:    "No private endpoint connections configured",
				Recommendation: "Configure private endpoints to restrict access to your virtual network.",
			})
		}

		if acct.Identity == nil || acct.Identity.Type == nil {
			findings = append(findings, CognitiveServicesFinding{
				Severity: Warning, Category: "No Managed Identity",
				AccountName: name, ResourceGroup: rg,
				Description:    "No managed identity configured — using key-based auth only",
				Recommendation: "Enable system-assigned or user-assigned managed identity for secure, keyless authentication.",
			})
		}

		if props.Encryption == nil || props.Encryption.KeySource == nil ||
			*props.Encryption.KeySource == armcognitiveservices.KeySourceMicrosoftCognitiveServices {
			findings = append(findings, CognitiveServicesFinding{
				Severity: Info, Category: "No Customer-Managed Key",
				AccountName: name, ResourceGroup: rg,
				Description:    "Using platform-managed encryption key (not customer-managed)",
				Recommendation: "Consider using customer-managed keys in Azure Key Vault for enhanced control over data encryption.",
			})
		}

		if props.NetworkACLs == nil {
			findings = append(findings, CognitiveServicesFinding{
				Severity: Warning, Category: "No Network Rules",
				AccountName: name, ResourceGroup: rg,
				Description:    "No network ACL rules configured — default access from all networks",
				Recommendation: "Configure network rules to restrict access to specific IP ranges or virtual networks.",
			})
		} else if props.NetworkACLs.DefaultAction != nil && *props.NetworkACLs.DefaultAction == armcognitiveservices.NetworkRuleActionAllow {
			findings = append(findings, CognitiveServicesFinding{
				Severity: Warning, Category: "Permissive Network Default",
				AccountName: name, ResourceGroup: rg,
				Description:    "Network default action is Allow — all networks can access this account",
				Recommendation: "Set the default network action to Deny and add specific allow rules for trusted networks.",
			})
		}

		if props.RestrictOutboundNetworkAccess != nil && !*props.RestrictOutboundNetworkAccess {
			findings = append(findings, CognitiveServicesFinding{
				Severity: Info, Category: "Outbound Access Not Restricted",
				AccountName: name, ResourceGroup: rg,
				Description:    "Outbound network access is not restricted",
				Recommendation: "Restrict outbound network access to prevent data exfiltration.",
			})
		}

		if props.DisableLocalAuth == nil || !*props.DisableLocalAuth {
			findings = append(findings, CognitiveServicesFinding{
				Severity: Info, Category: "Local Auth Enabled",
				AccountName: name, ResourceGroup: rg,
				Description:    "Key-based (local) authentication is enabled",
				Recommendation: "Disable local authentication and use Azure AD for all access to reduce key exposure risk.",
			})
		}

		if props.ProvisioningState != nil && *props.ProvisioningState != armcognitiveservices.ProvisioningStateSucceeded {
			findings = append(findings, CognitiveServicesFinding{
				Severity: Critical, Category: "Provisioning Issue",
				AccountName: name, ResourceGroup: rg,
				Description:    fmt.Sprintf("Account provisioning state is '%s' (not Succeeded)", *props.ProvisioningState),
				Recommendation: "Investigate the provisioning issue; the account may not be functional.",
			})
		}

		if acct.SKU != nil && acct.SKU.Name != nil && strings.EqualFold(*acct.SKU.Name, "F0") {
			findings = append(findings, CognitiveServicesFinding{
				Severity: Info, Category: "Free Tier",
				AccountName: name, ResourceGroup: rg,
				Description:    "Account is on Free (F0) tier — limited throughput and features",
				Recommendation: "Upgrade to a paid tier (S0+) for production workloads to ensure SLA coverage and higher limits.",
			})
		}
	}
	return findings
}

func printCognitiveServicesTable(r CognitiveServicesReport) {
	fmt.Println()
	fmt.Println("AZURE AI / COGNITIVE SERVICES ANALYSIS")
	fmt.Println(strings.Repeat("=", 100))
	fmt.Println()

	fmt.Println("SUMMARY")
	fmt.Println(strings.Repeat("-", 50))
	fmt.Printf("  Total Accounts: %d\n", r.Summary.TotalAccounts)
	fmt.Println()
	fmt.Println("  By Kind:")
	for kind, count := range r.Summary.ByKind {
		fmt.Printf("    %-30s %d\n", kind, count)
	}
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
	fmt.Fprintln(w, "SEVERITY\tCATEGORY\tACCOUNT\tRESOURCE GROUP\tDESCRIPTION\t")
	fmt.Fprintln(w, "--------\t--------\t-------\t--------------\t-----------\t")
	for _, f := range r.Findings {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t\n",
			f.Severity, f.Category, f.AccountName, f.ResourceGroup, f.Description)
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
