package extractors

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/appservice/armappservice/v2"
)

// FunctionsData holds the clean extracted data for all function apps.
type FunctionsData struct {
	TotalFunctionApps int               `json:"total_function_apps"`
	FunctionApps      []json.RawMessage `json:"function_apps"`
}

// ExtractFunctions fetches all function apps and returns clean JSON.
func ExtractFunctions(ctx context.Context, subID string, cred azcore.TokenCredential) (*FunctionsData, error) {
	client, err := armappservice.NewWebAppsClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating functions client: %w", err)
	}

	var apps []*armappservice.Site
	pager := client.NewListPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("listing web apps: %w", err)
		}
		for _, app := range page.Value {
			if app.Kind != nil && strings.Contains(strings.ToLower(*app.Kind), "functionapp") {
				apps = append(apps, app)
			}
		}
	}

	// Per-app security enrichment (spec 11 §1) is merged into each cleaned
	// envelope rather than changing this extractor's output shape.
	cleanApps := make([]json.RawMessage, 0, len(apps))
	for _, app := range apps {
		clean, err := CleanResource(app)
		if err != nil {
			return nil, fmt.Errorf("cleaning function app %s: %w", derefStr(app.Name), err)
		}
		enrichment := SiteEnrichment{}
		if app.ID != nil && app.Name != nil {
			enrichment = EnrichSite(ctx, client, extractResourceGroup(*app.ID), *app.Name)
		}
		functionList, functionsErr := listFunctionAuthLevels(ctx, client, extractResourceGroup(derefStr(app.ID)), derefStr(app.Name))

		enriched, err := mergeIntoJSON(clean, map[string]any{
			"security_config":          enrichment.SecurityConfig,
			"security_config_error":    omitEmpty(enrichment.SecurityConfigError),
			"auth_config":              enrichment.AuthConfig,
			"auth_config_error":        omitEmpty(enrichment.AuthConfigError),
			"app_setting_names":        enrichment.AppSettingNames,
			"app_settings_error":       omitEmpty(enrichment.AppSettingsError),
			"keyvault_reference_count": enrichment.KeyVaultReferenceCount,
			"functions":                functionList,
			"functions_error":          omitEmpty(errString(functionsErr)),
		})
		if err != nil {
			return nil, fmt.Errorf("enriching function app %s: %w", derefStr(app.Name), err)
		}
		cleanApps = append(cleanApps, enriched)
	}

	return &FunctionsData{
		TotalFunctionApps: len(apps),
		FunctionApps:      cleanApps,
	}, nil
}

// functionAuthLevel is the reduced view of one function within a Function
// App: its trigger type and authLevel (anonymous/function/admin) — added
// spec 11 round 3 to answer "is this HTTP-triggered function actually
// callable without a key?", which the app-level config can't answer (that
// lives per-function, in each function's own binding config).
type functionAuthLevel struct {
	Name        string `json:"name"`
	TriggerType string `json:"trigger_type,omitempty"`
	AuthLevel   string `json:"auth_level,omitempty"`
}

// listFunctionAuthLevels lists every function within one Function App and
// extracts its trigger type + authLevel from the function's Config (an
// untyped JSON blob shaped like function.json: {"bindings": [{"type":
// "httpTrigger", "authLevel": "anonymous", ...}]}).
func listFunctionAuthLevels(ctx context.Context, client *armappservice.WebAppsClient, rg, appName string) ([]functionAuthLevel, error) {
	if rg == "" || appName == "" {
		return nil, nil
	}
	var out []functionAuthLevel
	pager := client.NewListFunctionsPager(rg, appName, nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("listing functions for %s: %w", appName, err)
		}
		for _, f := range page.Value {
			if f == nil {
				continue
			}
			entry := functionAuthLevel{Name: derefStr(f.Name)}
			if f.Properties != nil {
				entry.TriggerType, entry.AuthLevel = extractHTTPTriggerAuth(f.Properties.Config)
			}
			out = append(out, entry)
		}
	}
	return out, nil
}

// extractHTTPTriggerAuth pulls "type" and "authLevel" out of the first
// HTTP-shaped trigger binding in a function's Config blob. Returns empty
// strings if Config isn't the expected shape (e.g. non-HTTP triggers, or a
// runtime that doesn't expose bindings this way) — never errors, since this
// is best-effort enrichment of an untyped field.
func extractHTTPTriggerAuth(config any) (triggerType, authLevel string) {
	m, ok := config.(map[string]any)
	if !ok {
		return "", ""
	}
	bindings, ok := m["bindings"].([]any)
	if !ok {
		return "", ""
	}
	for _, b := range bindings {
		binding, ok := b.(map[string]any)
		if !ok {
			continue
		}
		t, _ := binding["type"].(string)
		if !strings.Contains(strings.ToLower(t), "trigger") {
			continue
		}
		level, _ := binding["authLevel"].(string)
		return t, level
	}
	return "", ""
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
