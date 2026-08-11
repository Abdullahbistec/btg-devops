package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/network/armnetwork/v4"
	"github.com/spf13/cobra"
)

// ---------- data types ----------

type NSGFinding struct {
	Severity       Severity `json:"severity"`
	Category       string   `json:"category"`
	NSGName        string   `json:"nsg_name"`
	ResourceGroup  string   `json:"resource_group"`
	RuleName       string   `json:"rule_name,omitempty"`
	Description    string   `json:"description"`
	Recommendation string   `json:"recommendation"`
}

type NSGSummary struct {
	TotalNSGs          int            `json:"total_nsgs"`
	TotalRules         int            `json:"total_rules"`
	FindingsBySeverity map[string]int `json:"findings_by_severity"`
	UnassociatedNSGs   int            `json:"unassociated_nsgs"`
}

type NSGReport struct {
	Summary  NSGSummary   `json:"summary"`
	Findings []NSGFinding `json:"findings"`
}

// ---------- command ----------

var nsgCmd = &cobra.Command{
	Use:   "nsg",
	Short: "Analyze Network Security Groups for overly permissive rules and misconfigurations",
	Long:  "Checks all NSGs for any-any rules, open management ports (RDP/SSH) to the internet, overly broad CIDR ranges, and unassociated NSGs.",
	RunE:  runNSG,
}

func init() {
	analyzeCmd.AddCommand(nsgCmd)
	nsgCmd.Flags().StringVar(&flagSubscriptionID, "subscription-id", "", "Azure Subscription ID (overrides AZURE_SUBSCRIPTION_ID env var)")
	nsgCmd.Flags().StringVar(&flagResourceGroup, "resource-group", "", "Filter by resource group (optional)")
	nsgCmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
}

// Management ports considered dangerous when open to the internet
var dangerousPorts = map[int32]string{
	22:    "SSH",
	3389:  "RDP",
	445:   "SMB",
	1433:  "SQL Server",
	3306:  "MySQL",
	5432:  "PostgreSQL",
	27017: "MongoDB",
	6379:  "Redis",
}

