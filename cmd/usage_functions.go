package cmd

import "fmt"

// BuildFunctionsUsageTips returns optimization tips and estimated saving for a Function App.
func BuildFunctionsUsageTips(planType, state string, httpsOnly, alwaysOn, remoteDebugging bool, minTLSVersion string, totalCost float64) (tips []string, saving float64) {
	switch planType {
	case "S1", "S2", "S3", "P1v2", "P2v2", "P3v2", "P1v3", "P2v3", "P3v3":
		if totalCost > 30 {
			saving += totalCost * 0.50
			tips = append(tips, fmt.Sprintf("Functions on dedicated %s plan — switch to Consumption or Flex Consumption for event-driven workloads to save ~50%%", planType))
		}
	}
	switch planType {
	case "EP1", "EP2", "EP3":
		if totalCost > 50 {
			saving += totalCost * 0.35
			tips = append(tips, fmt.Sprintf("Elastic Premium %s plan — verify always-ready instance count; reduce pre-warmed instances to lower idle cost by ~35%%", planType))
		}
	}
	if (planType == "Y1" || planType == "unknown") && alwaysOn {
		tips = append(tips, "Always On is enabled on a Consumption/unknown plan — this has no effect on Consumption and wastes billing; disable it")
	}
	if state == "Stopped" {
		saving += totalCost
		tips = append(tips, "Function app is stopped — still consuming plan capacity on dedicated/premium plans; remove if unused")
	}
	if !httpsOnly {
		tips = append(tips, "HTTPS-only is not enforced — enable to prevent plain HTTP requests to function endpoints")
	}
	if minTLSVersion == "1.0" || minTLSVersion == "1.1" {
		tips = append(tips, fmt.Sprintf("Minimum TLS version is %s — upgrade to TLS 1.2 for security compliance", minTLSVersion))
	}
	if remoteDebugging {
		tips = append(tips, "Remote debugging is enabled — disable immediately in production; this is a significant security risk")
	}
	if planType == "Y1" && totalCost > 20 {
		tips = append(tips, fmt.Sprintf("High Consumption plan cost ($%.2f) — review function execution frequency and duration; optimize cold start time to reduce billing", totalCost))
	}
	if totalCost == 0 {
		tips = append(tips, "Zero cost — function app has no executions in this period; verify it is still needed or delete to free plan capacity")
	}
	if (planType == "EP1" || planType == "EP2" || planType == "EP3") && totalCost < 5 {
		saving += totalCost
		tips = append(tips, fmt.Sprintf("Premium plan %s with near-zero activity — switch to Consumption plan to pay only for actual executions", planType))
	}
	return
}
