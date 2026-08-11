package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/resources/armlocks"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/resources/armresources"
	"github.com/spf13/cobra"
)

// ---------- data types ----------

type RGFinding struct {
	Severity       Severity `json:"severity"`
	Category       string   `json:"category"`
	ResourceGroup  string   `json:"resource_group"`
	Location       string   `json:"location,omitempty"`
	Description    string   `json:"description"`
	Recommendation string   `json:"recommendation"`
}

type RGSummary struct {
	TotalResourceGroups int            `json:"total_resource_groups"`
	EmptyResourceGroups int            `json:"empty_resource_groups"`
	NoTagsCount         int            `json:"no_tags_count"`
	NoLocksCount        int            `json:"no_locks_count"`
	NamingViolations    int            `json:"naming_violations"`
	FindingsBySeverity  map[string]int `json:"findings_by_severity"`
}

type RGReport struct {
	Summary  RGSummary   `json:"summary"`
	Findings []RGFinding `json:"findings"`
}

// ---------- command ----------

var resourceGroupCmd = &cobra.Command{
	Use:   "resourcegroup",
	Short: "Analyze Resource Groups for empty groups, tag compliance, naming conventions, and missing locks",
	Long:  "Checks all Resource Groups for empty groups wasting clutter, missing tags, naming convention violations, and resources without management locks.",
	RunE:  runResourceGroup,
}

func init() {
	analyzeCmd.AddCommand(resourceGroupCmd)
	resourceGroupCmd.Flags().StringVar(&flagSubscriptionID, "subscription-id", "", "Azure Subscription ID (overrides AZURE_SUBSCRIPTION_ID env var)")
	resourceGroupCmd.Flags().StringVar(&flagOutput, "output", "table", "Output format: table or json")
}

// Naming convention: lowercase alphanumeric with hyphens, starting with a letter or "rg-" prefix
var rgNamingRegex = regexp.MustCompile(`^[a-z][a-z0-9-]*[a-z0-9]$`)

// Required tags that resource groups should have
var requiredTags = []string{"environment", "owner", "project"}

