package cmd

import (
	"testing"

	"github.com/chanbistec/btg-devops/provider"
)

// Representative sample per docs/superpowers/specs/2026-08-06-unified-analyzer-interface-design.md's
// testing approach: storage (the common case), iam (the non-obvious
// Resource field), and idle (the multi-return-value special case).

func TestStorageFindingsToProvider(t *testing.T) {
	in := []StorageFinding{
		{
			Severity:       Critical,
			Category:       "HTTPS Not Enforced",
			StorageAccount: "mystorageacct",
			ResourceGroup:  "rg-prod",
			Description:    "Storage account allows non-HTTPS traffic",
			Recommendation: "Enable 'Secure transfer required'.",
		},
	}
	got := storageFindingsToProvider(in)
	if len(got) != 1 {
		t.Fatalf("len = %d, want 1", len(got))
	}
	want := provider.Finding{
		Provider:       "azure",
		Service:        "Storage",
		Severity:       provider.Critical,
		Category:       "HTTPS Not Enforced",
		Resource:       "mystorageacct",
		Description:    "Storage account allows non-HTTPS traffic",
		Recommendation: "Enable 'Secure transfer required'.",
	}
	if got[0] != want {
		t.Errorf("got %+v, want %+v", got[0], want)
	}
}

func TestStorageFindingsToProvider_Empty(t *testing.T) {
	got := storageFindingsToProvider(nil)
	if len(got) != 0 {
		t.Errorf("len = %d, want 0", len(got))
	}
}

func TestIAMFindingsToProvider_ResourceIsPrincipal(t *testing.T) {
	in := []Finding{
		{
			Severity:       Critical,
			Category:       "Overprivileged",
			Description:    "Owner role assigned at subscription scope",
			Principal:      "11111111-2222-3333-4444-555555555555",
			PrincipalType:  "ServicePrincipal",
			Role:           "Owner",
			Recommendation: "Reduce scope.",
		},
	}
	got := iamFindingsToProvider(in)
	if len(got) != 1 {
		t.Fatalf("len = %d, want 1", len(got))
	}
	if got[0].Resource != "11111111-2222-3333-4444-555555555555" {
		t.Errorf("Resource = %q, want the Principal value (IAM has no named resource field)", got[0].Resource)
	}
	if got[0].Service != "IAM" {
		t.Errorf("Service = %q, want IAM", got[0].Service)
	}
	if got[0].Provider != "azure" {
		t.Errorf("Provider = %q, want azure", got[0].Provider)
	}
}

func TestIdleFindingsToProvider(t *testing.T) {
	in := []IdleFinding{
		{
			Severity:       Warning,
			Category:       "Unused IP",
			ResourceName:   "pip-orphaned-01",
			ResourceType:   "microsoft.network/publicipaddresses",
			ResourceGroup:  "rg-net",
			Description:    "Zero activity detected but $3.65/month still billed",
			Recommendation: "Delete the Public IP.",
		},
	}
	got := idleFindingsToProvider(in)
	if len(got) != 1 {
		t.Fatalf("len = %d, want 1", len(got))
	}
	if got[0].Resource != "pip-orphaned-01" {
		t.Errorf("Resource = %q, want pip-orphaned-01", got[0].Resource)
	}
	if got[0].Category != "Unused IP" {
		t.Errorf("Category = %q, want Unused IP", got[0].Category)
	}
	if got[0].Service != "Idle & Waste" {
		t.Errorf("Service = %q, want Idle & Waste", got[0].Service)
	}
}

// TestAzureProviderRegistration_AllCommandsRegistered verifies every one of
// the 14 Azure commands' init() successfully registered with the "azure"
// provider (including appservice-traffic's deliberate no-op stub) — a
// regression test for the registration lines themselves, independent of any
// live Azure call.
func TestAzureProviderRegistration_AllCommandsRegistered(t *testing.T) {
	want := []string{
		"acr", "appservice-traffic", "appserviceplan", "cognitiveservices",
		"cosmosdb", "functions", "iam", "idle", "keyvault", "nsg",
		"publicip", "resourcegroup", "sp-expiry", "storage",
	}
	got := map[string]bool{}
	for _, a := range provider.Analyzers("azure") {
		got[a.Name()] = true
	}
	for _, name := range want {
		if !got[name] {
			t.Errorf("provider.Analyzers(azure) is missing %q", name)
		}
	}
	if len(provider.Analyzers("azure")) != len(want) {
		t.Errorf("provider.Analyzers(azure) has %d entries, want %d (got names: %v)", len(provider.Analyzers("azure")), len(want), got)
	}
}

