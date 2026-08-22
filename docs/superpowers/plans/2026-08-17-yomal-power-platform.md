# Power Platform Support for Yomal's Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Power Platform (environments, apps, flows, Power BI) as a fully working audit type in Yomal's separate Postgres/Supabase-backed dashboard (`external/yomal`), using the exact same generic collect → raw-data → Claude-analysis → findings pipeline Azure subscriptions already use — no shortcuts, no bypassing the analysis pipeline.

**Architecture:** `external/yomal/CLI Engine` (Go, `pgxpool`) gains four new raw-data extractors under `internal/extractors/powerplatform/`, called from `cmd/collect.go` when a `subscriptions` row has `type = 'power_platform'`. Raw JSON lands in the existing generic `audits.raw_data` column exactly like Azure resource types do; `analysis_requests` gets one row queued per PP resource type automatically via the existing generic queuing loop — no new queue code. The existing Claude-driven analysis pipeline (`getScopedAuditData` in `external/yomal/dashboard/app/api/utils/claude.ts`) already handles arbitrary resource-type scopes generically (confirmed by reading it: the non-`all`/`cost`/`usage` branch just does `audit.raw_data[scope]` + an optional `checklistForType(scope)`), so the only pipeline change needed is adding four new checklist entries — no new Claude/MCP code. The dashboard gets a new `/power-platform` page (list + detail) and a type toggle on the Subscriptions onboarding form.

**Tech Stack:** Go 1.25 (`github.com/chanbistec/btg-devops` module, `azidentity`/`azcore` for OAuth, `pgx/v5` for Postgres), Next.js 16 App Router + React 19 (TypeScript, inline-style components, no CSS framework in use despite `tailwindcss` being a dependency), Postgres via Supabase.

**Spec:** `docs/superpowers/specs/2026-08-17-yomal-dashboard-power-platform-design.md`

## Global Constraints

- No changes to `web/` (the main SQLite-backed dashboard) — it already has Power Platform support via the Go CLI's `pp-*` commands.
- No unification of `external/yomal/CLI Engine`'s Go module with our root `cmd/` module — logic is ported, not shared, per `docs/superpowers/specs/2026-08-06-unified-analyzer-interface-design.md`'s finding that these are separate systems.
- Every extractor returns **raw resource data only** — never pre-computed findings. Findings come exclusively from the existing Claude analysis pipeline via `analysis_requests`.
- Schema changes must be additive `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements appended to the existing `schema` const in `external/yomal/CLI Engine/internal/db/schema.go` — this codebase has no separate migration tool, every prior schema change was done this way, and it must stay idempotent/safe to run on every startup.
- Never print/echo real secrets (`BTG_PP_CLIENT_SECRET`, the Supabase `DATABASE_URL`'s embedded password, etc.) in any command output or file the user didn't ask to see plainly.

---

### Task 1: Postgres schema — `subscriptions.type` + nullable `subscription_id`

**Files:**
- Modify: `external/yomal/CLI Engine/internal/db/schema.go`
- Modify: `external/yomal/CLI Engine/internal/db/subscription.go`

**Interfaces:**
- Produces: `SubscriptionCredentials.Type string` (new field, values `"azure"` or `"power_platform"`) — every later Go task reads this field to branch behavior.

- [ ] **Step 1: Add the schema migration**

Append to the end of the `schema` const string in `schema.go` (right before the `CREATE INDEX` block at the bottom):

```go
-- Power Platform support: a subscriptions row can now represent either an
-- Azure subscription (type='azure', has subscription_id) or a Power
-- Platform tenant service principal (type='power_platform', subscription_id
-- NULL — Power Platform has no subscription concept, only a tenant-wide SP).
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'azure'
  CHECK (type IN ('azure', 'power_platform'));
ALTER TABLE subscriptions ALTER COLUMN subscription_id DROP NOT NULL;
```

- [ ] **Step 2: Update `SubscriptionCredentials` and its two query functions**

In `subscription.go`, add `Type` to the struct and to both SELECT queries. `subscription_id` is wrapped in `COALESCE(subscription_id, '')` so `Scan` into a plain `string` field never fails on a NULL (Power Platform rows):

```go
type SubscriptionCredentials struct {
	SubscriptionID   string
	TenantID         string
	ClientID         string
	ClientSecretEnc  string
	SubscriptionName string
	Type             string // "azure" | "power_platform"
}

func FindSubscriptionCredentials(ctx context.Context, pool *pgxpool.Pool, subscriptionID string) (*SubscriptionCredentials, error) {
	row := pool.QueryRow(ctx,
		`SELECT COALESCE(subscription_id, ''), tenant_id, client_id, client_secret_enc, name, type
		 FROM subscriptions
		 WHERE subscription_id = $1 AND is_active = TRUE`,
		subscriptionID,
	)

	var creds SubscriptionCredentials
	err := row.Scan(&creds.SubscriptionID, &creds.TenantID, &creds.ClientID, &creds.ClientSecretEnc, &creds.SubscriptionName, &creds.Type)
	if err != nil {
		return nil, nil // not found — caller falls back to env vars
	}
	return &creds, nil
}