func runNSG(_ *cobra.Command, _ []string) error {
	ctx := context.Background()
	subID := getSubscriptionID()
	if subID == "" {
		return fmt.Errorf("subscription ID required: set --subscription-id or AZURE_SUBSCRIPTION_ID env var")
	}

	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("azure auth failed: %w", err)
	}

	nsgClient, err := armnetwork.NewSecurityGroupsClient(subID, cred, nil)
	if err != nil {
		return fmt.Errorf("creating NSG client: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Fetching NSGs for subscription %s...\n", subID)
	var nsgs []*armnetwork.SecurityGroup
	pager := nsgClient.NewListAllPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("listing NSGs: %w", err)
		}
		nsgs = append(nsgs, page.Value...)
	}

	// Filter by resource group if specified
	if flagResourceGroup != "" {
		var filtered []*armnetwork.SecurityGroup
		for _, n := range nsgs {
			if n.ID != nil {
				rg := extractResourceGroup(*n.ID)
				if strings.EqualFold(rg, flagResourceGroup) {
					filtered = append(filtered, n)
				}
			}
		}
		nsgs = filtered
	}

	fmt.Fprintf(os.Stderr, "Found %d NSG(s). Analyzing...\n", len(nsgs))

	summary := NSGSummary{
		TotalNSGs:          len(nsgs),
		FindingsBySeverity: map[string]int{},
	}
	var findings []NSGFinding

	for _, nsg := range nsgs {
		name := deref(nsg.Name)
		rg := extractResourceGroup(deref(nsg.ID))
		props := nsg.Properties

		if props == nil {
			continue
		}

		// Check if NSG is associated with anything
		subnetCount := 0
		nicCount := 0
		if props.Subnets != nil {
			subnetCount = len(props.Subnets)
		}
		if props.NetworkInterfaces != nil {
			nicCount = len(props.NetworkInterfaces)
		}
		if subnetCount == 0 && nicCount == 0 {
			summary.UnassociatedNSGs++
			findings = append(findings, NSGFinding{
				Severity:       Warning,
				Category:       "Unassociated NSG",
				NSGName:        name,
				ResourceGroup:  rg,
				Description:    "NSG is not associated with any subnet or network interface",
				Recommendation: "Remove unused NSGs or associate them with appropriate resources.",
			})
		}

		// Analyze security rules (custom rules)
		allRules := make([]*armnetwork.SecurityRule, 0)
		if props.SecurityRules != nil {
			allRules = append(allRules, props.SecurityRules...)
		}

		summary.TotalRules += len(allRules)

		for _, rule := range allRules {
			if rule.Properties == nil || rule.Name == nil {
				continue
			}
			rp := rule.Properties
			ruleName := *rule.Name

			// Only check Allow rules (Deny rules are fine)
			if rp.Access == nil || *rp.Access != armnetwork.SecurityRuleAccessAllow {
				continue
			}

			// Only check Inbound rules
			if rp.Direction == nil || *rp.Direction != armnetwork.SecurityRuleDirectionInbound {
				continue
			}

			srcAddr := deref(rp.SourceAddressPrefix)
			dstPort := deref(rp.DestinationPortRange)
			protocol := ""
			if rp.Protocol != nil {
				protocol = string(*rp.Protocol)
			}

			isFromInternet := srcAddr == "*" || strings.EqualFold(srcAddr, "Internet") || srcAddr == "0.0.0.0/0"

			// 1. Any-any rule (all ports, all sources)
			if isFromInternet && (dstPort == "*" || strings.EqualFold(protocol, "*")) {
				findings = append(findings, NSGFinding{
					Severity:       Critical,
					Category:       "Any-Any Allow Rule",
					NSGName:        name,
					ResourceGroup:  rg,
					RuleName:       ruleName,
					Description:    fmt.Sprintf("Rule allows ALL inbound traffic from %s on port %s (protocol: %s)", srcAddr, dstPort, protocol),
					Recommendation: "Restrict source addresses and destination ports to only what is needed.",
				})
				continue // Don't double-flag individual ports
			}

			// 2. Check for dangerous management ports open to the internet
			if isFromInternet {
				portStrs := collectPortStrings(rp.DestinationPortRange, rp.DestinationPortRanges)
				openPorts := parsePortRangesFromStrings(portStrs)
				for port, svcName := range dangerousPorts {
					if portInRanges(port, openPorts) {
						sev := Critical
						findings = append(findings, NSGFinding{
							Severity:       sev,
							Category:       "Management Port Open to Internet",
							NSGName:        name,
							ResourceGroup:  rg,
							RuleName:       ruleName,
							Description:    fmt.Sprintf("Port %d (%s) is open to the internet (source: %s)", port, svcName, srcAddr),
							Recommendation: fmt.Sprintf("Restrict %s (port %d) access to specific IP addresses or use a VPN/bastion.", svcName, port),
						})
					}
				}
			}

			// 3. Overly broad source (any/internet) even for non-management ports
			if isFromInternet && dstPort != "*" {
				// Already flagged management ports above, flag remaining as warning
				portStrs2 := collectPortStrings(rp.DestinationPortRange, rp.DestinationPortRanges)
				openPorts := parsePortRangesFromStrings(portStrs2)
				hasDangerousPort := false
				for port := range dangerousPorts {
					if portInRanges(port, openPorts) {
						hasDangerousPort = true
						break
					}
				}
				if !hasDangerousPort {
					findings = append(findings, NSGFinding{
						Severity:       Warning,
						Category:       "Internet-Facing Rule",
						NSGName:        name,
						ResourceGroup:  rg,
						RuleName:       ruleName,
						Description:    fmt.Sprintf("Rule allows inbound from internet on port(s) %s", dstPort),
						Recommendation: "Review if internet access is required; restrict source IPs where possible.",
					})
				}
			}
		}
	}

	// Severity counts
	for _, f := range findings {
		summary.FindingsBySeverity[string(f.Severity)]++
	}

	report := NSGReport{
		Summary:  summary,
		Findings: findings,
	}

	switch flagOutput {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	default:
		printNSGTable(report)
	}

	return nil
}

