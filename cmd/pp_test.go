package cmd

import (
	"testing"
	"time"
)

// ---------- ppDaysSince ----------

func TestPPDaysSince_ValidRFC3339(t *testing.T) {
	ts := time.Now().Add(-48 * time.Hour).UTC().Format(time.RFC3339)
	days := ppDaysSince(ts)
	if days < 1 || days > 3 {
		t.Errorf("expected ~2 days, got %d", days)
	}
}

func TestPPDaysSince_AltFormat(t *testing.T) {
	ts := time.Now().Add(-24 * time.Hour).UTC().Format("2006-01-02T15:04:05.0000000Z")
	days := ppDaysSince(ts)
	if days < 0 || days > 2 {
		t.Errorf("expected ~1 day, got %d", days)
	}
}

func TestPPDaysSince_Empty(t *testing.T) {
	if ppDaysSince("") != -1 {
		t.Error("empty string should return -1")
	}
}

func TestPPDaysSince_Unparseable(t *testing.T) {
	if ppDaysSince("not-a-date") != -1 {
		t.Error("unparseable string should return -1")
	}
}

func TestPPDaysSince_FutureDate(t *testing.T) {
	ts := time.Now().Add(24 * time.Hour).UTC().Format(time.RFC3339)
	days := ppDaysSince(ts)
	if days != 0 {
		t.Errorf("future date should return 0, got %d", days)
	}
}

// ---------- isPowerPlatformSKU ----------

func TestIsPPSKU_PowerApps(t *testing.T) {
	cases := []string{
		"POWERAPPS_PER_USER",
		"POWERAPPS_PER_APP",
		"POWERAPPS_DEV",
	}
	for _, c := range cases {
		if !isPowerPlatformSKU(c) {
			t.Errorf("expected %q to be a PP SKU", c)
		}
	}
}

func TestIsPPSKU_Flow(t *testing.T) {
	cases := []string{"FLOW_PER_USER", "FLOW_PER_USER_VIRAL", "FLOW_FREE"}
	for _, c := range cases {
		if !isPowerPlatformSKU(c) {
			t.Errorf("expected %q to be a PP SKU", c)
		}
	}
}

func TestIsPPSKU_PowerBI(t *testing.T) {
	cases := []string{"POWERBI_PRO", "POWERBI_PREMIUM_PER_USER", "POWER_BI_STANDARD"}
	for _, c := range cases {
		if !isPowerPlatformSKU(c) {
			t.Errorf("expected %q to be a PP SKU", c)
		}
	}
}

func TestIsPPSKU_Dynamics(t *testing.T) {
	cases := []string{"DYN365_ENTERPRISE_SALES", "DYN365_BUSINESS_CENTRAL_ESSENTIAL"}
	for _, c := range cases {
		if !isPowerPlatformSKU(c) {
			t.Errorf("expected %q to be a PP SKU", c)
		}
	}
}

func TestIsPPSKU_NonPP(t *testing.T) {
	cases := []string{"ENTERPRISEPREMIUM", "AAD_PREMIUM", "MCOSTANDARD", "SPE_E3"}
	for _, c := range cases {
		if isPowerPlatformSKU(c) {
			t.Errorf("expected %q NOT to be a PP SKU", c)
		}
	}
}

// ---------- isTrialSKU ----------

func TestIsTrialSKU_Viral(t *testing.T) {
	if !isTrialSKU("FLOW_PER_USER_VIRAL") {
		t.Error("FLOW_PER_USER_VIRAL should be trial")
	}
	if !isTrialSKU("POWER_VIRTUAL_AGENTS_VIRAL") {
		t.Error("POWER_VIRTUAL_AGENTS_VIRAL should be trial")
	}
}

func TestIsTrialSKU_Dev(t *testing.T) {
	if !isTrialSKU("POWERAPPS_DEV") {
		t.Error("POWERAPPS_DEV should be trial")
	}
}

func TestIsTrialSKU_Free(t *testing.T) {
	if !isTrialSKU("FLOW_FREE") {
		t.Error("FLOW_FREE should be trial")
	}
}

