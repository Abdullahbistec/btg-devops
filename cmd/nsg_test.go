package cmd

import (
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/network/armnetwork/v4"
)

// These tests exercise AnalyzeNSGFindings, the pure analyzer function that
// runs NSG checks against pre-fetched security groups — no Azure calls,
// matching the existing acr_test.go / keyvault_test.go style.

func TestAnalyzeNSGFindings_UnassociatedNSG(t *testing.T) {
	name := "orphan-nsg"
	nsgs := []*armnetwork.SecurityGroup{
		{
			Name: &name,
			Properties: &armnetwork.SecurityGroupPropertiesFormat{
				NetworkInterfaces: nil,
				Subnets:           nil,
			},
		},
	}

	findings := AnalyzeNSGFindings(nsgs)

	found := false
	for _, f := range findings {
		if f.Category == "Unassociated NSG" {
			found = true
			if f.Severity != Warning {
				t.Errorf("expected Warning severity for unassociated NSG, got %v", f.Severity)
			}
		}
	}
	if !found {
		t.Error("expected an Unassociated NSG finding when no interfaces/subnets attached, got none")
	}
}

func TestAnalyzeNSGFindings_NoFindingWhenAssociated(t *testing.T) {
	name := "associated-nsg"
	subnetID := "subnet-1"
	nsgs := []*armnetwork.SecurityGroup{
		{
			Name: &name,
			Properties: &armnetwork.SecurityGroupPropertiesFormat{
				Subnets: []*armnetwork.Subnet{{ID: &subnetID}},
			},
		},
	}

	findings := AnalyzeNSGFindings(nsgs)

	for _, f := range findings {
		if f.Category == "Unassociated NSG" {
			t.Errorf("did not expect an Unassociated NSG finding when a subnet is attached, got: %+v", f)
		}
	}
}

func TestAnalyzeNSGFindings_AnyAnyAllowRule(t *testing.T) {
	nsgName := "my-nsg"
	ruleName := "allow-all"
	access := armnetwork.SecurityRuleAccessAllow
	direction := armnetwork.SecurityRuleDirectionInbound
	protocol := armnetwork.SecurityRuleProtocolAsterisk
	srcAddr := "*"
	dstPort := "*"
	nsgs := []*armnetwork.SecurityGroup{
		{
			Name: &nsgName,
			Properties: &armnetwork.SecurityGroupPropertiesFormat{
				SecurityRules: []*armnetwork.SecurityRule{
					{
						Name: &ruleName,
						Properties: &armnetwork.SecurityRulePropertiesFormat{
							Access:               &access,
							Direction:            &direction,
							Protocol:             &protocol,
							SourceAddressPrefix:  &srcAddr,
							DestinationPortRange: &dstPort,
						},
					},
				},
			},
		},
	}

	findings := AnalyzeNSGFindings(nsgs)

	found := false
	for _, f := range findings {
		if f.Category == "Any-Any Allow Rule" {
			found = true
			if f.Severity != Critical {
				t.Errorf("expected Critical severity for any-any allow rule, got %v", f.Severity)
			}
		}
	}
	if !found {
		t.Error("expected an Any-Any Allow Rule finding for a rule open to all sources/ports, got none")
	}
}

func TestAnalyzeNSGFindings_ManagementPortOpenToInternet(t *testing.T) {
	nsgName := "my-nsg"
	ruleName := "allow-ssh"
	access := armnetwork.SecurityRuleAccessAllow
	direction := armnetwork.SecurityRuleDirectionInbound
	protocol := armnetwork.SecurityRuleProtocolTCP
	srcAddr := "Internet"
	dstPort := "22"
	nsgs := []*armnetwork.SecurityGroup{
		{
			Name: &nsgName,
			Properties: &armnetwork.SecurityGroupPropertiesFormat{
				SecurityRules: []*armnetwork.SecurityRule{
					{
						Name: &ruleName,
						Properties: &armnetwork.SecurityRulePropertiesFormat{
							Access:               &access,
							Direction:            &direction,
							Protocol:             &protocol,
							SourceAddressPrefix:  &srcAddr,
							DestinationPortRange: &dstPort,
						},
					},
				},
			},
		},
	}

	findings := AnalyzeNSGFindings(nsgs)

	found := false
	for _, f := range findings {
		if f.Category == "Management Port Open to Internet" {
			found = true
			if f.Severity != Critical {
				t.Errorf("expected Critical severity for management port open to internet, got %v", f.Severity)
			}
		}
	}
	if !found {
		t.Error("expected a Management Port Open to Internet finding for SSH open to Internet, got none")
	}
}