// AnalyzeNSGFindings runs NSG checks on pre-fetched data â€” no Azure calls.
func AnalyzeNSGFindings(nsgs []*armnetwork.SecurityGroup) []NSGFinding {
	var findings []NSGFinding
	for _, nsg := range nsgs {
		name := deref(nsg.Name)
		rg := extractResourceGroup(deref(nsg.ID))
		props := nsg.Properties
		if props == nil {
			continue
		}

		subnetCount, nicCount := 0, 0
		if props.Subnets != nil {
			subnetCount = len(props.Subnets)
		}
		if props.NetworkInterfaces != nil {
			nicCount = len(props.NetworkInterfaces)
		}
		if subnetCount == 0 && nicCount == 0 {
			findings = append(findings, NSGFinding{
				Severity: Warning, Category: "Unassociated NSG",
				NSGName: name, ResourceGroup: rg,
				Description:    "NSG is not associated with any subnet or network interface",
				Recommendation: "Remove unused NSGs or associate them with appropriate resources.",
			})
		}

		var allRules []*armnetwork.SecurityRule
		if props.SecurityRules != nil {
			allRules = append(allRules, props.SecurityRules...)
		}

		for _, rule := range allRules {
			if rule.Properties == nil || rule.Name == nil {
				continue
			}
			rp := rule.Properties
			ruleName := *rule.Name

			if rp.Access == nil || *rp.Access != armnetwork.SecurityRuleAccessAllow {
				continue
			}
			if rp.Direction == nil || *rp.Direction != armnetwork.SecurityRuleDirectionInbound {
				continue
			}

			srcAddr := deref(rp.SourceAddressPrefix)
			dstPort := deref(rp.DestinationPortRange)
			protocol := ""
			if rp.Protocol != nil {
				protocol = string(*rp.Protocol)
			}

			isFromInternet := srcAddr == "*" || strings.EqualFold(srcAddr, "Internet") || srcAddr == "0.0.0.0/0"

			if isFromInternet && (dstPort == "*" || strings.EqualFold(protocol, "*")) {
				findings = append(findings, NSGFinding{
					Severity: Critical, Category: "Any-Any Allow Rule",
					NSGName: name, ResourceGroup: rg, RuleName: ruleName,
					Description:    fmt.Sprintf("Rule allows ALL inbound traffic from %s on port %s (protocol: %s)", srcAddr, dstPort, protocol),
					Recommendation: "Restrict source addresses and destination ports to only what is needed.",
				})
				continue
			}

			if isFromInternet {
				portStrs := collectPortStrings(rp.DestinationPortRange, rp.DestinationPortRanges)
				openPorts := parsePortRangesFromStrings(portStrs)
				for port, svcName := range dangerousPorts {
					if portInRanges(port, openPorts) {
						findings = append(findings, NSGFinding{
							Severity: Critical, Category: "Management Port Open to Internet",
							NSGName: name, ResourceGroup: rg, RuleName: ruleName,
							Description:    fmt.Sprintf("Port %d (%s) is open to the internet (source: %s)", port, svcName, srcAddr),
							Recommendation: fmt.Sprintf("Restrict %s (port %d) access to specific IP addresses or use a VPN/bastion.", svcName, port),
						})
					}
				}
			}

			if isFromInternet && dstPort != "*" {
				portStrs2 := collectPortStrings(rp.DestinationPortRange, rp.DestinationPortRanges)
				openPorts := parsePortRangesFromStrings(portStrs2)
				hasDangerousPort := false
				for port := range dangerousPorts {
					if portInRanges(port, openPorts) {
						hasDangerousPort = true
						break
					}
				}
				if !hasDangerousPort {
					findings = append(findings, NSGFinding{
						Severity: Warning, Category: "Internet-Facing Rule",
						NSGName: name, ResourceGroup: rg, RuleName: ruleName,
						Description:    fmt.Sprintf("Rule allows inbound from internet on port(s) %s", dstPort),
						Recommendation: "Review if internet access is required; restrict source IPs where possible.",
					})
				}
			}
		}
	}
	return findings
}

// ---------- port parsing helpers ----------

type portRange struct {
	Start int32
	End   int32
}

func collectPortStrings(single *string, multi []*string) []string {
	var out []string
	if single != nil && *single != "" {
		out = append(out, *single)
	}
	for _, p := range multi {
		if p != nil {
			out = append(out, *p)
		}
	}
	return out
}

func parsePortRangesFromStrings(portStrs []string) []portRange {
	var ranges []portRange
	sources := portStrs
	for _, s := range sources {
		if s == "*" {
			ranges = append(ranges, portRange{0, 65535})
			continue
		}
		parts := strings.SplitN(s, "-", 2)
		if len(parts) == 2 {
			var lo, hi int32
			_, _ = fmt.Sscanf(parts[0], "%d", &lo)
			_, _ = fmt.Sscanf(parts[1], "%d", &hi)
			ranges = append(ranges, portRange{lo, hi})
		} else {
			var p int32
			_, _ = fmt.Sscanf(s, "%d", &p)
			ranges = append(ranges, portRange{p, p})
		}
	}
	return ranges
}

func portInRanges(port int32, ranges []portRange) bool {
	for _, r := range ranges {
		if port >= r.Start && port <= r.End {
			return true
		}
	}
	return false
}

// ---------- output ----------

func printNSGTable(r NSGReport) {
	fmt.Println()
	fmt.Println("NETWORK SECURITY GROUP ANALYSIS")
	fmt.Println(strings.Repeat("=", 100))
	fmt.Println()

	fmt.Println("SUMMARY")
	fmt.Println(strings.Repeat("-", 50))
	fmt.Printf("  Total NSGs:           %d\n", r.Summary.TotalNSGs)
	fmt.Printf("  Total Custom Rules:   %d\n", r.Summary.TotalRules)
	fmt.Printf("  Unassociated NSGs:    %d\n", r.Summary.UnassociatedNSGs)
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
	fmt.Fprintln(w, "SEVERITY\tCATEGORY\tNSG\tRULE\tRESOURCE GROUP\tDESCRIPTION\t")
	fmt.Fprintln(w, "--------\t--------\t---\t----\t--------------\t-----------\t")
	for _, f := range r.Findings {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\t\n",
			f.Severity, f.Category, f.NSGName, f.RuleName, f.ResourceGroup, f.Description)
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
