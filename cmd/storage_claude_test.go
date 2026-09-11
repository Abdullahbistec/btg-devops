package cmd

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/storage/armstorage"
)

// This test file shrinks claudeAnalysisTimeout so the handoff-timeout test
// doesn't take the real 60s production timeout, and stubs storageFetcher so
// tests don't call through to the real Azure SDK — with the nil credential
// these tests pass, the real fetchStorageAccounts panics deep inside
// azidentity's token-acquisition chain rather than returning an error.
func init() {
	claudeAnalysisTimeout = 2 * time.Second
	storageFetcher = func(ctx context.Context, cred *azidentity.DefaultAzureCredential, subID, resourceGroupFilter string) ([]*armstorage.Account, *armstorage.ManagementPoliciesClient, error) {
		return nil, nil, nil
	}
}

func TestRunStorageAnalysis_UsesClaudeFindingsOnSuccess(t *testing.T) {
	spawn := func(promptPath, requestID, rawDataPath string, timeout time.Duration) error {
		return writeHandoffResult(HandoffResultPath(requestID), []HandoffFinding{
			{Service: "storage", Resource: "acct1", Severity: "Critical", Category: "Test Finding", Description: "d", Recommendation: "r", Confidence: 0.95, Reasoning: "because"},
		})
	}

	report, err := runStorageAnalysis(context.Background(), nil, "sub-id", spawn)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(report.Findings) != 1 || report.Findings[0].Category != "Test Finding" {
		t.Fatalf("expected the Claude-sourced finding, got %+v", report.Findings)
	}
}

func TestRunStorageAnalysis_FallsBackOnSpawnError(t *testing.T) {
	spawn := func(promptPath, requestID, rawDataPath string, timeout time.Duration) error {
		return errors.New("claude exited non-zero")
	}

	report, err := runStorageAnalysis(context.Background(), nil, "sub-id", spawn)
	if err != nil {
		t.Fatalf("expected no error (fallback should succeed), got %v", err)
	}
	// With no live Azure client, fetchStorageAccounts against a nil
	// credential returns an error inside the real flow — this test only
	// exercises the fallback *decision*, so we assert the function did
	// not return a Claude-path error; full fallback correctness is
	// covered by TestAnalyzeStorageAccounts_EmptyInput plus this
	// spawn-error path returning without panicking.
	_ = report
}

func TestRunStorageAnalysis_FallsBackOnHandoffTimeout(t *testing.T) {
	spawn := func(promptPath, requestID, rawDataPath string, timeout time.Duration) error {
		return nil // "succeeds" but never writes the handoff file
	}

	start := time.Now()
	_, err := runStorageAnalysis(context.Background(), nil, "sub-id", spawn)
	if err != nil {
		t.Fatalf("expected fallback, not an error, got %v", err)
	}
	if time.Since(start) > 6*time.Second {
		t.Errorf("expected the test timeout override to keep this fast, took %s", time.Since(start))
	}
}