// ---------- Power Platform provider: all 5 analyzers ----------
// Unlike Azure's representative sample, all 5 Power Platform conversion
// functions are tested since there are few enough to cover exhaustively.

func TestPowerplatformFindingsToProvider(t *testing.T) {
	in := []PPFinding{
		{
			Severity:       Critical,
			Category:       "Zero Usage",
			LicenseName:    "Power Apps per User Plan",
			SKUPartNumber:  "POWERAPPS_PER_USER",
			Description:    "10 purchased seats with 0 users assigned",
			Recommendation: "Cancel subscription immediately if not planned for use.",
		},
	}
	got := powerplatformFindingsToProvider(in)
	if len(got) != 1 {
		t.Fatalf("len = %d, want 1", len(got))
	}
	want := provider.Finding{
		Provider:       "powerplatform",
		Service:        "Power Platform",
		Severity:       provider.Critical,
		Category:       "Zero Usage",
		Resource:       "Power Apps per User Plan",
		Description:    "10 purchased seats with 0 users assigned",
		Recommendation: "Cancel subscription immediately if not planned for use.",
	}
	if got[0] != want {
		t.Errorf("got %+v, want %+v", got[0], want)
	}
}

func TestPPEnvironmentsFindingsToProvider_ResourceAndEnvironmentBothSet(t *testing.T) {
	in := []PPEnvFinding{
		{
			Severity:       Warning,
			Category:       "No DLP Policy",
			Environment:    "Default-Contoso",
			EnvironmentSku: "Production",
			Description:    "has no DLP policies",
			Recommendation: "Create a DLP policy.",
		},
	}
	got := ppEnvironmentsFindingsToProvider(in)
	if len(got) != 1 {
		t.Fatalf("len = %d, want 1", len(got))
	}
	if got[0].Resource != "Default-Contoso" {
		t.Errorf("Resource = %q, want Default-Contoso (PP Environments has no separate named resource)", got[0].Resource)
	}
	if got[0].Environment != "Default-Contoso" {
		t.Errorf("Environment = %q, want Default-Contoso", got[0].Environment)
	}
	if got[0].Service != "PP Environments" {
		t.Errorf("Service = %q, want PP Environments", got[0].Service)
	}
}

func TestPPAppsFindingsToProvider(t *testing.T) {
	in := []PPAppFinding{
		{
			Severity:       Warning,
			Category:       "Stale App",
			AppName:        "Expense Tracker",
			Environment:    "Production",
			Owner:          "alice@contoso.com",
			Description:    "Not modified in 400 days",
			Recommendation: "Archive or delete if no longer in use.",
		},
	}
	got := ppAppsFindingsToProvider(in)
	if len(got) != 1 {
		t.Fatalf("len = %d, want 1", len(got))
	}
	if got[0].Resource != "Expense Tracker" {
		t.Errorf("Resource = %q, want Expense Tracker", got[0].Resource)
	}
	if got[0].Environment != "Production" {
		t.Errorf("Environment = %q, want Production", got[0].Environment)
	}
	if got[0].Service != "PP Apps" {
		t.Errorf("Service = %q, want PP Apps", got[0].Service)
	}
}

func TestPPFlowsFindingsToProvider(t *testing.T) {
	in := []PPFlowFinding{
		{
			Severity:       Critical,
			Category:       "Suspended Flow",
			FlowName:       "Approval Workflow",
			Environment:    "Production",
			State:          "Suspended",
			Owner:          "bob@contoso.com",
			Description:    "is suspended — it is NOT running",
			Recommendation: "Review run history for errors.",
		},
	}
	got := ppFlowsFindingsToProvider(in)
	if len(got) != 1 {
		t.Fatalf("len = %d, want 1", len(got))
	}
	if got[0].Resource != "Approval Workflow" {
		t.Errorf("Resource = %q, want Approval Workflow", got[0].Resource)
	}
	if got[0].Service != "PP Flows" {
		t.Errorf("Service = %q, want PP Flows", got[0].Service)
	}
}

