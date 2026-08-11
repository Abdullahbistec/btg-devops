package usage_analyzers_test

import (
	"testing"

	"github.com/chanbistec/btg-devops/cmd"
	"github.com/stretchr/testify/assert"
)

func TestBuildCogServicesAccountTips_PublicNetworkOpen(t *testing.T) {
	tips, _ := cmd.BuildCogServicesAccountTips("OpenAI", "S0", "Enabled", true, true, 50, 1)
	assertContainsTip(t, tips, "Public network access is open")
}

func TestBuildCogServicesAccountTips_PublicNetworkDisabledNoTip(t *testing.T) {
	tips, _ := cmd.BuildCogServicesAccountTips("OpenAI", "S0", "Disabled", true, true, 50, 1)
	for _, tip := range tips {
		assert.NotContains(t, tip, "Public network access is open")
	}
}

func TestBuildCogServicesAccountTips_OutboundNotRestricted(t *testing.T) {
	tips, _ := cmd.BuildCogServicesAccountTips("OpenAI", "S0", "Disabled", false, true, 50, 1)
	assertContainsTip(t, tips, "Outbound network access is not restricted")
}

func TestBuildCogServicesAccountTips_LocalAuthEnabled(t *testing.T) {
	tips, _ := cmd.BuildCogServicesAccountTips("OpenAI", "S0", "Disabled", true, false, 50, 1)
	assertContainsTip(t, tips, "Local API key authentication is enabled")
}

func TestBuildCogServicesAccountTips_LocalAuthDisabledNoTip(t *testing.T) {
	tips, _ := cmd.BuildCogServicesAccountTips("OpenAI", "S0", "Disabled", true, true, 50, 1)
	for _, tip := range tips {
		assert.NotContains(t, tip, "Local API key")
	}
}

func TestBuildCogServicesAccountTips_OpenAIS0HighCost(t *testing.T) {
	tips, saving := cmd.BuildCogServicesAccountTips("OpenAI", "S0", "Disabled", true, true, 150, 1)
	assertContainsTip(t, tips, "Provisioned Throughput Units")
	assert.Greater(t, saving, float64(0))
}

func TestBuildCogServicesAccountTips_OpenAIS0LowCostNoTip(t *testing.T) {
	tips, _ := cmd.BuildCogServicesAccountTips("OpenAI", "S0", "Disabled", true, true, 50, 1)
	for _, tip := range tips {
		assert.NotContains(t, tip, "Provisioned Throughput Units")
	}
}

func TestBuildCogServicesAccountTips_ZeroCost(t *testing.T) {
	tips, _ := cmd.BuildCogServicesAccountTips("OpenAI", "S0", "Disabled", true, true, 0, 1)
	assertContainsTip(t, tips, "Zero cost")
}

func TestBuildCogServicesAccountTips_OpenAINoDeployments(t *testing.T) {
	tips, _ := cmd.BuildCogServicesAccountTips("OpenAI", "S0", "Disabled", true, true, 10, 0)
	assertContainsTip(t, tips, "No model deployments found")
}

func TestBuildCogServicesAccountTips_OpenAIWithDeployments(t *testing.T) {
	tips, _ := cmd.BuildCogServicesAccountTips("OpenAI", "S0", "Disabled", true, true, 10, 2)
	for _, tip := range tips {
		assert.NotContains(t, tip, "No model deployments found")
	}
}

func TestBuildCogServicesAccountTips_NonOpenAIHighCost(t *testing.T) {
	tips, _ := cmd.BuildCogServicesAccountTips("TextAnalytics", "S1", "Disabled", true, true, 80, 0)
	assertContainsTip(t, tips, "High spend")
}

func TestBuildCogServicesAccountTips_NonOpenAILowCostNoTip(t *testing.T) {
	tips, _ := cmd.BuildCogServicesAccountTips("TextAnalytics", "S1", "Disabled", true, true, 30, 0)
	for _, tip := range tips {
		assert.NotContains(t, tip, "High spend")
	}
}

func TestBuildCogServicesAccountTips_HealthyAccount(t *testing.T) {
	tips, saving := cmd.BuildCogServicesAccountTips("OpenAI", "S0", "Disabled", true, true, 50, 2)
	assert.Empty(t, tips)
	assert.Equal(t, float64(0), saving)
}
