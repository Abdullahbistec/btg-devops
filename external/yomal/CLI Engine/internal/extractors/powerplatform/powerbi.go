package powerplatform

import (
	"context"
	"fmt"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
)

type pbiGroupsResponse struct {
	Value         []pbiGroup `json:"value"`
	OdataNextLink string     `json:"@odata.nextLink"`
}

type pbiGroup struct {
	ID                    string       `json:"id"`
	Name                  string       `json:"name"`
	IsReadOnly            bool         `json:"isReadOnly"`
	IsOnDedicatedCapacity bool         `json:"isOnDedicatedCapacity"`
	Type                  string       `json:"type"`
	State                 string       `json:"state"`
	Users                 []pbiUser    `json:"users"`
	Reports               []pbiReport  `json:"reports"`
	Datasets              []pbiDataset `json:"datasets"`
}

type pbiUser struct {
	GroupUserAccessRight string `json:"groupUserAccessRight"`
	EmailAddress         string `json:"emailAddress"`
	PrincipalType        string `json:"principalType"`
}

type pbiReport struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type pbiDataset struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	IsRefreshable bool   `json:"isRefreshable"`
	ConfiguredBy  string `json:"configuredBy"`
}

type PPPowerBIData struct {
	TotalWorkspaces int        `json:"total_workspaces"`
	TotalReports    int        `json:"total_reports"`
	TotalDatasets   int        `json:"total_datasets"`
	Workspaces      []pbiGroup `json:"workspaces"`
}

func fetchPBIWorkspaces(ctx context.Context, token string) ([]pbiGroup, error) {
	var all []pbiGroup
	url := ppBIBase + "/v1.0/myorg/admin/groups?$top=200&$expand=users,reports,datasets"
	for url != "" {
		var page pbiGroupsResponse
		if err := ppFetch(ctx, token, url, &page); err != nil {
			return nil, err
		}
		all = append(all, page.Value...)
		url = page.OdataNextLink
	}
	return all, nil
}

func fetchAndBuildPowerBI(ctx context.Context, token string) (*PPPowerBIData, error) {
	groups, err := fetchPBIWorkspaces(ctx, token)
	if err != nil {
		return nil, fmt.Errorf("listing workspaces: %w", err)
	}
	data := &PPPowerBIData{TotalWorkspaces: len(groups), Workspaces: groups}
	for _, ws := range groups {
		data.TotalReports += len(ws.Reports)
		data.TotalDatasets += len(ws.Datasets)
	}
	return data, nil
}

// ExtractPPPowerBI fetches every Power BI workspace, report, and dataset in the tenant.
func ExtractPPPowerBI(ctx context.Context, tenantID string, cred azcore.TokenCredential) (*PPPowerBIData, error) {
	token, err := ppToken(ctx, cred, ppBIScope)
	if err != nil {
		return nil, fmt.Errorf("acquiring power bi token: %w", err)
	}
	return fetchAndBuildPowerBI(ctx, token)
}
