package cmd

import (
	"testing"
	"time"
)

// These tests exercise each analyzer's pure hetznerXxxFindings(...) function
// directly against in-memory fixture structs — no network, no live API
// calls, matching the existing pp_test.go / idle_test.go style.

// ---------- hetzner-servers ----------

func TestHetznerServerFindings_StoppedServer(t *testing.T) {
	servers := []hetznerServer{
		{Name: "web-1", Status: "off", PublicNet: hetznerPublicNet{Firewalls: []hetznerAppliedFirewall{{ID: 1}}}, BackupWindow: "22-02"},
	}
	summary := &HetznerServerSummary{}
	findings := hetznerServerFindings(servers, summary)

	if summary.StoppedServers != 1 {
		t.Errorf("StoppedServers = %d, want 1", summary.StoppedServers)
	}
	if len(findings) != 1 || findings[0].Category != "Stopped Server — Still Billed" {
		t.Errorf("got %+v, want one Stopped Server finding", findings)
	}
}

func TestHetznerServerFindings_NoFirewall(t *testing.T) {
	servers := []hetznerServer{
		{Name: "web-2", Status: "running", PublicNet: hetznerPublicNet{Firewalls: nil}, BackupWindow: "22-02"},
	}
	summary := &HetznerServerSummary{}
	findings := hetznerServerFindings(servers, summary)

	if summary.NoFirewall != 1 {
		t.Errorf("NoFirewall = %d, want 1", summary.NoFirewall)
	}
	if len(findings) != 1 || findings[0].Category != "No Firewall Attached" {
		t.Errorf("got %+v, want one No Firewall Attached finding", findings)
	}
}

func TestHetznerServerFindings_DeprecatedImage(t *testing.T) {
	servers := []hetznerServer{
		{
			Name:         "web-3",
			Status:       "running",
			PublicNet:    hetznerPublicNet{Firewalls: []hetznerAppliedFirewall{{ID: 1}}},
			BackupWindow: "22-02",
			Image:        &hetznerImage{Name: "ubuntu-20.04", Deprecated: "2024-01-15T00:00:00+00:00"},
		},
	}
	summary := &HetznerServerSummary{}
	findings := hetznerServerFindings(servers, summary)

	if summary.DeprecatedImage != 1 {
		t.Errorf("DeprecatedImage = %d, want 1", summary.DeprecatedImage)
	}
	if len(findings) != 1 || findings[0].Category != "Deprecated Image" {
		t.Errorf("got %+v, want one Deprecated Image finding", findings)
	}
}

func TestHetznerServerFindings_NoBackups(t *testing.T) {
	servers := []hetznerServer{
		{Name: "web-4", Status: "running", PublicNet: hetznerPublicNet{Firewalls: []hetznerAppliedFirewall{{ID: 1}}}, BackupWindow: ""},
	}
	summary := &HetznerServerSummary{}
	findings := hetznerServerFindings(servers, summary)

	if summary.NoBackups != 1 {
		t.Errorf("NoBackups = %d, want 1", summary.NoBackups)
	}
	if len(findings) != 1 || findings[0].Category != "Backups Disabled" {
		t.Errorf("got %+v, want one Backups Disabled finding", findings)
	}
}

func TestHetznerServerFindings_HealthyServerProducesNoFindings(t *testing.T) {
	servers := []hetznerServer{
		{
			Name:         "web-5",
			Status:       "running",
			PublicNet:    hetznerPublicNet{Firewalls: []hetznerAppliedFirewall{{ID: 1}}},
			BackupWindow: "22-02",
			Image:        &hetznerImage{Name: "ubuntu-24.04", Deprecated: ""},
		},
	}
	findings := hetznerServerFindings(servers, &HetznerServerSummary{})
	if len(findings) != 0 {
		t.Errorf("got %+v, want no findings for a fully healthy server", findings)
	}
}

// ---------- hetzner-volumes ----------

func TestHetznerVolumeFindings_AttachedVolumeSkipped(t *testing.T) {
	server := 42
	volumes := []hetznerVolume{{Name: "vol-attached", Size: 10, Server: &server}}
	findings := hetznerVolumeFindings(volumes, &HetznerVolumeSummary{})
	if len(findings) != 0 {
		t.Errorf("got %+v, want no findings for an attached volume", findings)
	}
}