func TestPPPowerBIFindingsToProvider(t *testing.T) {
	in := []PPBIFinding{
		{
			Severity:       Critical,
			Category:       "No Admin — Orphaned",
			Workspace:      "Sales Analytics",
			WorkspaceType:  "Workspace",
			Description:    "has no admin users",
			Recommendation: "Assign an admin or delete it.",
		},
	}
	got := ppPowerBIFindingsToProvider(in)
	if len(got) != 1 {
		t.Fatalf("len = %d, want 1", len(got))
	}
	if got[0].Resource != "Sales Analytics" {
		t.Errorf("Resource = %q, want Sales Analytics", got[0].Resource)
	}
	if got[0].Service != "Power BI" {
		t.Errorf("Service = %q, want Power BI", got[0].Service)
	}
}

// TestPowerPlatformProviderRegistration_AllCommandsRegistered mirrors the
// Azure registration-completeness test for the "powerplatform" provider key.
func TestPowerPlatformProviderRegistration_AllCommandsRegistered(t *testing.T) {
	want := []string{"powerplatform", "pp-environments", "pp-apps", "pp-flows", "pp-powerbi"}
	got := map[string]bool{}
	for _, a := range provider.Analyzers("powerplatform") {
		got[a.Name()] = true
	}
	for _, name := range want {
		if !got[name] {
			t.Errorf("provider.Analyzers(powerplatform) is missing %q", name)
		}
	}
	if len(provider.Analyzers("powerplatform")) != len(want) {
		t.Errorf("provider.Analyzers(powerplatform) has %d entries, want %d (got names: %v)", len(provider.Analyzers("powerplatform")), len(want), got)
	}
}

// ---------- Hetzner provider: all 5 read-only analyzers ----------
// Exhaustive, like Power Platform's coverage above, since there are few
// enough analyzers to cover completely rather than sample.

func TestHetznerServersFindingsToProvider(t *testing.T) {
	in := []HetznerServerFinding{
		{
			Severity:       Warning,
			Category:       "Stopped Server — Still Billed",
			ServerName:     "web-1",
			Datacenter:     "fsn1-dc8",
			Description:    "'web-1' is powered off but still billed at the full server rate",
			Recommendation: "Delete the server if it's no longer needed, or power it back on if it is.",
		},
	}
	got := hetznerServersFindingsToProvider(in)
	if len(got) != 1 {
		t.Fatalf("len = %d, want 1", len(got))
	}
	want := provider.Finding{
		Provider:       "hetzner",
		Service:        "Hetzner Servers",
		Severity:       provider.Warning,
		Category:       "Stopped Server — Still Billed",
		Resource:       "web-1",
		Description:    "'web-1' is powered off but still billed at the full server rate",
		Recommendation: "Delete the server if it's no longer needed, or power it back on if it is.",
	}
	if got[0] != want {
		t.Errorf("got %+v, want %+v", got[0], want)
	}
}

func TestHetznerVolumesFindingsToProvider(t *testing.T) {
	in := []HetznerVolumeFinding{
		{
			Severity:        Critical,
			Category:        "Unattached Volume",
			VolumeName:      "vol-old",
			SizeGB:          100,
			DaysUnattached:  30,
			EstMonthlyWaste: 4.4,
			Description:     "'vol-old' (100GB) is not attached to any server — est. €4.40/month at list price",
			Recommendation:  "Attach the volume to a server, or delete it if it's no longer needed.",
		},
	}
	got := hetznerVolumesFindingsToProvider(in)
	if len(got) != 1 {
		t.Fatalf("len = %d, want 1", len(got))
	}
	if got[0].Resource != "vol-old" {
		t.Errorf("Resource = %q, want vol-old", got[0].Resource)
	}
	if got[0].Service != "Hetzner Volumes" {
		t.Errorf("Service = %q, want Hetzner Volumes", got[0].Service)
	}
	if got[0].Provider != "hetzner" {
		t.Errorf("Provider = %q, want hetzner", got[0].Provider)
	}
}