func runResourceGroup(_ *cobra.Command, _ []string) error {
	ctx := context.Background()
	subID := getSubscriptionID()
	if subID == "" {
		return fmt.Errorf("subscription ID required: set --subscription-id or AZURE_SUBSCRIPTION_ID env var")
	}

	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("azure auth failed: %w", err)
	}

	rgClient, err := armresources.NewResourceGroupsClient(subID, cred, nil)
	if err != nil {
		return fmt.Errorf("creating resource groups client: %w", err)
	}

	resClient, err := armresources.NewClient(subID, cred, nil)
	if err != nil {
		return fmt.Errorf("creating resources client: %w", err)
	}

	locksClient, err := armlocks.NewManagementLocksClient(subID, cred, nil)
	if err != nil {
		return fmt.Errorf("creating locks client: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Fetching Resource Groups for subscription %s...\n", subID)

	type rgInfo struct {
		Name     string
		Location string
		Tags     map[string]*string
	}

	var rgs []rgInfo
	pager := rgClient.NewListPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("listing resource groups: %w", err)
		}
		for _, rg := range page.Value {
			tags := map[string]*string{}
			if rg.Tags != nil {
				tags = rg.Tags
			}
			rgs = append(rgs, rgInfo{
				Name:     deref(rg.Name),
				Location: deref(rg.Location),
				Tags:     tags,
			})
		}
	}

	fmt.Fprintf(os.Stderr, "Found %d Resource Groups. Analyzing...\n", len(rgs))

	report := RGReport{
		Summary: RGSummary{
			TotalResourceGroups: len(rgs),
			FindingsBySeverity:  map[string]int{},
		},
	}

	for i, rg := range rgs {
		fmt.Fprintf(os.Stderr, "  [%d/%d] Checking %s...\n", i+1, len(rgs), rg.Name)
		// Check 1: Empty resource group
		checkCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		isEmpty, err := isRGEmpty(checkCtx, resClient, rg.Name)
		cancel()
		if err != nil {
			fmt.Fprintf(os.Stderr, "  Warning: could not check resources in %s: %v\n", rg.Name, err)
		} else if isEmpty {
			report.Summary.EmptyResourceGroups++
			report.addRGFinding(RGFinding{
				Severity:       Warning,
				Category:       "Empty Resource Group",
				ResourceGroup:  rg.Name,
				Location:       rg.Location,
				Description:    fmt.Sprintf("Resource group '%s' contains no resources", rg.Name),
				Recommendation: "Delete empty resource groups to reduce clutter and improve governance",
			})
		}

		// Check 2: Missing required tags
		missingTags := []string{}
		for _, tag := range requiredTags {
			found := false
			for k := range rg.Tags {
				if strings.EqualFold(k, tag) {
					found = true
					break
				}
			}
			if !found {
				missingTags = append(missingTags, tag)
			}
		}
		if len(missingTags) > 0 {
			sev := Warning
			if len(rg.Tags) == 0 {
				sev = Critical
				report.Summary.NoTagsCount++
			}
			report.addRGFinding(RGFinding{
				Severity:       sev,
				Category:       "Tag Compliance",
				ResourceGroup:  rg.Name,
				Location:       rg.Location,
				Description:    fmt.Sprintf("Resource group '%s' missing tags: %s", rg.Name, strings.Join(missingTags, ", ")),
				Recommendation: "Add required tags (environment, owner, project) for cost tracking and governance",
			})
		}

		// Check 3: Naming convention violations
		nameLower := strings.ToLower(rg.Name)
		if !rgNamingRegex.MatchString(nameLower) {
			report.Summary.NamingViolations++
			report.addRGFinding(RGFinding{
				Severity:       Info,
				Category:       "Naming Convention",
				ResourceGroup:  rg.Name,
				Location:       rg.Location,
				Description:    fmt.Sprintf("Resource group '%s' doesn't follow naming convention (lowercase alphanumeric with hyphens)", rg.Name),
				Recommendation: "Use consistent naming like 'rg-<project>-<env>-<region>' for better organization",
			})
		}

		// Check 4: No management locks (skip empty RGs)
		if !isEmpty {
			lockCtx, lockCancel := context.WithTimeout(ctx, 10*time.Second)
			hasLock, err := rgHasLock(lockCtx, locksClient, rg.Name)
			lockCancel()
			if err != nil {
				fmt.Fprintf(os.Stderr, "  Warning: could not check locks for %s: %v\n", rg.Name, err)
			} else if !hasLock {
				report.Summary.NoLocksCount++
				report.addRGFinding(RGFinding{
					Severity:       Info,
					Category:       "Missing Lock",
					ResourceGroup:  rg.Name,
					Location:       rg.Location,
					Description:    fmt.Sprintf("Resource group '%s' has no management lock", rg.Name),
					Recommendation: "Add a CanNotDelete or ReadOnly lock to protect critical resource groups from accidental deletion",
				})
			}
		}
	}

	switch flagOutput {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	default:
		printRGReport(report)
	}
	return nil
}

// RGInput holds pre-fetched resource group data for testable analysis.
type RGInput struct {
	Name     string
	Location string
	Tags     map[string]*string
	IsEmpty  bool
	HasLock  bool
}

// AnalyzeRGFindings runs resource group checks on pre-fetched data â€” no Azure calls.
func AnalyzeRGFindings(rgs []RGInput) []RGFinding {
	var findings []RGFinding
	for _, rg := range rgs {
		if rg.IsEmpty {
			findings = append(findings, RGFinding{
				Severity: Warning, Category: "Empty Resource Group",
				ResourceGroup: rg.Name, Location: rg.Location,
				Description:    fmt.Sprintf("Resource group '%s' contains no resources", rg.Name),
				Recommendation: "Delete empty resource groups to reduce clutter and improve governance",
			})
		}

		missingTags := []string{}
		for _, tag := range requiredTags {
			found := false
			for k := range rg.Tags {
				if strings.EqualFold(k, tag) {
					found = true
					break
				}
			}
			if !found {
				missingTags = append(missingTags, tag)
			}
		}
		if len(missingTags) > 0 {
			sev := Warning
			if len(rg.Tags) == 0 {
				sev = Critical
			}
			findings = append(findings, RGFinding{
				Severity: sev, Category: "Tag Compliance",
				ResourceGroup: rg.Name, Location: rg.Location,
				Description:    fmt.Sprintf("Resource group '%s' missing tags: %s", rg.Name, strings.Join(missingTags, ", ")),
				Recommendation: "Add required tags (environment, owner, project) for cost tracking and governance",
			})
		}

		nameLower := strings.ToLower(rg.Name)
		if !rgNamingRegex.MatchString(nameLower) {
			findings = append(findings, RGFinding{
				Severity: Info, Category: "Naming Convention",
				ResourceGroup: rg.Name, Location: rg.Location,
				Description:    fmt.Sprintf("Resource group '%s' doesn't follow naming convention (lowercase alphanumeric with hyphens)", rg.Name),
				Recommendation: "Use consistent naming like 'rg-<project>-<env>-<region>' for better organization",
			})
		}

		if !rg.IsEmpty && !rg.HasLock {
			findings = append(findings, RGFinding{
				Severity: Info, Category: "Missing Lock",
				ResourceGroup: rg.Name, Location: rg.Location,
				Description:    fmt.Sprintf("Resource group '%s' has no management lock", rg.Name),
				Recommendation: "Add a CanNotDelete or ReadOnly lock to protect critical resource groups from accidental deletion",
			})
		}
	}
	return findings
}

