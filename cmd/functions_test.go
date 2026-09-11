package cmd

import "testing"

// These tests exercise AnalyzeFunctionsData, the pure analyzer function that
// runs Function App checks against pre-built input — no Azure calls, matching
// the existing acr_test.go / appserviceplan_test.go style.

func TestAnalyzeFunctionsData_OldRuntimeVersion(t *testing.T) {
	inputs := []FunctionAppInput{
		{
			Name:               "old-func-app",
			ResourceGroup:      "rg1",
			HTTPSOnly:          true,
			HasManagedIdentity: true,
			ExtensionVersion:   "~4",
			Runtime:            "node",
			RuntimeVersion:     "~14",
			IsConsumptionPlan:  true,
			MinTLSVersion:      "1.2",
			FtpsState:          "Disabled",
			State:              "Running",
		},
	}

	findings := AnalyzeFunctionsData(inputs)

	found := false
	for _, f := range findings {
		if f.Category == "Runtime Version" {
			found = true
		}
	}
	if !found {
		t.Error("expected a Runtime Version finding for outdated node ~14, got none")
	}
}

func TestAnalyzeFunctionsData_OutdatedExtensionVersionCritical(t *testing.T) {
	inputs := []FunctionAppInput{
		{
			Name:               "old-ext-func-app",
			ResourceGroup:      "rg1",
			HTTPSOnly:          true,
			HasManagedIdentity: true,
			ExtensionVersion:   "~2",
			IsConsumptionPlan:  true,
			MinTLSVersion:      "1.2",
			FtpsState:          "Disabled",
			State:              "Running",
		},
	}

	findings := AnalyzeFunctionsData(inputs)

	found := false
	for _, f := range findings {
		if f.Category == "Outdated Runtime Version" {
			found = true
			if f.Severity != Critical {
				t.Errorf("expected Critical severity for extension version ~2, got %v", f.Severity)
			}
		}
	}
	if !found {
		t.Error("expected an Outdated Runtime Version finding for extension version ~2, got none")
	}
}

func TestAnalyzeFunctionsData_HTTPSNotEnforced(t *testing.T) {
	inputs := []FunctionAppInput{
		{
			Name:               "http-func-app",
			ResourceGroup:      "rg1",
			HTTPSOnly:          false,
			HasManagedIdentity: true,
			IsConsumptionPlan:  true,
			MinTLSVersion:      "1.2",
			State:              "Running",
		},
	}

	findings := AnalyzeFunctionsData(inputs)

	found := false
	for _, f := range findings {
		if f.Category == "HTTPS Not Enforced" {
			found = true
		}
	}
	if !found {
		t.Error("expected an HTTPS Not Enforced finding, got none")
	}
}

func TestAnalyzeFunctionsData_NoManagedIdentity(t *testing.T) {
	inputs := []FunctionAppInput{
		{
			Name:               "no-identity-func-app",
			ResourceGroup:      "rg1",
			HTTPSOnly:          true,
			HasManagedIdentity: false,
			IsConsumptionPlan:  true,
			MinTLSVersion:      "1.2",
			State:              "Running",
		},
	}

	findings := AnalyzeFunctionsData(inputs)

	found := false
	for _, f := range findings {
		if f.Category == "No Managed Identity" {
			found = true
		}
	}
	if !found {
		t.Error("expected a No Managed Identity finding, got none")
	}
}

func TestAnalyzeFunctionsData_AlwaysOnDisabledOnDedicatedPlan(t *testing.T) {
	inputs := []FunctionAppInput{
		{
			Name:               "dedicated-func-app",
			ResourceGroup:      "rg1",
			HTTPSOnly:          true,
			HasManagedIdentity: true,
			IsConsumptionPlan:  false,
			AlwaysOn:           false,
			MinTLSVersion:      "1.2",
			State:              "Running",
		},
	}

	findings := AnalyzeFunctionsData(inputs)

	found := false
	for _, f := range findings {
		if f.Category == "Always-On Disabled" {
			found = true
		}
	}
	if !found {
		t.Error("expected an Always-On Disabled finding for a dedicated plan with AlwaysOn=false, got none")
	}
}

func TestAnalyzeFunctionsData_ConsumptionPlanInfo(t *testing.T) {
	inputs := []FunctionAppInput{
		{
			Name:               "consumption-func-app",
			ResourceGroup:      "rg1",
			HTTPSOnly:          true,
			HasManagedIdentity: true,
			IsConsumptionPlan:  true,
			MinTLSVersion:      "1.2",
			State:              "Running",
		},
	}

	findings := AnalyzeFunctionsData(inputs)

	found := false
	for _, f := range findings {
		if f.Category == "Consumption Plan" {
			found = true
			if f.Severity != Info {
				t.Errorf("expected Info severity for Consumption Plan finding, got %v", f.Severity)
			}
		}
	}
	if !found {
		t.Error("expected a Consumption Plan finding, got none")
	}
}

