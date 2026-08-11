package usage_analyzers_test

import (
	"strings"
	"testing"

	"github.com/chanbistec/btg-devops/cmd"
	"github.com/stretchr/testify/assert"
)

// ─── CalcWasteScore ────────────────────────────────────────────────────────

func TestCalcWasteScore_ZeroCost(t *testing.T) {
	score, reason := cmd.CalcWasteScore(0, -1, -1)
	assert.Equal(t, "IDLE", score)
	assert.NotEmpty(t, reason)
}

func TestCalcWasteScore_ZeroPctAndZeroActivity(t *testing.T) {
	score, reason := cmd.CalcWasteScore(30, 0, 0)
	assert.Equal(t, "IDLE", score)
	assert.NotEmpty(t, reason)
}

func TestCalcWasteScore_PercentageBased(t *testing.T) {
	tests := []struct {
		name          string
		cost          float64
		primaryPct    float64
		expectedScore string
	}{
		{"under 5pct high cost is HIGH", 50, 2, "HIGH"},
		{"under 10pct high cost is MEDIUM", 50, 8, "MEDIUM"},
		{"under 35pct high cost is LOW", 50, 25, "LOW"},
		{"over 70pct is HEALTHY", 50, 80, "HEALTHY"},
		{"50pct default is LOW", 50, 50, "LOW"},
		{"low cost under 5pct is not HIGH", 5, 2, "LOW"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			score, reason := cmd.CalcWasteScore(tt.cost, tt.primaryPct, -1)
			assert.Equal(t, tt.expectedScore, score)
			assert.NotEmpty(t, reason)
		})
	}
}

func TestCalcWasteScore_ActivityBased(t *testing.T) {
	tests := []struct {
		name          string
		cost          float64
		activity      float64
		expectedScore string
	}{
		{"zero activity with cost is IDLE", 30, 0, "IDLE"},
		{"very low activity high cost is HIGH", 50, 5, "HIGH"},
		{"low activity medium cost is MEDIUM", 100, 50, "MEDIUM"},
		{"moderate activity is HEALTHY", 100, 200, "HEALTHY"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			score, reason := cmd.CalcWasteScore(tt.cost, -1, tt.activity)
			assert.Equal(t, tt.expectedScore, score)
			assert.NotEmpty(t, reason)
		})
	}
}

// ─── CostSeverity ──────────────────────────────────────────────────────────

func TestCostSeverity(t *testing.T) {
	tests := []struct {
		cost     float64
		expected cmd.Severity
	}{
		{0, cmd.Info},
		{49.99, cmd.Info},
		{50, cmd.Warning},
		{199.99, cmd.Warning},
		{200, cmd.Critical},
		{500, cmd.Critical},
	}
	for _, tt := range tests {
		t.Run("", func(t *testing.T) {
			assert.Equal(t, tt.expected, cmd.CostSeverity(tt.cost),
				"cost=%.2f should be %v", tt.cost, tt.expected)
		})
	}
}

// ─── RenderBar ─────────────────────────────────────────────────────────────

func TestRenderBar(t *testing.T) {
	tests := []struct {
		name     string
		cost     float64
		maxCost  float64
		width    int
		contains string
		length   int
	}{
		{"zero maxCost returns empty", 50, 0, 10, "", 0},
		{"zero width returns empty", 50, 100, 0, "", 0},
		{"half filled", 50, 100, 10, "█████░░░░░", 10},
		{"fully filled", 100, 100, 10, "██████████", 10},
		{"tiny cost still shows 1 filled", 0.01, 100, 10, "█░░░░░░░░░", 10},
		{"over max is capped", 200, 100, 10, "██████████", 10},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := cmd.RenderBar(tt.cost, tt.maxCost, tt.width)
			if tt.length > 0 {
				assert.Equal(t, tt.length, len([]rune(result)))
			} else {
				assert.Equal(t, "", result)
			}
			if tt.contains != "" {
				assert.Equal(t, tt.contains, result)
			}
		})
	}
}

// ─── SortMetersByCost ──────────────────────────────────────────────────────

func TestSortMetersByCost(t *testing.T) {
	meters := []cmd.MeterCost{
		{Name: "A", Cost: 10},
		{Name: "B", Cost: 50},
		{Name: "C", Cost: 25},
	}
	cmd.SortMetersByCost(meters)
	assert.Equal(t, float64(50), meters[0].Cost)
	assert.Equal(t, float64(25), meters[1].Cost)
	assert.Equal(t, float64(10), meters[2].Cost)
}

func TestSortMetersByCost_Empty(_ *testing.T) {
	var meters []cmd.MeterCost
	cmd.SortMetersByCost(meters) // must not panic
}

