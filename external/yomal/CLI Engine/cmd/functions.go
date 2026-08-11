package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/appservice/armappservice/v2"
	"github.com/spf13/cobra"
)

// ---------- data types ----------

type FunctionsFinding struct {
	Severity       Severity `json:"severity"`
	Category       string   `json:"category"`
	FunctionApp    string   `json:"function_app"`
	ResourceGrp    string   `json:"resource_group"`
	Description    string   `json:"description"`
	Recommendation string   `json:"recommendation"`
}

type FunctionsSummary struct {
	TotalFunctionApps  int            `json:"total_function_apps"`
	FindingsBySeverity map[string]int `json:"findings_by_severity"`
	ByRuntime          map[string]int `json:"by_runtime"`
	BySKU              map[string]int `json:"by_sku"`
	ByOS               map[string]int `json:"by_os"`
}

type FunctionsReport struct {
	Summary  FunctionsSummary   `json:"summary"`
	Findings []FunctionsFinding `json:"findings"`
}

// ---------- constants ----------

// Current (recommended) runtime versions as of early 2026
var currentRuntimeVersions = map[string]string{
	"dotnet":          "v8.0",
	"dotnet-isolated": "v8.0",
	"node":            "~20",
	"python":          "3.11",
	"java":            "17",
	"powershell":      "7.4",
}

// ---------- command ----------

var functionsCmd = &cobra.Command{
	Use:   "functions",
	Short: "Analyze Azure Functions for runtime currency, configuration, and best practices",
	Long:  "Checks all Function Apps for runtime version currency, always-on configuration, HTTPS enforcement, managed identity, runtime settings, and SKU appropriateness.",
	RunE:  runFunctions,
}

func init() {
	analyzeCmd.AddCommand(functionsCmd)
	functionsCmd.Flags().StringVar(&flagSubscriptionID, "subscription-id", "", "Azure Subscription ID (overrides AZURE_SUBSCRIPTION_ID env var)")
	functionsCmd.Flags().StringVar(&flagResourceGroup, "resource-group", "", "Filter by resource group (optional)")
	functionsCmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
}

