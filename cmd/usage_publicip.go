package cmd

import (
	"context"
	"fmt"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/network/armnetwork/v4"
)

// BuildPublicIPUsageTips returns optimization tips and estimated saving for a Public IP address.
func BuildPublicIPUsageTips(attached bool, allocationMethod, sku string, ddosProtection bool, idleTimeoutMinutes int32, ipVersion, rg string, totalCost float64, meters []MeterCost) (tips []string, saving float64) {
	if !attached {
		saving += totalCost
		tips = append(tips, "IP is not attached to any resource — static IPs still incur hourly charges; delete or reassign to eliminate cost")
	}
	if allocationMethod == "Static" && !attached {
		saving += totalCost * 0.10
		tips = append(tips, "Static IP reserved but unattached — static IPs cost more than dynamic; release it if no longer needed")
	}
	if sku == "Basic" && attached {
		tips = append(tips, "Basic SKU Public IP has no zone redundancy and no SLA — upgrade to Standard SKU for production use")
	}
	if sku == "Standard" && !ddosProtection && totalCost > 5 {
		tips = append(tips, "Standard SKU IP has no DDoS protection configured — enable DDoS Network Protection or DDoS IP Protection for internet-facing endpoints")
	}
	if idleTimeoutMinutes > 10 {
		tips = append(tips, fmt.Sprintf("Idle timeout is %d minutes (default is 4) — high idle timeouts keep TCP connections open longer, increasing memory usage on backend VMs", idleTimeoutMinutes))
	}
	if ipVersion == "IPv4" && sku == "Standard" {
		tips = append(tips, "Only IPv4 is configured — consider adding IPv6 for dual-stack support to improve reach and future-proof the architecture")
	}
	for _, m := range meters {
		if m.Name == "Data Transfer" && m.Cost > 20 {
			saving += m.Cost * 0.30
			tips = append(tips, fmt.Sprintf("High data transfer cost ($%.2f) — review what is generating outbound traffic from this IP; consider Azure CDN for large content delivery", m.Cost))
		}
	}
	if totalCost == 0 && attached {
		tips = append(tips, "Zero cost despite being attached — verify the resource using this IP is active; it may indicate a billing data delay")
	}
	if sku == "Basic" && totalCost > 10 {
		tips = append(tips, "Basic SKU does not support availability zones — if the attached resource uses zone-redundant deployment, the IP becomes a single point of failure")
	}
	if !attached && totalCost > 2 {
		tips = append(tips, fmt.Sprintf("Unattached IP costing $%.2f/month — audit all Public IPs in resource group '%s' for similar waste", totalCost, rg))
	}
	if allocationMethod == "Static" && sku == "Basic" {
		tips = append(tips, "Basic Static IP — Basic SKU is being retired; plan migration to Standard SKU before retirement deadline")
	}
	return
}