func TestHetznerFloatingIPsFindingsToProvider(t *testing.T) {
	in := []HetznerFloatingIPFinding{
		{
			Severity:       Warning,
			Category:       "Unassigned Floating IP",
			Name:           "fip-b",
			IP:             "1.2.3.4",
			HomeLocation:   "fsn1",
			Description:    "'fip-b' (1.2.3.4) is not assigned to any server",
			Recommendation: "Assign the Floating IP to a server, or delete it if it's no longer needed.",
		},
	}
	got := hetznerFloatingIPsFindingsToProvider(in)
	if len(got) != 1 {
		t.Fatalf("len = %d, want 1", len(got))
	}
	if got[0].Resource != "fip-b" {
		t.Errorf("Resource = %q, want fip-b (Floating IPs have no separate named resource)", got[0].Resource)
	}
	if got[0].Service != "Hetzner Floating IPs" {
		t.Errorf("Service = %q, want Hetzner Floating IPs", got[0].Service)
	}
}

func TestHetznerFirewallsFindingsToProvider(t *testing.T) {
	in := []HetznerFirewallFinding{
		{
			Severity:       Critical,
			Category:       "Sensitive Port Open to Internet",
			FirewallName:   "fw-ssh",
			Description:    "'fw-ssh' allows tcp/22 (SSH) from 0.0.0.0/0 — anyone on the internet can attempt to connect",
			Recommendation: "Restrict the source IP range for port 22 to known, trusted addresses.",
		},
	}
	got := hetznerFirewallsFindingsToProvider(in)
	if len(got) != 1 {
		t.Fatalf("len = %d, want 1", len(got))
	}
	if got[0].Resource != "fw-ssh" {
		t.Errorf("Resource = %q, want fw-ssh", got[0].Resource)
	}
	if got[0].Service != "Hetzner Firewalls" {
		t.Errorf("Service = %q, want Hetzner Firewalls", got[0].Service)
	}
}

func TestHetznerCertificatesFindingsToProvider(t *testing.T) {
	in := []HetznerCertificateFinding{
		{
			Severity:       Critical,
			Category:       "Expiring Within 30 Days",
			CertName:       "cert-soon",
			ExpiresOn:      "2026-09-01T00:00:00+00:00",
			DaysRemaining:  10,
			Recommendation: "Renew this certificate before it expires in 10 days.",
		},
	}
	got := hetznerCertificatesFindingsToProvider(in)
	if len(got) != 1 {
		t.Fatalf("len = %d, want 1", len(got))
	}
	if got[0].Resource != "cert-soon" {
		t.Errorf("Resource = %q, want cert-soon", got[0].Resource)
	}
	if got[0].Description != "cert-soon — expires 2026-09-01T00:00:00+00:00" {
		t.Errorf("Description = %q, want it to embed the cert name and expiry", got[0].Description)
	}
	if got[0].Service != "Hetzner Certificates" {
		t.Errorf("Service = %q, want Hetzner Certificates", got[0].Service)
	}
}

// TestHetznerProviderRegistration_AllCommandsRegistered mirrors the
// Azure/PowerPlatform registration-completeness tests for the "hetzner"
// provider key.
func TestHetznerProviderRegistration_AllCommandsRegistered(t *testing.T) {
	want := []string{
		"hetzner-servers", "hetzner-volumes", "hetzner-floatingips",
		"hetzner-firewalls", "hetzner-certificates",
	}
	got := map[string]bool{}
	for _, a := range provider.Analyzers("hetzner") {
		got[a.Name()] = true
	}
	for _, name := range want {
		if !got[name] {
			t.Errorf("provider.Analyzers(hetzner) is missing %q", name)
		}
	}
	if len(provider.Analyzers("hetzner")) != len(want) {
		t.Errorf("provider.Analyzers(hetzner) has %d entries, want %d (got names: %v)", len(provider.Analyzers("hetzner")), len(want), got)
	}
}