func runFunctions(_ *cobra.Command, _ []string) error {
	ctx := context.Background()
	subID := getSubscriptionID()
	if subID == "" {
		return fmt.Errorf("subscription ID required: set --subscription-id or AZURE_SUBSCRIPTION_ID env var")
	}

	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("azure auth failed: %w", err)
	}

	webClient, err := armappservice.NewWebAppsClient(subID, cred, nil)
	if err != nil {
		return fmt.Errorf("creating web apps client: %w", err)
	}

	plansClient, err := armappservice.NewPlansClient(subID, cred, nil)
	if err != nil {
		return fmt.Errorf("creating app service plans client: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Fetching Function Apps for subscription %s...\n", subID)

	var functionApps []*armappservice.Site
	pager := webClient.NewListPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("listing web apps: %w", err)
		}
		for _, app := range page.Value {
			if app.Kind != nil && strings.Contains(strings.ToLower(*app.Kind), "functionapp") {
				functionApps = append(functionApps, app)
			}
		}
	}

	if flagResourceGroup != "" {
		var filtered []*armappservice.Site
		for _, app := range functionApps {
			if app.ID != nil {
				rg := extractResourceGroup(*app.ID)
				if strings.EqualFold(rg, flagResourceGroup) {
					filtered = append(filtered, app)
				}
			}
		}
		functionApps = filtered
	}

	fmt.Fprintf(os.Stderr, "Found %d Function App(s). Analyzing...\n", len(functionApps))

	summary := FunctionsSummary{
		TotalFunctionApps:  len(functionApps),
		FindingsBySeverity: map[string]int{},
		ByRuntime:          map[string]int{},
		BySKU:              map[string]int{},
		ByOS:               map[string]int{},
	}
	var findings []FunctionsFinding

	// Cache plans to avoid repeated lookups
	planCache := map[string]*armappservice.Plan{}

	for _, app := range functionApps {
		name := deref(app.Name)
		rg := extractResourceGroup(deref(app.ID))
		props := app.Properties
		if props == nil {
			continue
		}

		// Determine OS
		osType := "Windows"
		if app.Kind != nil && strings.Contains(strings.ToLower(*app.Kind), "linux") {
			osType = "Linux"
		}
		summary.ByOS[osType]++

		// Get site config for runtime details
		config, err := webClient.GetConfiguration(ctx, rg, name, nil)
		var siteConfig *armappservice.SiteConfig
		if err == nil && config.Properties != nil {
			siteConfig = config.Properties
		}

		// Determine runtime and version
		runtime := "unknown"
		runtimeVersion := ""
		if siteConfig != nil {
			if siteConfig.LinuxFxVersion != nil && *siteConfig.LinuxFxVersion != "" {
				parts := strings.SplitN(*siteConfig.LinuxFxVersion, "|", 2)
				runtime = strings.ToLower(parts[0])
				if len(parts) > 1 {
					runtimeVersion = parts[1]
				}
			} else if siteConfig.NetFrameworkVersion != nil && *siteConfig.NetFrameworkVersion != "" {
				runtime = "dotnet"
				runtimeVersion = *siteConfig.NetFrameworkVersion
			} else if siteConfig.JavaVersion != nil && *siteConfig.JavaVersion != "" {
				runtime = "java"
				runtimeVersion = *siteConfig.JavaVersion
			} else if siteConfig.PowerShellVersion != nil && *siteConfig.PowerShellVersion != "" {
				runtime = "powershell"
				runtimeVersion = *siteConfig.PowerShellVersion
			}
		}

		// Also check app settings for FUNCTIONS_WORKER_RUNTIME and FUNCTIONS_EXTENSION_VERSION
		appSettings, err := webClient.ListApplicationSettings(ctx, rg, name, nil)
		workerRuntime := ""
		extensionVersion := ""
		if err == nil && appSettings.Properties != nil {
			for k, v := range appSettings.Properties {
				if strings.EqualFold(k, "FUNCTIONS_WORKER_RUNTIME") && v != nil {
					workerRuntime = *v
				}
				if strings.EqualFold(k, "FUNCTIONS_EXTENSION_VERSION") && v != nil {
					extensionVersion = *v
				}
			}
		}

		if workerRuntime != "" {
			runtime = strings.ToLower(workerRuntime)
		}
		summary.ByRuntime[runtime]++

		// 1. Functions Extension Version check
		if extensionVersion != "" && extensionVersion != "~4" {
			sev := Warning
			if extensionVersion == "~1" || extensionVersion == "~2" {
				sev = Critical
			}
			findings = append(findings, FunctionsFinding{
				Severity:       sev,
				Category:       "Outdated Runtime Version",
				FunctionApp:    name,
				ResourceGrp:    rg,
				Description:    fmt.Sprintf("Functions extension version is %s (recommended: ~4)", extensionVersion),
				Recommendation: "Upgrade to Functions runtime v4 for latest features, security patches, and performance improvements.",
			})
		}

		// 2. Runtime version currency
		if runtimeVersion != "" {
			if current, ok := currentRuntimeVersions[runtime]; ok {
				if !strings.Contains(runtimeVersion, strings.TrimPrefix(current, "~")) &&
					!strings.Contains(runtimeVersion, strings.TrimPrefix(current, "v")) &&
					runtimeVersion != current {
					findings = append(findings, FunctionsFinding{
						Severity:       Info,
						Category:       "Runtime Version",
						FunctionApp:    name,
						ResourceGrp:    rg,
						Description:    fmt.Sprintf("Runtime %s version %s (current recommended: %s)", runtime, runtimeVersion, current),
						Recommendation: fmt.Sprintf("Consider upgrading %s runtime to %s for latest features and security patches.", runtime, current),
					})
				}
			}
		}

		// 3. HTTPS only
		if props.HTTPSOnly == nil || !*props.HTTPSOnly {
			findings = append(findings, FunctionsFinding{
				Severity:       Warning,
				Category:       "HTTPS Not Enforced",
				FunctionApp:    name,
				ResourceGrp:    rg,
				Description:    "HTTPS-only is not enabled â€” HTTP traffic is allowed",
				Recommendation: "Enable HTTPS Only to ensure all traffic is encrypted in transit.",
			})
		}

		// 4. Managed Identity
		if app.Identity == nil || app.Identity.Type == nil ||
			*app.Identity.Type == armappservice.ManagedServiceIdentityTypeNone {
			findings = append(findings, FunctionsFinding{
				Severity:       Warning,
				Category:       "No Managed Identity",
				FunctionApp:    name,
				ResourceGrp:    rg,
				Description:    "No managed identity configured â€” likely using connection strings or keys for auth",
				Recommendation: "Enable system-assigned or user-assigned managed identity for secure, keyless authentication to Azure services.",
			})
		}

		// 5. Check App Service Plan (always-on, SKU)
		if props.ServerFarmID != nil && *props.ServerFarmID != "" {
			planID := *props.ServerFarmID
			plan, ok := planCache[strings.ToLower(planID)]
			if !ok {
				planRG := extractResourceGroup(planID)
				planName := extractLastSegment(planID)
				if planRG != "" && planName != "" {
					resp, err := plansClient.Get(ctx, planRG, planName, nil)
					if err == nil {
						plan = &resp.Plan
						planCache[strings.ToLower(planID)] = plan
					}
				}
			}

			if plan != nil {
				skuName := ""
				skuTier := ""
				if plan.SKU != nil {
					if plan.SKU.Name != nil {
						skuName = *plan.SKU.Name
					}
					if plan.SKU.Tier != nil {
						skuTier = *plan.SKU.Tier
					}
				}
				summary.BySKU[skuName]++

				isConsumption := strings.EqualFold(skuTier, "Dynamic") || strings.EqualFold(skuName, "Y1")
				isPremium := strings.HasPrefix(strings.ToUpper(skuName), "EP") || strings.EqualFold(skuTier, "ElasticPremium")

				// Always-on check (only relevant for non-consumption plans)
				if !isConsumption {
					if siteConfig != nil && (siteConfig.AlwaysOn == nil || !*siteConfig.AlwaysOn) {
						findings = append(findings, FunctionsFinding{
							Severity:       Warning,
							Category:       "Always-On Disabled",
							FunctionApp:    name,
							ResourceGrp:    rg,
							Description:    fmt.Sprintf("Always-On is disabled on %s plan (SKU: %s) â€” may cause cold starts", skuTier, skuName),
							Recommendation: "Enable Always-On for dedicated/premium plans to avoid cold starts and idle timeouts.",
						})
					}
				}

				// Consumption plan info
				if isConsumption {
					findings = append(findings, FunctionsFinding{
						Severity:       Info,
						Category:       "Consumption Plan",
						FunctionApp:    name,
						ResourceGrp:    rg,
						Description:    "Running on Consumption plan â€” subject to cold starts and 5-minute timeout",
						Recommendation: "Consider Premium plan (EP1+) if you need predictable latency, VNET integration, or longer execution times.",
					})
				}

				// Premium plan without VNET
				if isPremium {
					if props.VirtualNetworkSubnetID == nil || *props.VirtualNetworkSubnetID == "" {
						findings = append(findings, FunctionsFinding{
							Severity:       Info,
							Category:       "Premium Without VNET",
							FunctionApp:    name,
							ResourceGrp:    rg,
							Description:    "Running on Premium plan but no VNET integration configured",
							Recommendation: "Premium plans support VNET integration â€” configure it if you need private access to backend services.",
						})
					}
				}
			}
		}

		// 6. Minimum TLS version
		if siteConfig != nil && siteConfig.MinTLSVersion != nil {
			tlsVer := string(*siteConfig.MinTLSVersion)
			if tlsVer != "" && tlsVer != "1.2" && tlsVer != "1.3" {
				findings = append(findings, FunctionsFinding{
					Severity:       Warning,
					Category:       "Outdated TLS Version",
					FunctionApp:    name,
					ResourceGrp:    rg,
					Description:    fmt.Sprintf("Minimum TLS version is %s", tlsVer),
					Recommendation: "Set minimum TLS version to 1.2 or higher for security compliance.",
				})
			}
		}

		// 8. App state
		if props.State != nil && !strings.EqualFold(*props.State, "Running") {
			findings = append(findings, FunctionsFinding{
				Severity:       Info,
				Category:       "Not Running",
				FunctionApp:    name,
				ResourceGrp:    rg,
				Description:    fmt.Sprintf("Function App state: %s", deref(props.State)),
				Recommendation: "Review if this Function App is still needed. Delete if unused to reduce clutter.",
			})
		}

		// 9. Remote debugging
		if siteConfig != nil && siteConfig.RemoteDebuggingEnabled != nil && *siteConfig.RemoteDebuggingEnabled {
			findings = append(findings, FunctionsFinding{
				Severity:       Critical,
				Category:       "Remote Debugging Enabled",
				FunctionApp:    name,
				ResourceGrp:    rg,
				Description:    "Remote debugging is enabled in production",
				Recommendation: "Disable remote debugging â€” it opens additional ports and should only be used during active debugging sessions.",
			})
		}

		// 10. FTP state
		if siteConfig != nil && siteConfig.FtpsState != nil {
			ftps := string(*siteConfig.FtpsState)
			if strings.EqualFold(ftps, "AllAllowed") {
				findings = append(findings, FunctionsFinding{
					Severity:       Warning,
					Category:       "FTP Allowed",
					FunctionApp:    name,
					ResourceGrp:    rg,
					Description:    "Plain FTP is allowed (not just FTPS)",
					Recommendation: "Set FTP state to 'FtpsOnly' or 'Disabled' to prevent unencrypted file transfers.",
				})
			}
		}
	}

	for _, f := range findings {
		summary.FindingsBySeverity[string(f.Severity)]++
	}

	report := FunctionsReport{
		Summary:  summary,
		Findings: findings,
	}

	switch flagOutput {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	default:
		printFunctionsTable(report)
	}

	return nil
}

