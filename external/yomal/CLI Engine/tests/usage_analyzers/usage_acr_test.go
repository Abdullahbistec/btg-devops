package usage_analyzers_test

import (
	"strings"
	"testing"

	"github.com/chanbistec/btg-devops/cmd"
	"github.com/stretchr/testify/assert"
)

func TestBuildACRUsageTips_StandardSKUNoFindings(t *testing.T) {
	tips, saving := cmd.BuildACRUsageTips("Standard", false, "Disabled", "Enabled", 2, 60, nil)
	for _, tip := range tips {
		assert.NotContains(t, tip, "Premium")
	}
	assert.Equal(t, float64(0), saving)
}

func TestBuildACRUsageTips_PremiumLowCost(t *testing.T) {
	tips, saving := cmd.BuildACRUsageTips("Premium", false, "Disabled", "Enabled", 2, 30, nil)
	assertContainsTip(t, tips, "Premium SKU at low cost")
	assert.Greater(t, saving, float64(0))
}

func TestBuildACRUsageTips_PremiumHighCostNoDowngrade(t *testing.T) {
	tips, _ := cmd.BuildACRUsageTips("Premium", false, "Disabled", "Enabled", 3, 100, nil)
	for _, tip := range tips {
		assert.NotContains(t, tip, "downgrade to Standard (~45%")
	}
}

func TestBuildACRUsageTips_BasicSKUHighCost(t *testing.T) {
	tips, _ := cmd.BuildACRUsageTips("Basic", false, "Disabled", "Enabled", 0, 20, nil)
	assertContainsTip(t, tips, "Basic SKU has limited storage")
}

func TestBuildACRUsageTips_BasicSKULowCostNoTip(t *testing.T) {
	tips, _ := cmd.BuildACRUsageTips("Basic", false, "Disabled", "Enabled", 0, 5, nil)
	for _, tip := range tips {
		assert.NotContains(t, tip, "Basic SKU has limited storage")
	}
}

func TestBuildACRUsageTips_AdminEnabled(t *testing.T) {
	tips, _ := cmd.BuildACRUsageTips("Standard", true, "Disabled", "Enabled", 0, 20, nil)
	assertContainsTip(t, tips, "Admin user is enabled")
}

func TestBuildACRUsageTips_PublicAccessEnabled(t *testing.T) {
	tips, _ := cmd.BuildACRUsageTips("Standard", false, "Enabled", "Enabled", 0, 20, nil)
	assertContainsTip(t, tips, "Public network access is open")
}

func TestBuildACRUsageTips_PremiumNoGeoReplications(t *testing.T) {
	tips, saving := cmd.BuildACRUsageTips("Premium", false, "Disabled", "Enabled", 1, 60, nil)
	assertContainsTip(t, tips, "Premium SKU with no geo-replications")
	assert.Greater(t, saving, float64(0))
}

func TestBuildACRUsageTips_PremiumWithReplications(t *testing.T) {
	tips, _ := cmd.BuildACRUsageTips("Premium", false, "Disabled", "Enabled", 3, 60, nil)
	for _, tip := range tips {
		assert.NotContains(t, tip, "no geo-replications")
	}
}

func TestBuildACRUsageTips_PremiumZoneRedundancyDisabled(t *testing.T) {
	tips, _ := cmd.BuildACRUsageTips("Premium", false, "Disabled", "Disabled", 3, 60, nil)
	assertContainsTip(t, tips, "Zone redundancy is disabled on Premium SKU")
}

func TestBuildACRUsageTips_HighStorageMeter(t *testing.T) {
	meters := []cmd.MeterCost{{Name: "Storage", Cost: 25}}
	tips, _ := cmd.BuildACRUsageTips("Standard", false, "Disabled", "Enabled", 0, 30, meters)
	assertContainsTip(t, tips, "High storage cost")
}

func TestBuildACRUsageTips_HighBuildMeter(t *testing.T) {
	meters := []cmd.MeterCost{{Name: "Build", Cost: 15}}
	tips, _ := cmd.BuildACRUsageTips("Standard", false, "Disabled", "Enabled", 0, 30, meters)
	assertContainsTip(t, tips, "ACR Tasks build cost")
}

func TestBuildACRUsageTips_ZeroCostIdle(t *testing.T) {
	tips, _ := cmd.BuildACRUsageTips("Standard", false, "Disabled", "Enabled", 0, 0, nil)
	assertContainsTip(t, tips, "Zero cost")
}

func TestBuildACRUsageTips_PremiumNearZeroActivity(t *testing.T) {
	tips, saving := cmd.BuildACRUsageTips("Premium", false, "Disabled", "Enabled", 2, 3, nil)
	assertContainsTip(t, tips, "near-zero activity")
	assert.Greater(t, saving, float64(0))
}

// assertContainsTip asserts that at least one tip in the slice contains substr.
func assertContainsTip(t *testing.T, tips []string, substr string) {
	t.Helper()
	for _, tip := range tips {
		if strings.Contains(tip, substr) {
			return
		}
	}
	t.Errorf("expected a tip containing %q, got: %v", substr, tips)
}
