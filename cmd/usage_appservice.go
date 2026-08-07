package cmd

import (
	"context"
	"fmt"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/appservice/armappservice/v2"
)

// BuildAppServiceUsageTips returns optimization tips and estimated monthly saving for an App Service app.
func BuildAppServiceUsageTips(state string, httpsOnly, clientCertEnabled, alwaysOn, http20Enabled, remoteDebugging bool, minTLSVersion, planName string, totalCost float64, meters []MeterCost) (tips []string, saving float64) {
	if state == "Stopped" {
		saving += totalCost
		tips = append(tips, "App is stopped but still accruing plan charges — remove if no longer needed")
	}
	if !httpsOnly {
		tips = append(tips, "HTTPS-only is not enforced — enable to prevent HTTP traffic and meet security standards (no cost impact)")
	}
	if minTLSVersion == "1.0" || minTLSVersion == "1.1" {
		tips = append(tips, fmt.Sprintf("Minimum TLS version is %s — upgrade to TLS 1.2 minimum for PCI-DSS and security compliance", minTLSVersion))
	}
	if remoteDebugging {
		tips = append(tips, "Remote debugging is enabled — this is a security risk in production; disable it immediately")
	}
	if !alwaysOn && totalCost > 10 {
		tips = append(tips, "Always On is disabled — app will be unloaded after inactivity causing cold start delays; enable if this is a production app")
	}
	if !http20Enabled {
		tips = append(tips, "HTTP/2 is not enabled — enable it for better performance and reduced bandwidth usage at no extra cost")
	}
	if !clientCertEnabled && totalCost > 20 {
		tips = append(tips, "Client certificate authentication is disabled — consider enabling for APIs to add mutual TLS authentication")
	}
	for _, m := range meters {
		if m.Name == "Bandwidth" && m.Cost > 10 {
			tips = append(tips, fmt.Sprintf("High bandwidth cost ($%.2f) — add Azure CDN or Front Door in front of this app to cache static content", m.Cost))
			saving += m.Cost * 0.40
		}
	}
	if totalCost == 0 {
		tips = append(tips, "Zero cost detected — app has no billable activity; verify it is still needed or delete to free plan capacity")
	}
	if planName == "" {
		tips = append(tips, "No App Service Plan linked — app may be in a broken state; verify plan assignment")
	}
	return
}