// FunctionAppInput consolidates all fields needed for testable analysis.
type FunctionAppInput struct {
	Name                   string
	ResourceGroup          string
	Kind                   string
	State                  string
	HTTPSOnly              bool
	HasManagedIdentity     bool
	ExtensionVersion       string
	WorkerRuntime          string
	Runtime                string
	RuntimeVersion         string
	AlwaysOn               bool
	IsConsumptionPlan      bool
	IsPremiumPlan          bool
	HasVNETIntegration     bool
	MinTLSVersion          string
	RemoteDebuggingEnabled bool
	FtpsState              string
}

// AnalyzeFunctionsData runs function app checks on pre-built input â€” no Azure calls.
func AnalyzeFunctionsData(apps []FunctionAppInput) []FunctionsFinding {
	var findings []FunctionsFinding
	for _, app := range apps {
		if app.ExtensionVersion != "" && app.ExtensionVersion != "~4" {
			sev := Warning
			if app.ExtensionVersion == "~1" || app.ExtensionVersion == "~2" {
				sev = Critical
			}
			findings = append(findings, FunctionsFinding{
				Severity: sev, Category: "Outdated Runtime Version",
				FunctionApp: app.Name, ResourceGrp: app.ResourceGroup,
				Description:    fmt.Sprintf("Functions extension version is %s (recommended: ~4)", app.ExtensionVersion),
				Recommendation: "Upgrade to Functions runtime v4 for latest features, security patches, and performance improvements.",
			})
		}

		if app.RuntimeVersion != "" && app.Runtime != "" {
			if current, ok := currentRuntimeVersions[app.Runtime]; ok {
				if !strings.Contains(app.RuntimeVersion, strings.TrimPrefix(current, "~")) &&
					!strings.Contains(app.RuntimeVersion, strings.TrimPrefix(current, "v")) &&
					app.RuntimeVersion != current {
					findings = append(findings, FunctionsFinding{
						Severity: Info, Category: "Runtime Version",
						FunctionApp: app.Name, ResourceGrp: app.ResourceGroup,
						Description:    fmt.Sprintf("Runtime %s version %s (current recommended: %s)", app.Runtime, app.RuntimeVersion, current),
						Recommendation: fmt.Sprintf("Consider upgrading %s runtime to %s for latest features and security patches.", app.Runtime, current),
					})
				}
			}
		}

		if !app.HTTPSOnly {
			findings = append(findings, FunctionsFinding{
				Severity: Warning, Category: "HTTPS Not Enforced",
				FunctionApp: app.Name, ResourceGrp: app.ResourceGroup,
				Description:    "HTTPS-only is not enabled â€” HTTP traffic is allowed",
				Recommendation: "Enable HTTPS Only to ensure all traffic is encrypted in transit.",
			})
		}

		if !app.HasManagedIdentity {
			findings = append(findings, FunctionsFinding{
				Severity: Warning, Category: "No Managed Identity",
				FunctionApp: app.Name, ResourceGrp: app.ResourceGroup,
				Description:    "No managed identity configured â€” likely using connection strings or keys for auth",
				Recommendation: "Enable system-assigned or user-assigned managed identity for secure, keyless authentication to Azure services.",
			})
		}

		if !app.IsConsumptionPlan && !app.AlwaysOn {
			findings = append(findings, FunctionsFinding{
				Severity: Warning, Category: "Always-On Disabled",
				FunctionApp: app.Name, ResourceGrp: app.ResourceGroup,
				Description:    "Always-On is disabled on dedicated/premium plan â€” may cause cold starts",
				Recommendation: "Enable Always-On for dedicated/premium plans to avoid cold starts and idle timeouts.",
			})
		}

		if app.IsConsumptionPlan {
			findings = append(findings, FunctionsFinding{
				Severity: Info, Category: "Consumption Plan",
				FunctionApp: app.Name, ResourceGrp: app.ResourceGroup,
				Description:    "Running on Consumption plan â€” subject to cold starts and 5-minute timeout",
				Recommendation: "Consider Premium plan (EP1+) if you need predictable latency, VNET integration, or longer execution times.",
			})
		}

		if app.IsPremiumPlan && !app.HasVNETIntegration {
			findings = append(findings, FunctionsFinding{
				Severity: Info, Category: "Premium Without VNET",
				FunctionApp: app.Name, ResourceGrp: app.ResourceGroup,
				Description:    "Running on Premium plan but no VNET integration configured",
				Recommendation: "Premium plans support VNET integration â€” configure it if you need private access to backend services.",
			})
		}

		if app.MinTLSVersion != "" && app.MinTLSVersion != "1.2" && app.MinTLSVersion != "1.3" {
			findings = append(findings, FunctionsFinding{
				Severity: Warning, Category: "Outdated TLS Version",
				FunctionApp: app.Name, ResourceGrp: app.ResourceGroup,
				Description:    fmt.Sprintf("Minimum TLS version is %s", app.MinTLSVersion),
				Recommendation: "Set minimum TLS version to 1.2 or higher for security compliance.",
			})
		}

		if app.State != "" && !strings.EqualFold(app.State, "Running") {
			findings = append(findings, FunctionsFinding{
				Severity: Info, Category: "Not Running",
				FunctionApp: app.Name, ResourceGrp: app.ResourceGroup,
				Description:    fmt.Sprintf("Function App state: %s", app.State),
				Recommendation: "Review if this Function App is still needed. Delete if unused to reduce clutter.",
			})
		}

		if app.RemoteDebuggingEnabled {
			findings = append(findings, FunctionsFinding{
				Severity: Critical, Category: "Remote Debugging Enabled",
				FunctionApp: app.Name, ResourceGrp: app.ResourceGroup,
				Description:    "Remote debugging is enabled in production",
				Recommendation: "Disable remote debugging â€” it opens additional ports and should only be used during active debugging sessions.",
			})
		}

		if strings.EqualFold(app.FtpsState, "AllAllowed") {
			findings = append(findings, FunctionsFinding{
				Severity: Warning, Category: "FTP Allowed",
				FunctionApp: app.Name, ResourceGrp: app.ResourceGroup,
				Description:    "Plain FTP is allowed (not just FTPS)",
				Recommendation: "Set FTP state to 'FtpsOnly' or 'Disabled' to prevent unencrypted file transfers.",
			})
		}
	}
	return findings
}

