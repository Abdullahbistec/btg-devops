package usage_analyzers_test

import (
	"testing"

	"github.com/chanbistec/btg-devops/cmd"
	"github.com/stretchr/testify/assert"
)

// ─── Database-level tips ───────────────────────────────────────────────────

func TestBuildCosmosDatabaseTips_HighFixedRU(t *testing.T) {
	tips, saving := cmd.BuildCosmosDatabaseTips(5000, false, 80)
	assertContainsTip(t, tips, "High fixed RU/s without autoscale")
	assert.Greater(t, saving, float64(0))
}

func TestBuildCosmosDatabaseTips_HighFixedRUWithAutoscaleNoTip(t *testing.T) {
	tips, _ := cmd.BuildCosmosDatabaseTips(5000, true, 80)
	for _, tip := range tips {
		assert.NotContains(t, tip, "High fixed RU/s without autoscale")
	}
}

func TestBuildCosmosDatabaseTips_VeryHighRU(t *testing.T) {
	tips, saving := cmd.BuildCosmosDatabaseTips(15000, false, 200)
	assertContainsTip(t, tips, "Very high provisioned throughput")
	assert.Greater(t, saving, float64(0))
}

func TestBuildCosmosDatabaseTips_MinimumRU(t *testing.T) {
	tips, saving := cmd.BuildCosmosDatabaseTips(400, false, 10)
	assertContainsTip(t, tips, "minimum 400 RU/s")
	assert.Greater(t, saving, float64(0))
}

func TestBuildCosmosDatabaseTips_MinimumRULowCostNoTip(t *testing.T) {
	tips, _ := cmd.BuildCosmosDatabaseTips(400, false, 3)
	for _, tip := range tips {
		assert.NotContains(t, tip, "minimum 400 RU/s")
	}
}

func TestBuildCosmosDatabaseTips_AutoscaleMaxTooHigh(t *testing.T) {
	tips, saving := cmd.BuildCosmosDatabaseTips(25000, true, 150)
	assertContainsTip(t, tips, "Autoscale max set to")
	assert.Greater(t, saving, float64(0))
}

func TestBuildCosmosDatabaseTips_HighCostDB(t *testing.T) {
	tips, _ := cmd.BuildCosmosDatabaseTips(2000, false, 120)
	assertContainsTip(t, tips, "High monthly cost")
}

func TestBuildCosmosDatabaseTips_NormalRU(t *testing.T) {
	tips, saving := cmd.BuildCosmosDatabaseTips(1000, false, 20)
	assert.Empty(t, tips)
	assert.Equal(t, float64(0), saving)
}

// ─── Account-level tips ────────────────────────────────────────────────────

func TestBuildCosmosAccountTips_StrongConsistency(t *testing.T) {
	tips, saving := cmd.BuildCosmosAccountTips("Strong", 1, "configured", true, 50, 1)
	assertContainsTip(t, tips, "Strong consistency")
	assert.Greater(t, saving, float64(0))
}

func TestBuildCosmosAccountTips_SessionConsistencyNoTip(t *testing.T) {
	tips, _ := cmd.BuildCosmosAccountTips("Session", 1, "configured", true, 50, 1)
	for _, tip := range tips {
		assert.NotContains(t, tip, "consistency")
	}
}

func TestBuildCosmosAccountTips_MultiRegion(t *testing.T) {
	tips, saving := cmd.BuildCosmosAccountTips("Session", 4, "configured", true, 100, 2)
	assertContainsTip(t, tips, "regions")
	assert.Greater(t, saving, float64(0))
}

func TestBuildCosmosAccountTips_TwoRegionsNoTip(t *testing.T) {
	tips, _ := cmd.BuildCosmosAccountTips("Session", 2, "configured", true, 100, 2)
	for _, tip := range tips {
		assert.NotContains(t, tip, "regions")
	}
}

func TestBuildCosmosAccountTips_NoBackupPolicy(t *testing.T) {
	tips, _ := cmd.BuildCosmosAccountTips("Session", 1, "none", true, 50, 1)
	assertContainsTip(t, tips, "No backup policy")
}

func TestBuildCosmosAccountTips_FreeTierNotEnabled(t *testing.T) {
	tips, saving := cmd.BuildCosmosAccountTips("Session", 1, "configured", false, 20, 1)
	assertContainsTip(t, tips, "Free tier not enabled")
	assert.Equal(t, float64(25), saving)
}

func TestBuildCosmosAccountTips_FreeTierAlreadyEnabled(t *testing.T) {
	tips, _ := cmd.BuildCosmosAccountTips("Session", 1, "configured", true, 20, 1)
	for _, tip := range tips {
		assert.NotContains(t, tip, "Free tier not enabled")
	}
}

func TestBuildCosmosAccountTips_NoDatabases(t *testing.T) {
	tips, saving := cmd.BuildCosmosAccountTips("Session", 1, "configured", true, 50, 0)
	assertContainsTip(t, tips, "No SQL databases found")
	assert.Equal(t, float64(50), saving)
}

func TestBuildCosmosAccountTips_HealthyAccount(t *testing.T) {
	tips, saving := cmd.BuildCosmosAccountTips("Session", 2, "configured", true, 50, 2)
	assert.Empty(t, tips)
	assert.Equal(t, float64(0), saving)
}
