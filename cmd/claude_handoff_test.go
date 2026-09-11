package cmd

import (
	"os"
	"testing"
	"time"
)

func TestNewHandoffRequest_GeneratesUniquePaths(t *testing.T) {
	id1, path1 := NewHandoffRequest()
	id2, path2 := NewHandoffRequest()
	if id1 == id2 {
		t.Error("expected two calls to generate different request IDs")
	}
	if path1 == path2 {
		t.Error("expected two calls to generate different result paths")
	}
}

func TestWaitForHandoff_ReturnsFindingsOnceFileAppears(t *testing.T) {
	_, path := NewHandoffRequest()
	defer os.Remove(path)

	go func() {
		time.Sleep(100 * time.Millisecond)
		writeHandoffFile(t, path, `[{"service":"storage","resource":"acct1","severity":"Critical","category":"HTTPS Not Enforced","description":"d","recommendation":"r","confidence":0.9,"reasoning":"why"}]`)
	}()

	findings, err := WaitForHandoff(path, 2*time.Second)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(findings) != 1 {
		t.Fatalf("expected 1 finding, got %d", len(findings))
	}
	if findings[0].Confidence != 0.9 {
		t.Errorf("expected confidence 0.9, got %v", findings[0].Confidence)
	}
}

func TestWaitForHandoff_TimesOutIfFileNeverAppears(t *testing.T) {
	_, path := NewHandoffRequest()
	_, err := WaitForHandoff(path, 300*time.Millisecond)
	if err == nil {
		t.Fatal("expected a timeout error, got nil")
	}
}

func writeHandoffFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatalf("failed to write test handoff file: %v", err)
	}
}

func TestValidateRequestID_RejectsPathTraversal(t *testing.T) {
	tests := []string{
		"../../etc/passwd",
		"../../../sensitive",
		"..\\..\\windows\\system32",
		"..",
		"....",
		"/etc/passwd",
		"~/.ssh/id_rsa",
	}
	for _, requestID := range tests {
		if err := validateRequestID(requestID); err == nil {
			t.Errorf("validateRequestID(%q) should reject path-traversal attempt, got no error", requestID)
		}
	}
}

func TestValidateRequestID_AcceptsValidUUID(t *testing.T) {
	// uuid.NewString() generates valid UUIDs like "550e8400-e29b-41d4-a716-446655440000"
	id, _ := NewHandoffRequest()
	if err := validateRequestID(id); err != nil {
		t.Errorf("validateRequestID should accept valid UUID %q, got error: %v", id, err)
	}
}
