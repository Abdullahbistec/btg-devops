package usage_analyzers_test

import (
	"testing"

	"github.com/chanbistec/btg-devops/cmd"
	"github.com/stretchr/testify/assert"
)

func TestBuildFunctionsUsageTips_DedicatedPlanHighCost(t *testing.T) {
	for _, sku := range []string{"S1", "S2", "S3", "P1v2", "P1v3"} {
		tips, saving := cmd.BuildFunctionsUsageTips(sku, "Running", true, false, false, "1.2", 50)
		assertContainsTip(t, tips, "dedicated")
		assert.Greater(t, saving, float64(0), "sku=%s", sku)
	}
}

func TestBuildFunctionsUsageTips_DedicatedPlanLowCostNoTip(t *testing.T) {
	tips, _ := cmd.BuildFunctionsUsageTips("S1", "Running", true, false, false, "1.2", 20)
	for _, tip := range tips {
		assert.NotContains(t, tip, "dedicated")
	}
}

func TestBuildFunctionsUsageTips_ElasticPremiumHighCost(t *testing.T) {
	for _, sku := range []string{"EP1", "EP2", "EP3"} {
		tips, saving := cmd.BuildFunctionsUsageTips(sku, "Running", true, false, false, "1.2", 100)
		assertContainsTip(t, tips, "Elastic Premium")
		assert.Greater(t, saving, float64(0), "sku=%s", sku)
	}
}

func TestBuildFunctionsUsageTips_ConsumptionAlwaysOnEnabled(t *testing.T) {
	tips, _ := cmd.BuildFunctionsUsageTips("Y1", "Running", true, true, false, "1.2", 10)
	assertContainsTip(t, tips, "Always On is enabled on a Consumption")
}

func TestBuildFunctionsUsageTips_StoppedApp(t *testing.T) {
	tips, saving := cmd.BuildFunctionsUsageTips("EP1", "Stopped", true, false, false, "1.2", 50)
	assertContainsTip(t, tips, "Function app is stopped")
	assert.GreaterOrEqual(t, saving, float64(50))
}

func TestBuildFunctionsUsageTips_HTTPSNotEnforced(t *testing.T) {
	tips, _ := cmd.BuildFunctionsUsageTips("Y1", "Running", false, false, false, "1.2", 10)
	assertContainsTip(t, tips, "HTTPS-only is not enforced")
}

func TestBuildFunctionsUsageTips_OldTLS(t *testing.T) {
	tips, _ := cmd.BuildFunctionsUsageTips("Y1", "Running", true, false, false, "1.0", 10)
	assertContainsTip(t, tips, "Minimum TLS version is 1.0")
}

func TestBuildFunctionsUsageTips_RemoteDebugging(t *testing.T) {
	tips, _ := cmd.BuildFunctionsUsageTips("Y1", "Running", true, false, true, "1.2", 10)
	assertContainsTip(t, tips, "Remote debugging is enabled")
}

func TestBuildFunctionsUsageTips_ConsumptionHighCost(t *testing.T) {
	tips, _ := cmd.BuildFunctionsUsageTips("Y1", "Running", true, false, false, "1.2", 30)
	assertContainsTip(t, tips, "High Consumption plan cost")
}

func TestBuildFunctionsUsageTips_ZeroCost(t *testing.T) {
	tips, _ := cmd.BuildFunctionsUsageTips("Y1", "Running", true, false, false, "1.2", 0)
	assertContainsTip(t, tips, "Zero cost")
}

func TestBuildFunctionsUsageTips_ElasticPremiumNearZero(t *testing.T) {
	tips, saving := cmd.BuildFunctionsUsageTips("EP1", "Running", true, false, false, "1.2", 3)
	assertContainsTip(t, tips, "near-zero activity")
	assert.Greater(t, saving, float64(0))
}

func TestBuildFunctionsUsageTips_ConsumptionHealthy(t *testing.T) {
	tips, saving := cmd.BuildFunctionsUsageTips("Y1", "Running", true, false, false, "1.2", 15)
	assert.Empty(t, tips)
	assert.Equal(t, float64(0), saving)
}