func runAppServiceUsage(ctx context.Context, subID string, cred *azidentity.DefaultAzureCredential, resourceID, name, rg string, days int) (*UsageReport, error) {
	appsClient, err := armappservice.NewWebAppsClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating web apps client: %w", err)
	}

	app, err := appsClient.Get(ctx, rg, name, nil)
	if err != nil {
		return nil, fmt.Errorf("getting web app: %w", err)
	}

	meterMap, totalCost, currency, err := queryMeterCosts(ctx, subID, cred, resourceID, days)
	if err != nil {
		return nil, fmt.Errorf("querying meter costs: %w", err)
	}

	var meters []MeterCost
	for meterName, cost := range meterMap {
		meters = append(meters, MeterCost{Name: meterName, Cost: cost, Currency: currency})
	}
	sortMetersByCost(meters)

	// App properties
	state := ""
	planID := ""
	planName := ""
	httpsOnly := false
	clientCertEnabled := false
	alwaysOn := false
	http20Enabled := false
	minTLSVersion := ""
	remoteDebugging := false

	if app.Properties != nil {
		if app.Properties.State != nil {
			state = *app.Properties.State
		}
		if app.Properties.ServerFarmID != nil {
			planID = *app.Properties.ServerFarmID
			planName = lastSegment(planID)
		}
		if app.Properties.HTTPSOnly != nil {
			httpsOnly = *app.Properties.HTTPSOnly
		}
		if app.Properties.ClientCertEnabled != nil {
			clientCertEnabled = *app.Properties.ClientCertEnabled
		}
		if app.Properties.SiteConfig != nil {
			if app.Properties.SiteConfig.AlwaysOn != nil {
				alwaysOn = *app.Properties.SiteConfig.AlwaysOn
			}
			if app.Properties.SiteConfig.Http20Enabled != nil {
				http20Enabled = *app.Properties.SiteConfig.Http20Enabled
			}
			if app.Properties.SiteConfig.MinTLSVersion != nil {
				minTLSVersion = string(*app.Properties.SiteConfig.MinTLSVersion)
			}
			// FtpState not available in this SDK version
			if app.Properties.SiteConfig.RemoteDebuggingEnabled != nil {
				remoteDebugging = *app.Properties.SiteConfig.RemoteDebuggingEnabled
			}
		}
	}

	var tips []string
	totalSaving := 0.0

	// Rule 1 — App is stopped
	if state == "Stopped" {
		tips = append(tips, "App is stopped but still accruing plan charges — remove if no longer needed")
		totalSaving += totalCost
	}

	// Rule 2 — HTTPS not enforced
	if !httpsOnly {
		tips = append(tips, "HTTPS-only is not enforced — enable to prevent HTTP traffic and meet security standards (no cost impact)")
	}

	// Rule 3 — Old TLS version
	if minTLSVersion == "1.0" || minTLSVersion == "1.1" {
		tips = append(tips, fmt.Sprintf("Minimum TLS version is %s — upgrade to TLS 1.2 minimum for PCI-DSS and security compliance", minTLSVersion))
	}

	// Rule 5 — Remote debugging left on
	if remoteDebugging {
		tips = append(tips, "Remote debugging is enabled — this is a security risk in production; disable it immediately")
	}

	// Rule 6 — Always-on disabled (cold starts)
	if !alwaysOn && totalCost > 10 {
		tips = append(tips, "Always On is disabled — app will be unloaded after inactivity causing cold start delays; enable if this is a production app")
	}

	// Rule 7 — HTTP/2 not enabled
	if !http20Enabled {
		tips = append(tips, "HTTP/2 is not enabled — enable it for better performance and reduced bandwidth usage at no extra cost")
	}

	// Rule 8 — No client certificate
	if !clientCertEnabled && totalCost > 20 {
		tips = append(tips, "Client certificate authentication is disabled — consider enabling for APIs to add mutual TLS authentication")
	}

	// Rule 9 — High bandwidth cost
	for _, m := range meters {
		if m.Name == "Bandwidth" && m.Cost > 10 {
			tips = append(tips, fmt.Sprintf("High bandwidth cost ($%.2f) — add Azure CDN or Front Door in front of this app to cache static content", m.Cost))
			totalSaving += m.Cost * 0.40
		}
	}

	// Rule 10 — Zero cost (app completely idle)
	if totalCost == 0 {
		tips = append(tips, "Zero cost detected — app has no billable activity; verify it is still needed or delete to free plan capacity")
	}

	// Rule 11 — Plan name check
	if planName == "" {
		tips = append(tips, "No App Service Plan linked — app may be in a broken state; verify plan assignment")
	}

	tip := ""
	if len(tips) > 0 {
		tip = tips[0]
		if len(tips) > 1 {
			tip += fmt.Sprintf(" (+%d more findings)", len(tips)-1)
		}
	}

	subResources := []UsageSubResource{
		{
			Name:     name,
			Cost:     totalCost,
			Currency: currency,
			Severity: costSeverity(totalCost),
			Details: map[string]string{
				"state":        state,
				"plan":         planName,
				"https_only":   fmt.Sprintf("%v", httpsOnly),
				"always_on":    fmt.Sprintf("%v", alwaysOn),
				"remote_debug": fmt.Sprintf("%v", remoteDebugging),
				"min_tls":      minTLSVersion,
			},
			Tip:           tip,
			MonthlySaving: totalSaving,
		},
	}

	topRec := ""
	if len(tips) > 0 {
		topRec = tips[0]
	}

	avgMetrics := queryResourceMetrics(ctx, subID, cred, resourceID, []string{"CpuPercentage", "MemoryPercentage"}, days, "Average")
	countMetrics := queryResourceMetrics(ctx, subID, cred, resourceID, []string{"Requests"}, days, "Count")
	cpuPct := avgMetrics["CpuPercentage"]
	memPct := avgMetrics["MemoryPercentage"]
	requestsPerDay := countMetrics["Requests"]
	wasteScore, wasteReason := calcWasteScore(totalCost, cpuPct, requestsPerDay)

	return &UsageReport{
		ResourceName:      name,
		ResourceType:      "microsoft.web/sites",
		ResourceGroup:     rg,
		Period:            periodString(days),
		Days:              days,
		TotalCost:         totalCost,
		Currency:          currency,
		Severity:          costSeverity(totalCost),
		Meters:            meters,
		SubResources:      subResources,
		TotalSaving:       totalSaving,
		TopRecommendation: topRec,
		Utilization:       map[string]float64{"CPU %": cpuPct, "Memory %": memPct, "Requests/day": requestsPerDay},
		WasteScore:        wasteScore,
		WasteReason:       wasteReason,
	}, nil
}
