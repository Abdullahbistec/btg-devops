package usage_analyzers_test

import (
	"testing"

	"github.com/chanbistec/btg-devops/cmd"
	"github.com/stretchr/testify/assert"
)

func TestBuildASPUsageTips_OldPv2SKU(t *testing.T) {
	for _, sku := range []string{"P1v2", "P2v2", "P3v2"} {
		tips, saving := cmd.BuildASPUsageTips(sku, "PremiumV2", 2, 5, 2, 0, 0, 100)
		assertContainsTip(t, tips, "older generation")
		assert.Greater(t, saving, float64(0), "sku=%s should have saving", sku)
	}
}

func TestBuildASPUsageTips_NewPv3SKUNoUpgradeTip(t *testing.T) {
	tips, _ := cmd.BuildASPUsageTips("P1v3", "PremiumV3", 2, 5, 2, 0, 0, 100)
	for _, tip := range tips {
		assert.NotContains(t, tip, "older generation")
	}
}

func TestBuildASPUsageTips_StoppedApps(t *testing.T) {
	tips, _ := cmd.BuildASPUsageTips("S1", "Standard", 2, 5, 3, 2, 0, 80)
	assertContainsTip(t, tips, "stopped app(s)")
}

func TestBuildASPUsageTips_OverScaledWorkers(t *testing.T) {
	tips, saving := cmd.BuildASPUsageTips("S2", "Standard", 5, 10, 2, 0, 0, 200)
	assertContainsTip(t, tips, "worker instances but only")
	assert.Greater(t, saving, float64(0))
}

func TestBuildASPUsageTips_WorkersNotOverScaled(t *testing.T) {
	tips, _ := cmd.BuildASPUsageTips("S2", "Standard", 2, 5, 3, 0, 0, 100)
	for _, tip := range tips {
		assert.NotContains(t, tip, "worker instances but only")
	}
}

func TestBuildASPUsageTips_IdlePlan(t *testing.T) {
	tips, saving := cmd.BuildASPUsageTips("S1", "Standard", 1, 5, 0, 0, 0, 100)
	assertContainsTip(t, tips, "plan is completely idle")
	assert.Equal(t, float64(100), saving)
}

func TestBuildASPUsageTips_SingleAppOnPremiumHighCost(t *testing.T) {
	tips, saving := cmd.BuildASPUsageTips("P1v3", "PremiumV3", 1, 5, 1, 0, 0, 150)
	assertContainsTip(t, tips, "Only 1 app on")
	assert.Greater(t, saving, float64(0))
}

func TestBuildASPUsageTips_SingleAppPremiumLowCostNoTip(t *testing.T) {
	tips, _ := cmd.BuildASPUsageTips("P1v3", "PremiumV3", 1, 5, 1, 0, 0, 50)
	for _, tip := range tips {
		assert.NotContains(t, tip, "Only 1 app on")
	}
}

func TestBuildASPUsageTips_MaxWorkersHighCurrentLow(t *testing.T) {
	tips, _ := cmd.BuildASPUsageTips("S2", "Standard", 2, 15, 2, 0, 0, 100)
	assertContainsTip(t, tips, "Autoscale max set to")
}

func TestBuildASPUsageTips_FreeSharedTier(t *testing.T) {
	for _, sku := range []string{"F1", "D1"} {
		tips, _ := cmd.BuildASPUsageTips(sku, "Free", 1, 1, 1, 0, 0, 0)
		assertContainsTip(t, tips, "Free/Shared")
	}
}

func TestBuildASPUsageTips_BasicTierManyApps(t *testing.T) {
	tips, _ := cmd.BuildASPUsageTips("B2", "Basic", 1, 5, 3, 0, 0, 80)
	assertContainsTip(t, tips, "Basic tier does not support autoscale")
}

func TestBuildASPUsageTips_SavingCalculation(t *testing.T) {
	_, saving := cmd.BuildASPUsageTips("P1v2", "PremiumV2", 2, 5, 0, 0, 0, 100)
	// Idle plan (saving += 100) + P1v2 old gen (saving += 40)
	assert.Equal(t, float64(140), saving)
}
