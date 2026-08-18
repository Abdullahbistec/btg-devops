package powerplatform

import (
	"context"
	"fmt"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
)

type ppAppsResponse struct {
	Value    []ppApp `json:"value"`
	NextLink string  `json:"nextLink"`
}

type ppApp struct {
	Name       string     `json:"name"`
	ID         string     `json:"id"`
	Properties ppAppProps `json:"properties"`
}

type ppAppProps struct {
	DisplayName           string     `json:"displayName"`
	Description           string     `json:"description"`
	CreatedTime           string     `json:"createdTime"`
	LastModifiedTime      string     `json:"lastModifiedTime"`
	LastPublishTime       string     `json:"lastPublishTime"`
	SharedGroupsCount     int        `json:"sharedGroupsCount"`
	SharedUsersCount      int        `json:"sharedUsersCount"`
	UsesPremiumApi        bool       `json:"usesPremiumApi"`
	UsesCustomApi         bool       `json:"usesCustomApi"`
	AppPlanClassification string     `json:"appPlanClassification"`
	Owner                 ppAppOwner `json:"owner"`
	CreatedBy             ppAppOwner `json:"createdBy"`
}

type ppAppOwner struct {
	DisplayName string `json:"displayName"`
	Email       string `json:"email"`
	ID          string `json:"id"`
	Type        string `json:"type"`
}

// ppAppWithEnv pairs an app with the environment it was fetched from, since
// the Power Apps admin API only lists apps scoped to one environment at a
// time — there is no tenant-wide list endpoint.
type ppAppWithEnv struct {
	App         ppApp  `json:"app"`
	Environment string `json:"environment"`
}

type PPAppsData struct {
	TotalApps int            `json:"total_apps"`
	Apps      []ppAppWithEnv `json:"apps"`
}

func fetchPPApps(ctx context.Context, token, envName string) ([]ppApp, error) {
	var all []ppApp
	url := fmt.Sprintf("%s/providers/Microsoft.PowerApps/scopes/admin/environments/%s/apps?api-version=2016-11-01",
		ppAppsBase, envName)
	for url != "" {
		var page ppAppsResponse
		if err := ppFetch(ctx, token, url, &page); err != nil {
			return nil, err
		}
		all = append(all, page.Value...)
		url = page.NextLink
	}
	return all, nil
}

func fetchAndBuildApps(ctx context.Context, token string) (*PPAppsData, error) {
	envs, err := fetchPPEnvironments(ctx, token)
	if err != nil {
		return nil, fmt.Errorf("listing environments: %w", err)
	}

	var all []ppAppWithEnv
	for _, env := range envs {
		apps, err := fetchPPApps(ctx, token, env.Name)
		if err != nil {
			// One environment's apps failing to list (e.g. a disabled
			// environment) shouldn't fail the whole tenant-wide scan.
			continue
		}
		for _, a := range apps {
			all = append(all, ppAppWithEnv{App: a, Environment: env.Name})
		}
	}
	return &PPAppsData{TotalApps: len(all), Apps: all}, nil
}

// ExtractPPApps fetches every Power App across every environment in the tenant.
func ExtractPPApps(ctx context.Context, tenantID string, cred azcore.TokenCredential) (*PPAppsData, error) {
	token, err := ppToken(ctx, cred, ppAppsScope)
	if err != nil {
		return nil, fmt.Errorf("acquiring power platform token: %w", err)
	}
	return fetchAndBuildApps(ctx, token)
}