func TestSortMetersByCost_AlreadySorted(t *testing.T) {
	meters := []cmd.MeterCost{
		{Name: "A", Cost: 100},
		{Name: "B", Cost: 50},
	}
	cmd.SortMetersByCost(meters)
	assert.Equal(t, float64(100), meters[0].Cost)
	assert.Equal(t, float64(50), meters[1].Cost)
}

// ─── MaxMeterCost ──────────────────────────────────────────────────────────

func TestMaxMeterCost(t *testing.T) {
	assert.Equal(t, float64(0), cmd.MaxMeterCost(nil))
	assert.Equal(t, float64(0), cmd.MaxMeterCost([]cmd.MeterCost{}))
	assert.Equal(t, float64(42), cmd.MaxMeterCost([]cmd.MeterCost{{Cost: 42}}))
	assert.Equal(t, float64(99), cmd.MaxMeterCost([]cmd.MeterCost{
		{Cost: 10}, {Cost: 99}, {Cost: 5},
	}))
}

// ─── BuildUtilizationString ────────────────────────────────────────────────

func TestBuildUtilizationString_Empty(t *testing.T) {
	assert.Equal(t, "", cmd.BuildUtilizationString(map[string]float64{}))
	assert.Equal(t, "", cmd.BuildUtilizationString(nil))
}

func TestBuildUtilizationString_Integer(t *testing.T) {
	result := cmd.BuildUtilizationString(map[string]float64{"requests": 100})
	assert.Equal(t, "requests: 100", result)
}

func TestBuildUtilizationString_Float(t *testing.T) {
	result := cmd.BuildUtilizationString(map[string]float64{"cpu": 75.5})
	assert.Equal(t, "cpu: 75.5", result)
}

func TestBuildUtilizationString_MultipleEntriesSorted(t *testing.T) {
	result := cmd.BuildUtilizationString(map[string]float64{
		"zoo":   1,
		"alpha": 2,
		"beta":  3,
	})
	parts := strings.Split(result, "  |  ")
	assert.Equal(t, 3, len(parts))
	assert.Contains(t, parts[0], "alpha")
	assert.Contains(t, parts[1], "beta")
	assert.Contains(t, parts[2], "zoo")
}

// ─── UsageTypeAliases ──────────────────────────────────────────────────────

func TestUsageTypeAliases_KnownAliases(t *testing.T) {
	aliases := cmd.UsageTypeAliases
	tests := []struct {
		alias    string
		expected string
	}{
		{"cosmosdb", "microsoft.documentdb/databaseaccounts"},
		{"cosmos", "microsoft.documentdb/databaseaccounts"},
		{"storage", "microsoft.storage/storageaccounts"},
		{"storageaccount", "microsoft.storage/storageaccounts"},
		{"keyvault", "microsoft.keyvault/vaults"},
		{"kv", "microsoft.keyvault/vaults"},
		{"acr", "microsoft.containerregistry/registries"},
		{"containerregistry", "microsoft.containerregistry/registries"},
		{"appservice", "microsoft.web/sites"},
		{"webapp", "microsoft.web/sites"},
		{"functions", "microsoft.web/sites"},
		{"functionapp", "microsoft.web/sites"},
		{"appserviceplan", "microsoft.web/serverfarms"},
		{"asp", "microsoft.web/serverfarms"},
		{"publicip", "microsoft.network/publicipaddresses"},
		{"pip", "microsoft.network/publicipaddresses"},
		{"cognitiveservices", "microsoft.cognitiveservices/accounts"},
		{"openai", "microsoft.cognitiveservices/accounts"},
		{"cognitive", "microsoft.cognitiveservices/accounts"},
	}
	for _, tt := range tests {
		t.Run(tt.alias, func(t *testing.T) {
			got, ok := aliases[tt.alias]
			assert.True(t, ok, "alias %q should exist", tt.alias)
			assert.Equal(t, tt.expected, got)
		})
	}
}

func TestUsageTypeAliases_UnknownAlias(t *testing.T) {
	_, ok := cmd.UsageTypeAliases["nonexistent"]
	assert.False(t, ok)
}

// ─── SupportedUsageTypes ───────────────────────────────────────────────────

func TestSupportedUsageTypes_ContainsExpected(t *testing.T) {
	expected := []string{
		"microsoft.documentdb/databaseaccounts",
		"microsoft.storage/storageaccounts",
		"microsoft.web/serverfarms",
		"microsoft.keyvault/vaults",
		"microsoft.containerregistry/registries",
		"microsoft.web/sites",
		"microsoft.network/publicipaddresses",
		"microsoft.cognitiveservices/accounts",
	}
	for _, want := range expected {
		found := false
		for _, got := range cmd.SupportedUsageTypes {
			if got == want {
				found = true
				break
			}
		}
		assert.True(t, found, "expected %q in SupportedUsageTypes", want)
	}
}