func TestHetznerVolumeFindings_UnattachedRecent_Warning(t *testing.T) {
	volumes := []hetznerVolume{{Name: "vol-new", Size: 10, Server: nil, Created: nowMinusDays(1)}}
	summary := &HetznerVolumeSummary{}
	findings := hetznerVolumeFindings(volumes, summary)

	if summary.UnattachedVolumes != 1 || summary.UnattachedGB != 10 {
		t.Errorf("summary = %+v, want UnattachedVolumes=1 UnattachedGB=10", summary)
	}
	if len(findings) != 1 || findings[0].Severity != Warning {
		t.Errorf("got %+v, want one Warning finding for a freshly-unattached volume", findings)
	}
}

func TestHetznerVolumeFindings_UnattachedOld_Critical(t *testing.T) {
	volumes := []hetznerVolume{{Name: "vol-old", Size: 100, Server: nil, Created: nowMinusDays(30)}}
	findings := hetznerVolumeFindings(volumes, &HetznerVolumeSummary{})

	if len(findings) != 1 || findings[0].Severity != Critical {
		t.Errorf("got %+v, want one Critical finding for a long-unattached volume", findings)
	}
}

// ---------- hetzner-floatingips ----------

func TestHetznerFloatingIPFindings_AssignedSkipped(t *testing.T) {
	server := 7
	ips := []hetznerFloatingIP{{Name: "fip-a", Server: &server}}
	findings := hetznerFloatingIPFindings(ips, &HetznerFloatingIPSummary{})
	if len(findings) != 0 {
		t.Errorf("got %+v, want no findings for an assigned floating IP", findings)
	}
}

func TestHetznerFloatingIPFindings_Unassigned(t *testing.T) {
	ips := []hetznerFloatingIP{{Name: "fip-b", IP: "1.2.3.4", Server: nil}}
	summary := &HetznerFloatingIPSummary{}
	findings := hetznerFloatingIPFindings(ips, summary)

	if summary.UnassignedFloatingIPs != 1 {
		t.Errorf("UnassignedFloatingIPs = %d, want 1", summary.UnassignedFloatingIPs)
	}
	if len(findings) != 1 || findings[0].Category != "Unassigned Floating IP" {
		t.Errorf("got %+v, want one Unassigned Floating IP finding", findings)
	}
}

// ---------- hetzner-firewalls ----------

func TestHetznerFirewallFindings_SensitivePortOpenToInternet_Critical(t *testing.T) {
	firewalls := []hetznerFirewall{
		{
			Name:      "fw-ssh",
			Rules:     []hetznerFirewallRule{{Direction: "in", Protocol: "tcp", Port: "22", SourceIPs: []string{"0.0.0.0/0"}}},
			AppliedTo: []hetznerFirewallTarget{{Type: "server"}},
		},
	}
	summary := &HetznerFirewallSummary{}
	findings := hetznerFirewallFindings(firewalls, summary)

	if summary.OpenSensitivePort != 1 {
		t.Errorf("OpenSensitivePort = %d, want 1", summary.OpenSensitivePort)
	}
	if len(findings) != 1 || findings[0].Severity != Critical {
		t.Errorf("got %+v, want one Critical finding", findings)
	}
}

func TestHetznerFirewallFindings_OtherPortOpenToInternet_Warning(t *testing.T) {
	firewalls := []hetznerFirewall{
		{
			Name:      "fw-web",
			Rules:     []hetznerFirewallRule{{Direction: "in", Protocol: "tcp", Port: "8080", SourceIPs: []string{"0.0.0.0/0"}}},
			AppliedTo: []hetznerFirewallTarget{{Type: "server"}},
		},
	}
	summary := &HetznerFirewallSummary{}
	findings := hetznerFirewallFindings(firewalls, summary)

	if summary.OpenOtherPort != 1 {
		t.Errorf("OpenOtherPort = %d, want 1", summary.OpenOtherPort)
	}
	if len(findings) != 1 || findings[0].Severity != Warning {
		t.Errorf("got %+v, want one Warning finding", findings)
	}
}

func TestHetznerFirewallFindings_RestrictedSourceProducesNoRuleFinding(t *testing.T) {
	firewalls := []hetznerFirewall{
		{
			Name:      "fw-restricted",
			Rules:     []hetznerFirewallRule{{Direction: "in", Protocol: "tcp", Port: "22", SourceIPs: []string{"10.0.0.0/8"}}},
			AppliedTo: []hetznerFirewallTarget{{Type: "server"}},
		},
	}
	findings := hetznerFirewallFindings(firewalls, &HetznerFirewallSummary{})
	if len(findings) != 0 {
		t.Errorf("got %+v, want no findings for a restricted-source rule", findings)
	}
}

