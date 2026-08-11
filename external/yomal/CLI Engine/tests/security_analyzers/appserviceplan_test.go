package security_analyzers_test

import (
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/appservice/armappservice/v2"
	"github.com/chanbistec/btg-devops/cmd"
	"github.com/stretchr/testify/assert"
)

func aspPlan(name, skuName, skuTier string, capacity int32) *armappservice.Plan {
	id := "/subscriptions/sub/resourceGroups/rg-test/providers/Microsoft.Web/serverfarms/" + name
	return &armappservice.Plan{
		Name: strPtr(name),
		ID:   strPtr(id),
		SKU: &armappservice.SKUDescription{
			Name:     strPtr(skuName),
			Tier:     strPtr(skuTier),
			Capacity: &capacity,
		},
		Properties: &armappservice.PlanProperties{},
	}
}

func TestAnalyzeASPsData(t *testing.T) {
	tests := []struct {
		name         string
		plans        []*armappservice.Plan
		planAppCount map[string]int
		checkReport  func(t *testing.T, report cmd.ASPReport)
	}{
		{
			name:  "Empty plan list",
			plans: []*armappservice.Plan{},
			checkReport: func(t *testing.T, report cmd.ASPReport) {
				assert.Equal(t, 0, report.Summary.TotalPlans)
				assert.Equal(t, 0, len(report.Findings))
			},
		},
		{
			name:         "Empty plan with paid SKU is Critical",
			plans:        []*armappservice.Plan{aspPlan("plan1", "S1", "Standard", 1)},
			planAppCount: map[string]int{},
			checkReport: func(t *testing.T, report cmd.ASPReport) {
				assert.Equal(t, 1, report.Summary.EmptyPlans)
				found := false
				for _, f := range report.Findings {
					if f.Category == "Empty Plan" {
						found = true
						assert.Equal(t, cmd.Critical, f.Severity)
						assert.Equal(t, "plan1", f.PlanName)
					}
				}
				assert.True(t, found, "expected Empty Plan Critical finding")
			},
		},
		{
			name:         "Empty plan with Free SKU is Info",
			plans:        []*armappservice.Plan{aspPlan("plan1", "F1", "Free", 1)},
			planAppCount: map[string]int{},
			checkReport: func(t *testing.T, report cmd.ASPReport) {
				found := false
				for _, f := range report.Findings {
					if f.Category == "Empty Plan" {
						found = true
						assert.Equal(t, cmd.Info, f.Severity)
					}
				}
				assert.True(t, found, "expected Empty Plan Info finding for Free SKU")
			},
		},
		{
			name:  "Premium plan with 1 app is Info (SKU right-sizing)",
			plans: []*armappservice.Plan{aspPlan("plan1", "P1V3", "PremiumV3", 1)},
			planAppCount: map[string]int{
				"/subscriptions/sub/resourcegroups/rg-test/providers/microsoft.web/serverfarms/plan1": 1,
			},
			checkReport: func(t *testing.T, report cmd.ASPReport) {
				found := false
				for _, f := range report.Findings {
					if f.Category == "SKU Right-Sizing" {
						found = true
						assert.Equal(t, cmd.Info, f.Severity)
					}
				}
				assert.True(t, found, "expected SKU Right-Sizing finding")
			},
		},
		{
			name:  "Free tier plan with apps is Warning (No SLA)",
			plans: []*armappservice.Plan{aspPlan("plan1", "F1", "Free", 1)},
			planAppCount: map[string]int{
				"/subscriptions/sub/resourcegroups/rg-test/providers/microsoft.web/serverfarms/plan1": 2,
			},
			checkReport: func(t *testing.T, report cmd.ASPReport) {
				found := false
				for _, f := range report.Findings {
					if f.Category == "No SLA" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
					}
				}
				assert.True(t, found, "expected No SLA finding for Free tier")
			},
		},
		{
			name:  "Plan with 4 or more workers flags Autoscale Info",
			plans: []*armappservice.Plan{aspPlan("plan1", "S2", "Standard", 4)},
			planAppCount: map[string]int{
				"/subscriptions/sub/resourcegroups/rg-test/providers/microsoft.web/serverfarms/plan1": 1,
			},
			checkReport: func(t *testing.T, report cmd.ASPReport) {
				found := false
				for _, f := range report.Findings {
					if f.Category == "Autoscale" {
						found = true
						assert.Equal(t, cmd.Info, f.Severity)
					}
				}
				assert.True(t, found, "expected Autoscale finding for high worker count")
			},
		},
		{
			name:         "Estimated waste is calculated for empty paid plan",
			plans:        []*armappservice.Plan{aspPlan("plan1", "S1", "Standard", 1)},
			planAppCount: map[string]int{},
			checkReport: func(t *testing.T, report cmd.ASPReport) {
				assert.Greater(t, report.Summary.EstimatedWasteUSD, 0.0)
			},
		},
		{
			name: "SKU breakdown is populated",
			plans: []*armappservice.Plan{
				aspPlan("plan1", "S1", "Standard", 1),
				aspPlan("plan2", "P1V3", "PremiumV3", 1),
			},
			planAppCount: map[string]int{},
			checkReport: func(t *testing.T, report cmd.ASPReport) {
				assert.Equal(t, 2, report.Summary.TotalPlans)
				assert.Equal(t, 1, report.Summary.BySKU["S1"])
				assert.Equal(t, 1, report.Summary.BySKU["P1V3"])
			},
		},
		{
			name:         "Finding fields are populated",
			plans:        []*armappservice.Plan{aspPlan("myplan", "S2", "Standard", 1)},
			planAppCount: map[string]int{},
			checkReport: func(t *testing.T, report cmd.ASPReport) {
				assert.Greater(t, len(report.Findings), 0)
				f := report.Findings[0]
				assert.Equal(t, "myplan", f.PlanName)
				assert.NotEmpty(t, f.Description)
				assert.NotEmpty(t, f.Recommendation)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			report := cmd.AnalyzeASPsData(tt.plans, tt.planAppCount)
			if tt.checkReport != nil {
				tt.checkReport(t, report)
			}
		})
	}
}
