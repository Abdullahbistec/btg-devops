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
//
// ResourceGroup is a named field (rather than going through Fields) because
// it is common enough, across Azure services, to deserve first-class
// treatment. Fields is a general escape hatch for the rest — service-specific
// identifying data (IAM principals, Power Platform workspace/flow names,
// etc.) that Phase 2's other 18 services will need but that doesn't warrant
// its own named field here. It is additive and unused by storage today.
type HandoffFinding struct {
	Service        string            `json:"service"`
	Resource       string            `json:"resource"`
	ResourceGroup  string            `json:"resource_group"`
	Severity       string            `json:"severity"`
	Category       string            `json:"category"`
	Description    string            `json:"description"`
	Recommendation string            `json:"recommendation"`
	Confidence     float64           `json:"confidence"`
	Reasoning      string            `json:"reasoning"`
	Fields         map[string]string `json:"fields,omitempty"`
}

// HandoffResultPath is the single source of truth for the temp file path
// convention every caller (the MCP tool handler, per-service wiring, tests)
// uses instead of recomputing the pattern.
//
// Constraint: this mechanism requires the MCP server and the CLI process
// invoking it to share a local filesystem (same machine, or a shared mount)
// — the CLI process polls this exact path on its own local disk for the file
// submit_findings's handler writes. It will not work against a
// remote/tunneled MCP server (cmd/mcp.go's --http mode is deliberately
// reachable through a tunnel/real domain for a scheduled cloud routine — see
// its own comments): in that deployment shape every call here silently times
// out and falls back to rule-based analysis, since the two processes never
// see the same file. There is no cross-machine detection or alternate
// transport here — this is a known, accepted limitation of the current
// design, not a bug to fix in this pass.
func HandoffResultPath(requestID string) string {
	return filepath.Join(os.TempDir(), "btg-handoff-"+requestID+".json")
}

// NewHandoffRequest generates a fresh request ID and the temp file path
// submit_findings will write to for that ID. Call this before spawning
// claude -p; embed the returned requestID in the prompt so the spawned
// agent knows what to pass to submit_findings.

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
//
// Writes to a sibling ".tmp" file and renames it into place rather than
// writing resultPath directly: os.Rename is atomic within a directory on
// both Linux and Windows, so WaitForHandoff's concurrent os.ReadFile polling
// never observes a partially-written file (which, for a large findings
// array, previously risked a torn read failing JSON parsing and being
// treated as a hard Claude-analysis failure instead of a clean success).
func writeHandoffResult(resultPath string, findings []HandoffFinding) error {
	data, err := json.Marshal(findings)
	if err != nil {
		return fmt.Errorf("marshaling handoff findings: %w", err)
	}
	tmpPath := resultPath + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0600); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, resultPath); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("renaming handoff temp file into place: %w", err)
	}
	return nil
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
