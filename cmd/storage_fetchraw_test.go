package cmd

import "testing"

// This test only confirms the function signatures exist and that
// analyzeStorageAccounts on an empty input produces an empty, non-nil
// report — the existing analysis logic itself is unit-tested by
// Phase 2's testable-function port (a separate, already-planned effort),
// not duplicated here.
func TestAnalyzeStorageAccounts_EmptyInput(t *testing.T) {
	report := analyzeStorageAccounts(nil, nil, nil)
	if report.Summary.TotalAccounts != 0 {
		t.Errorf("expected 0 accounts for nil input, got %d", report.Summary.TotalAccounts)
	}
	if len(report.Findings) != 0 {
		t.Errorf("expected no findings for nil input, got %d", len(report.Findings))
	}
}
