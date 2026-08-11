package extractors

import (
	"context"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/monitor/armmonitor"
)

// diagnosticSetting is the reduced view of one diagnostic setting on a
// resource: which log categories are enabled and where they go. Enough to
// answer the "is auditing/logging configured at all?" checklist items
// (spec 11 §5) without storing the full Monitor payload.
type diagnosticSetting struct {
	Name                 string   `json:"name"`
	EnabledLogCategories []string `json:"enabled_log_categories"`
	Destinations         []string `json:"destinations"`
}

// addDiagnosticSettings records a resource's diagnostic settings into extra
// under "diagnostic_settings". An empty list means CONFIRMED none configured
// (the distinction the analyzer needs vs. "not collected"). Best-effort: on
// failure only diagnostic_settings_error is set.
func addDiagnosticSettings(ctx context.Context, cred azcore.TokenCredential, resourceID string, extra map[string]any) {
	client, err := armmonitor.NewDiagnosticSettingsClient(cred, nil)
	if err != nil {
		extra["diagnostic_settings_error"] = err.Error()
		return
	}

	settings := []diagnosticSetting{}
	pager := client.NewListPager(resourceID, nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			extra["diagnostic_settings_error"] = err.Error()
			return
		}
		for _, s := range page.Value {
			if s == nil {
				continue
			}
			d := diagnosticSetting{
				Name:                 derefStr(s.Name),
				EnabledLogCategories: []string{},
				Destinations:         []string{},
			}
			if p := s.Properties; p != nil {
				for _, l := range p.Logs {
					if l == nil || l.Enabled == nil || !*l.Enabled {
						continue
					}
					switch {
					case l.Category != nil:
						d.EnabledLogCategories = append(d.EnabledLogCategories, *l.Category)
					case l.CategoryGroup != nil:
						d.EnabledLogCategories = append(d.EnabledLogCategories, "group:"+*l.CategoryGroup)
					}
				}
				if p.WorkspaceID != nil && *p.WorkspaceID != "" {
					d.Destinations = append(d.Destinations, "log_analytics")
				}
				if p.StorageAccountID != nil && *p.StorageAccountID != "" {
					d.Destinations = append(d.Destinations, "storage")
				}
				if p.EventHubName != nil && *p.EventHubName != "" || p.EventHubAuthorizationRuleID != nil && *p.EventHubAuthorizationRuleID != "" {
					d.Destinations = append(d.Destinations, "event_hub")
				}
			}
			settings = append(settings, d)
		}
	}
	extra["diagnostic_settings"] = settings
}
