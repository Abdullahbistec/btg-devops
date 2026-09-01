package cmd

import (
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/appservice/armappservice/v2"
)

// This test exercises AnalyzeASPsData, the pure analyzer function that runs
// App Service Plan checks against pre-fetched data — no Azure calls, matching
// the existing acr_test.go / appservice_traffic_test.go style.

func TestAnalyzeASPsData_EmptyPlanFinding(t *testing.T) {
	planID := "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Web/serverfarms/plan1"
	planName := "plan1"
	skuName := "S1"
	skuTier := "Standard"

	plans := []*armappservice.Plan{
		{
			ID:   &planID,
			Name: &planName,
			SKU: &armappservice.SKUDescription{
				Name: &skuName,
				Tier: &skuTier,
			},
		},
	}
	planAppCount := map[string]int{} // no apps assigned to plan1

	report := AnalyzeASPsData(plans, planAppCount)

	found := false
	for _, f := range report.Findings {
		if f.Category == "Empty Plan" {
			found = true
			if f.Severity != Critical {
				t.Errorf("expected Critical severity for empty Standard-tier plan, got %v", f.Severity)
			}
		}
	}
	if !found {
		t.Error("expected an Empty Plan finding for a plan with zero apps, got none")
	}
}

func TestAnalyzeASPsData_NoEmptyPlanFindingWhenAppsPresent(t *testing.T) {
	planID := "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Web/serverfarms/plan2"
	planName := "plan2"
	skuName := "S1"
	skuTier := "Standard"

	plans := []*armappservice.Plan{
		{
			ID:   &planID,
			Name: &planName,
			SKU: &armappservice.SKUDescription{
				Name: &skuName,
				Tier: &skuTier,
			},
		},
	}
	planAppCount := map[string]int{
		"/subscriptions/sub1/resourcegroups/rg1/providers/microsoft.web/serverfarms/plan2": 3,
	}

	report := AnalyzeASPsData(plans, planAppCount)

	for _, f := range report.Findings {
		if f.Category == "Empty Plan" {
			t.Errorf("did not expect an Empty Plan finding when apps are assigned, got: %+v", f)
		}
	}
}