func isRGEmpty(ctx context.Context, client *armresources.Client, rgName string) (bool, error) {
	pager := client.NewListByResourceGroupPager(rgName, nil)
	if pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return false, err
		}
		return len(page.Value) == 0, nil
	}
	return true, nil
}

func rgHasLock(ctx context.Context, client *armlocks.ManagementLocksClient, rgName string) (bool, error) {
	pager := client.NewListAtResourceGroupLevelPager(rgName, nil)
	if pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return false, err
		}
		return len(page.Value) > 0, nil
	}
	return false, nil
}

func (r *RGReport) addRGFinding(f RGFinding) {
	r.Findings = append(r.Findings, f)
	r.Summary.FindingsBySeverity[string(f.Severity)]++
}

func printRGReport(report RGReport) {
	fmt.Println()
	fmt.Println("╔══════════════════════════════════════════════════════════════╗")
	fmt.Println("║           RESOURCE GROUP ANALYSIS REPORT                     ║")
	fmt.Println("╚══════════════════════════════════════════════════════════════╝")
	fmt.Println()

	fmt.Printf("  Total Resource Groups:     %d\n", report.Summary.TotalResourceGroups)
	fmt.Printf("  Empty Resource Groups:     %d\n", report.Summary.EmptyResourceGroups)
	fmt.Printf("  No Tags At All:            %d\n", report.Summary.NoTagsCount)
	fmt.Printf("  No Management Locks:       %d\n", report.Summary.NoLocksCount)
	fmt.Printf("  Naming Violations:         %d\n", report.Summary.NamingViolations)
	fmt.Println()

	fmt.Println("  Findings by Severity:")
	for _, sev := range []string{"Critical", "Warning", "Info"} {
		if count, ok := report.Summary.FindingsBySeverity[sev]; ok {
			fmt.Printf("    %-12s %d\n", sev, count)
		}
	}
	fmt.Println()

	if len(report.Findings) == 0 {
		fmt.Println("  âœ… No issues found!")
		return
	}

	fmt.Println("  â”€â”€ Findings â”€â”€")
	fmt.Println()
	w := tabwriter.NewWriter(os.Stdout, 2, 4, 2, ' ', 0)
	fmt.Fprintf(w, "  SEVERITY\tCATEGORY\tRESOURCE GROUP\tLOCATION\tDESCRIPTION\n")
	fmt.Fprintf(w, "  --------\t--------\t--------------\t--------\t-----------\n")
	for _, f := range report.Findings {
		fmt.Fprintf(w, "  %s\t%s\t%s\t%s\t%s\n",
			f.Severity, f.Category, f.ResourceGroup, f.Location, f.Description)
	}
	w.Flush()
	fmt.Println()

	fmt.Println("  â”€â”€ Recommendations â”€â”€")
	fmt.Println()
	seen := map[string]bool{}
	for _, f := range report.Findings {
		if !seen[f.Recommendation] {
			fmt.Printf("  â€¢ %s\n", f.Recommendation)
			seen[f.Recommendation] = true
		}
	}
	fmt.Println()
}
