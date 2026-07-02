package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore/policy"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
)

// PP-2: Environment variable naming decision.
//
// Power Platform commands reuse the same AZURE_* env vars as the Azure analyzers.
// This keeps a single credential set for the whole tool and matches the existing
// Service Principal auth pattern in btg-devops.
//
//   AZURE_TENANT_ID      → getTenantID()  — used by all pp-* commands
//   AZURE_CLIENT_ID      → DefaultAzureCredential (implicit)
//   AZURE_CLIENT_SECRET  → DefaultAzureCredential (implicit)
//   AZURE_SUBSCRIPTION_ID → getSubscriptionID() — Azure commands only
//
// Power Platform API base URLs and OAuth scopes.
//
// Authentication requirements:
//   - The service principal must be registered as a Power Platform management app
//     by a Global Admin or Power Platform Admin running:
//       Install-Module -Name Microsoft.PowerApps.Administration.PowerShell
//       Add-PowerAppsAccount
//       New-PowerAppManagementApp -ApplicationId <AZURE_CLIENT_ID>
//
// Required Entra ID roles on the service principal:
//   - Power Platform Administrator  → pp-environments, pp-apps, pp-flows
//   - Power BI Administrator         → pp-powerbi
//   - (Graph) Organization.Read.All  → powerplatform (licensing)
//
// Token scopes per command:
//   pp-environments : ppAppsScope  (BAP API — api.bap.microsoft.com)
//   pp-apps         : ppAppsScope  (Power Apps Admin API — api.powerapps.com)
//   pp-flows        : ppFlowScope  (Power Automate Admin API — api.flow.microsoft.com)
//   pp-powerbi      : ppBIScope    (Power BI Admin API — api.powerbi.com)
//   powerplatform   : graph scope  (Microsoft Graph — graph.microsoft.com)
const (
	ppAppsScope = "https://service.powerapps.com/.default"
	ppFlowScope = "https://service.flow.microsoft.com/.default"
	ppBIScope   = "https://analysis.windows.net/powerbi/api/.default"
	ppBAPBase   = "https://api.bap.microsoft.com"
	ppAppsBase  = "https://api.powerapps.com"
	ppFlowBase  = "https://api.flow.microsoft.com"
	ppBIBase    = "https://api.powerbi.com"
)

// ---------- PP-4: Analyzer interface ----------

// PPAnalyzer is the interface all Power Platform analysis commands implement.
// Each command (pp-environments, pp-apps, pp-flows, pp-powerbi) follows this
// contract: acquire a token for its scope, call its API, and return
// severity-classified findings in a consistent report structure.
type PPAnalyzer interface {
	// Name returns the analyzer's display name used in output headers.
	Name() string
	// Scope returns the OAuth scope required to authenticate with the target API.
	Scope() string
	// Analyze runs all checks and returns severity-classified findings.
	Analyze(ctx context.Context, token string) ([]PPBaseFinding, error)
}

// PPBaseFinding is the shared finding shape across all Power Platform analyzers.
// Command-specific finding structs mirror this layout and are JSON-compatible.
type PPBaseFinding struct {
	Severity       Severity `json:"severity"`
	Category       string   `json:"category"`
	Resource       string   `json:"resource"`
	Environment    string   `json:"environment"`
	Description    string   `json:"description"`
	Recommendation string   `json:"recommendation"`
}

// ---------- PP-6: Risky connector catalogue ----------

// ppHighRiskConnectors maps connector API name → human reason.
// These connectors are flagged Critical when found in a running flow.
var ppHighRiskConnectors = map[string]string{
	"shared_http":             "HTTP — can POST data to any external URL (data exfiltration risk)",
	"shared_httpwithazuread":  "HTTP with Azure AD — authenticated outbound HTTP to arbitrary endpoints",
	"shared_ftp":              "FTP — insecure file transfer, plaintext credentials in transit",
	"shared_sftp":             "SFTP — external file transfer, verify destination is authorised",
	"shared_smtp":             "SMTP — can send email from any address (phishing/spam risk)",
}

// ppWarnConnectors maps connector API name → human reason.
// These connectors are flagged Warning — legitimate but broad data access.
var ppWarnConnectors = map[string]string{
	"shared_azureblob":              "Azure Blob Storage — broad cloud storage read/write",
	"shared_sql":                    "SQL Server — direct database access",
	"shared_sharepointonline":        "SharePoint Online — broad document and list access",
	"shared_commondataservice":       "Dataverse — full organisation data access",
	"shared_commondataserviceforapps": "Dataverse for Apps — full organisation data access",
	"shared_onedriveforbusiness":     "OneDrive for Business — broad file access",
	"shared_office365":               "Office 365 Outlook — email read/send access",
}

// ---------- HTTP helpers ----------

// ppFetch makes an authenticated GET request and unmarshals the JSON response.
func ppFetch(ctx context.Context, token, url string, out interface{}) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		s := string(body)
		if len(s) > 400 {
			s = s[:400]
		}
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, s)
	}
	return json.Unmarshal(body, out)
}

// ppToken acquires an OAuth token for the given scope.
func ppToken(ctx context.Context, cred *azidentity.DefaultAzureCredential, scope string) (string, error) {
	t, err := cred.GetToken(ctx, policy.TokenRequestOptions{Scopes: []string{scope}})
	if err != nil {
		return "", err
	}
	return t.Token, nil
}