func TestAnalyzeNSGFindings_InternetFacingRule(t *testing.T) {
	nsgName := "my-nsg"
	ruleName := "allow-http"
	access := armnetwork.SecurityRuleAccessAllow
	direction := armnetwork.SecurityRuleDirectionInbound
	protocol := armnetwork.SecurityRuleProtocolTCP
	srcAddr := "0.0.0.0/0"
	dstPort := "8080"
	nsgs := []*armnetwork.SecurityGroup{
		{
			Name: &nsgName,
			Properties: &armnetwork.SecurityGroupPropertiesFormat{
				SecurityRules: []*armnetwork.SecurityRule{
					{
						Name: &ruleName,
						Properties: &armnetwork.SecurityRulePropertiesFormat{
							Access:               &access,
							Direction:            &direction,
							Protocol:             &protocol,
							SourceAddressPrefix:  &srcAddr,
							DestinationPortRange: &dstPort,
						},
					},
				},
			},
		},
	}

	findings := AnalyzeNSGFindings(nsgs)

	found := false
	for _, f := range findings {
		if f.Category == "Internet-Facing Rule" {
			found = true
			if f.Severity != Warning {
				t.Errorf("expected Warning severity for internet-facing rule, got %v", f.Severity)
			}
		}
	}
	if !found {
		t.Error("expected an Internet-Facing Rule finding for a non-management port open to the internet, got none")
	}
}

func TestAnalyzeNSGFindings_DenyRuleSkipped(t *testing.T) {
	nsgName := "my-nsg"
	ruleName := "deny-all"
	access := armnetwork.SecurityRuleAccessDeny
	direction := armnetwork.SecurityRuleDirectionInbound
	srcAddr := "*"
	dstPort := "*"
	nsgs := []*armnetwork.SecurityGroup{
		{
			Name: &nsgName,
			Properties: &armnetwork.SecurityGroupPropertiesFormat{
				SecurityRules: []*armnetwork.SecurityRule{
					{
						Name: &ruleName,
						Properties: &armnetwork.SecurityRulePropertiesFormat{
							Access:               &access,
							Direction:            &direction,
							SourceAddressPrefix:  &srcAddr,
							DestinationPortRange: &dstPort,
						},
					},
				},
			},
		},
	}

	findings := AnalyzeNSGFindings(nsgs)

	for _, f := range findings {
		if f.Category != "Unassociated NSG" {
			t.Errorf("expected no rule-based findings for a Deny rule, got: %+v", f)
		}
	}
}

func TestAnalyzeNSGFindings_OutboundRuleSkipped(t *testing.T) {
	nsgName := "my-nsg"
	ruleName := "allow-outbound"
	access := armnetwork.SecurityRuleAccessAllow
	direction := armnetwork.SecurityRuleDirectionOutbound
	srcAddr := "*"
	dstPort := "*"
	nsgs := []*armnetwork.SecurityGroup{
		{
			Name: &nsgName,
			Properties: &armnetwork.SecurityGroupPropertiesFormat{
				SecurityRules: []*armnetwork.SecurityRule{
					{
						Name: &ruleName,
						Properties: &armnetwork.SecurityRulePropertiesFormat{
							Access:               &access,
							Direction:            &direction,
							SourceAddressPrefix:  &srcAddr,
							DestinationPortRange: &dstPort,
						},
					},
				},
			},
		},
	}

	findings := AnalyzeNSGFindings(nsgs)

	for _, f := range findings {
		if f.Category != "Unassociated NSG" {
			t.Errorf("expected no rule-based findings for an Outbound rule, got: %+v", f)
		}
	}
}

func TestAnalyzeNSGFindings_NilPropertiesSkipped(t *testing.T) {
	name := "no-props-nsg"
	nsgs := []*armnetwork.SecurityGroup{
		{
			Name:       &name,
			Properties: nil,
		},
	}

	findings := AnalyzeNSGFindings(nsgs)

	if len(findings) != 0 {
		t.Errorf("expected no findings for an NSG with nil Properties, got: %+v", findings)
	}
}
