package extractors

import (
	"encoding/json"
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/appservice/armappservice/v2"
)

func strP(s string) *string { return &s }
func boolP(b bool) *bool    { return &b }
func int32P(n int32) *int32 { return &n }

func TestReduceAppSettings_NamesOnlyAndKeyVaultRefs(t *testing.T) {
	settings := map[string]*string{
		"DB_PASSWORD":       strP("hunter2"),
		"API_KEY":           strP("@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/api-key)"),
		"QUEUE_CONN":        strP("  @Microsoft.KeyVault(VaultName=kv;SecretName=queue)"),
		"WEBSITE_TIME_ZONE": strP("UTC"),
		"NIL_VALUE":         nil,
	}

	names, kvRefs := reduceAppSettings(settings)

	if len(names) != 5 {
		t.Fatalf("expected 5 setting names, got %d: %v", len(names), names)
	}
	// Sorted, and names only — never values.
	expected := []string{"API_KEY", "DB_PASSWORD", "NIL_VALUE", "QUEUE_CONN", "WEBSITE_TIME_ZONE"}
	for i, want := range expected {
		if names[i] != want {
			t.Errorf("names[%d]: expected %q, got %q", i, want, names[i])
		}
	}
	if kvRefs != 2 {
		t.Errorf("expected 2 Key Vault references (incl. leading-whitespace one), got %d", kvRefs)
	}
}

func TestReduceSiteConfig_KeepsOnlySecurityFields(t *testing.T) {
	tls := armappservice.SupportedTLSVersionsOne2
	cfg := &armappservice.SiteConfig{
		MinTLSVersion: &tls,
		Http20Enabled: boolP(true),
		// A field NOT on the keep-list — must not leak through.
		NodeVersion: strP("18-lts"),
		IPSecurityRestrictions: []*armappservice.IPSecurityRestriction{
			{
				Name:      strP("allow-office"),
				Action:    strP("Allow"),
				Priority:  int32P(100),
				IPAddress: strP("203.0.113.0/24"),
			},
			nil, // must not panic
		},
	}

	out := reduceSiteConfig(cfg)
	if out == nil {
		t.Fatal("expected non-nil reduced config")
	}
	if out["minTlsVersion"] != "1.2" {
		t.Errorf("expected minTlsVersion 1.2, got %v", out["minTlsVersion"])
	}
	if out["http20Enabled"] != true {
		t.Errorf("expected http20Enabled true, got %v", out["http20Enabled"])
	}
	if _, leaked := out["nodeVersion"]; leaked {
		t.Error("nodeVersion leaked into reduced config — only security fields should be kept")
	}

	rules, ok := out["ip_security_restrictions"].([]map[string]any)
	if !ok || len(rules) != 1 {
		t.Fatalf("expected 1 reduced ip restriction, got %v", out["ip_security_restrictions"])
	}
	if rules[0]["name"] != "allow-office" || rules[0]["ip_address"] != "203.0.113.0/24" {
		t.Errorf("unexpected reduced rule: %v", rules[0])
	}
}

func TestReduceAuthSettings_EnabledProvidersAndAction(t *testing.T) {
	action := armappservice.UnauthenticatedClientActionV2RedirectToLoginPage
	auth := &armappservice.SiteAuthSettingsV2Properties{
		Platform: &armappservice.AuthPlatform{Enabled: boolP(true)},
		GlobalValidation: &armappservice.GlobalValidation{
			UnauthenticatedClientAction: &action,
		},
		IdentityProviders: &armappservice.IdentityProviders{
			AzureActiveDirectory: &armappservice.AzureActiveDirectory{Enabled: boolP(true)},
			GitHub:               &armappservice.GitHub{Enabled: boolP(false)},
		},
	}

	out := reduceAuthSettings(auth)
	if out["enabled"] != true {
		t.Errorf("expected enabled true, got %v", out["enabled"])
	}
	if out["unauthenticated_client_action"] != "RedirectToLoginPage" {
		t.Errorf("unexpected action: %v", out["unauthenticated_client_action"])
	}
	providers, _ := out["enabled_providers"].([]string)
	if len(providers) != 1 || providers[0] != "azureActiveDirectory" {
		t.Errorf("expected only azureActiveDirectory enabled, got %v", providers)
	}
}

func TestReduceAuthSettings_NilSafe(t *testing.T) {
	if out := reduceAuthSettings(nil); out != nil {
		t.Errorf("expected nil for nil input, got %v", out)
	}
	// Auth object with nothing set — enabled must default to false.
	out := reduceAuthSettings(&armappservice.SiteAuthSettingsV2Properties{})
	if out["enabled"] != false {
		t.Errorf("expected enabled false for empty auth settings, got %v", out["enabled"])
	}
}

func TestMergeIntoJSON_AddsFieldsAndSkipsNil(t *testing.T) {
	base := json.RawMessage(`{"name":"acct1","location":"southeastasia"}`)

	merged, err := mergeIntoJSON(base, map[string]any{
		"total_containers": 3,
		"skipped_error":    omitEmpty(""),        // must be left out entirely
		"real_error":       omitEmpty("timeout"), // must be kept
		"confirmed_null":   json.RawMessage("null"),
	})
	if err != nil {
		t.Fatalf("mergeIntoJSON returned error: %v", err)
	}

	var out map[string]any
	if err := json.Unmarshal(merged, &out); err != nil {
		t.Fatalf("failed to unmarshal merged JSON: %v", err)
	}

	if out["name"] != "acct1" {
		t.Errorf("original field lost: %v", out)
	}
	if out["total_containers"] != float64(3) {
		t.Errorf("expected total_containers 3, got %v", out["total_containers"])
	}
	if _, exists := out["skipped_error"]; exists {
		t.Error(`empty omitEmpty field must be omitted, but "skipped_error" is present`)
	}
	if out["real_error"] != "timeout" {
		t.Errorf("expected real_error to survive, got %v", out["real_error"])
	}
	if v, exists := out["confirmed_null"]; !exists || v != nil {
		t.Errorf("expected explicit JSON null to survive as null, got exists=%v value=%v", exists, v)
	}
}
