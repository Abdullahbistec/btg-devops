package powerplatform

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/policy"
)

// Power Platform API base URLs and OAuth scopes. Kept as vars (not const) so
// tests can point them at an httptest.Server.
var (
	ppAppsScope = "https://service.powerapps.com/.default"
	ppFlowScope = "https://service.flow.microsoft.com/.default"
	ppBIScope   = "https://analysis.windows.net/powerbi/api/.default"
	ppBAPBase   = "https://api.bap.microsoft.com"
	ppAppsBase  = "https://api.powerapps.com"
	ppFlowBase  = "https://api.flow.microsoft.com"
	ppBIBase    = "https://api.powerbi.com"
)

var ppHTTPClient = &http.Client{Timeout: 30 * time.Second}

// ppFetch makes an authenticated GET request and unmarshals the JSON response.
func ppFetch(ctx context.Context, token, url string, out interface{}) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")

	resp, err := ppHTTPClient.Do(req)
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

// ppToken acquires an OAuth token for the given scope using whatever
// credential the caller has for this subscription row (a per-row
// ClientSecretCredential in production, or DefaultAzureCredential in a local
// dev fallback — both satisfy azcore.TokenCredential).
func ppToken(ctx context.Context, cred azcore.TokenCredential, scope string) (string, error) {
	t, err := cred.GetToken(ctx, policy.TokenRequestOptions{Scopes: []string{scope}})
	if err != nil {
		return "", err
	}
	return t.Token, nil
}