func TestIsTrialSKU_PaidPlan(t *testing.T) {
	cases := []string{"POWERAPPS_PER_USER", "FLOW_PER_USER", "POWERBI_PRO"}
	for _, c := range cases {
		if isTrialSKU(c) {
			t.Errorf("expected %q NOT to be trial", c)
		}
	}
}

// ---------- DLP helpers ----------

func TestDLPHTTPBlocked_Blocked(t *testing.T) {
	pol := ppDLPPolicy{
		Properties: ppDLPPolicyProps{
			ConnectorGroups: []ppConnectorGroup{
				{
					Classification: "Blocked",
					Connectors: []ppConnector{
						{Name: "shared_http"},
					},
				},
			},
		},
	}
	if !dlpHTTPBlocked(pol) {
		t.Error("expected HTTP to be blocked")
	}
}

func TestDLPHTTPBlocked_NotBlocked(t *testing.T) {
	pol := ppDLPPolicy{
		Properties: ppDLPPolicyProps{
			ConnectorGroups: []ppConnectorGroup{
				{
					Classification: "Confidential",
					Connectors:     []ppConnector{{Name: "shared_salesforce"}},
				},
				{
					Classification: "Blocked",
					Connectors:     []ppConnector{{Name: "shared_ftp"}},
				},
			},
		},
	}
	if dlpHTTPBlocked(pol) {
		t.Error("HTTP is not in Blocked group — should return false")
	}
}

func TestDLPCoveredEnvs_Include(t *testing.T) {
	pol := ppDLPPolicy{
		Properties: ppDLPPolicyProps{
			FilterType: "Include",
			Environments: []ppDLPEnvRef{
				{Name: "env-a"},
				{Name: "env-b"},
			},
		},
	}
	all := []string{"env-a", "env-b", "env-c"}
	covered := dlpCoveredEnvs(pol, all)
	if !covered["env-a"] || !covered["env-b"] {
		t.Error("env-a and env-b should be covered")
	}
	if covered["env-c"] {
		t.Error("env-c should not be covered by Include policy")
	}
}

func TestDLPCoveredEnvs_Exclude(t *testing.T) {
	pol := ppDLPPolicy{
		Properties: ppDLPPolicyProps{
			FilterType: "Exclude",
			Environments: []ppDLPEnvRef{
				{Name: "env-a"},
			},
		},
	}
	all := []string{"env-a", "env-b", "env-c"}
	covered := dlpCoveredEnvs(pol, all)
	if covered["env-a"] {
		t.Error("env-a should be excluded")
	}
	if !covered["env-b"] || !covered["env-c"] {
		t.Error("env-b and env-c should be covered by Exclude policy")
	}
}

func TestDLPCoveredEnvs_TenantWide(t *testing.T) {
	pol := ppDLPPolicy{
		Properties: ppDLPPolicyProps{
			FilterType:   "",
			Environments: nil,
		},
	}
	all := []string{"env-a", "env-b"}
	covered := dlpCoveredEnvs(pol, all)
	if !covered["env-a"] || !covered["env-b"] {
		t.Error("tenant-wide policy should cover all environments")
	}
}

// ---------- Risky connector catalogue ----------

func TestHighRiskConnectors_HTTPPresent(t *testing.T) {
	if _, ok := ppHighRiskConnectors["shared_http"]; !ok {
		t.Error("shared_http should be in high-risk connector list")
	}
}

func TestWarnConnectors_SharePointPresent(t *testing.T) {
	if _, ok := ppWarnConnectors["shared_sharepointonline"]; !ok {
		t.Error("shared_sharepointonline should be in warn connector list")
	}
}

func TestConnectorCatalogues_NoOverlap(t *testing.T) {
	for k := range ppHighRiskConnectors {
		if _, exists := ppWarnConnectors[k]; exists {
			t.Errorf("connector %q appears in both high-risk and warn catalogues", k)
		}
	}
}
