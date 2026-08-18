package powerplatform

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestFetchAndBuildApps_AggregatesAcrossEnvironments(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"value": []map[string]any{
				{"name": "env-1", "properties": map[string]any{"displayName": "Env One"}},
			},
		})
	})
	mux.HandleFunc("/providers/Microsoft.PowerApps/scopes/admin/environments/env-1/apps", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"value": []map[string]any{
				{"name": "app-1", "properties": map[string]any{"displayName": "Test App", "usesPremiumApi": true}},
			},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	origBAP, origApps := ppBAPBase, ppAppsBase
	ppBAPBase, ppAppsBase = srv.URL, srv.URL
	defer func() { ppBAPBase, ppAppsBase = origBAP, origApps }()

	data, err := fetchAndBuildApps(context.Background(), "test-token")
	require.NoError(t, err)
	assert.Equal(t, 1, data.TotalApps)
	require.Len(t, data.Apps, 1)
	assert.Equal(t, "app-1", data.Apps[0].App.Name)
	assert.Equal(t, "env-1", data.Apps[0].Environment)
	fmt.Sprintf("%v", data) // keep fmt import used if assertions above change
}
