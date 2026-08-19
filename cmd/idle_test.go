package cmd

import "testing"

func TestIdleCategory_PublicIPIdle(t *testing.T) {
	got := idleCategory("IDLE", "microsoft.network/publicipaddresses")
	if got != "Unused IP" {
		t.Errorf("got %q, want %q", got, "Unused IP")
	}
}

func TestIdleCategory_AppServicePlanIdle(t *testing.T) {
	got := idleCategory("IDLE", "microsoft.web/serverfarms")
	if got != "Empty Plan" {
		t.Errorf("got %q, want %q", got, "Empty Plan")
	}
}

func TestIdleCategory_OtherTypeIdle(t *testing.T) {
	cases := []string{
		"microsoft.documentdb/databaseaccounts",
		"microsoft.storage/storageaccounts",
		"microsoft.keyvault/vaults",
		"microsoft.containerregistry/registries",
		"microsoft.web/sites",
		"microsoft.cognitiveservices/accounts",
	}
	for _, rtype := range cases {
		if got := idleCategory("IDLE", rtype); got != "Zero Usage" {
			t.Errorf("idleCategory(IDLE, %q) = %q, want %q", rtype, got, "Zero Usage")
		}
	}
}

func TestIdleCategory_HighWaste(t *testing.T) {
	if got := idleCategory("HIGH", "microsoft.storage/storageaccounts"); got != "Over-provisioned" {
		t.Errorf("got %q, want %q", got, "Over-provisioned")
	}
}

func TestIdleCategory_MediumWaste(t *testing.T) {
	if got := idleCategory("MEDIUM", "microsoft.web/sites"); got != "Over-provisioned" {
		t.Errorf("got %q, want %q", got, "Over-provisioned")
	}
}

func TestIdleCategory_LowAndHealthyProduceNoFinding(t *testing.T) {
	for _, score := range []string{"LOW", "HEALTHY"} {
		if got := idleCategory(score, "microsoft.storage/storageaccounts"); got != "" {
			t.Errorf("idleCategory(%q, ...) = %q, want empty string", score, got)
		}
	}
}

func TestIdleFindingsToProvider_CarriesCostAndSaving(t *testing.T) {
	findings := []IdleFinding{
		{
			Severity:       Critical,
			Category:       "Zero Usage",
			ResourceName:   "unused-ip",
			ResourceType:   "microsoft.network/publicipaddresses",
			ResourceGroup:  "rg-test",
			Description:    "Idle for 30 days",
			Recommendation: "Delete it",
			MonthlyCost:    12.5,
			MonthlySaving:  12.5,
		},
	}

	out := idleFindingsToProvider(findings)

	if len(out) != 1 {
		t.Fatalf("expected 1 finding, got %d", len(out))
	}
	if out[0].MonthlyCost == nil || *out[0].MonthlyCost != 12.5 {
		t.Errorf("expected MonthlyCost 12.5, got %v", out[0].MonthlyCost)
	}
	if out[0].MonthlySaving == nil || *out[0].MonthlySaving != 12.5 {
		t.Errorf("expected MonthlySaving 12.5, got %v", out[0].MonthlySaving)
	}
}
