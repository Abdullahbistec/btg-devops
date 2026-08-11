package usage_analyzers_test

import (
	"testing"

	"github.com/chanbistec/btg-devops/cmd"
	"github.com/stretchr/testify/assert"
)

func TestBuildKeyVaultUsageTips_PremiumSKU(t *testing.T) {
	tips, saving := cmd.BuildKeyVaultUsageTips("premium", true, true, true, 14, "Deny", "Disabled", 50, nil)
	assertContainsTip(t, tips, "Premium (HSM) SKU")
	assert.Greater(t, saving, float64(0))
}

func TestBuildKeyVaultUsageTips_StandardSKUNoHSMTip(t *testing.T) {
	tips, _ := cmd.BuildKeyVaultUsageTips("standard", true, true, true, 14, "Deny", "Disabled", 50, nil)
	for _, tip := range tips {
		assert.NotContains(t, tip, "HSM")
	}
}

func TestBuildKeyVaultUsageTips_SoftDeleteDisabled(t *testing.T) {
	tips, _ := cmd.BuildKeyVaultUsageTips("standard", false, true, true, 90, "Deny", "Disabled", 10, nil)
	assertContainsTip(t, tips, "Soft delete is disabled")
}

func TestBuildKeyVaultUsageTips_LongRetention(t *testing.T) {
	tips, _ := cmd.BuildKeyVaultUsageTips("standard", true, true, true, 90, "Deny", "Disabled", 10, nil)
	assertContainsTip(t, tips, "Soft-delete retention is 90 days")
}

func TestBuildKeyVaultUsageTips_ShortRetentionNoTip(t *testing.T) {
	tips, _ := cmd.BuildKeyVaultUsageTips("standard", true, true, true, 14, "Deny", "Disabled", 10, nil)
	for _, tip := range tips {
		assert.NotContains(t, tip, "retention")
	}
}

func TestBuildKeyVaultUsageTips_NoPurgeProtection(t *testing.T) {
	tips, _ := cmd.BuildKeyVaultUsageTips("standard", true, false, true, 14, "Deny", "Disabled", 10, nil)
	assertContainsTip(t, tips, "Purge protection is disabled")
}

func TestBuildKeyVaultUsageTips_LegacyAccessPolicies(t *testing.T) {
	tips, _ := cmd.BuildKeyVaultUsageTips("standard", true, true, false, 14, "Deny", "Disabled", 10, nil)
	assertContainsTip(t, tips, "legacy Vault Access Policies")
}

func TestBuildKeyVaultUsageTips_NetworkAllowAll(t *testing.T) {
	tips, _ := cmd.BuildKeyVaultUsageTips("standard", true, true, true, 14, "Allow", "Disabled", 10, nil)
	assertContainsTip(t, tips, "Network ACL default action is Allow")
}

func TestBuildKeyVaultUsageTips_PublicAndAllow(t *testing.T) {
	tips, _ := cmd.BuildKeyVaultUsageTips("standard", true, true, true, 14, "Allow", "Enabled", 10, nil)
	assertContainsTip(t, tips, "Public network access is fully open")
}

func TestBuildKeyVaultUsageTips_HighOperationsMeter(t *testing.T) {
	meters := []cmd.MeterCost{{Name: "Operations", Cost: 8}}
	tips, _ := cmd.BuildKeyVaultUsageTips("standard", true, true, true, 14, "Deny", "Disabled", 20, meters)
	assertContainsTip(t, tips, "High operation cost")
}

func TestBuildKeyVaultUsageTips_VeryLowCostIdle(t *testing.T) {
	tips, _ := cmd.BuildKeyVaultUsageTips("standard", true, true, true, 14, "Deny", "Disabled", 0.5, nil)
	assertContainsTip(t, tips, "Very low cost")
}

func TestBuildKeyVaultUsageTips_ZeroCost(t *testing.T) {
	tips, _ := cmd.BuildKeyVaultUsageTips("standard", true, true, true, 14, "Deny", "Disabled", 0, nil)
	assertContainsTip(t, tips, "Zero cost in the period")
}

func TestBuildKeyVaultUsageTips_StandardHighCost(t *testing.T) {
	tips, _ := cmd.BuildKeyVaultUsageTips("standard", true, true, true, 14, "Deny", "Disabled", 80, nil)
	assertContainsTip(t, tips, "High operation volume")
}

func TestBuildKeyVaultUsageTips_HealthyVault(t *testing.T) {
	tips, saving := cmd.BuildKeyVaultUsageTips("standard", true, true, true, 14, "Deny", "Disabled", 10, nil)
	assert.Empty(t, tips)
	assert.Equal(t, float64(0), saving)
}
