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
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/cosmos/armcosmos/v3"
	"github.com/spf13/cobra"
)

// ---------- data types ----------

type CosmosDBFinding struct {
	Severity       Severity `json:"severity"`
	Category       string   `json:"category"`
	AccountName    string   `json:"account_name"`
	ResourceGroup  string   `json:"resource_group"`
	Description    string   `json:"description"`
	Recommendation string   `json:"recommendation"`
}

type CosmosDBSummary struct {
	TotalAccounts      int            `json:"total_accounts"`
	FindingsBySeverity map[string]int `json:"findings_by_severity"`
	ByKind             map[string]int `json:"by_kind"`
}

type CosmosDBReport struct {
	Summary  CosmosDBSummary   `json:"summary"`
	Findings []CosmosDBFinding `json:"findings"`
}

// ---------- command ----------

var cosmosdbCmd = &cobra.Command{
	Use:   "cosmosdb",
	Short: "Analyze Cosmos DB accounts for cost optimization, configuration, and best practices",
	Long:  "Checks all Azure Cosmos DB accounts for throughput settings, autoscale configuration, backup policies, network security, and consistency settings.",
	RunE:  runCosmosDB,
}

func init() {
	analyzeCmd.AddCommand(cosmosdbCmd)
	cosmosdbCmd.Flags().StringVar(&flagSubscriptionID, "subscription-id", "", "Azure Subscription ID (overrides AZURE_SUBSCRIPTION_ID env var)")
	cosmosdbCmd.Flags().StringVar(&flagResourceGroup, "resource-group", "", "Filter by resource group (optional)")
	cosmosdbCmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
}

