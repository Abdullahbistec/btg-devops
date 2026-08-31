package cmd

import "testing"

// These tests exercise AnalyzeRGFindings, the pure analyzer function that
// runs resource group checks against pre-fetched data — no Azure calls,
// matching the existing acr_test.go / pp_test.go / idle_test.go style.

func TestAnalyzeRGFindings_EmptyResourceGroup(t *testing.T) {
	rgs := []RGInput{
		{
			Name:     "rg-empty-test",
			Location: "eastus",
			Tags:     map[string]*string{},
			IsEmpty:  true,
			HasLock:  false,
		},
	}

	findings := AnalyzeRGFindings(rgs)

	found := false
	for _, f := range findings {
		if f.Category == "Empty Resource Group" {
			found = true
			if f.Severity != Warning {
				t.Errorf("expected Warning severity for empty resource group, got %v", f.Severity)
			}
		}
	}
	if !found {
		t.Error("expected an Empty Resource Group finding, got none")
	}
}

func TestAnalyzeRGFindings_TagCompliance_NoTagsAtAllIsCritical(t *testing.T) {
	rgs := []RGInput{
		{
			Name:     "rg-no-tags",
			Location: "eastus",
			Tags:     map[string]*string{},
			IsEmpty:  false,
			HasLock:  true,
		},
	}

	findings := AnalyzeRGFindings(rgs)

	found := false
	for _, f := range findings {
		if f.Category == "Tag Compliance" {
			found = true
			if f.Severity != Critical {
				t.Errorf("expected Critical severity when no tags at all, got %v", f.Severity)
			}
		}
	}
	if !found {
		t.Error("expected a Tag Compliance finding when no tags present, got none")
	}
}

func TestAnalyzeRGFindings_TagCompliance_PartialTagsIsWarning(t *testing.T) {
	rgs := []RGInput{
		{
			Name:     "rg-partial-tags",
			Location: "eastus",
			Tags: map[string]*string{
				"environment": strPtr("prod"),
			},
			IsEmpty: false,
			HasLock: true,
		},
	}

	findings := AnalyzeRGFindings(rgs)

	found := false
	for _, f := range findings {
		if f.Category == "Tag Compliance" {
			found = true
			if f.Severity != Warning {
				t.Errorf("expected Warning severity for partially-tagged RG, got %v", f.Severity)
			}
		}
	}
	if !found {
		t.Error("expected a Tag Compliance finding for missing owner/project tags, got none")
	}
}

func TestAnalyzeRGFindings_TagCompliance_AllTagsPresentNoFinding(t *testing.T) {
	rgs := []RGInput{
		{
			Name:     "rg-fully-tagged",
			Location: "eastus",
			Tags: map[string]*string{
				"environment": strPtr("prod"),
				"owner":       strPtr("team-a"),
				"project":     strPtr("proj-x"),
			},
			IsEmpty: false,
			HasLock: true,
		},
	}

	findings := AnalyzeRGFindings(rgs)

	for _, f := range findings {
		if f.Category == "Tag Compliance" {
			t.Errorf("expected no Tag Compliance finding when all required tags present, got %+v", f)
		}
	}
}

func TestAnalyzeRGFindings_NamingConvention(t *testing.T) {
	rgs := []RGInput{
		{
			Name:     "RG_Bad_Name!",
			Location: "eastus",
			Tags: map[string]*string{
				"environment": strPtr("prod"),
				"owner":       strPtr("team-a"),
				"project":     strPtr("proj-x"),
			},
			IsEmpty: false,
			HasLock: true,
		},
	}

	findings := AnalyzeRGFindings(rgs)

	found := false
	for _, f := range findings {
		if f.Category == "Naming Convention" {
			found = true
			if f.Severity != Info {
				t.Errorf("expected Info severity for naming convention violation, got %v", f.Severity)
			}
		}
	}
	if !found {
		t.Error("expected a Naming Convention finding for a non-conforming name, got none")
	}
}

func TestAnalyzeRGFindings_MissingLock(t *testing.T) {
	rgs := []RGInput{
		{
			Name:     "rg-no-lock",
			Location: "eastus",
			Tags: map[string]*string{
				"environment": strPtr("prod"),
				"owner":       strPtr("team-a"),
				"project":     strPtr("proj-x"),
			},
			IsEmpty: false,
			HasLock: false,
		},
	}

	findings := AnalyzeRGFindings(rgs)

	found := false
	for _, f := range findings {
		if f.Category == "Missing Lock" {
			found = true
			if f.Severity != Info {
				t.Errorf("expected Info severity for missing lock, got %v", f.Severity)
			}
		}
	}
	if !found {
		t.Error("expected a Missing Lock finding when HasLock is false, got none")
	}
}

func TestAnalyzeRGFindings_EmptyRGSkipsLockCheck(t *testing.T) {
	rgs := []RGInput{
		{
			Name:     "rg-empty-and-unlocked",
			Location: "eastus",
			Tags: map[string]*string{
				"environment": strPtr("prod"),
				"owner":       strPtr("team-a"),
				"project":     strPtr("proj-x"),
			},
			IsEmpty: true,
			HasLock: false,
		},
	}

	findings := AnalyzeRGFindings(rgs)

	for _, f := range findings {
		if f.Category == "Missing Lock" {
			t.Errorf("expected no Missing Lock finding for an empty resource group, got %+v", f)
		}
	}
}

func TestAnalyzeRGFindings_NoIssuesNoFindings(t *testing.T) {
	rgs := []RGInput{
		{
			Name:     "rg-clean",
			Location: "eastus",
			Tags: map[string]*string{
				"environment": strPtr("prod"),
				"owner":       strPtr("team-a"),
				"project":     strPtr("proj-x"),
			},
			IsEmpty: false,
			HasLock: true,
		},
	}

	findings := AnalyzeRGFindings(rgs)

	if len(findings) != 0 {
		t.Errorf("expected no findings for a fully compliant resource group, got %+v", findings)
	}
}
