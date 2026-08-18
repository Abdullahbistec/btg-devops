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

func TestExtractPPEnvironments_ParsesEnvironmentList(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"value": []map[string]any{
					{
						"name":     "env-1",
						"id":       "/providers/Microsoft.BusinessAppPlatform/environments/env-1",
						"location": "unitedstates",
						"properties": map[string]any{
							"displayName":       "Production",
							"environmentSku":    "Production",
							"isDefault":         false,
							"provisioningState": "Succeeded",
						},
					},
				},
			})
		} else if r.URL.Path == "/providers/Microsoft.BusinessAppPlatform/scopes/admin/apiPolicies" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"value": []map[string]any{},
			})
		}
	}))
	defer srv.Close()

	orig := ppBAPBase
	ppBAPBase = srv.URL
	defer func() { ppBAPBase = orig }()

	data, err := fetchAndBuildEnvironments(context.Background(), "test-token")
	require.NoError(t, err)
	assert.Equal(t, 1, data.TotalEnvironments)
	require.Len(t, data.Environments, 1)
	assert.Equal(t, "env-1", data.Environments[0].Name)
	assert.Equal(t, "Production", data.Environments[0].Properties.DisplayName)
}