func runCosmosDB(_ *cobra.Command, _ []string) error {
	ctx := context.Background()
	subID := getSubscriptionID()
	if subID == "" {
		return fmt.Errorf("subscription ID required: set --subscription-id or AZURE_SUBSCRIPTION_ID env var")
	}

	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("azure auth failed: %w", err)
	}

	accountsClient, err := armcosmos.NewDatabaseAccountsClient(subID, cred, nil)
	if err != nil {
		return fmt.Errorf("creating cosmos db client: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Fetching Cosmos DB accounts for subscription %s...\n", subID)
	var accounts []*armcosmos.DatabaseAccountGetResults
	pager := accountsClient.NewListPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("listing cosmos db accounts: %w", err)
		}
		accounts = append(accounts, page.Value...)
	}

	// Filter by resource group if specified
	if flagResourceGroup != "" {
		var filtered []*armcosmos.DatabaseAccountGetResults
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

	fmt.Fprintf(os.Stderr, "Found %d Cosmos DB account(s). Analyzing...\n", len(accounts))

	summary := CosmosDBSummary{
		TotalAccounts:      len(accounts),
		FindingsBySeverity: map[string]int{},
		ByKind:             map[string]int{},
	}
	var findings []CosmosDBFinding

	// SQL Resources client for database/container throughput checks
	sqlClient, err := armcosmos.NewSQLResourcesClient(subID, cred, nil)
	if err != nil {
		sqlClient = nil
	}

	for _, acct := range accounts {
		name := deref(acct.Name)
		rg := extractResourceGroup(deref(acct.ID))
		props := acct.Properties

		if props == nil {
			continue
		}

		// Track account kind
		if props.DatabaseAccountOfferType != nil {
			summary.ByKind[string(*props.DatabaseAccountOfferType)]++
		}

		// 1. Public network access enabled
		if props.PublicNetworkAccess != nil && *props.PublicNetworkAccess == armcosmos.PublicNetworkAccessEnabled {
			findings = append(findings, CosmosDBFinding{
				Severity:       Warning,
				Category:       "Public Network Access",
				AccountName:    name,
				ResourceGroup:  rg,
				Description:    "Public network access is enabled â€” account is accessible from the internet",
				Recommendation: "Disable public network access and use private endpoints or IP firewall rules.",
			})
		}

		// 2. No IP firewall rules and public access
		if len(props.IPRules) == 0 {
			if props.PublicNetworkAccess == nil || *props.PublicNetworkAccess == armcosmos.PublicNetworkAccessEnabled {
				findings = append(findings, CosmosDBFinding{
					Severity:       Warning,
					Category:       "No IP Firewall Rules",
					AccountName:    name,
					ResourceGroup:  rg,
					Description:    "No IP firewall rules configured â€” all public IPs can access the account",
					Recommendation: "Configure IP firewall rules to restrict access to known IP ranges.",
				})
			}
		}

		// 3. No private endpoint connections
		if len(props.PrivateEndpointConnections) == 0 {
			findings = append(findings, CosmosDBFinding{
				Severity:       Warning,
				Category:       "No Private Endpoint",
				AccountName:    name,
				ResourceGroup:  rg,
				Description:    "No private endpoint connections configured",
				Recommendation: "Configure private endpoints to restrict access to your virtual network.",
			})
		}

		// 4. Backup policy â€” check if continuous or periodic
		if props.BackupPolicy != nil {
			switch bp := props.BackupPolicy.(type) {
			case *armcosmos.PeriodicModeBackupPolicy:
				if bp.PeriodicModeProperties != nil {
					interval := bp.PeriodicModeProperties.BackupIntervalInMinutes
					retention := bp.PeriodicModeProperties.BackupRetentionIntervalInHours
					if interval != nil && *interval > 240 {
						findings = append(findings, CosmosDBFinding{
							Severity:       Warning,
							Category:       "Infrequent Backups",
							AccountName:    name,
							ResourceGroup:  rg,
							Description:    fmt.Sprintf("Backup interval is %d minutes (>4 hours) â€” risk of data loss", *interval),
							Recommendation: "Reduce backup interval or switch to continuous backup for point-in-time restore.",
						})
					}
					if retention != nil && *retention < 24 {
						findings = append(findings, CosmosDBFinding{
							Severity:       Warning,
							Category:       "Short Backup Retention",
							AccountName:    name,
							ResourceGroup:  rg,
							Description:    fmt.Sprintf("Backup retention is only %d hours", *retention),
							Recommendation: "Increase backup retention period or switch to continuous backup.",
						})
					}
				}
				findings = append(findings, CosmosDBFinding{
					Severity:       Info,
					Category:       "Periodic Backup Mode",
					AccountName:    name,
					ResourceGroup:  rg,
					Description:    "Using periodic backup mode â€” no point-in-time restore capability",
					Recommendation: "Consider switching to continuous backup for point-in-time restore (up to 30 days).",
				})
			}
		}

		// 5. Consistency level check
		if props.ConsistencyPolicy != nil && props.ConsistencyPolicy.DefaultConsistencyLevel != nil {
			level := *props.ConsistencyPolicy.DefaultConsistencyLevel
			if level == armcosmos.DefaultConsistencyLevelStrong {
				findings = append(findings, CosmosDBFinding{
					Severity:       Info,
					Category:       "Strong Consistency",
					AccountName:    name,
					ResourceGroup:  rg,
					Description:    "Using Strong consistency â€” highest RU cost and latency",
					Recommendation: "Evaluate if Session or Bounded Staleness consistency would meet requirements at lower cost.",
				})
			}
		}

		// 6. Multi-region write not enabled
		if props.EnableMultipleWriteLocations != nil && !*props.EnableMultipleWriteLocations {
			if len(props.Locations) > 1 {
				findings = append(findings, CosmosDBFinding{
					Severity:       Info,
					Category:       "Multi-Region Write Disabled",
					AccountName:    name,
					ResourceGroup:  rg,
					Description:    "Account has multiple regions but multi-region write is disabled",
					Recommendation: "Enable multi-region writes for lower write latency and higher availability.",
				})
			}
		}

		// 7. Single region â€” no geo-redundancy
		if len(props.Locations) <= 1 {
			findings = append(findings, CosmosDBFinding{
				Severity:       Info,
				Category:       "Single Region",
				AccountName:    name,
				ResourceGroup:  rg,
				Description:    "Account is deployed in a single region â€” no geo-redundancy",
				Recommendation: "Add a secondary region for disaster recovery and high availability.",
			})
		}

		// 8. Automatic failover not enabled
		if props.EnableAutomaticFailover != nil && !*props.EnableAutomaticFailover {
			if len(props.Locations) > 1 {
				findings = append(findings, CosmosDBFinding{
					Severity:       Warning,
					Category:       "Automatic Failover Disabled",
					AccountName:    name,
					ResourceGroup:  rg,
					Description:    "Multi-region account without automatic failover â€” manual intervention needed during outages",
					Recommendation: "Enable automatic failover for seamless region failover during outages.",
				})
			}
		}

		// 9. CORS configured (potential security review)
		if len(props.Cors) > 0 {
			for _, cors := range props.Cors {
				if cors.AllowedOrigins != nil && *cors.AllowedOrigins == "*" {
					findings = append(findings, CosmosDBFinding{
						Severity:       Warning,
						Category:       "Wildcard CORS",
						AccountName:    name,
						ResourceGroup:  rg,
						Description:    "CORS allows all origins (*) â€” potential security risk",
						Recommendation: "Restrict CORS allowed origins to specific, trusted domains.",
					})
				}
			}
		}

		// 10. Check for key-based auth (disable if using RBAC)
		if props.DisableLocalAuth != nil && !*props.DisableLocalAuth {
			findings = append(findings, CosmosDBFinding{
				Severity:       Info,
				Category:       "Key-Based Auth Enabled",
				AccountName:    name,
				ResourceGroup:  rg,
				Description:    "Key-based (primary/secondary key) authentication is enabled",
				Recommendation: "Consider disabling key-based auth and using Azure AD RBAC for better security and auditability.",
			})
		}

		// 11. Check SQL databases and containers for throughput (manual vs autoscale)
		// Only check SQL API accounts
		isSQLAPI := props.DatabaseAccountOfferType != nil // all accounts have this, check Kind
		if acct.Kind != nil {
			k := strings.ToLower(string(*acct.Kind))
			if strings.Contains(k, "mongo") || strings.Contains(k, "gremlin") || strings.Contains(k, "table") || strings.Contains(k, "cassandra") {
				isSQLAPI = false
			}
		}
		// Also check capabilities for specific APIs
		for _, cap := range props.Capabilities {
			if cap.Name != nil {
				cn := strings.ToLower(*cap.Name)
				if strings.Contains(cn, "mongo") || strings.Contains(cn, "gremlin") || strings.Contains(cn, "table") || strings.Contains(cn, "cassandra") {
					isSQLAPI = false
				}
			}
		}
		if sqlClient != nil && isSQLAPI {
			tpCtx, tpCancel := context.WithTimeout(ctx, 15*time.Second)
			dbPager := sqlClient.NewListSQLDatabasesPager(rg, name, nil)
			for dbPager.More() {
				dbPage, err := dbPager.NextPage(tpCtx)
				if err != nil {
					break
				}
				for _, db := range dbPage.Value {
					dbName := deref(db.Name)

					// Check database-level throughput
					throughput, err := sqlClient.GetSQLDatabaseThroughput(tpCtx, rg, name, dbName, nil)
					if err == nil && throughput.Properties != nil && throughput.Properties.Resource != nil {
						res := throughput.Properties.Resource
						if res.AutoscaleSettings == nil && res.Throughput != nil {
							findings = append(findings, CosmosDBFinding{
								Severity:       Info,
								Category:       "Manual Throughput (Database)",
								AccountName:    name,
								ResourceGroup:  rg,
								Description:    fmt.Sprintf("Database '%s' uses manual throughput (%d RU/s) â€” may over-provision during low usage", dbName, *res.Throughput),
								Recommendation: fmt.Sprintf("Consider enabling autoscale on database '%s' to reduce costs during low-traffic periods.", dbName),
							})
						}
						if res.AutoscaleSettings != nil && res.AutoscaleSettings.MaxThroughput != nil {
							maxRU := *res.AutoscaleSettings.MaxThroughput
							if maxRU >= 40000 {
								findings = append(findings, CosmosDBFinding{
									Severity:       Warning,
									Category:       "High Autoscale Max (Database)",
									AccountName:    name,
									ResourceGroup:  rg,
									Description:    fmt.Sprintf("Database '%s' has autoscale max of %d RU/s â€” verify this is needed", dbName, maxRU),
									Recommendation: fmt.Sprintf("Review if database '%s' needs %d max RU/s or if it can be lowered to reduce costs.", dbName, maxRU),
								})
							}
						}
					}

					// Check container-level throughput
					cPager := sqlClient.NewListSQLContainersPager(rg, name, dbName, nil)
					for cPager.More() {
						cPage, err := cPager.NextPage(tpCtx)
						if err != nil {
							break
						}
						for _, container := range cPage.Value {
							cName := deref(container.Name)
							cThroughput, err := sqlClient.GetSQLContainerThroughput(tpCtx, rg, name, dbName, cName, nil)
							if err == nil && cThroughput.Properties != nil && cThroughput.Properties.Resource != nil {
								res := cThroughput.Properties.Resource
								if res.AutoscaleSettings == nil && res.Throughput != nil {
									findings = append(findings, CosmosDBFinding{
										Severity:       Info,
										Category:       "Manual Throughput (Container)",
										AccountName:    name,
										ResourceGroup:  rg,
										Description:    fmt.Sprintf("Container '%s/%s' uses manual throughput (%d RU/s)", dbName, cName, *res.Throughput),
										Recommendation: fmt.Sprintf("Consider enabling autoscale on container '%s/%s' to reduce costs.", dbName, cName),
									})
								}
								if res.AutoscaleSettings != nil && res.AutoscaleSettings.MaxThroughput != nil {
									maxRU := *res.AutoscaleSettings.MaxThroughput
									if maxRU >= 40000 {
										findings = append(findings, CosmosDBFinding{
											Severity:       Warning,
											Category:       "High Autoscale Max (Container)",
											AccountName:    name,
											ResourceGroup:  rg,
											Description:    fmt.Sprintf("Container '%s/%s' has autoscale max of %d RU/s", dbName, cName, maxRU),
											Recommendation: fmt.Sprintf("Review container '%s/%s' throughput requirements.", dbName, cName),
										})
									}
								}
							}
						}
					}
				}
			}
			tpCancel()
		}

		// 12. Analytical store not enabled (missed HTAP opportunity)
		if props.EnableAnalyticalStorage != nil && !*props.EnableAnalyticalStorage {
			findings = append(findings, CosmosDBFinding{
				Severity:       Info,
				Category:       "Analytical Store Disabled",
				AccountName:    name,
				ResourceGroup:  rg,
				Description:    "Analytical storage (Azure Synapse Link) is not enabled",
				Recommendation: "Enable analytical storage if you need to run analytical queries without impacting transactional workloads.",
			})
		}
	}

	// Severity counts
	for _, f := range findings {
		summary.FindingsBySeverity[string(f.Severity)]++
	}

	report := CosmosDBReport{
		Summary:  summary,
		Findings: findings,
	}

	switch flagOutput {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	default:
		printCosmosDBTable(report)
	}

	return nil
}

