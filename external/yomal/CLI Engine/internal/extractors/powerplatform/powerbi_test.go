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

func TestFetchAndBuildPowerBI_ParsesWorkspaces(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Contains(t, r.URL.Path, "/v1.0/myorg/admin/groups")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"value": []map[string]any{
				{
					"id": "ws-1", "name": "Marketing Reports", "type": "Workspace",
					"isOnDedicatedCapacity": false,
					"reports":               []map[string]any{{"id": "r1", "name": "Report 1"}},
					"datasets":              []map[string]any{{"id": "d1", "name": "Dataset 1", "isRefreshable": true}},
					"users":                 []map[string]any{{"groupUserAccessRight": "Admin", "emailAddress": "a@b.com"}},
				},
				{
					"id": "ws-2", "name": "Sales Analytics", "type": "Workspace",
					"isOnDedicatedCapacity": true,
					"reports":               []map[string]any{{"id": "r2", "name": "Report 2"}, {"id": "r3", "name": "Report 3"}},
					"datasets":              []map[string]any{{"id": "d2", "name": "Dataset 2", "isRefreshable": true}, {"id": "d3", "name": "Dataset 3", "isRefreshable": false}, {"id": "d4", "name": "Dataset 4", "isRefreshable": true}},
					"users":                 []map[string]any{{"groupUserAccessRight": "Admin", "emailAddress": "c@d.com"}},
				},
			},
		})
	}))
	defer srv.Close()

	orig := ppBIBase
	ppBIBase = srv.URL
	defer func() { ppBIBase = orig }()

	data, err := fetchAndBuildPowerBI(context.Background(), "test-token")
	require.NoError(t, err)
	assert.Equal(t, 2, data.TotalWorkspaces)
	assert.Equal(t, 3, data.TotalReports)
	assert.Equal(t, 4, data.TotalDatasets)
	require.Len(t, data.Workspaces, 2)
	assert.Equal(t, "Marketing Reports", data.Workspaces[0].Name)
	assert.Equal(t, "Sales Analytics", data.Workspaces[1].Name)
}
