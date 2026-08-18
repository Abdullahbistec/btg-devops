package powerplatform

import (
	"context"
	"fmt"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
)

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
	DisplayName               string              `json:"displayName"`
	EnvironmentSku            string              `json:"environmentSku"`
	IsDefault                 bool                `json:"isDefault"`
	IsDisabled                bool                `json:"isDisabled"`
	ProvisioningState         string              `json:"provisioningState"`
	CreatedTime               string              `json:"createdTime"`
	LastModifiedTime          string              `json:"lastModifiedTime"`
	ExpirationTime            *string             `json:"expirationTime"`
	EnvironmentPolicies       ppEnvPolicies       `json:"environmentPolicies"`
	LinkedEnvironmentMetadata *ppLinkedEnvMeta    `json:"linkedEnvironmentMetadata"`
	GovernanceConfiguration   *ppGovernanceConfig `json:"governanceConfiguration"`
}

type ppGovernanceConfig struct {
	ProtectionLevel string `json:"protectionLevel"`
}

type ppEnvPolicies struct {
	DataLossPreventionPolicies ppDLPInfo `json:"dataLossPreventionPolicies"`
}

type ppDLPInfo struct {
	Count int `json:"count"`
}

type ppLinkedEnvMeta struct {
	FriendlyName  string `json:"friendlyName"`
	InstanceUrl   string `json:"instanceUrl"`
	UniqueName    string `json:"uniqueName"`
	InstanceState string `json:"instanceState"`
	IsDormant     bool   `json:"isDormant"`
}

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
	DisplayName                     string             `json:"displayName"`
	DefaultConnectorsClassification string             `json:"defaultConnectorsClassification"`
	ConnectorGroups                 []ppConnectorGroup `json:"connectorGroups"`
	Environments                    []ppDLPEnvRef      `json:"environments"`
	FilterType                      string             `json:"filterType"`
}

type ppConnectorGroup struct {
	Classification string        `json:"classification"`
	Connectors     []ppConnector `json:"connectors"`
}

type ppConnector struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type ppDLPEnvRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// PPEnvironmentsData is the raw shape saved into audits.raw_data["pp-environments"].
// total_* fields exist so collect.go's countResources() (which looks for a
// "total_" prefixed field) reports a meaningful resource count.
type PPEnvironmentsData struct {
	TotalEnvironments int           `json:"total_environments"`
	Environments      []ppEnvironment `json:"environments"`
	DLPPolicies       []ppDLPPolicy   `json:"dlp_policies"`
}

func fetchPPEnvironments(ctx context.Context, token string) ([]ppEnvironment, error) {
	var all []ppEnvironment
	url := ppBAPBase + "/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments?api-version=2016-11-01"
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

func fetchAndBuildEnvironments(ctx context.Context, token string) (*PPEnvironmentsData, error) {
	envs, err := fetchPPEnvironments(ctx, token)
	if err != nil {
		return nil, fmt.Errorf("listing environments: %w", err)
	}
	policies, err := fetchDLPPolicies(ctx, token)
	if err != nil {
		// DLP policies are supplementary context for the checklist, not the
		// primary resource — a failure here shouldn't fail the whole scope.
		policies = nil
	}
	return &PPEnvironmentsData{
		TotalEnvironments: len(envs),
		Environments:      envs,
		DLPPolicies:       policies,
	}, nil
}

// ExtractPPEnvironments fetches every Power Platform environment and
// tenant-level DLP policy for the tenant. Mirrors the Azure extractors'
// signature shape (ctx, id, cred) → (*Data, error) used by collect.go.
func ExtractPPEnvironments(ctx context.Context, tenantID string, cred azcore.TokenCredential) (*PPEnvironmentsData, error) {
	token, err := ppToken(ctx, cred, ppAppsScope)
	if err != nil {
		return nil, fmt.Errorf("acquiring power platform token: %w", err)
	}
	return fetchAndBuildEnvironments(ctx, token)
}