func runPublicIPUsage(ctx context.Context, subID string, cred *azidentity.DefaultAzureCredential, resourceID, name, rg string, days int) (*UsageReport, error) {
	pipClient, err := armnetwork.NewPublicIPAddressesClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating public ip client: %w", err)
	}

	pip, err := pipClient.Get(ctx, rg, name, nil)
	if err != nil {
		return nil, fmt.Errorf("getting public ip: %w", err)
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

	// IP properties
	attached := false
	attachedTo := ""
	ipAddr := ""
	sku := ""
	allocationMethod := ""
	ddosProtection := false
	idleTimeoutMinutes := int32(4)
	ipVersion := ""

	if pip.Properties != nil {
		if pip.Properties.IPConfiguration != nil && pip.Properties.IPConfiguration.ID != nil {
			attached = true
			attachedTo = lastSegment(*pip.Properties.IPConfiguration.ID)
		}
		if pip.Properties.IPAddress != nil {
			ipAddr = *pip.Properties.IPAddress
		}
		if pip.Properties.PublicIPAllocationMethod != nil {
			allocationMethod = string(*pip.Properties.PublicIPAllocationMethod)
		}
		if pip.Properties.DdosSettings != nil && pip.Properties.DdosSettings.ProtectionMode != nil {
			if string(*pip.Properties.DdosSettings.ProtectionMode) == "Enabled" {
				ddosProtection = true
			}
		}
		if pip.Properties.IdleTimeoutInMinutes != nil {
			idleTimeoutMinutes = *pip.Properties.IdleTimeoutInMinutes
		}
		if pip.Properties.PublicIPAddressVersion != nil {
			ipVersion = string(*pip.Properties.PublicIPAddressVersion)
		}
	}
	if pip.SKU != nil && pip.SKU.Name != nil {
		sku = string(*pip.SKU.Name)
	}

	var tips []string
	totalSaving := 0.0

	// Rule 1 — Unattached IP (biggest waste)
	if !attached {
		tips = append(tips, "IP is not attached to any resource — static IPs still incur hourly charges; delete or reassign to eliminate cost")
		totalSaving += totalCost
	}

	// Rule 2 — Dynamic IP used as static (over-provisioned)
	if allocationMethod == "Static" && !attached {
		tips = append(tips, "Static IP reserved but unattached — static IPs cost more than dynamic; release it if no longer needed")
		totalSaving += totalCost * 0.10
	}

	// Rule 3 — Basic SKU in production (no zone redundancy, no SLA)
	if sku == "Basic" && attached {
		tips = append(tips, "Basic SKU Public IP has no zone redundancy and no SLA — upgrade to Standard SKU for production use")
	}

	// Rule 4 — No DDoS protection on Standard SKU
	if sku == "Standard" && !ddosProtection && totalCost > 5 {
		tips = append(tips, "Standard SKU IP has no DDoS protection configured — enable DDoS Network Protection or DDoS IP Protection for internet-facing endpoints")
	}

	// Rule 5 — High idle timeout
	if idleTimeoutMinutes > 10 {
		tips = append(tips, fmt.Sprintf("Idle timeout is %d minutes (default is 4) — high idle timeouts keep TCP connections open longer, increasing memory usage on backend VMs", idleTimeoutMinutes))
	}

	// Rule 6 — IPv4 only (consider IPv6 dual-stack)
	if ipVersion == "IPv4" && sku == "Standard" {
		tips = append(tips, "Only IPv4 is configured — consider adding IPv6 for dual-stack support to improve reach and future-proof the architecture")
	}

	// Rule 7 — High bandwidth cost
	for _, m := range meters {
		if m.Name == "Data Transfer" && m.Cost > 20 {
			tips = append(tips, fmt.Sprintf("High data transfer cost ($%.2f) — review what is generating outbound traffic from this IP; consider Azure CDN for large content delivery", m.Cost))
			totalSaving += m.Cost * 0.30
		}
	}

	// Rule 8 — Zero cost but attached (possible billing gap)
	if totalCost == 0 && attached {
		tips = append(tips, "Zero cost despite being attached — verify the resource using this IP is active; it may indicate a billing data delay")
	}

	// Rule 9 — Basic SKU with zone-critical workload
	if sku == "Basic" && totalCost > 10 {
		tips = append(tips, "Basic SKU does not support availability zones — if the attached resource uses zone-redundant deployment, the IP becomes a single point of failure")
	}

	// Rule 10 — Multiple IPs in same RG all unattached (pattern)
	if !attached && totalCost > 2 {
		tips = append(tips, fmt.Sprintf("Unattached IP costing $%.2f/month — audit all Public IPs in resource group '%s' for similar waste", totalCost, rg))
	}

	// Rule 11 — Static IP not needed (dynamic would suffice)
	if allocationMethod == "Static" && sku == "Basic" {
		tips = append(tips, "Basic Static IP — Basic SKU is being retired; plan migration to Standard SKU before retirement deadline")
	}

	tip := ""
	if len(tips) > 0 {
		tip = tips[0]
		if len(tips) > 1 {
			tip += fmt.Sprintf(" (+%d more findings)", len(tips)-1)
		}
	}

	details := map[string]string{
		"IP":               ipAddr,
		"SKU":              sku,
		"allocation":       allocationMethod,
		"ddos_protection":  fmt.Sprintf("%v", ddosProtection),
		"idle_timeout_min": fmt.Sprintf("%d", idleTimeoutMinutes),
		"ip_version":       ipVersion,
	}
	if attached {
		details["attached_to"] = attachedTo
	} else {
		details["status"] = "UNATTACHED"
	}

	subResources := []UsageSubResource{
		{
			Name:          name,
			Cost:          totalCost,
			Currency:      currency,
			Severity:      boolSeverity(!attached),
			Details:       details,
			Tip:           tip,
			MonthlySaving: totalSaving,
		},
	}

	topRec := ""
	if len(tips) > 0 {
		topRec = tips[0]
	}

	utilMetrics := queryResourceMetrics(ctx, subID, cred, resourceID, []string{"PacketCount", "ByteCount"}, days, "Count")
	packetsPerDay := utilMetrics["PacketCount"]
	bytesPerDay := utilMetrics["ByteCount"]
	_ = bytesPerDay
	wasteScore, wasteReason := calcWasteScore(totalCost, -1, packetsPerDay)
	if !attached {
		wasteScore = "IDLE"
		wasteReason = "Public IP is not attached to any resource — delete to stop incurring charges"
	}

	return &UsageReport{
		ResourceName:      name,
		ResourceType:      "microsoft.network/publicipaddresses",
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
		Utilization:       map[string]float64{"Packets/day": packetsPerDay},
		WasteScore:        wasteScore,
		WasteReason:       wasteReason,
	}, nil
}

func boolSeverity(isWarning bool) Severity {
	if isWarning {
		return Warning
	}
	return Info
}