func FindAllActiveSubscriptions(ctx context.Context, pool *pgxpool.Pool) ([]SubscriptionCredentials, error) {
	rows, err := pool.Query(ctx,
		`SELECT COALESCE(subscription_id, ''), tenant_id, client_id, client_secret_enc, name, type
		 FROM subscriptions WHERE is_active = TRUE ORDER BY created_at ASC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var subs []SubscriptionCredentials
	for rows.Next() {
		var s SubscriptionCredentials
		if err := rows.Scan(&s.SubscriptionID, &s.TenantID, &s.ClientID, &s.ClientSecretEnc, &s.SubscriptionName, &s.Type); err != nil {
			return nil, err
		}
		subs = append(subs, s)
	}
	return subs, nil
}
```

`TouchLastAudit` is unchanged (it already looks up by `subscription_id`, which stays populated for Azure rows — the only kind it's called for today; Task 7 below calls it conditionally).

- [ ] **Step 3: Verify it compiles**

Run: `cd "external/yomal/CLI Engine" && go build ./...`
Expected: no errors.

- [ ] **Step 4: Apply the migration against the real Supabase database**

Run (loads `DATABASE_URL` from `external/yomal/dashboard/.env.local` without ever printing it):

```bash
cd "external/yomal/CLI Engine" && node -e "
const fs = require('fs');
const env = fs.readFileSync('../dashboard/.env.local', 'utf8');
process.env.DATABASE_URL = (env.match(/^DATABASE_URL=(.*)\$/m)||[])[1];
const { execSync } = require('child_process');
execSync('go run . collect --trigger manual', { stdio: 'inherit', env: process.env });
"
```

Expected: this actually runs a full collect (since `ApplySchema` runs on every `collect` invocation) — it will apply the migration as a side effect. If there are no active subscriptions yet in the DB it will exit with "no active subscriptions found in DB", which is fine — the goal here is just the schema side effect, confirmed by the absence of a Postgres error.

- [ ] **Step 5: Commit**

```bash
git add "external/yomal/CLI Engine/internal/db/schema.go" "external/yomal/CLI Engine/internal/db/subscription.go"
git commit -m "feat(yomal): add subscriptions.type for Power Platform tenants"
```

---

### Task 2: Go — Power Platform HTTP/token helpers

**Files:**
- Create: `external/yomal/CLI Engine/internal/extractors/powerplatform/helpers.go`
- Test: `external/yomal/CLI Engine/internal/extractors/powerplatform/helpers_test.go`

**Interfaces:**
- Consumes: `azcore.TokenCredential` (already used throughout `collect.go` — `cred.GetToken(ctx, policy.TokenRequestOptions{...})`)
- Produces: `ppToken(ctx, cred azcore.TokenCredential, scope string) (string, error)`, `ppFetch(ctx, token, url string, out interface{}) error`, scope/base-URL constants — every extractor task below depends on these two functions.

- [ ] **Step 1: Write the failing test**

```go
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

func TestPPFetch_DecodesJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "Bearer test-token", r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"hello": "world"})
	}))
	defer srv.Close()

	var out map[string]string
	err := ppFetch(context.Background(), "test-token", srv.URL, &out)
	require.NoError(t, err)
	assert.Equal(t, "world", out["hello"])
}

func TestPPFetch_NonOKStatusReturnsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"forbidden"}`))
	}))
	defer srv.Close()

	var out map[string]string
	err := ppFetch(context.Background(), "test-token", srv.URL, &out)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "403")
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "external/yomal/CLI Engine" && go test ./internal/extractors/powerplatform/... -run TestPPFetch -v`
Expected: FAIL — package/function `ppFetch` does not exist yet.

- [ ] **Step 3: Write the implementation**

Ported from our root `cmd/pp_helpers.go` (`ppFetch`, `ppToken`, scope/base-URL constants), adapted to accept the generic `azcore.TokenCredential` interface instead of the env-var-only `*azidentity.DefaultAzureCredential`, so it works with the per-row `azidentity.NewClientSecretCredential` that `collect.go` already builds for every subscription:

```go
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "external/yomal/CLI Engine" && go test ./internal/extractors/powerplatform/... -run TestPPFetch -v`
Expected: PASS (both subtests).

- [ ] **Step 5: Commit**

```bash
git add "external/yomal/CLI Engine/internal/extractors/powerplatform/helpers.go" "external/yomal/CLI Engine/internal/extractors/powerplatform/helpers_test.go"
git commit -m "feat(yomal): add Power Platform HTTP/token helpers"
```

---

### Task 3: Go — Power Platform Environments extractor

**Files:**
- Create: `external/yomal/CLI Engine/internal/extractors/powerplatform/environments.go`
- Test: `external/yomal/CLI Engine/internal/extractors/powerplatform/environments_test.go`

**Interfaces:**
- Consumes: `ppToken`, `ppFetch`, `ppBAPBase` (Task 2)
- Produces: `PPEnvironmentsData` struct, `ExtractPPEnvironments(ctx context.Context, tenantID string, cred azcore.TokenCredential) (*PPEnvironmentsData, error)` — consumed by Task 7 (`collect.go`).

- [ ] **Step 1: Write the failing test**

```go
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

type fakeCred struct{ token string }

func (f fakeCred) GetToken(ctx context.Context, opts interface {
}) (interface{}, error) {
	return nil, nil // unused directly — tests call ExtractPPEnvironments with a real token via a test seam instead
}

