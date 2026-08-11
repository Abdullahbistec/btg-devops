package usage_analyzers_test

import (
	"testing"

	"github.com/chanbistec/btg-devops/cmd"
	"github.com/stretchr/testify/assert"
)

func TestBuildStorageAccountTips_HotTierHighCost(t *testing.T) {
	tips, saving := cmd.BuildStorageAccountTips("Hot", "Standard_LRS", "StorageV2", true, false, "TLS1_2", 20, 0, 3)
	assertContainsTip(t, tips, "Access tier is Hot")
	assert.Greater(t, saving, float64(0))
}

func TestBuildStorageAccountTips_CoolTierNoHotTip(t *testing.T) {
	tips, _ := cmd.BuildStorageAccountTips("Cool", "Standard_LRS", "StorageV2", true, false, "TLS1_2", 20, 0, 3)
	for _, tip := range tips {
		assert.NotContains(t, tip, "Access tier is Hot")
	}
}

func TestBuildStorageAccountTips_GRSHighCost(t *testing.T) {
	tips, saving := cmd.BuildStorageAccountTips("Hot", "Standard_GRS", "StorageV2", true, false, "TLS1_2", 50, 0, 3)
	assertContainsTip(t, tips, "geo-redundant")
	assert.Greater(t, saving, float64(0))
}

func TestBuildStorageAccountTips_LRSHighCost(t *testing.T) {
	tips, _ := cmd.BuildStorageAccountTips("Hot", "Standard_LRS", "StorageV2", true, false, "TLS1_2", 60, 0, 3)
	assertContainsTip(t, tips, "LRS (single region)")
}

func TestBuildStorageAccountTips_LRSLowCostNoTip(t *testing.T) {
	tips, _ := cmd.BuildStorageAccountTips("Hot", "Standard_LRS", "StorageV2", true, false, "TLS1_2", 30, 0, 3)
	for _, tip := range tips {
		assert.NotContains(t, tip, "LRS (single region)")
	}
}

func TestBuildStorageAccountTips_HTTPSNotEnforced(t *testing.T) {
	tips, _ := cmd.BuildStorageAccountTips("Hot", "Standard_LRS", "StorageV2", false, false, "TLS1_2", 20, 0, 3)
	assertContainsTip(t, tips, "HTTPS-only traffic is not enforced")
}

func TestBuildStorageAccountTips_BlobPublicAccessNoContainers(t *testing.T) {
	tips, _ := cmd.BuildStorageAccountTips("Hot", "Standard_LRS", "StorageV2", true, true, "TLS1_2", 20, 0, 3)
	assertContainsTip(t, tips, "AllowBlobPublicAccess is enabled at account level")
}

func TestBuildStorageAccountTips_BlobPublicAccessWithPublicContainers(t *testing.T) {
	tips, _ := cmd.BuildStorageAccountTips("Hot", "Standard_LRS", "StorageV2", true, true, "TLS1_2", 20, 2, 3)
	for _, tip := range tips {
		assert.NotContains(t, tip, "AllowBlobPublicAccess is enabled at account level")
	}
}

func TestBuildStorageAccountTips_OldTLS(t *testing.T) {
	for _, tls := range []string{"TLS1_0", "TLS1_1"} {
		tips, _ := cmd.BuildStorageAccountTips("Hot", "Standard_LRS", "StorageV2", true, false, tls, 20, 0, 3)
		assertContainsTip(t, tips, "Minimum TLS version is "+tls)
	}
}

func TestBuildStorageAccountTips_LifecyclePolicySaving(t *testing.T) {
	_, saving := cmd.BuildStorageAccountTips("Cool", "Standard_LRS", "StorageV2", true, false, "TLS1_2", 20, 0, 3)
	assert.Greater(t, saving, float64(0))
}

func TestBuildStorageAccountTips_LegacyBlobStorage(t *testing.T) {
	tips, _ := cmd.BuildStorageAccountTips("Hot", "Standard_LRS", "BlobStorage", true, false, "TLS1_2", 20, 0, 3)
	assertContainsTip(t, tips, "BlobStorage (legacy)")
}

func TestBuildStorageAccountTips_NoContainersIdle(t *testing.T) {
	tips, saving := cmd.BuildStorageAccountTips("Hot", "Standard_LRS", "StorageV2", true, false, "TLS1_2", 20, 0, 0)
	assertContainsTip(t, tips, "No blob containers found")
	assert.GreaterOrEqual(t, saving, float64(20))
}

func TestBuildStorageAccountTips_HealthyAccount(t *testing.T) {
	tips, _ := cmd.BuildStorageAccountTips("Cool", "Standard_LRS", "StorageV2", true, false, "TLS1_2", 5, 0, 3)
	assert.Empty(t, tips)
}