func TestHetznerFirewallFindings_OutboundRuleIgnored(t *testing.T) {
	firewalls := []hetznerFirewall{
		{
			Name:      "fw-egress",
			Rules:     []hetznerFirewallRule{{Direction: "out", Protocol: "tcp", Port: "443", SourceIPs: []string{"0.0.0.0/0"}}},
			AppliedTo: []hetznerFirewallTarget{{Type: "server"}},
		},
	}
	findings := hetznerFirewallFindings(firewalls, &HetznerFirewallSummary{})
	if len(findings) != 0 {
		t.Errorf("got %+v, want outbound rules to be ignored", findings)
	}
}

func TestHetznerFirewallFindings_Unused(t *testing.T) {
	firewalls := []hetznerFirewall{{Name: "fw-orphan", AppliedTo: nil}}
	summary := &HetznerFirewallSummary{}
	findings := hetznerFirewallFindings(firewalls, summary)

	if summary.UnusedFirewalls != 1 {
		t.Errorf("UnusedFirewalls = %d, want 1", summary.UnusedFirewalls)
	}
	if len(findings) != 1 || findings[0].Category != "Unused Firewall" {
		t.Errorf("got %+v, want one Unused Firewall finding", findings)
	}
}

// ---------- hetzner-certificates ----------

func TestHetznerCertificateFindings_Expired(t *testing.T) {
	certs := []hetznerCertificate{{Name: "cert-old", NotValidAfter: nowMinusDays(5)}}
	summary := &HetznerCertificateSummary{}
	findings := hetznerCertificateFindings(certs, summary)

	if summary.Expired != 1 {
		t.Errorf("Expired = %d, want 1", summary.Expired)
	}
	if len(findings) != 1 || findings[0].Category != "Expired Certificate" {
		t.Errorf("got %+v, want one Expired Certificate finding", findings)
	}
}

func TestHetznerCertificateFindings_ExpiringWithin30Days(t *testing.T) {
	certs := []hetznerCertificate{{Name: "cert-soon", NotValidAfter: nowPlusDays(10)}}
	findings := hetznerCertificateFindings(certs, &HetznerCertificateSummary{})
	if len(findings) != 1 || findings[0].Severity != Critical {
		t.Errorf("got %+v, want one Critical finding for a cert expiring in 10 days", findings)
	}
}

func TestHetznerCertificateFindings_HealthyCertProducesNoExpiryFinding(t *testing.T) {
	certs := []hetznerCertificate{{Name: "cert-healthy", NotValidAfter: nowPlusDays(200)}}
	findings := hetznerCertificateFindings(certs, &HetznerCertificateSummary{})
	if len(findings) != 0 {
		t.Errorf("got %+v, want no findings for a cert expiring in 200 days", findings)
	}
}

func TestHetznerCertificateFindings_IssuanceFailed(t *testing.T) {
	certs := []hetznerCertificate{{
		Name:          "cert-managed",
		NotValidAfter: nowPlusDays(200),
		Status:        &hetznerCertStatus{Issuance: "failed"},
	}}
	summary := &HetznerCertificateSummary{}
	findings := hetznerCertificateFindings(certs, summary)

	if summary.IssuanceFailed != 1 {
		t.Errorf("IssuanceFailed = %d, want 1", summary.IssuanceFailed)
	}
	found := false
	for _, f := range findings {
		if f.Category == "Certificate Issuance Failed" && f.Severity == Critical {
			found = true
		}
	}
	if !found {
		t.Errorf("got %+v, want a Critical Certificate Issuance Failed finding", findings)
	}
}

func TestHetznerCertificateFindings_RenewalFailed(t *testing.T) {
	certs := []hetznerCertificate{{
		Name:          "cert-managed-2",
		NotValidAfter: nowPlusDays(200),
		Status:        &hetznerCertStatus{Issuance: "completed", Renewal: "failed"},
	}}
	summary := &HetznerCertificateSummary{}
	findings := hetznerCertificateFindings(certs, summary)

	if summary.RenewalFailed != 1 {
		t.Errorf("RenewalFailed = %d, want 1", summary.RenewalFailed)
	}
	found := false
	for _, f := range findings {
		if f.Category == "Certificate Renewal Failed" && f.Severity == Warning {
			found = true
		}
	}
	if !found {
		t.Errorf("got %+v, want a Warning Certificate Renewal Failed finding", findings)
	}
}

// ---------- fixture time helpers ----------

func nowMinusDays(d int) string {
	return time.Now().AddDate(0, 0, -d).UTC().Format("2006-01-02T15:04:05Z07:00")
}

func nowPlusDays(d int) string {
	return time.Now().AddDate(0, 0, d).UTC().Format("2006-01-02T15:04:05Z07:00")
}