func TestExtractPPEnvironments_ParsesEnvironmentList(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Contains(t, r.URL.Path, "/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments")
		w.Header().Set("Content-Type", "application/json")
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "external/yomal/CLI Engine" && go test ./internal/extractors/powerplatform/... -run TestExtractPPEnvironments -v`
Expected: FAIL — `fetchAndBuildEnvironments` does not exist yet. (Testing this unexported helper directly, split out from `ExtractPPEnvironments`, is what lets the test inject a token without needing a real `azcore.TokenCredential` — the token-acquisition line is one call to `ppToken`, not worth mocking.)

- [ ] **Step 3: Write the implementation**

Raw-data types ported from our root `cmd/pp_helpers.go` (`ppEnvironment`, `ppEnvironmentProps`, etc.) — same JSON shape, same API endpoint, but returning the raw list instead of computing findings:

```go
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "external/yomal/CLI Engine" && go test ./internal/extractors/powerplatform/... -run TestExtractPPEnvironments -v`
Expected: PASS.

Also delete the unused `fakeCred` type from the test file written in Step 1 if `go vet` flags it as unused — it isn't referenced by the final test, only kept if a later task needs it.

- [ ] **Step 5: Run the full package test suite**

Run: `cd "external/yomal/CLI Engine" && go test ./internal/extractors/powerplatform/... -v`
Expected: PASS (all tests from Tasks 2 and 3).

- [ ] **Step 6: Commit**

```bash
git add "external/yomal/CLI Engine/internal/extractors/powerplatform/environments.go" "external/yomal/CLI Engine/internal/extractors/powerplatform/environments_test.go"
git commit -m "feat(yomal): add Power Platform environments extractor"
```

---

### Task 4: Go — Power Platform Apps extractor

**Files:**
- Create: `external/yomal/CLI Engine/internal/extractors/powerplatform/apps.go`
- Test: `external/yomal/CLI Engine/internal/extractors/powerplatform/apps_test.go`

**Interfaces:**
- Consumes: `ppToken`, `ppFetch`, `ppAppsBase`, `ppAppsScope` (Task 2), `fetchPPEnvironments` (Task 3)
- Produces: `PPAppsData`, `ExtractPPApps(ctx, tenantID string, cred azcore.TokenCredential) (*PPAppsData, error)`

Power Apps are listed **per environment** (there is no tenant-wide "list all apps" endpoint), so this extractor first calls `fetchPPEnvironments`, then fetches apps for each one.

- [ ] **Step 1: Write the failing test**

```go
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "external/yomal/CLI Engine" && go test ./internal/extractors/powerplatform/... -run TestFetchAndBuildApps -v`
Expected: FAIL — `fetchAndBuildApps` does not exist yet.

- [ ] **Step 3: Write the implementation**

Types ported from root `cmd/pp_apps.go` (`ppApp`, `ppAppProps`, `ppAppOwner`); wrapped with the owning environment name since apps are fetched per-environment and the checklist/analyst needs to know which environment each app lives in:

```go
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "external/yomal/CLI Engine" && go test ./internal/extractors/powerplatform/... -run TestFetchAndBuildApps -v`
Expected: PASS. Remove the unused `fmt.Sprintf("%v", data)` line from the test if `go vet`/`golangci-lint` flags an unused-import concern — `fmt` is already used by `t.Run`-style helpers elsewhere in Go stdlib testing, so this line only exists to avoid an unused-var lint on `data` if you trim assertions; delete it once real assertions reference `data`.

- [ ] **Step 5: Commit**

```bash
git add "external/yomal/CLI Engine/internal/extractors/powerplatform/apps.go" "external/yomal/CLI Engine/internal/extractors/powerplatform/apps_test.go"
git commit -m "feat(yomal): add Power Platform apps extractor"
```

---

### Task 5: Go — Power Platform Flows extractor

**Files:**
- Create: `external/yomal/CLI Engine/internal/extractors/powerplatform/flows.go`
- Test: `external/yomal/CLI Engine/internal/extractors/powerplatform/flows_test.go`

**Interfaces:**
- Consumes: `ppToken`, `ppFetch`, `ppFlowBase`, `ppFlowScope` (Task 2), `fetchPPEnvironments` (Task 3)
- Produces: `PPFlowsData`, `ExtractPPFlows(ctx, tenantID string, cred azcore.TokenCredential) (*PPFlowsData, error)`

Same per-environment shape as apps. Types ported from root `cmd/pp_flows.go` (`ppFlow`, `ppFlowProps`, `ppFlowCreator`, `ppFlowDefSummary`, `ppFlowAction`, `ppFlowConnAPI`) — the `definitionSummary` (triggers/actions/connectors) is kept because it's exactly what the checklist (Task 9) needs to flag high-risk connectors like `shared_http`/`shared_ftp`.

- [ ] **Step 1: Write the failing test**

```go
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "external/yomal/CLI Engine" && go test ./internal/extractors/powerplatform/... -run TestFetchAndBuildFlows -v`
Expected: FAIL — `fetchAndBuildFlows` does not exist yet.

- [ ] **Step 3: Write the implementation**

```go
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

func fetchAndBuildFlows(ctx context.Context, token string) (*PPFlowsData, error) {
	envs, err := fetchPPEnvironments(ctx, token)
	if err != nil {
		return nil, fmt.Errorf("listing environments: %w", err)
	}

	var all []ppFlowWithEnv
	for _, env := range envs {
		flows, err := fetchPPFlows(ctx, token, env.Name)
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
func ExtractPPFlows(ctx context.Context, tenantID string, cred azcore.TokenCredential) (*PPFlowsData, error) {
	token, err := ppToken(ctx, cred, ppFlowScope)
	if err != nil {
		return nil, fmt.Errorf("acquiring power platform token: %w", err)
	}
	return fetchAndBuildFlows(ctx, token)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "external/yomal/CLI Engine" && go test ./internal/extractors/powerplatform/... -run TestFetchAndBuildFlows -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "external/yomal/CLI Engine/internal/extractors/powerplatform/flows.go" "external/yomal/CLI Engine/internal/extractors/powerplatform/flows_test.go"
git commit -m "feat(yomal): add Power Platform flows extractor"
```

---

### Task 6: Go — Power Platform Power BI extractor

**Files:**
- Create: `external/yomal/CLI Engine/internal/extractors/powerplatform/powerbi.go`
- Test: `external/yomal/CLI Engine/internal/extractors/powerplatform/powerbi_test.go`

**Interfaces:**
- Consumes: `ppToken`, `ppFetch`, `ppBIBase`, `ppBIScope` (Task 2)
- Produces: `PPPowerBIData`, `ExtractPPPowerBI(ctx, tenantID string, cred azcore.TokenCredential) (*PPPowerBIData, error)`

Types ported from root `cmd/pp_powerbi.go` (`pbiGroup`, `pbiUser`, `pbiReport`, `pbiDataset`). This one is tenant-wide (no per-environment loop) — confirmed live this session: the real BISTEC tenant returned 200 workspaces, 318 reports, 333 datasets from this exact endpoint.

- [ ] **Step 1: Write the failing test**

```go
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
			},
		})
	}))
	defer srv.Close()

	orig := ppBIBase
	ppBIBase = srv.URL
	defer func() { ppBIBase = orig }()

	data, err := fetchAndBuildPowerBI(context.Background(), "test-token")
	require.NoError(t, err)
	assert.Equal(t, 1, data.TotalWorkspaces)
	assert.Equal(t, 1, data.TotalReports)
	assert.Equal(t, 1, data.TotalDatasets)
	require.Len(t, data.Workspaces, 1)
	assert.Equal(t, "Marketing Reports", data.Workspaces[0].Name)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "external/yomal/CLI Engine" && go test ./internal/extractors/powerplatform/... -run TestFetchAndBuildPowerBI -v`
Expected: FAIL — `fetchAndBuildPowerBI` does not exist yet.

- [ ] **Step 3: Write the implementation**

```go
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "external/yomal/CLI Engine" && go test ./internal/extractors/powerplatform/... -v`
Expected: PASS — every test in the `powerplatform` package (Tasks 2-6) passes.

- [ ] **Step 5: Commit**

```bash
git add "external/yomal/CLI Engine/internal/extractors/powerplatform/powerbi.go" "external/yomal/CLI Engine/internal/extractors/powerplatform/powerbi_test.go"
git commit -m "feat(yomal): add Power Platform Power BI extractor"
```

---

### Task 7: Go — branch `collect.go` on subscription type

**Files:**
- Modify: `external/yomal/CLI Engine/cmd/collect.go`
- Test: `external/yomal/CLI Engine/cmd/collect_test.go` (new — this file doesn't exist yet; check with `ls external/yomal/CLI\ Engine/cmd/*_test.go` first in case it's been added since this plan was written)

**Interfaces:**
- Consumes: `db.SubscriptionCredentials.Type` (Task 1), `powerplatform.ExtractPPEnvironments/ExtractPPApps/ExtractPPFlows/ExtractPPPowerBI` (Tasks 3-6)
- Produces: `collectForSubscription` now handles both types — no new exported symbol, this is the integration point everything else feeds into.

- [ ] **Step 1: Write the failing test**

`collectForSubscription` isn't unit-testable in isolation today (it takes a live `*pgxpool.Pool`), so this test targets the smaller, pure piece being added: which extractor list gets built for which subscription type. Refactor the extractor-list construction into its own function first so it's testable without a database or network:

```go
package cmd

import (
	"testing"

	"github.com/chanbistec/btg-devops/internal/db"
	"github.com/stretchr/testify/assert"
)

func TestExtractorKeysForType(t *testing.T) {
	azureKeys := extractorKeysForType(db.SubscriptionCredentials{Type: "azure"})
	assert.Contains(t, azureKeys, "storage")
	assert.Contains(t, azureKeys, "vm")
	assert.NotContains(t, azureKeys, "pp-environments")

	ppKeys := extractorKeysForType(db.SubscriptionCredentials{Type: "power_platform"})
	assert.Equal(t, []string{"pp-environments", "pp-apps", "pp-flows", "pp-powerbi"}, ppKeys)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "external/yomal/CLI Engine" && go test ./cmd/... -run TestExtractorKeysForType -v`
Expected: FAIL — `extractorKeysForType` does not exist yet.

- [ ] **Step 3: Refactor `collectForSubscription` to branch on type**

Add the import, the small testable helper, and change the `allExtractors` construction plus the cost/usage step (skipped entirely for Power Platform — it has no Azure Cost Management/Monitor data) and the `subID` used for the audit row (falls back to `TenantID` for Power Platform, since it has no subscription ID):

```go
import (
	// ...existing imports...
	"github.com/chanbistec/btg-devops/internal/extractors/powerplatform"
)
```

```go
// extractorKeysForType returns which extractor keys collectForSubscription
// runs for a given subscription type — split out from collectForSubscription
// so the branching logic is unit-testable without a database or network.
func extractorKeysForType(sub db.SubscriptionCredentials) []string {
	if sub.Type == "power_platform" {
		return []string{"pp-environments", "pp-apps", "pp-flows", "pp-powerbi"}
	}
	return []string{
		"storage", "iam", "nsg", "acr", "cosmosdb", "keyvault", "functions",
		"appservice", "appserviceplan", "publicip", "cognitiveservices",
		"resourcegroup", "cdn", "vm", "inventory",
	}
}
```

In `collectForSubscription`, replace the audit-row identifier and the `allExtractors` slice construction:

```go
	subID := sub.SubscriptionID
	if sub.Type == "power_platform" {
		subID = sub.TenantID // Power Platform has no subscription ID — the tenant ID is the natural per-audit identifier
	}

	// --- Create audit row ---
	auditID, err := db.CreateAudit(ctx, pool, db.CreateAuditParams{
		SubscriptionID: subID,
		TriggerType:    trigger,
	})
	if err != nil {
		return fmt.Errorf("creating audit row: %w", err)
	}
	fmt.Fprintf(os.Stderr, "Audit started: %s\n\n", auditID)

	// --- Credentials ---
	var cred azcore.TokenCredential
	if sub.ClientSecretEnc != "" {
		secret, err := crypto.DecryptSecret(sub.ClientSecretEnc)
		if err != nil {
			failAndAlert(ctx, pool, auditID, sub, fmt.Sprintf("decrypt credentials failed: %v", err))
			return fmt.Errorf("decrypt credentials: %w", err)
		}
		cred, err = azidentity.NewClientSecretCredential(sub.TenantID, sub.ClientID, secret, nil)
		if err != nil {
			failAndAlert(ctx, pool, auditID, sub, fmt.Sprintf("auth failed: %v", err))
			return fmt.Errorf("auth failed: %w", err)
		}
		if sub.Type != "power_platform" {
			_ = db.TouchLastAudit(ctx, pool, subID) // TouchLastAudit looks up by subscription_id, which is empty for PP rows
		}
		fmt.Fprintf(os.Stderr, "Using credentials from database for: %s\n", sub.SubscriptionName)
	} else {
		cred, err = azidentity.NewDefaultAzureCredential(nil)
		if err != nil {
			failAndAlert(ctx, pool, auditID, sub, fmt.Sprintf("auth failed: %v", err))
			return fmt.Errorf("auth failed: %w", err)
		}
		fmt.Fprintf(os.Stderr, "Using credentials from environment variables\n")
	}

	// --- Run extractors for this subscription's type ---
	type extractor struct {
		key string
		run func() (any, error)
	}

	var allExtractors []extractor
	if sub.Type == "power_platform" {
		allExtractors = []extractor{
			{"pp-environments", func() (any, error) { return powerplatform.ExtractPPEnvironments(ctx, sub.TenantID, cred) }},
			{"pp-apps", func() (any, error) { return powerplatform.ExtractPPApps(ctx, sub.TenantID, cred) }},
			{"pp-flows", func() (any, error) { return powerplatform.ExtractPPFlows(ctx, sub.TenantID, cred) }},
			{"pp-powerbi", func() (any, error) { return powerplatform.ExtractPPPowerBI(ctx, sub.TenantID, cred) }},
		}
	} else {
		allExtractors = []extractor{
			{"storage", func() (any, error) { return extractors.ExtractStorage(ctx, subID, cred) }},
			{"iam", func() (any, error) { return extractors.ExtractIAM(ctx, subID, cred) }},
			{"nsg", func() (any, error) { return extractors.ExtractNSG(ctx, subID, cred) }},
			{"acr", func() (any, error) { return extractors.ExtractACR(ctx, subID, cred) }},
			{"cosmosdb", func() (any, error) { return extractors.ExtractCosmosDB(ctx, subID, cred) }},
			{"keyvault", func() (any, error) { return extractors.ExtractKeyVault(ctx, subID, cred) }},
			{"functions", func() (any, error) { return extractors.ExtractFunctions(ctx, subID, cred) }},
			{"appservice", func() (any, error) { return extractors.ExtractAppService(ctx, subID, cred) }},
			{"appserviceplan", func() (any, error) { return extractors.ExtractAppServicePlan(ctx, subID, cred) }},
			{"publicip", func() (any, error) { return extractors.ExtractPublicIP(ctx, subID, cred) }},
			{"cognitiveservices", func() (any, error) { return extractors.ExtractCognitiveServices(ctx, subID, cred) }},
			{"resourcegroup", func() (any, error) { return extractors.ExtractResourceGroup(ctx, subID, cred) }},
			{"cdn", func() (any, error) { return extractors.ExtractCDN(ctx, subID, cred) }},
			{"vm", func() (any, error) { return extractors.ExtractVM(ctx, subID, cred) }},
			{"inventory", func() (any, error) { return extractors.ExtractInventory(ctx, subID, cred) }},
		}
	}
```

Later in the same function, the cost/usage extraction block (`extractors.ExtractCost`, `extractors.ExtractUsage`) and the `costData`/`usageData` variables it produces must be skipped for Power Platform — wrap that whole block:

```go
	var costData *extractors.CostData
	var usageData *extractors.UsageData
	if sub.Type != "power_platform" {
		fmt.Fprintf(os.Stderr, "[1/2] Extracting cost...\n")
		// ...existing cost extraction block, unchanged...
		// ...existing usage extraction block, unchanged...
	}
```

(`extractors.ExtractCost` returns `(*extractors.CostData, error)` and `extractors.ExtractUsage` returns `(*extractors.UsageData, error)` — confirmed in `internal/extractors/cost.go:45` and `internal/extractors/usage.go:68` — so the `var` declarations above are exactly `var costData *extractors.CostData` and `var usageData *extractors.UsageData`.)

The `totalChecks := total + 1` failure-threshold check further down already generalizes correctly since `total := len(allExtractors)` is computed after the branch — for Power Platform, `total` is 4, so "all 4 PP extractors + nothing else failed" is the failure bar, matching intent (there's no separate cost check to add to the threshold for PP).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "external/yomal/CLI Engine" && go test ./cmd/... -run TestExtractorKeysForType -v`
Expected: PASS.

- [ ] **Step 5: Verify the whole module still builds and all tests pass**

Run: `cd "external/yomal/CLI Engine" && go build ./... && go vet ./... && go test ./...`
Expected: no build errors, no vet warnings, all tests pass (including the pre-existing Azure ones — this refactor must not change Azure behavior).

- [ ] **Step 6: Commit**

```bash
git add "external/yomal/CLI Engine/cmd/collect.go" "external/yomal/CLI Engine/cmd/collect_test.go"
git commit -m "feat(yomal): collect.go branches on subscription type for Power Platform"
```

---

### Task 8: Dashboard backend — subscriptions `type` support

**Files:**
- Modify: `external/yomal/dashboard/app/types/index.ts`
- Modify: `external/yomal/dashboard/app/api/models/subscription.ts`
- Modify: `external/yomal/dashboard/app/api/controllers/subscription.ts`

**Interfaces:**
- Produces: `Subscription.type: 'azure' | 'power_platform'`, `insertSubscription(..., type)`, `createSubscriptionController` accepting `type` and validating conditionally — consumed by Task 10 (onboarding form).

- [ ] **Step 1: Add `type` to the `Subscription` type**

In `app/types/index.ts`:

```ts
export interface Subscription {
  id: string
  name: string
  type: 'azure' | 'power_platform'
  subscription_id: string | null
  tenant_id: string
  client_id: string
  is_active: boolean
  created_at: string
  last_audit_at: string | null
}
```

(`subscription_id` becomes `string | null` since Task 1 made the column nullable — check every other place in this file/the app that reads `Subscription.subscription_id` as a bare `string` and confirm it tolerates `null`; the audits list page reads `Audit.subscription_id`, a separate type, unaffected.)

- [ ] **Step 2: Update the model layer**

In `app/api/models/subscription.ts`, add `type` to every query and to `insertSubscription`'s parameters:

```ts
export async function findAllSubscriptions(): Promise<Subscription[]> {
  const { rows } = await pool.query(
    `SELECT id, name, type, subscription_id, tenant_id, client_id, is_active, created_at, last_audit_at
     FROM subscriptions ORDER BY created_at ASC`
  )
  return rows
}

export async function findSubscriptionById(id: string): Promise<Subscription | null> {
  const { rows } = await pool.query(
    `SELECT id, name, type, subscription_id, tenant_id, client_id, is_active, created_at, last_audit_at
     FROM subscriptions WHERE id = $1`,
    [id]
  )
  return rows[0] || null
}

export async function insertSubscription(
  name: string,
  type: 'azure' | 'power_platform',
  subscriptionId: string | null,
  tenantId: string,
  clientId: string,
  clientSecretEnc: string,
  createdBy: string
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO subscriptions (name, type, subscription_id, tenant_id, client_id, client_secret_enc, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [name, type, subscriptionId, tenantId, clientId, clientSecretEnc, createdBy]
  )
  return rows[0].id
}
```

(`updateSubscription`/`deleteSubscription` are unchanged — `type` is set once at creation and never edited, matching that `subscription_id` also isn't in the update fields list today.)

- [ ] **Step 3: Update the controller's validation**

In `app/api/controllers/subscription.ts`, `subscription_id` becomes required only for `type === 'azure'`:

```ts
export async function createSubscriptionController(
  body: { name: string; type?: 'azure' | 'power_platform'; subscription_id?: string; tenant_id: string; client_id: string; client_secret: string },
  auth: JWTPayload
) {
  const { name, tenant_id, client_id, client_secret } = body
  const type = body.type === 'power_platform' ? 'power_platform' : 'azure'

  if (!name || !tenant_id || !client_id || !client_secret) {
    return { error: 'name, tenant_id, client_id and client_secret required', status: 400 }
  }
  if (type === 'azure' && !body.subscription_id) {
    return { error: 'subscription_id is required for an Azure subscription', status: 400 }
  }

  const client_secret_enc = await encryptSecret(client_secret)
  const id = await insertSubscription(
    name, type, type === 'power_platform' ? null : body.subscription_id!,
    tenant_id, client_id, client_secret_enc, auth.user_id
  )
  return { data: { id }, status: 201 }
}
```

- [ ] **Step 4: Verify it type-checks**

Run: `cd external/yomal/dashboard && npx tsc --noEmit`
Expected: no new type errors (pre-existing errors, if any, are out of scope for this task — only confirm no *new* ones from these three files).

- [ ] **Step 5: Commit**

```bash
git add external/yomal/dashboard/app/types/index.ts external/yomal/dashboard/app/api/models/subscription.ts external/yomal/dashboard/app/api/controllers/subscription.ts
git commit -m "feat(yomal): add subscriptions.type support to dashboard backend"
```

---

### Task 9: Dashboard — checklists and resource metadata for the 4 PP scopes

**Files:**
- Modify: `external/yomal/dashboard/app/api/utils/analysisChecklists.ts`
- Modify: `external/yomal/dashboard/app/lib/resourceMeta.tsx`

**Interfaces:**
- Consumes: nothing new — `checklistForType`/`resourceMeta` are already called generically by `claude.ts`/UI components for any scope string.
- Produces: checklist coverage for `pp-environments`, `pp-apps`, `pp-flows`, `pp-powerbi` — without this task the pipeline still works end-to-end (per `checklistForType`'s graceful `''` fallback for unknown types) but with weaker, generic-only analysis instructions.

- [ ] **Step 1: Add the four checklists**

In `analysisChecklists.ts`, add to the `CHECKLISTS` map (content translated from the governance rules already proven in our root `cmd/pp_environments.go`/`pp_apps.go`/`pp_flows.go`/`pp_powerbi.go` and this session's live `pp-powerbi` run against the real BISTEC tenant — e.g. "Deleted Workspace", "No Admin — Orphaned", "Content in Personal Workspace" were all real findings seen this session):

```ts
  'pp-environments': [
    'Using each environment\'s own "properties.isDisabled": is a disabled environment still present and consuming a capacity allocation?',
    'Using each environment\'s own "properties.governanceConfiguration.protectionLevel": is a production-looking environment (by name/sku) missing the Managed Environment governance layer ("Standard" protection level)?',
    'Using "dlp_policies" and each policy\'s "properties.environments"/"filterType": is any environment NOT covered by any tenant DLP policy, leaving connector usage completely ungoverned there?',
    'Using each policy\'s "properties.connectorGroups": is the HTTP connector (shared_http, shared_httpwithazuread) absent from every policy\'s "Blocked" group tenant-wide?',
    'Using each environment\'s own "properties.linkedEnvironmentMetadata.isDormant": is a Dataverse-linked environment dormant while still incurring capacity cost?',
    'Using each environment\'s own "properties.expirationTime": is a trial/sandbox environment approaching or past its expiration with real content still in it?',
    'Is more than one environment marked "properties.isDefault" — the tenant should have exactly one Default environment?',
  ],
  'pp-apps': [
    'Using each app\'s own "app.properties.owner"/"app.properties.createdBy": is the owner a departed/disabled user (cross-reference against known-active users if available), leaving the app effectively unowned?',
    'Using each app\'s own "app.properties.lastModifiedTime": has a shared app (sharedGroupsCount or sharedUsersCount > 0) had no updates in a long time while still being actively shared — stale but still exposed?',
    'Using each app\'s own "app.properties.usesPremiumApi": is a premium-connector app running in an environment/tenant where premium licensing has not been confirmed?',
    'Using each app\'s own "app.properties.usesCustomApi": does a custom-connector app lack any visible owner/documentation context, making it hard to audit what it actually connects to?',
    'Using each app\'s own "app.properties.sharedUsersCount"/"sharedGroupsCount": is an app shared tenant-wide or to a very large group when its name/description suggests a narrow, personal, or test purpose?',
    'Using each app\'s "environment" field: are there multiple near-duplicate app names in different environments, suggesting an abandoned copy that should be cleaned up?',
  ],
  'pp-flows': [
    'Using each flow\'s own "flow.properties.state": is a flow "Suspended" (Microsoft auto-suspends flows with persistent failures) and still present, indicating an unresolved broken automation?',
    'Using each flow\'s own "flow.properties.definitionSummary.actions[].api.name"/"triggers[].api.name": does the flow use a high-risk connector (shared_http, shared_httpwithazuread, shared_ftp, shared_sftp, shared_smtp) that can move data to/from arbitrary external endpoints?',
    'Using the same "definitionSummary" fields: does the flow use a broad-data-access connector (shared_sql, shared_sharepointonline, shared_commondataservice(forapps), shared_azureblob, shared_onedriveforbusiness, shared_office365) worth confirming is actually authorized?',
    'Using each flow\'s own "flow.properties.creator": is the creator a departed/disabled user, leaving a still-running automation effectively unowned?',
    'Using each flow\'s own "flow.properties.lastModifiedTime" combined with "state": is a "Started" (active) flow untouched for a very long time — worth confirming it is still actually needed?',
    'Using each flow\'s own "environment" field: is a flow running in a non-production-looking environment (dev/test/sandbox by name) but touching production-grade connectors (SQL, SharePoint, Dataverse)?',
  ],
  'pp-powerbi': [
    'Using each workspace\'s own "state": is the workspace "Deleted" but still showing up in the admin listing — should be permanently removed?',
    'Using each workspace\'s own "users[].groupUserAccessRight": does a non-personal workspace ("type" != "PersonalGroup") have no user with "Admin" access — an orphaned workspace no one manages?',
    'Using each workspace\'s own "reports"/"datasets" arrays: is a non-personal workspace completely empty (zero reports and zero datasets) — safe to delete?',
    'Using each workspace\'s own "type" and "reports"/"datasets" counts: does a "PersonalGroup" (My Workspace) hold a significant number of reports/datasets — real business content siloed in a personal workspace instead of a shared one?',
    'Using each workspace\'s own "isOnDedicatedCapacity" alongside "reports"/"datasets" counts: is a large workspace (many reports/datasets) still on shared capacity, risking inconsistent performance?',
    'Using each dataset\'s own "isRefreshable" field: are there datasets with refresh disabled in a non-personal workspace, meaning reports built on them may show stale data?',
  ],
```

- [ ] **Step 2: Add the four resource-meta entries**

In `resourceMeta.tsx`, add a `Blocks` icon import and four `META` entries:

```tsx
import {
  HardDrive, UserCheck, Shield, Container, Database, KeyRound,
  Zap, Globe, Layers, Brain, FolderTree, Network, Box, Blocks, LucideIcon,
} from 'lucide-react'
```

```tsx
  'pp-environments': { label: 'PP Environments',    icon: Blocks },
  'pp-apps':         { label: 'Power Apps',         icon: Zap },
  'pp-flows':        { label: 'Power Automate Flows', icon: Network },
  'pp-powerbi':      { label: 'Power BI Workspaces', icon: Database },
```

- [ ] **Step 3: Verify it type-checks**

Run: `cd external/yomal/dashboard && npx tsc --noEmit`
Expected: no new type errors.

- [ ] **Step 4: Commit**

```bash
git add external/yomal/dashboard/app/api/utils/analysisChecklists.ts external/yomal/dashboard/app/lib/resourceMeta.tsx
git commit -m "feat(yomal): add Power Platform analysis checklists and resource metadata"
```

---

### Task 10: Dashboard — subscriptions onboarding type toggle

**Files:**
- Modify: `external/yomal/dashboard/app/subscriptions/page.tsx`

**Interfaces:**
- Consumes: `api.createSubscription` (unchanged signature — takes `unknown`), `Subscription.type` (Task 8)

- [ ] **Step 1: Add `type` to form state and the toggle UI**

```tsx
interface FormState {
  name: string
  type: 'azure' | 'power_platform'
  subscription_id: string
  tenant_id: string
  client_id: string
  client_secret: string
  is_active: boolean
}

const emptyForm: FormState = {
  name: '', type: 'azure', subscription_id: '', tenant_id: '', client_id: '', client_secret: '', is_active: true,
}
```

In the form JSX (inside the add/edit modal, before the Name field), add a type selector shown only when adding (not editing — type is immutable after creation, matching that the backend never accepts a `type` update):

```tsx
{modal === 'add' && (
  <div style={{ marginBottom: '1rem' }}>
    <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--t2)', display: 'block', marginBottom: '0.4rem' }}>Type</label>
    <div style={{ display: 'flex', gap: '0.5rem' }}>
      {(['azure', 'power_platform'] as const).map(t => (
        <button
          key={t}
          type="button"
          onClick={() => setForm(f => ({ ...f, type: t }))}
          style={{
            flex: 1, padding: '0.5rem', borderRadius: 8, cursor: 'pointer',
            border: `1px solid ${form.type === t ? 'var(--acc)' : 'var(--border)'}`,
            background: form.type === t ? 'var(--acc-soft)' : 'transparent',
            color: form.type === t ? 'var(--acc)' : 'var(--t2)',
            fontSize: '0.8rem', fontWeight: 500,
          }}
        >
          {t === 'azure' ? 'Azure Subscription' : 'Power Platform Tenant'}
        </button>
      ))}
    </div>
  </div>
)}
```

Make the Subscription ID field conditional (only for Azure) and relabel the tenant/client/secret fields for Power Platform:

```tsx
{form.type === 'azure' && (
  <input
    placeholder="Subscription ID"
    value={form.subscription_id}
    onChange={e => setForm(f => ({ ...f, subscription_id: e.target.value }))}
  />
)}
<input
  placeholder={form.type === 'power_platform' ? 'Tenant (Directory) ID' : 'Tenant ID'}
  value={form.tenant_id}
  onChange={e => setForm(f => ({ ...f, tenant_id: e.target.value }))}
/>
<input
  placeholder={form.type === 'power_platform' ? 'Service Principal Client ID' : 'Client ID'}
  value={form.client_id}
  onChange={e => setForm(f => ({ ...f, client_id: e.target.value }))}
/>
<input
  type="password"
  placeholder={form.type === 'power_platform' ? 'Service Principal Client Secret' : 'Client Secret'}
  value={form.client_secret}
  onChange={e => setForm(f => ({ ...f, client_secret: e.target.value }))}
/>
```

- [ ] **Step 2: Update validation and submit**

```tsx
async function handleSubmit(e: FormEvent) {
  e.preventDefault()
  setFormError('')

  if (!form.name.trim()) {
    setFormError('Name is required.')
    return
  }
  if (form.type === 'azure' && !form.subscription_id.trim()) {
    setFormError('Subscription ID is required for an Azure subscription.')
    return
  }
  if (modal === 'add' && (!form.tenant_id.trim() || !form.client_id.trim() || !form.client_secret)) {
    setFormError('Tenant ID, Client ID, and Client Secret are required when adding.')
    return
  }

  setSaving(true)
  try {
    if (modal === 'add') {
      await api.createSubscription({
        name: form.name.trim(),
        type: form.type,
        subscription_id: form.type === 'azure' ? form.subscription_id.trim() : undefined,
        tenant_id: form.tenant_id.trim(),
        client_id: form.client_id.trim(),
        client_secret: form.client_secret,
      })
    } else if (editing) {
      // ...unchanged edit path...
    }
    setModal(null)
    load()
  } catch (err) {
    setFormError(err instanceof Error ? err.message : 'Save failed')
  } finally {
    // ...unchanged...
  }
}
```

Also update `openAdd`/`openEdit` to include `type: 'azure'`/`type: editing's actual type` respectively in the `setForm` calls, and add a small type badge (reusing the existing `<Badge>` component) next to each row's name in the subscriptions table so Azure and Power Platform rows are visually distinguishable in the list.

- [ ] **Step 3: Verify it type-checks**

Run: `cd external/yomal/dashboard && npx tsc --noEmit`
Expected: no new type errors.

- [ ] **Step 4: Manual verification**

Run: the dashboard is already running at `http://localhost:3001` (started earlier this session) — if not, `cd external/yomal/dashboard && npm run dev -- -p 3001`.
Open `http://localhost:3001/subscriptions`, click "Add", confirm the type toggle appears and switching to "Power Platform Tenant" hides the Subscription ID field and relabels the other three.

- [ ] **Step 5: Commit**

```bash
git add external/yomal/dashboard/app/subscriptions/page.tsx
git commit -m "feat(yomal): add Power Platform tenant type toggle to subscriptions onboarding"
```

---

### Task 11: Dashboard — Power Platform nav entry

**Files:**
- Modify: `external/yomal/dashboard/app/components/Sidebar.tsx`

- [ ] **Step 1: Add the nav item**

```tsx
import { LayoutDashboard, FileSearch, DollarSign, Globe, Users, Bell, AlertTriangle, LogOut, Menu, X, Blocks } from 'lucide-react'

const navItems = [
  { label: 'Dashboard',       href: '/',               icon: LayoutDashboard, exact: true  },
  { label: 'Audits',          href: '/audits',          icon: FileSearch,      exact: false },
  { label: 'Power Platform',  href: '/power-platform',  icon: Blocks,          exact: false },
  { label: 'Cost & Usage',    href: '/cost-usage',      icon: DollarSign,      exact: false },
]
```

- [ ] **Step 2: Verify it type-checks and renders**

Run: `cd external/yomal/dashboard && npx tsc --noEmit`
Expected: no new type errors (the route `/power-platform` doesn't exist until Task 12, so the link will 404 until then — expected and fine at this point in the plan).

- [ ] **Step 3: Commit**

```bash
git add external/yomal/dashboard/app/components/Sidebar.tsx
git commit -m "feat(yomal): add Power Platform nav entry"
```

---

### Task 12: Dashboard — Power Platform list page

**Files:**
- Create: `external/yomal/dashboard/app/power-platform/page.tsx`

**Interfaces:**
- Consumes: `api.listAudits()` → `Audit[]` (confirmed in `app/lib/api.ts:42-43` — `apiFetch<Audit[]>('/api/audits')`, no filtering params) and `api.listSubscriptions()` → `Subscription[]` (Task 8). There is no server-side subscription-type filter on the audits endpoint, so this page does the Power-Platform filtering client-side by joining against `Subscription.tenant_id` (see Step 1 below for why `tenant_id`, not `id`).

- [ ] **Step 1: Write the list page**

Modeled directly on `app/audits/page.tsx`'s existing list rendering (reuse `Header`, `Badge`, `TableSkeleton`, `statusConfig` from `app/lib/utils`), but scoped to Power Platform:

```tsx
'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Header } from '../components/Header'
import { Badge } from '../components/Badge'
import { TableSkeleton } from '../components/Skeleton'
import { api } from '../lib/api'
import { shortId, statusConfig, triggerConfig } from '../lib/utils'
import type { Audit, Subscription } from '../types'

export default function PowerPlatformPage() {
  const [audits, setAudits] = useState<Audit[] | null>(null)
  // Power Platform audits store the tenant ID (not the subscriptions.id UUID)
  // in audits.subscription_id — see Task 7, which sets
  // subID = sub.TenantID for type='power_platform' rows, since Power
  // Platform has no subscription concept to use instead. So the join here
  // is against Subscription.tenant_id, not Subscription.id.
  const [ppTenantIds, setPpTenantIds] = useState<Set<string> | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([api.listAudits(), api.listSubscriptions()])
      .then(([allAudits, subs]) => {
        const ppIds = new Set(
          (subs as Subscription[]).filter(s => s.type === 'power_platform').map(s => s.tenant_id)
        )
        setPpTenantIds(ppIds)
        setAudits(allAudits as Audit[])
      })
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load Power Platform audits'))
  }, [])

  const ppAudits = audits && ppTenantIds
    ? audits.filter(a => ppTenantIds.has(a.subscription_id))
    : null

  return (
    <>
      <Header title="Power Platform" subtitle="Environments, apps, flows, and Power BI governance" />
      {error && <div style={{ color: '#ef4444', padding: '1rem' }}>{error}</div>}
      {!ppAudits ? (
        <TableSkeleton rows={5} />
      ) : ppAudits.length === 0 ? (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--t3)' }}>
          No Power Platform tenant onboarded yet. Add one from the Subscriptions page.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '1rem' }}>
          {ppAudits.map(a => (
            <Link key={a.id} href={`/power-platform/${a.id}`} style={{ textDecoration: 'none' }}>
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '1rem', borderRadius: 10, border: '1px solid var(--border)',
              }}>
                <div>
                  <div style={{ fontWeight: 600, color: 'var(--t1)' }}>{a.subscription_name}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--t3)' }}>{shortId(a.id)} · {a.created_at}</div>
                </div>
                <Badge color={statusConfig[a.status]?.color} label={statusConfig[a.status]?.label ?? a.status} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  )
}
```

- [ ] **Step 2: Verify it type-checks and renders**

Run: `cd external/yomal/dashboard && npx tsc --noEmit`
Then open `http://localhost:3001/power-platform` in a browser (dev server already running) and confirm the empty state renders (no PP tenant onboarded yet at this point in the plan).

- [ ] **Step 3: Commit**

```bash
git add external/yomal/dashboard/app/power-platform/page.tsx
git commit -m "feat(yomal): add Power Platform audits list page"
```

---

### Task 13: Dashboard — Power Platform detail page

**Files:**
- Create: `external/yomal/dashboard/app/power-platform/[id]/page.tsx`

**Interfaces:**
- Consumes: `api.getAudit(id)` → `AuditDetail` (confirmed in `app/lib/api.ts:69-70`), and the same three components `app/audits/[id]/page.tsx` already uses to render findings — `AnalysisPanel` (`app/components/AnalysisPanel.tsx`, props `{ auditId, resourceCounts, initialStore, hasCost, usageTypes, onScopeChange }`, confirmed at `AnalysisPanel.tsx:138`), `RawDataSection` (props `{ auditId, resourceCounts, selectedType }`, confirmed at `RawDataSection.tsx:235`), and `ChatDock` (props `{ auditId, resourceCounts, hasCost, usageTypes }`). All three are already fully generic over whatever keys appear in `resourceCounts`/`raw_data` (`AnalysisPanel`'s scope list comes from `buildScopeGroups(resourceCounts, ...)`, which just does `Object.keys(resourceCounts)` — confirmed in `app/lib/scopes.ts:22`) — so no PP-specific findings-rendering code is needed at all, only PP-specific page chrome (title) and skipping the cost/usage-only props since a PP audit never has `has_cost`/`usage_types` populated.

- [ ] **Step 1: Write the detail page**

This is a thin, PP-titled wrapper around the exact same three components `audits/[id]/page.tsx` uses — `hasCost={false}` and `usageTypes={[]}` are passed explicitly since a Power Platform audit's `cost_data`/`usage_data` columns are never populated (Task 7 skips that extraction block entirely for `type='power_platform'`):

```tsx
'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { Header } from '../../components/Header'
import { Badge } from '../../components/Badge'
import { AnalysisPanel } from '../../components/AnalysisPanel'
import { RawDataSection } from '../../components/RawDataSection'
import { ChatDock } from '../../components/ChatDock'
import { DetailSkeleton } from '../../components/Skeleton'
import { api } from '../../lib/api'
import { statusConfig } from '../../lib/utils'
import type { AuditDetail } from '../../types'

export default function PowerPlatformDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params.id

  const [audit, setAudit] = useState<AuditDetail | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [error, setError] = useState('')
  const [analyzeScope, setAnalyzeScope] = useState<string>('')

  useEffect(() => {
    api.getAudit(id)
      .then(setAudit)
      .catch(e => {
        const msg = e instanceof Error ? e.message : ''
        if (msg.includes('not found') || msg.includes('404')) setNotFound(true)
        else setError(msg || 'Failed to load audit')
      })
  }, [id])

  if (notFound) return <div style={{ padding: '1rem', color: 'var(--t3)' }}>Audit not found.</div>
  if (error) return <div style={{ color: '#ef4444', padding: '1rem' }}>{error}</div>
  if (!audit) return <DetailSkeleton />

  const counts = audit.resource_counts || {}
  const failed = audit.status === 'failed'
  const sc = statusConfig[audit.status]

  return (
    <>
      <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <div>
          <Header title={audit.subscription_name || 'Power Platform Tenant'} subtitle="Power Platform audit" />
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.25rem' }}>
            <Badge color={sc?.color} label={sc?.label ?? audit.status} />
            <span style={{ fontSize: '0.72rem', color: 'var(--t3)' }}>{new Date(audit.created_at).toLocaleString()}</span>
          </div>
        </div>

        {failed && (
          <pre style={{
            background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.25)',
            borderRadius: 8, padding: '0.875rem 1rem', fontSize: '0.78rem', color: '#ef4444',
            fontFamily: 'ui-monospace, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}>
            {audit.error_message || 'Audit failed with no error message.'}
          </pre>
        )}

        {!failed && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <AnalysisPanel
              auditId={audit.id}
              resourceCounts={counts}
              initialStore={audit.claude_analysis}
              hasCost={false}
              usageTypes={[]}
              onScopeChange={setAnalyzeScope}
            />
            <RawDataSection key={analyzeScope} auditId={audit.id} resourceCounts={counts} selectedType={analyzeScope} />
          </div>
        )}
      </div>

      {!failed && (
        <ChatDock auditId={audit.id} resourceCounts={counts} hasCost={false} usageTypes={[]} />
      )}
    </>
  )
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd external/yomal/dashboard && npx tsc --noEmit`
Expected: no new type errors.

- [ ] **Step 3: Commit**

```bash
git add "external/yomal/dashboard/app/power-platform/[id]/page.tsx"
git commit -m "feat(yomal): add Power Platform audit detail page"
```

---

### Task 14: End-to-end — onboard the real BISTEC tenant and verify real findings

**Files:** none (verification only)

- [ ] **Step 1: Rebuild the CLI Engine binary**

Run: `cd "external/yomal/CLI Engine" && go build -o btg-devops-collector .`
Expected: builds successfully with all Tasks 1-7's changes included.

- [ ] **Step 2: Add the real BISTEC Power Platform tenant via the UI**

Open `http://localhost:3001/subscriptions` (dashboard already running), click Add, select "Power Platform Tenant", and fill in:
- Name: "BISTEC Power Platform Tenant"
- Tenant ID / Client ID / Client Secret: the same `BTG_PP_TENANT_ID` / `BTG_PP_CLIENT_ID` / `BTG_PP_CLIENT_SECRET` values already verified working this session (visible in `web/.env.local` in the main repo, not this one — read them into the form manually, never paste them into any chat/log).

- [ ] **Step 3: Run collect against the real tenant**

Run (loads `DATABASE_URL` from `.env.local` without printing it):

```bash
cd "external/yomal/CLI Engine" && node -e "
const fs = require('fs');
const env = fs.readFileSync('../dashboard/.env.local', 'utf8');
process.env.DATABASE_URL = (env.match(/^DATABASE_URL=(.*)\$/m)||[])[1];
const { execSync } = require('child_process');
execSync('go run . collect --trigger manual', { stdio: 'inherit', env: process.env });
"
```

Expected: stderr shows `[1/4] Extracting pp-environments...` through `[4/4] Extracting pp-powerbi...`, then `Audit complete: <uuid>` with resource counts — `pp-powerbi` should show a count matching the ~200 workspaces confirmed live earlier this session.

- [ ] **Step 4: Confirm analysis_requests got queued**

Run:
```bash
node -e "
const fs = require('fs');
const env = fs.readFileSync('external/yomal/dashboard/.env.local', 'utf8');
const { Client } = require('pg');
const c = new Client({ connectionString: (env.match(/^DATABASE_URL=(.*)\$/m)||[])[1] });
c.connect().then(async () => {
  const r = await c.query(\"SELECT scope, status FROM analysis_requests ORDER BY requested_at DESC LIMIT 10\");
  console.log(r.rows);
  await c.end();
});
"
```
Expected: rows with `scope` in (`pp-environments`, `pp-apps`, `pp-flows`, `pp-powerbi`), `status = 'pending'`.

- [ ] **Step 5: Let the existing analysis mechanism process the queue**

Reuse whatever already-working mechanism processes `analysis_requests` for Azure today (the same Claude Code routine/MCP-server flow built earlier this session for the main `btg-devops` repo's own `analysis_requests` table is a **separate** queue in a **separate** database — Yomal's Postgres `analysis_requests` needs its own MCP server pointed at Yomal's dashboard, which is out of scope for this plan to stand up if it doesn't already exist. Confirm with the user whether Yomal's dashboard already has a working scheduled-analysis mechanism before assuming one needs to be built — check `external/yomal/dashboard/.env.local` for `ROUTINE_TRIGGER_TOKEN`/`ANALYZER_ROUTINE_ID` being set, and check whether `app/api/mcp/route.ts` is reachable, before treating this step as blocked).

- [ ] **Step 6: Verify real findings on the new page**

Once at least one `analysis_requests` row shows `status = 'done'`, open `http://localhost:3001/power-platform`, click into the BISTEC tenant's audit, and confirm real findings render under the corresponding tab (e.g. a Power BI tab finding referencing one of the real personal-workspace or shared-capacity issues already observed live this session).

- [ ] **Step 7: Report final status**

Summarize to the user: what got onboarded, what real findings (if any) appeared, and — if Step 5 revealed no working analysis mechanism for Yomal's dashboard yet — flag that as the one remaining gap (raw PP data collection is fully working end-to-end; only the "turn raw data into findings" half depends on infrastructure this plan didn't build, since it may already exist for Azure and just need pointing at, or may not exist at all).