// AnalyzeCosmosDBFindings runs CosmosDB checks on pre-fetched data â€” no Azure calls.
// Skips SQL throughput checks (require Azure client).
func AnalyzeCosmosDBFindings(accounts []*armcosmos.DatabaseAccountGetResults) []CosmosDBFinding {
	var findings []CosmosDBFinding
	for _, acct := range accounts {
		name := deref(acct.Name)
		rg := extractResourceGroup(deref(acct.ID))
		props := acct.Properties
		if props == nil {
			continue
		}

		if props.PublicNetworkAccess != nil && *props.PublicNetworkAccess == armcosmos.PublicNetworkAccessEnabled {
			findings = append(findings, CosmosDBFinding{
				Severity: Warning, Category: "Public Network Access",
				AccountName: name, ResourceGroup: rg,
				Description:    "Public network access is enabled â€” account is accessible from the internet",
				Recommendation: "Disable public network access and use private endpoints or IP firewall rules.",
			})
		}

		if len(props.IPRules) == 0 {
			if props.PublicNetworkAccess == nil || *props.PublicNetworkAccess == armcosmos.PublicNetworkAccessEnabled {
				findings = append(findings, CosmosDBFinding{
					Severity: Warning, Category: "No IP Firewall Rules",
					AccountName: name, ResourceGroup: rg,
					Description:    "No IP firewall rules configured â€” all public IPs can access the account",
					Recommendation: "Configure IP firewall rules to restrict access to known IP ranges.",
				})
			}
		}

		if len(props.PrivateEndpointConnections) == 0 {
			findings = append(findings, CosmosDBFinding{
				Severity: Warning, Category: "No Private Endpoint",
				AccountName: name, ResourceGroup: rg,
				Description:    "No private endpoint connections configured",
				Recommendation: "Configure private endpoints to restrict access to your virtual network.",
			})
		}

		if props.BackupPolicy != nil {
			switch bp := props.BackupPolicy.(type) {
			case *armcosmos.PeriodicModeBackupPolicy:
				if bp.PeriodicModeProperties != nil {
					interval := bp.PeriodicModeProperties.BackupIntervalInMinutes
					retention := bp.PeriodicModeProperties.BackupRetentionIntervalInHours
					if interval != nil && *interval > 240 {
						findings = append(findings, CosmosDBFinding{
							Severity: Warning, Category: "Infrequent Backups",
							AccountName: name, ResourceGroup: rg,
							Description:    fmt.Sprintf("Backup interval is %d minutes (>4 hours) â€” risk of data loss", *interval),
							Recommendation: "Reduce backup interval or switch to continuous backup for point-in-time restore.",
						})
					}
					if retention != nil && *retention < 24 {
						findings = append(findings, CosmosDBFinding{
							Severity: Warning, Category: "Short Backup Retention",
							AccountName: name, ResourceGroup: rg,
							Description:    fmt.Sprintf("Backup retention is only %d hours", *retention),
							Recommendation: "Increase backup retention period or switch to continuous backup.",
						})
					}
				}
				findings = append(findings, CosmosDBFinding{
					Severity: Info, Category: "Periodic Backup Mode",
					AccountName: name, ResourceGroup: rg,
					Description:    "Using periodic backup mode â€” no point-in-time restore capability",
					Recommendation: "Consider switching to continuous backup for point-in-time restore (up to 30 days).",
				})
			}
		}

		if props.ConsistencyPolicy != nil && props.ConsistencyPolicy.DefaultConsistencyLevel != nil {
			if *props.ConsistencyPolicy.DefaultConsistencyLevel == armcosmos.DefaultConsistencyLevelStrong {
				findings = append(findings, CosmosDBFinding{
					Severity: Info, Category: "Strong Consistency",
					AccountName: name, ResourceGroup: rg,
					Description:    "Using Strong consistency â€” highest RU cost and latency",
					Recommendation: "Evaluate if Session or Bounded Staleness consistency would meet requirements at lower cost.",
				})
			}
		}

		if props.EnableMultipleWriteLocations != nil && !*props.EnableMultipleWriteLocations {
			if len(props.Locations) > 1 {
				findings = append(findings, CosmosDBFinding{
					Severity: Info, Category: "Multi-Region Write Disabled",
					AccountName: name, ResourceGroup: rg,
					Description:    "Account has multiple regions but multi-region write is disabled",
					Recommendation: "Enable multi-region writes for lower write latency and higher availability.",
				})
			}
		}

		if len(props.Locations) <= 1 {
			findings = append(findings, CosmosDBFinding{
				Severity: Info, Category: "Single Region",
				AccountName: name, ResourceGroup: rg,
				Description:    "Account is deployed in a single region â€” no geo-redundancy",
				Recommendation: "Add a secondary region for disaster recovery and high availability.",
			})
		}

		if props.EnableAutomaticFailover != nil && !*props.EnableAutomaticFailover {
			if len(props.Locations) > 1 {
				findings = append(findings, CosmosDBFinding{
					Severity: Warning, Category: "Automatic Failover Disabled",
					AccountName: name, ResourceGroup: rg,
					Description:    "Multi-region account without automatic failover â€” manual intervention needed during outages",
					Recommendation: "Enable automatic failover for seamless region failover during outages.",
				})
			}
		}

		if props.Cors != nil {
			for _, cors := range props.Cors {
				if cors.AllowedOrigins != nil && *cors.AllowedOrigins == "*" {
					findings = append(findings, CosmosDBFinding{
						Severity: Warning, Category: "Wildcard CORS",
						AccountName: name, ResourceGroup: rg,
						Description:    "CORS allows all origins (*) â€” potential security risk",
						Recommendation: "Restrict CORS allowed origins to specific, trusted domains.",
					})
				}
			}
		}

		if props.DisableLocalAuth != nil && !*props.DisableLocalAuth {
			findings = append(findings, CosmosDBFinding{
				Severity: Info, Category: "Key-Based Auth Enabled",
				AccountName: name, ResourceGroup: rg,
				Description:    "Key-based (primary/secondary key) authentication is enabled",
				Recommendation: "Consider disabling key-based auth and using Azure AD RBAC for better security and auditability.",
			})
		}

		if props.EnableAnalyticalStorage != nil && !*props.EnableAnalyticalStorage {
			findings = append(findings, CosmosDBFinding{
				Severity: Info, Category: "Analytical Store Disabled",
				AccountName: name, ResourceGroup: rg,
				Description:    "Analytical storage (Azure Synapse Link) is not enabled",
				Recommendation: "Enable analytical storage if you need to run analytical queries without impacting transactional workloads.",
			})
		}
	}
	return findings
}

func printCosmosDBTable(r CosmosDBReport) {
	fmt.Println()
	fmt.Println("COSMOS DB ANALYSIS")
	fmt.Println(strings.Repeat("=", 100))
	fmt.Println()

	fmt.Println("SUMMARY")
	fmt.Println(strings.Repeat("-", 50))
	fmt.Printf("  Total Accounts: %d\n", r.Summary.TotalAccounts)
	fmt.Println()
	fmt.Println("  By Offer Type:")
	for kind, count := range r.Summary.ByKind {
		fmt.Printf("    %-30s %d\n", kind, count)
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