func TestAnalyzeFunctionsData_PremiumWithoutVNET(t *testing.T) {
	inputs := []FunctionAppInput{
		{
			Name:               "premium-func-app",
			ResourceGroup:      "rg1",
			HTTPSOnly:          true,
			HasManagedIdentity: true,
			IsPremiumPlan:      true,
			HasVNETIntegration: false,
			AlwaysOn:           true,
			MinTLSVersion:      "1.2",
			State:              "Running",
		},
	}

	findings := AnalyzeFunctionsData(inputs)

	found := false
	for _, f := range findings {
		if f.Category == "Premium Without VNET" {
			found = true
		}
	}
	if !found {
		t.Error("expected a Premium Without VNET finding, got none")
	}
}

func TestAnalyzeFunctionsData_OutdatedTLSVersion(t *testing.T) {
	inputs := []FunctionAppInput{
		{
			Name:               "old-tls-func-app",
			ResourceGroup:      "rg1",
			HTTPSOnly:          true,
			HasManagedIdentity: true,
			IsConsumptionPlan:  true,
			MinTLSVersion:      "1.0",
			State:              "Running",
		},
	}

	findings := AnalyzeFunctionsData(inputs)

	found := false
	for _, f := range findings {
		if f.Category == "Outdated TLS Version" {
			found = true
		}
	}
	if !found {
		t.Error("expected an Outdated TLS Version finding for TLS 1.0, got none")
	}
}

func TestAnalyzeFunctionsData_NotRunning(t *testing.T) {
	inputs := []FunctionAppInput{
		{
			Name:               "stopped-func-app",
			ResourceGroup:      "rg1",
			HTTPSOnly:          true,
			HasManagedIdentity: true,
			IsConsumptionPlan:  true,
			MinTLSVersion:      "1.2",
			State:              "Stopped",
		},
	}

	findings := AnalyzeFunctionsData(inputs)

	found := false
	for _, f := range findings {
		if f.Category == "Not Running" {
			found = true
		}
	}
	if !found {
		t.Error("expected a Not Running finding for state=Stopped, got none")
	}
}

func TestAnalyzeFunctionsData_RemoteDebuggingEnabled(t *testing.T) {
	inputs := []FunctionAppInput{
		{
			Name:                   "debug-func-app",
			ResourceGroup:          "rg1",
			HTTPSOnly:              true,
			HasManagedIdentity:     true,
			IsConsumptionPlan:      true,
			MinTLSVersion:          "1.2",
			State:                  "Running",
			RemoteDebuggingEnabled: true,
		},
	}

	findings := AnalyzeFunctionsData(inputs)

	found := false
	for _, f := range findings {
		if f.Category == "Remote Debugging Enabled" {
			found = true
			if f.Severity != Critical {
				t.Errorf("expected Critical severity for remote debugging, got %v", f.Severity)
			}
		}
	}
	if !found {
		t.Error("expected a Remote Debugging Enabled finding, got none")
	}
}

func TestAnalyzeFunctionsData_FTPAllowed(t *testing.T) {
	inputs := []FunctionAppInput{
		{
			Name:               "ftp-func-app",
			ResourceGroup:      "rg1",
			HTTPSOnly:          true,
			HasManagedIdentity: true,
			IsConsumptionPlan:  true,
			MinTLSVersion:      "1.2",
			State:              "Running",
			FtpsState:          "AllAllowed",
		},
	}

	findings := AnalyzeFunctionsData(inputs)

	found := false
	for _, f := range findings {
		if f.Category == "FTP Allowed" {
			found = true
		}
	}
	if !found {
		t.Error("expected an FTP Allowed finding for FtpsState=AllAllowed, got none")
	}
}

func TestAnalyzeFunctionsData_CleanAppNoFindings(t *testing.T) {
	inputs := []FunctionAppInput{
		{
			Name:               "clean-func-app",
			ResourceGroup:      "rg1",
			HTTPSOnly:          true,
			HasManagedIdentity: true,
			ExtensionVersion:   "~4",
			Runtime:            "node",
			RuntimeVersion:     "~20",
			AlwaysOn:           true,
			IsConsumptionPlan:  false,
			IsPremiumPlan:      false,
			MinTLSVersion:      "1.2",
			State:              "Running",
			FtpsState:          "Disabled",
		},
	}

	findings := AnalyzeFunctionsData(inputs)

	if len(findings) != 0 {
		t.Errorf("expected no findings for a fully-compliant function app, got %d: %+v", len(findings), findings)
	}
}
