package powerplatform

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestFetchAndBuildFlows_AggregatesAcrossEnvironments(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"value": []map[string]any{{"name": "env-1", "properties": map[string]any{"displayName": "Env One"}}},
		})
	})
	mux.HandleFunc("/providers/Microsoft.ProcessSimple/scopes/admin/environments/env-1/v2/flows", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"value": []map[string]any{
				{
					"name": "flow-1",
					"properties": map[string]any{
						"displayName": "Test Flow",
						"state":       "Started",
						"definitionSummary": map[string]any{
							"actions": []map[string]any{
								{"type": "OpenApiConnection", "api": map[string]any{"name": "shared_http", "displayName": "HTTP"}},
							},
						},
					},
				},
			},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	origBAP, origFlow := ppBAPBase, ppFlowBase
	ppBAPBase, ppFlowBase = srv.URL, srv.URL
	defer func() { ppBAPBase, ppFlowBase = origBAP, origFlow }()

	data, err := fetchAndBuildFlows(context.Background(), "test-token")
	require.NoError(t, err)
	assert.Equal(t, 1, data.TotalFlows)
	require.Len(t, data.Flows, 1)
	assert.Equal(t, "flow-1", data.Flows[0].Flow.Name)
	assert.Equal(t, "env-1", data.Flows[0].Environment)
	require.Len(t, data.Flows[0].Flow.Properties.DefinitionSummary.Actions, 1)
	assert.Equal(t, "shared_http", data.Flows[0].Flow.Properties.DefinitionSummary.Actions[0].API.Name)
}
