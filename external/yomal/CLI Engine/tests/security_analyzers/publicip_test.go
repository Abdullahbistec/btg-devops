package security_analyzers_test

import (
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/network/armnetwork/v4"
	"github.com/chanbistec/btg-devops/cmd"
	"github.com/stretchr/testify/assert"
)

func pip(name string, sku armnetwork.PublicIPAddressSKUName, allocation armnetwork.IPAllocationMethod, attached bool) *armnetwork.PublicIPAddress {
	id := "/subscriptions/sub/resourceGroups/rg-test/providers/Microsoft.Network/publicIPAddresses/" + name
	skuVal := sku
	p := &armnetwork.PublicIPAddress{
		Name: strPtr(name),
		ID:   strPtr(id),
		SKU:  &armnetwork.PublicIPAddressSKU{Name: &skuVal},
		Properties: &armnetwork.PublicIPAddressPropertiesFormat{
			PublicIPAllocationMethod: &allocation,
		},
	}
	if attached {
		p.Properties.IPConfiguration = &armnetwork.IPConfiguration{ID: strPtr("ip-config-id")}
	}
	return p
}

func TestAnalyzePublicIPs(t *testing.T) {
	static := armnetwork.IPAllocationMethodStatic
	dynamic := armnetwork.IPAllocationMethodDynamic

	tests := []struct {
		name           string
		pips           []*armnetwork.PublicIPAddress
		wantUnattached int
		checkReport    func(t *testing.T, report cmd.PublicIPReport)
	}{
		{
			name:           "Empty PIP list returns empty report",
			pips:           []*armnetwork.PublicIPAddress{},
			wantUnattached: 0,
			checkReport: func(t *testing.T, report cmd.PublicIPReport) {
				assert.Equal(t, 0, report.Summary.TotalPIPs)
				assert.Equal(t, 0, len(report.Findings))
			},
		},
		{
			name:           "Unattached Standard PIP is Critical",
			pips:           []*armnetwork.PublicIPAddress{pip("pip1", armnetwork.PublicIPAddressSKUNameStandard, static, false)},
			wantUnattached: 1,
			checkReport: func(t *testing.T, report cmd.PublicIPReport) {
				assert.Equal(t, 1, report.Summary.UnattachedPIPs)
				found := false
				for _, f := range report.Findings {
					if f.Category == "Unused Resource" {
						found = true
						assert.Equal(t, cmd.Critical, f.Severity)
						assert.Equal(t, "pip1", f.PIPName)
					}
				}
				assert.True(t, found, "expected Unused Resource Critical finding for Standard PIP")
				assert.Greater(t, report.Summary.EstimatedWasteUSD, 0.0)
			},
		},
		{
			name:           "Unattached Basic PIP is Warning",
			pips:           []*armnetwork.PublicIPAddress{pip("pip1", armnetwork.PublicIPAddressSKUNameBasic, dynamic, false)},
			wantUnattached: 1,
			checkReport: func(t *testing.T, report cmd.PublicIPReport) {
				found := false
				for _, f := range report.Findings {
					if f.Category == "Unused Resource" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
					}
				}
				assert.True(t, found, "expected Unused Resource Warning for Basic PIP")
			},
		},
		{
			name: "Attached Standard PIP does not flag as unused",
			pips: []*armnetwork.PublicIPAddress{pip("pip1", armnetwork.PublicIPAddressSKUNameStandard, static, true)},
			checkReport: func(t *testing.T, report cmd.PublicIPReport) {
				assert.Equal(t, 0, report.Summary.UnattachedPIPs)
				for _, f := range report.Findings {
					assert.NotEqual(t, "Unused Resource", f.Category)
				}
			},
		},
		{
			name: "Basic SKU triggers SKU Upgrade Warning",
			pips: []*armnetwork.PublicIPAddress{pip("pip1", armnetwork.PublicIPAddressSKUNameBasic, dynamic, true)},
			checkReport: func(t *testing.T, report cmd.PublicIPReport) {
				found := false
				for _, f := range report.Findings {
					if f.Category == "SKU Upgrade" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
					}
				}
				assert.True(t, found, "expected SKU Upgrade finding for Basic PIP")
			},
		},
		{
			name: "Standard PIP without availability zones flags availability Info",
			pips: []*armnetwork.PublicIPAddress{pip("pip1", armnetwork.PublicIPAddressSKUNameStandard, static, true)},
			checkReport: func(t *testing.T, report cmd.PublicIPReport) {
				found := false
				for _, f := range report.Findings {
					if f.Category == "Availability" {
						found = true
						assert.Equal(t, cmd.Info, f.Severity)
					}
				}
				assert.True(t, found, "expected Availability finding")
			},
		},
		{
			name: "Summary counts are correct for mixed PIPs",
			pips: []*armnetwork.PublicIPAddress{
				pip("pip1", armnetwork.PublicIPAddressSKUNameStandard, static, true),
				pip("pip2", armnetwork.PublicIPAddressSKUNameStandard, static, false),
				pip("pip3", armnetwork.PublicIPAddressSKUNameBasic, dynamic, true),
			},
			checkReport: func(t *testing.T, report cmd.PublicIPReport) {
				assert.Equal(t, 3, report.Summary.TotalPIPs)
				assert.Equal(t, 1, report.Summary.UnattachedPIPs)
			},
		},
		{
			name: "Finding fields are populated",
			pips: []*armnetwork.PublicIPAddress{pip("mypip", armnetwork.PublicIPAddressSKUNameStandard, static, false)},
			checkReport: func(t *testing.T, report cmd.PublicIPReport) {
				assert.Greater(t, len(report.Findings), 0)
				f := report.Findings[0]
				assert.NotEmpty(t, f.Category)
				assert.NotEmpty(t, f.Description)
				assert.NotEmpty(t, f.Recommendation)
				assert.NotEmpty(t, f.PIPName)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			report := cmd.AnalyzePublicIPs(tt.pips)
			if tt.checkReport != nil {
				tt.checkReport(t, report)
			}
		})
	}
}
