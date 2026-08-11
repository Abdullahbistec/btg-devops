package usage_analyzers_test

import (
	"testing"

	"github.com/chanbistec/btg-devops/cmd"
	"github.com/stretchr/testify/assert"
)

func TestBuildPublicIPUsageTips_UnattachedIP(t *testing.T) {
	tips, saving := cmd.BuildPublicIPUsageTips(false, "Static", "Standard", false, 4, "IPv4", "rg-test", 10, nil)
	assertContainsTip(t, tips, "IP is not attached")
	assert.GreaterOrEqual(t, saving, float64(10))
}

func TestBuildPublicIPUsageTips_AttachedIPNoUnattachedTip(t *testing.T) {
	tips, _ := cmd.BuildPublicIPUsageTips(true, "Static", "Standard", false, 4, "IPv4", "rg-test", 10, nil)
	for _, tip := range tips {
		assert.NotContains(t, tip, "not attached to any resource")
	}
}

func TestBuildPublicIPUsageTips_StaticUnattachedExtraTip(t *testing.T) {
	tips, _ := cmd.BuildPublicIPUsageTips(false, "Static", "Standard", false, 4, "IPv4", "rg-test", 10, nil)
	assertContainsTip(t, tips, "Static IP reserved but unattached")
}

func TestBuildPublicIPUsageTips_DynamicUnattachedNoStaticTip(t *testing.T) {
	tips, _ := cmd.BuildPublicIPUsageTips(false, "Dynamic", "Standard", false, 4, "IPv4", "rg-test", 10, nil)
	for _, tip := range tips {
		assert.NotContains(t, tip, "static IPs cost more than dynamic")
	}
}

func TestBuildPublicIPUsageTips_BasicSKUAttached(t *testing.T) {
	tips, _ := cmd.BuildPublicIPUsageTips(true, "Dynamic", "Basic", false, 4, "IPv4", "rg-test", 10, nil)
	assertContainsTip(t, tips, "Basic SKU Public IP has no zone redundancy")
}

func TestBuildPublicIPUsageTips_StandardNoDDoSHighCost(t *testing.T) {
	tips, _ := cmd.BuildPublicIPUsageTips(true, "Static", "Standard", false, 4, "IPv4", "rg-test", 10, nil)
	assertContainsTip(t, tips, "no DDoS protection")
}

func TestBuildPublicIPUsageTips_StandardDDoSEnabled(t *testing.T) {
	tips, _ := cmd.BuildPublicIPUsageTips(true, "Static", "Standard", true, 4, "IPv4", "rg-test", 10, nil)
	for _, tip := range tips {
		assert.NotContains(t, tip, "DDoS protection")
	}
}

func TestBuildPublicIPUsageTips_HighIdleTimeout(t *testing.T) {
	tips, _ := cmd.BuildPublicIPUsageTips(true, "Static", "Standard", true, 15, "IPv4", "rg-test", 10, nil)
	assertContainsTip(t, tips, "Idle timeout is 15 minutes")
}

func TestBuildPublicIPUsageTips_IPv4StandardDualStackTip(t *testing.T) {
	tips, _ := cmd.BuildPublicIPUsageTips(true, "Static", "Standard", true, 4, "IPv4", "rg-test", 10, nil)
	assertContainsTip(t, tips, "IPv6")
}

func TestBuildPublicIPUsageTips_HighDataTransfer(t *testing.T) {
	meters := []cmd.MeterCost{{Name: "Data Transfer", Cost: 30}}
	tips, saving := cmd.BuildPublicIPUsageTips(true, "Static", "Standard", true, 4, "IPv4", "rg-test", 10, meters)
	assertContainsTip(t, tips, "High data transfer cost")
	assert.Greater(t, saving, float64(0))
}

func TestBuildPublicIPUsageTips_ZeroCostAttached(t *testing.T) {
	tips, _ := cmd.BuildPublicIPUsageTips(true, "Static", "Standard", true, 4, "IPv4", "rg-test", 0, nil)
	assertContainsTip(t, tips, "Zero cost despite being attached")
}

func TestBuildPublicIPUsageTips_BasicHighCost(t *testing.T) {
	tips, _ := cmd.BuildPublicIPUsageTips(true, "Dynamic", "Basic", false, 4, "IPv4", "rg-test", 15, nil)
	assertContainsTip(t, tips, "availability zones")
}

func TestBuildPublicIPUsageTips_UnattachedAuditTip(t *testing.T) {
	tips, _ := cmd.BuildPublicIPUsageTips(false, "Dynamic", "Standard", false, 4, "IPv4", "rg-test", 5, nil)
	assertContainsTip(t, tips, "audit all Public IPs")
}

func TestBuildPublicIPUsageTips_StaticBasicRetirement(t *testing.T) {
	tips, _ := cmd.BuildPublicIPUsageTips(false, "Static", "Basic", false, 4, "IPv4", "rg-test", 10, nil)
	assertContainsTip(t, tips, "being retired")
}
