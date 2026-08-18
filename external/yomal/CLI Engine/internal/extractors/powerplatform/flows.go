package powerplatform

import (
	"context"
	"fmt"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
)

type ppFlowsResponse struct {
	Value    []ppFlow `json:"value"`
	NextLink string   `json:"nextLink"`
}

type ppFlow struct {
	Name       string      `json:"name"`
	ID         string      `json:"id"`
	Properties ppFlowProps `json:"properties"`
}

type ppFlowProps struct {
	DisplayName       string           `json:"displayName"`
	State             string           `json:"state"`
	CreatedTime       string           `json:"createdTime"`
	LastModifiedTime  string           `json:"lastModifiedTime"`
	Creator           ppFlowCreator    `json:"creator"`
	DefinitionSummary ppFlowDefSummary `json:"definitionSummary"`
}

type ppFlowCreator struct {
	UserDisplayName string `json:"userDisplayName"`
	Email           string `json:"email"`
	ObjectId        string `json:"objectId"`
}

type ppFlowDefSummary struct {
	Triggers []ppFlowAction `json:"triggers"`
	Actions  []ppFlowAction `json:"actions"`
}

type ppFlowAction struct {
	Type string        `json:"type"`
	API  ppFlowConnAPI `json:"api"`
}

type ppFlowConnAPI struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	ID          string `json:"id"`
}

type ppFlowWithEnv struct {
	Flow        ppFlow `json:"flow"`
	Environment string `json:"environment"`
}

type PPFlowsData struct {
	TotalFlows int             `json:"total_flows"`
	Flows      []ppFlowWithEnv `json:"flows"`
}

func fetchPPFlows(ctx context.Context, token, envName string) ([]ppFlow, error) {
	var all []ppFlow
	url := fmt.Sprintf("%s/providers/Microsoft.ProcessSimple/scopes/admin/environments/%s/v2/flows?api-version=2016-11-01",
		ppFlowBase, envName)
	for url != "" {
		var page ppFlowsResponse
		if err := ppFetch(ctx, token, url, &page); err != nil {
			return nil, err
		}
		all = append(all, page.Value...)
		url = page.NextLink
	}
	return all, nil
}

func fetchAndBuildFlows(ctx context.Context, envToken, flowToken string) (*PPFlowsData, error) {
	envs, err := fetchPPEnvironments(ctx, envToken)
	if err != nil {
		return nil, fmt.Errorf("listing environments: %w", err)
	}

	var all []ppFlowWithEnv
	for _, env := range envs {
		flows, err := fetchPPFlows(ctx, flowToken, env.Name)
		if err != nil {
			continue
		}
		for _, f := range flows {
			all = append(all, ppFlowWithEnv{Flow: f, Environment: env.Name})
		}
	}
	return &PPFlowsData{TotalFlows: len(all), Flows: all}, nil
}

// ExtractPPFlows fetches every Power Automate flow across every environment in the tenant.
//
// This needs two token audiences: the environments lookup hits the BAP admin
// API (ppAppsScope), while the flows-per-environment calls hit the Power
// Automate API (ppFlowScope). Unlike apps.go, these two APIs do NOT share a
// resource audience, so a single token cannot be reused across both calls.
func ExtractPPFlows(ctx context.Context, tenantID string, cred azcore.TokenCredential) (*PPFlowsData, error) {
	envToken, err := ppToken(ctx, cred, ppAppsScope)
	if err != nil {
		return nil, fmt.Errorf("acquiring power platform token for environments lookup: %w", err)
	}
	flowToken, err := ppToken(ctx, cred, ppFlowScope)
	if err != nil {
		return nil, fmt.Errorf("acquiring power automate token: %w", err)
	}
	return fetchAndBuildFlows(ctx, envToken, flowToken)
}
