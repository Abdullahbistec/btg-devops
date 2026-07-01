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

// Power Platform API base URLs and OAuth scopes
const (
	ppAppsScope   = "https://service.powerapps.com/.default"
	ppFlowScope   = "https://service.flow.microsoft.com/.default"
	ppBIScope     = "https://analysis.windows.net/powerbi/api/.default"
	ppBAPBase     = "https://api.bap.microsoft.com"
	ppAppsBase    = "https://api.powerapps.com"
	ppFlowBase    = "https://api.flow.microsoft.com"
	ppBIBase      = "https://api.powerbi.com"
)

// ppFetch makes an authenticated GET request and unmarshals the JSON response
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

// ppToken acquires an OAuth token for the given scope
func ppToken(ctx context.Context, cred *azidentity.DefaultAzureCredential, scope string) (string, error) {
	t, err := cred.GetToken(ctx, policy.TokenRequestOptions{Scopes: []string{scope}})
	if err != nil {
		return "", err
	}
	return t.Token, nil
}

// ppDaysSince returns how many days ago a timestamp string was, or -1 if unparseable
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
	Name       string            `json:"name"`
	ID         string            `json:"id"`
	Location   string            `json:"location"`
	Properties ppEnvironmentProps `json:"properties"`
}

type ppEnvironmentProps struct {
	DisplayName         string        `json:"displayName"`
	EnvironmentSku      string        `json:"environmentSku"`
	IsDefault           bool          `json:"isDefault"`
	IsDisabled          bool          `json:"isDisabled"`
	ProvisioningState   string        `json:"provisioningState"`
	CreatedTime         string        `json:"createdTime"`
	LastModifiedTime    string        `json:"lastModifiedTime"`
	ExpirationTime      *string       `json:"expirationTime"`
	EnvironmentPolicies ppEnvPolicies `json:"environmentPolicies"`
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

// fetchPPEnvironments retrieves all Power Platform environments for the tenant
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

// ppEnvDisplayName returns the friendly name of an environment
func ppEnvDisplayName(env ppEnvironment) string {
	if env.Properties.DisplayName != "" {
		return env.Properties.DisplayName
	}
	return env.Name
}
