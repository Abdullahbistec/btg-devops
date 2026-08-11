package usage_analyzers_test

import (
	"testing"

	"github.com/chanbistec/btg-devops/cmd"
	"github.com/stretchr/testify/assert"
)

func TestBuildAppServiceUsageTips_StoppedApp(t *testing.T) {
	tips, saving := cmd.BuildAppServiceUsageTips("Stopped", true, true, true, true, false, "1.2", "plan1", 50, nil)
	assertContainsTip(t, tips, "App is stopped")
	assert.Equal(t, float64(50), saving)
}

func TestBuildAppServiceUsageTips_RunningNoIssues(t *testing.T) {
	tips, saving := cmd.BuildAppServiceUsageTips("Running", true, true, true, true, false, "1.2", "plan1", 50, nil)
	assert.Empty(t, tips)
	assert.Equal(t, float64(0), saving)
}

func TestBuildAppServiceUsageTips_HTTPSNotEnforced(t *testing.T) {
	tips, _ := cmd.BuildAppServiceUsageTips("Running", false, true, true, true, false, "1.2", "plan1", 50, nil)
	assertContainsTip(t, tips, "HTTPS-only is not enforced")
}

func TestBuildAppServiceUsageTips_OldTLS10(t *testing.T) {
	tips, _ := cmd.BuildAppServiceUsageTips("Running", true, true, true, true, false, "1.0", "plan1", 50, nil)
	assertContainsTip(t, tips, "Minimum TLS version is 1.0")
}

func TestBuildAppServiceUsageTips_OldTLS11(t *testing.T) {
	tips, _ := cmd.BuildAppServiceUsageTips("Running", true, true, true, true, false, "1.1", "plan1", 50, nil)
	assertContainsTip(t, tips, "Minimum TLS version is 1.1")
}

func TestBuildAppServiceUsageTips_TLS12NoTip(t *testing.T) {
	tips, _ := cmd.BuildAppServiceUsageTips("Running", true, true, true, true, false, "1.2", "plan1", 50, nil)
	for _, tip := range tips {
		assert.NotContains(t, tip, "TLS version")
	}
}

func TestBuildAppServiceUsageTips_RemoteDebugging(t *testing.T) {
	tips, _ := cmd.BuildAppServiceUsageTips("Running", true, true, true, true, true, "1.2", "plan1", 50, nil)
	assertContainsTip(t, tips, "Remote debugging is enabled")
}

func TestBuildAppServiceUsageTips_AlwaysOnDisabledHighCost(t *testing.T) {
	tips, _ := cmd.BuildAppServiceUsageTips("Running", true, true, false, true, false, "1.2", "plan1", 50, nil)
	assertContainsTip(t, tips, "Always On is disabled")
}

func TestBuildAppServiceUsageTips_AlwaysOnDisabledLowCostNoTip(t *testing.T) {
	tips, _ := cmd.BuildAppServiceUsageTips("Running", true, true, false, true, false, "1.2", "plan1", 5, nil)
	for _, tip := range tips {
		assert.NotContains(t, tip, "Always On")
	}
}

func TestBuildAppServiceUsageTips_HTTP2Disabled(t *testing.T) {
	tips, _ := cmd.BuildAppServiceUsageTips("Running", true, true, true, false, false, "1.2", "plan1", 50, nil)
	assertContainsTip(t, tips, "HTTP/2 is not enabled")
}

func TestBuildAppServiceUsageTips_NoClientCertHighCost(t *testing.T) {
	tips, _ := cmd.BuildAppServiceUsageTips("Running", true, false, true, true, false, "1.2", "plan1", 50, nil)
	assertContainsTip(t, tips, "Client certificate authentication is disabled")
}

func TestBuildAppServiceUsageTips_NoClientCertLowCostNoTip(t *testing.T) {
	tips, _ := cmd.BuildAppServiceUsageTips("Running", true, false, true, true, false, "1.2", "plan1", 10, nil)
	for _, tip := range tips {
		assert.NotContains(t, tip, "Client certificate")
	}
}

func TestBuildAppServiceUsageTips_BandwidthMeter(t *testing.T) {
	meters := []cmd.MeterCost{{Name: "Bandwidth", Cost: 15}}
	tips, saving := cmd.BuildAppServiceUsageTips("Running", true, true, true, true, false, "1.2", "plan1", 50, meters)
	assertContainsTip(t, tips, "High bandwidth cost")
	assert.Greater(t, saving, float64(0))
}

func TestBuildAppServiceUsageTips_ZeroCost(t *testing.T) {
	tips, _ := cmd.BuildAppServiceUsageTips("Running", true, true, true, true, false, "1.2", "plan1", 0, nil)
	assertContainsTip(t, tips, "Zero cost detected")
}

func TestBuildAppServiceUsageTips_NoPlanName(t *testing.T) {
	tips, _ := cmd.BuildAppServiceUsageTips("Running", true, true, true, true, false, "1.2", "", 50, nil)
	assertContainsTip(t, tips, "No App Service Plan linked")
}