// extractLastSegment returns the last path segment of a resource ID.
func extractLastSegment(resourceID string) string {
	parts := strings.Split(resourceID, "/")
	if len(parts) == 0 {
		return ""
	}
	return parts[len(parts)-1]
}

func printFunctionsTable(r FunctionsReport) {
	fmt.Println()
	fmt.Println("AZURE FUNCTIONS ANALYSIS")
	fmt.Println(strings.Repeat("=", 100))
	fmt.Println()

	fmt.Println("SUMMARY")
	fmt.Println(strings.Repeat("-", 50))
	fmt.Printf("  Total Function Apps: %d\n", r.Summary.TotalFunctionApps)
	fmt.Println()
	fmt.Println("  By Runtime:")
	for rt, count := range r.Summary.ByRuntime {
		fmt.Printf("    %-30s %d\n", rt, count)
	}
	fmt.Println()
	fmt.Println("  By SKU:")
	for sku, count := range r.Summary.BySKU {
		fmt.Printf("    %-30s %d\n", sku, count)
	}
	fmt.Println()
	fmt.Println("  By OS:")
	for os, count := range r.Summary.ByOS {
		fmt.Printf("    %-30s %d\n", os, count)
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
	fmt.Fprintln(w, "SEVERITY\tCATEGORY\tFUNCTION APP\tRESOURCE GROUP\tDESCRIPTION\t")
	fmt.Fprintln(w, "--------\t--------\t------------\t--------------\t-----------\t")
	for _, f := range r.Findings {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t\n",
			f.Severity, f.Category, f.FunctionApp, f.ResourceGrp, f.Description)
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