// ppDaysSince returns how many days ago a timestamp string was, or -1 if unparseable.
func ppDaysSince(s string) int {
	if s == "" {
		return -1
	}
	formats := []string{
		time.RFC3339,
		"2006-01-02T15:04:05Z",
		"2006-01-02T15:04:05.0000000Z",
		"2006-01-02T15:04:05.999999999Z",
	}
	for _, f := range formats {
		if t, err := time.Parse(f, s); err == nil {
			d := int(time.Since(t).Hours() / 24)
			if d < 0 {
				return 0
			}
			return d
		}
	}
	return -1
}

// ---------- Environments API types ----------

type ppEnvsResponse struct {
	Value    []ppEnvironment `json:"value"`
	NextLink string          `json:"nextLink"`
}

type ppEnvironment struct {
	Name       string             `json:"name"`
	ID         string             `json:"id"`
	Location   string             `json:"location"`
	Properties ppEnvironmentProps `json:"properties"`
}

type ppEnvironmentProps struct {
	DisplayName               string        `json:"displayName"`
	EnvironmentSku            string        `json:"environmentSku"`
	IsDefault                 bool          `json:"isDefault"`
	IsDisabled                bool          `json:"isDisabled"`
	ProvisioningState         string        `json:"provisioningState"`
	CreatedTime               string        `json:"createdTime"`
	LastModifiedTime          string        `json:"lastModifiedTime"`
	ExpirationTime            *string       `json:"expirationTime"`
	EnvironmentPolicies       ppEnvPolicies `json:"environmentPolicies"`
	LinkedEnvironmentMetadata *ppLinkedEnvMeta `json:"linkedEnvironmentMetadata"`
}

type ppEnvPolicies struct {
	DataLossPreventionPolicies ppDLPInfo `json:"dataLossPreventionPolicies"`
}

type ppDLPInfo struct {
	Count int `json:"count"`
}

type ppLinkedEnvMeta struct {
	FriendlyName string `json:"friendlyName"`
	InstanceUrl  string `json:"instanceUrl"`
	UniqueName   string `json:"uniqueName"`
}

// ---------- PP-7: DLP Policy API types ----------

type ppDLPPoliciesResponse struct {
	Value    []ppDLPPolicy `json:"value"`
	NextLink string        `json:"nextLink"`
}

type ppDLPPolicy struct {
	Name       string           `json:"name"`
	ID         string           `json:"id"`
	Properties ppDLPPolicyProps `json:"properties"`
}

type ppDLPPolicyProps struct {
	DisplayName                    string             `json:"displayName"`
	DefaultConnectorsClassification string            `json:"defaultConnectorsClassification"`
	ConnectorGroups                []ppConnectorGroup `json:"connectorGroups"`
	Environments                   []ppDLPEnvRef      `json:"environments"`
	FilterType                     string             `json:"filterType"`
}

type ppConnectorGroup struct {
	Classification string         `json:"classification"`
	Connectors     []ppConnector  `json:"connectors"`
}

type ppConnector struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type ppDLPEnvRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// fetchPPEnvironments retrieves all Power Platform environments for the tenant.
func fetchPPEnvironments(ctx context.Context, token string) ([]ppEnvironment, error) {
	var all []ppEnvironment
	url := ppBAPBase + "/providers/Microsoft.BusinessAppPlatform/environments?api-version=2016-11-01"
	for url != "" {
		var page ppEnvsResponse
		if err := ppFetch(ctx, token, url, &page); err != nil {
			return nil, err
		}
		all = append(all, page.Value...)
		url = page.NextLink
	}
	return all, nil
}

// fetchDLPPolicies retrieves all tenant-level DLP policies.
func fetchDLPPolicies(ctx context.Context, token string) ([]ppDLPPolicy, error) {
	var all []ppDLPPolicy
	url := ppBAPBase + "/providers/Microsoft.BusinessAppPlatform/scopes/admin/apiPolicies?api-version=2016-11-01"
	for url != "" {
		var page ppDLPPoliciesResponse
		if err := ppFetch(ctx, token, url, &page); err != nil {
			return nil, err
		}
		all = append(all, page.Value...)
		url = page.NextLink
	}
	return all, nil
}

// ppEnvDisplayName returns the friendly name of an environment.
func ppEnvDisplayName(env ppEnvironment) string {
	if env.Properties.DisplayName != "" {
		return env.Properties.DisplayName
	}
	return env.Name
}

// dlpCoveredEnvs builds a set of environment names covered by a DLP policy.
// filterType "Include" = policy covers listed envs only.
// filterType "Exclude" = policy covers all envs except listed ones (pass allEnvNames).
func dlpCoveredEnvs(policy ppDLPPolicy, allEnvNames []string) map[string]bool {
	covered := map[string]bool{}
	listed := map[string]bool{}
	for _, e := range policy.Properties.Environments {
		listed[e.Name] = true
	}
	switch policy.Properties.FilterType {
	case "Include":
		for name := range listed {
			covered[name] = true
		}
	case "Exclude":
		for _, name := range allEnvNames {
			if !listed[name] {
				covered[name] = true
			}
		}
	default:
		// Tenant-wide policy with no filter — covers all
		for _, name := range allEnvNames {
			covered[name] = true
		}
	}
	return covered
}

// dlpHTTPBlocked returns true if the HTTP connector is in the Blocked group.
func dlpHTTPBlocked(policy ppDLPPolicy) bool {
	for _, group := range policy.Properties.ConnectorGroups {
		if group.Classification == "Blocked" {
			for _, c := range group.Connectors {
				if c.Name == "shared_http" || c.Name == "shared_httpwithazuread" {
					return true
				}
			}
		}
	}
	return false
}
