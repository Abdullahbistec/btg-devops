package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
)

// HandoffFinding is the wire shape submit_findings writes and per-service
// callers of WaitForHandoff convert into their own XFinding struct.
type HandoffFinding struct {
	Service        string  `json:"service"`
	Resource       string  `json:"resource"`
	Severity       string  `json:"severity"`
	Category       string  `json:"category"`
	Description    string  `json:"description"`
	Recommendation string  `json:"recommendation"`
	Confidence     float64 `json:"confidence"`
	Reasoning      string  `json:"reasoning"`
}

// NewHandoffRequest generates a fresh request ID and the temp file path
// submit_findings will write to for that ID. Call this before spawning
// claude -p; embed the returned requestID in the prompt so the spawned
// agent knows what to pass to submit_findings.
func HandoffResultPath(requestID string) string {
	return filepath.Join(os.TempDir(), "btg-handoff-"+requestID+".json")
}

func NewHandoffRequest() (requestID string, resultPath string) {
	id := uuid.NewString()
	return id, HandoffResultPath(id)
}

// WaitForHandoff polls for resultPath every 250ms until it appears (parsed
// and returned) or timeout elapses (returns an error — callers treat this
// as "Claude failed", triggering their own rule-based fallback).
func WaitForHandoff(resultPath string, timeout time.Duration) ([]HandoffFinding, error) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(resultPath)
		if err == nil {
			defer os.Remove(resultPath)
			var findings []HandoffFinding
			if jerr := json.Unmarshal(data, &findings); jerr != nil {
				return nil, fmt.Errorf("handoff file had invalid JSON: %w", jerr)
			}
			return findings, nil
		}
		time.Sleep(250 * time.Millisecond)
	}
	return nil, fmt.Errorf("timed out after %s waiting for handoff file %s", timeout, resultPath)
}

// writeHandoffResult is called by the submit_findings MCP tool handler —
// it writes the file WaitForHandoff is polling for.
func writeHandoffResult(resultPath string, findings []HandoffFinding) error {
	data, err := json.Marshal(findings)
	if err != nil {
		return fmt.Errorf("marshaling handoff findings: %w", err)
	}
	return os.WriteFile(resultPath, data, 0600)
}

// validateRequestID ensures the request_id is a well-formed UUID, preventing
// path traversal attacks where a compromised/hallucinating claude process or
// malicious MCP client might pass path-traversal sequences like "../../../etc/passwd"
// into HandoffResultPath's filepath.Join.
func validateRequestID(requestID string) error {
	_, err := uuid.Parse(requestID)
	if err != nil {
		return fmt.Errorf("request_id must be a valid UUID, got %q: %w", requestID, err)
	}
	return nil
}
