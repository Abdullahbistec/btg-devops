package security_analyzers_test

import (
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/network/armnetwork/v4"
	"github.com/chanbistec/btg-devops/cmd"
	"github.com/stretchr/testify/assert"
)

func nsgWithRule(name, ruleName string, access armnetwork.SecurityRuleAccess, direction armnetwork.SecurityRuleDirection, protocol armnetwork.SecurityRuleProtocol, src, dstPort string) *armnetwork.SecurityGroup {
	id := "/subscriptions/sub/resourceGroups/rg-test/providers/Microsoft.Network/networkSecurityGroups/" + name
	return &armnetwork.SecurityGroup{
		Name: strPtr(name),
		ID:   strPtr(id),
		Properties: &armnetwork.SecurityGroupPropertiesFormat{
			Subnets: []*armnetwork.Subnet{{ID: strPtr("subnet1")}}, // associated
			SecurityRules: []*armnetwork.SecurityRule{
				{
					Name: strPtr(ruleName),
					Properties: &armnetwork.SecurityRulePropertiesFormat{
						Access:                   &access,
						Direction:                &direction,
						Protocol:                 &protocol,
						SourceAddressPrefix:      strPtr(src),
						DestinationPortRange:     strPtr(dstPort),
						Priority:                 int32Ptr(100),
						DestinationAddressPrefix: strPtr("*"),
					},
				},
			},
		},
	}
}

func TestAnalyzeNSGFindings(t *testing.T) {
	inbound := armnetwork.SecurityRuleDirectionInbound
	allow := armnetwork.SecurityRuleAccessAllow
	deny := armnetwork.SecurityRuleAccessDeny
	asterisk := armnetwork.SecurityRuleProtocolAsterisk
	tcp := armnetwork.SecurityRuleProtocolTCP

	tests := []struct {
		name          string
		nsgs          []*armnetwork.SecurityGroup
		expectedCount int
		checkFindings func(t *testing.T, findings []cmd.NSGFinding)
	}{
		{
			name:          "Empty NSG list returns no findings",
			nsgs:          []*armnetwork.SecurityGroup{},
			expectedCount: 0,
		},
		{
			name: "NSG with nil properties is skipped",
			nsgs: []*armnetwork.SecurityGroup{
				{Name: strPtr("nsg1"), ID: strPtr("/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Network/networkSecurityGroups/nsg1"), Properties: nil},
			},
			expectedCount: 0,
		},
		{
			name: "Unassociated NSG is Warning",
			nsgs: []*armnetwork.SecurityGroup{
				{
					Name: strPtr("nsg1"),
					ID:   strPtr("/subscriptions/sub/resourceGroups/rg-test/providers/Microsoft.Network/networkSecurityGroups/nsg1"),
					Properties: &armnetwork.SecurityGroupPropertiesFormat{
						Subnets:           []*armnetwork.Subnet{},
						NetworkInterfaces: []*armnetwork.Interface{},
					},
				},
			},
			expectedCount: 1,
			checkFindings: func(t *testing.T, findings []cmd.NSGFinding) {
				assert.Equal(t, "Unassociated NSG", findings[0].Category)
				assert.Equal(t, cmd.Warning, findings[0].Severity)
			},
		},
		{
			name: "Any-any allow rule from internet is Critical",
			nsgs: []*armnetwork.SecurityGroup{nsgWithRule("nsg1", "rule1", allow, inbound, asterisk, "*", "*")},
			checkFindings: func(t *testing.T, findings []cmd.NSGFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Any-Any Allow Rule" {
						found = true
						assert.Equal(t, cmd.Critical, f.Severity)
					}
				}
				assert.True(t, found, "expected Any-Any Allow Rule finding")
			},
		},
		{
			name: "SSH port 22 open to internet is Critical",
			nsgs: []*armnetwork.SecurityGroup{nsgWithRule("nsg1", "allow-ssh", allow, inbound, tcp, "*", "22")},
			checkFindings: func(t *testing.T, findings []cmd.NSGFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Management Port Open to Internet" {
						found = true
						assert.Equal(t, cmd.Critical, f.Severity)
						assert.Contains(t, f.Description, "22")
					}
				}
				assert.True(t, found, "expected Management Port finding for SSH")
			},
		},
		{
			name: "RDP port 3389 open to internet is Critical",
			nsgs: []*armnetwork.SecurityGroup{nsgWithRule("nsg1", "allow-rdp", allow, inbound, tcp, "*", "3389")},
			checkFindings: func(t *testing.T, findings []cmd.NSGFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Management Port Open to Internet" {
						found = true
						assert.Equal(t, cmd.Critical, f.Severity)
					}
				}
				assert.True(t, found, "expected Management Port finding for RDP")
			},
		},
		{
			name: "Deny rule does not produce findings",
			nsgs: []*armnetwork.SecurityGroup{nsgWithRule("nsg1", "deny-all", deny, inbound, asterisk, "*", "*")},
			checkFindings: func(t *testing.T, findings []cmd.NSGFinding) {
				for _, f := range findings {
					assert.NotEqual(t, "Any-Any Allow Rule", f.Category, "deny rule should not flag Any-Any")
				}
			},
		},
		{
			name: "Non-dangerous port from internet is Warning",
			nsgs: []*armnetwork.SecurityGroup{nsgWithRule("nsg1", "allow-http", allow, inbound, tcp, "*", "80")},
			checkFindings: func(t *testing.T, findings []cmd.NSGFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Internet-Facing Rule" {
						found = true
						assert.Equal(t, cmd.Warning, f.Severity)
					}
				}
				assert.True(t, found, "expected Internet-Facing Rule finding")
			},
		},
		{
			name: "Restricted source address does not flag internet rules",
			nsgs: []*armnetwork.SecurityGroup{nsgWithRule("nsg1", "allow-specific", allow, inbound, tcp, "10.0.0.0/8", "22")},
			checkFindings: func(t *testing.T, findings []cmd.NSGFinding) {
				for _, f := range findings {
					assert.NotEqual(t, "Management Port Open to Internet", f.Category)
				}
			},
		},
		{
			name: "Finding fields are populated",
			nsgs: []*armnetwork.SecurityGroup{nsgWithRule("my-nsg", "bad-rule", allow, inbound, asterisk, "*", "*")},
			checkFindings: func(t *testing.T, findings []cmd.NSGFinding) {
				found := false
				for _, f := range findings {
					if f.Category == "Any-Any Allow Rule" {
						found = true
						assert.Equal(t, "my-nsg", f.NSGName)
						assert.NotEmpty(t, f.ResourceGroup)
						assert.NotEmpty(t, f.Description)
						assert.NotEmpty(t, f.Recommendation)
					}
				}
				assert.True(t, found)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			findings := cmd.AnalyzeNSGFindings(tt.nsgs)
			if tt.expectedCount > 0 {
				assert.Equal(t, tt.expectedCount, len(findings))
			}
			if tt.checkFindings != nil {
				tt.checkFindings(t, findings)
			}
		})
	}
}
