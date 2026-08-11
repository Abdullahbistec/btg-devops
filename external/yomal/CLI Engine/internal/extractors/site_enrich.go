package extractors

import (
	"context"
	"encoding/json"
	"sort"
	"strings"

	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/appservice/armappservice/v2"
)

// SiteEnrichment holds security-relevant per-site details that the sites
// list API does not return (spec 11 §1): site config (TLS, FTPS, CORS, IP
// restrictions), Easy Auth state, and app-setting NAMES. Setting values are
// never collected — names alone let the analyzer spot plaintext-credential
// smells (a DB_PASSWORD setting with no Key Vault reference) without ever
// storing a secret. Each sub-fetch is best-effort: a failure records an
// *_error string on the entry instead of failing the audit.
type SiteEnrichment struct {
	SecurityConfig      map[string]any `json:"security_config,omitempty"`
	SecurityConfigError string         `json:"security_config_error,omitempty"`
	AuthConfig          map[string]any `json:"auth_config,omitempty"`
	AuthConfigError     string         `json:"auth_config_error,omitempty"`
	AppSettingNames     []string       `json:"app_setting_names,omitempty"`
	AppSettingsError    string         `json:"app_settings_error,omitempty"`
	// How many app settings resolve through Key Vault references
	// (@Microsoft.KeyVault(...)) rather than holding their value inline.
	KeyVaultReferenceCount int `json:"keyvault_reference_count"`
}

// securityConfigFields are the site-config fields worth keeping for
// analysis — the full SiteConfig is hundreds of fields of runtime noise.
var securityConfigFields = []string{
	"minTlsVersion",
	"ftpsState",
	"http20Enabled",
	"remoteDebuggingEnabled",
	"cors",
	"publicNetworkAccess",
}

// EnrichSite fetches per-site security details for one web/function app.
// Never returns an error — failures are recorded in the enrichment itself.
func EnrichSite(ctx context.Context, client *armappservice.WebAppsClient, resourceGroup, name string) SiteEnrichment {
	var e SiteEnrichment

	if cfg, err := client.GetConfiguration(ctx, resourceGroup, name, nil); err != nil {
		e.SecurityConfigError = err.Error()
	} else {
		e.SecurityConfig = reduceSiteConfig(cfg.Properties)
	}

	if auth, err := client.GetAuthSettingsV2WithoutSecrets(ctx, resourceGroup, name, nil); err != nil {
		e.AuthConfigError = err.Error()
	} else {
		e.AuthConfig = reduceAuthSettings(auth.Properties)
	}

	if settings, err := client.ListApplicationSettings(ctx, resourceGroup, name, nil); err != nil {
		e.AppSettingsError = err.Error()
	} else {
		e.AppSettingNames, e.KeyVaultReferenceCount = reduceAppSettings(settings.Properties)
	}

	return e
}

// reduceSiteConfig keeps only the analysis-relevant fields of a SiteConfig,
// plus a reduced view of the IP restriction rules (rule identity only, no
// headers or descriptions).
func reduceSiteConfig(cfg *armappservice.SiteConfig) map[string]any {
	if cfg == nil {
		return nil
	}
	raw, err := json.Marshal(cfg)
	if err != nil {
		return nil
	}
	var full map[string]any
	if err := json.Unmarshal(raw, &full); err != nil {
		return nil
	}

	out := map[string]any{}
	for _, f := range securityConfigFields {
		if v, ok := full[f]; ok && v != nil {
			out[f] = v
		}
	}
	out["ip_security_restrictions"] = reduceIPRestrictions(cfg.IPSecurityRestrictions)
	out["scm_ip_security_restrictions"] = reduceIPRestrictions(cfg.ScmIPSecurityRestrictions)
	return out
}

func reduceIPRestrictions(rules []*armappservice.IPSecurityRestriction) []map[string]any {
	out := make([]map[string]any, 0, len(rules))
	for _, r := range rules {
		if r == nil {
			continue
		}
		m := map[string]any{}
		if r.Name != nil {
			m["name"] = *r.Name
		}
		if r.Action != nil {
			m["action"] = *r.Action
		}
		if r.Priority != nil {
			m["priority"] = *r.Priority
		}
		if r.IPAddress != nil {
			m["ip_address"] = *r.IPAddress
		}
		if r.VnetSubnetResourceID != nil {
			m["vnet_subnet_id"] = *r.VnetSubnetResourceID
		}
		out = append(out, m)
	}
	return out
}

// reduceAuthSettings keeps whether Easy Auth is on, what happens to
// unauthenticated requests, and which identity providers are enabled —
// nothing else (and never any secret setting names/values; the fetch itself
// already uses the WithoutSecrets variant).
func reduceAuthSettings(auth *armappservice.SiteAuthSettingsV2Properties) map[string]any {
	if auth == nil {
		return nil
	}
	out := map[string]any{}
	enabled := false
	if auth.Platform != nil && auth.Platform.Enabled != nil {
		enabled = *auth.Platform.Enabled
	}
	out["enabled"] = enabled
	if auth.GlobalValidation != nil && auth.GlobalValidation.UnauthenticatedClientAction != nil {
		out["unauthenticated_client_action"] = string(*auth.GlobalValidation.UnauthenticatedClientAction)
	}

	var providers []string
	if p := auth.IdentityProviders; p != nil {
		add := func(name string, on *bool) {
			if on != nil && *on {
				providers = append(providers, name)
			}
		}
		if p.AzureActiveDirectory != nil {
			add("azureActiveDirectory", p.AzureActiveDirectory.Enabled)
		}
		if p.Facebook != nil {
			add("facebook", p.Facebook.Enabled)
		}
		if p.GitHub != nil {
			add("gitHub", p.GitHub.Enabled)
		}
		if p.Google != nil {
			add("google", p.Google.Enabled)
		}
		if p.Twitter != nil {
			add("twitter", p.Twitter.Enabled)
		}
		if p.Apple != nil {
			add("apple", p.Apple.Enabled)
		}
	}
	out["enabled_providers"] = providers
	return out
}

// reduceAppSettings returns the sorted setting NAMES (never values) and how
// many of the values are Key Vault references.
func reduceAppSettings(settings map[string]*string) ([]string, int) {
	names := make([]string, 0, len(settings))
	kvRefs := 0
	for name, value := range settings {
		names = append(names, name)
		if value != nil && strings.HasPrefix(strings.TrimSpace(*value), "@Microsoft.KeyVault") {
			kvRefs++
		}
	}
	sort.Strings(names)
	return names, kvRefs
}

// mergeIntoJSON adds extra top-level fields to an already-cleaned resource
// JSON object. Used by extractors that enrich the raw list-API envelope
// with per-resource fetches (spec 11) without changing their output shape.
// Nil values are skipped, so optional fields (built with omitEmpty) don't
// litter every resource with `"x_error": null`.
func mergeIntoJSON(clean json.RawMessage, extra map[string]any) (json.RawMessage, error) {
	var m map[string]any
	if err := json.Unmarshal(clean, &m); err != nil {
		return nil, err
	}
	for k, v := range extra {
		if v == nil {
			continue
		}
		m[k] = v
	}
	return json.Marshal(m)
}

// omitEmpty maps "" to nil so mergeIntoJSON leaves the field out entirely.
func omitEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
