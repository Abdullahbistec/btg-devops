package provider

import (
	"context"
	"errors"
	"testing"
)

// resetRegistry gives each test its own clean slate — the real registry is a
// package-level var shared by every cmd/*.go init() in the real binary, so
// tests must not leak state into each other.
func resetRegistry(t *testing.T) {
	t.Helper()
	old := registry
	registry = map[string][]Analyzer{}
	t.Cleanup(func() { registry = old })
}

type stubAnalyzer struct {
	name     string
	findings []Finding
	err      error
	panics   bool
}

func (s stubAnalyzer) Name() string { return s.name }

func (s stubAnalyzer) Run(ctx context.Context) ([]Finding, error) {
	if s.panics {
		panic("boom")
	}
	return s.findings, s.err
}

func TestRegister_ScopesByProvider(t *testing.T) {
	resetRegistry(t)
	Register("azure", stubAnalyzer{name: "storage"})
	Register("azure", stubAnalyzer{name: "iam"})
	Register("hetzner", stubAnalyzer{name: "volumes"})

	if got := len(Analyzers("azure")); got != 2 {
		t.Errorf("Analyzers(azure) len = %d, want 2", got)
	}
	if got := len(Analyzers("hetzner")); got != 1 {
		t.Errorf("Analyzers(hetzner) len = %d, want 1", got)
	}
	if got := len(Analyzers("nonexistent")); got != 0 {
		t.Errorf("Analyzers(nonexistent) len = %d, want 0", got)
	}
}

func TestProviders_ListsRegisteredNames(t *testing.T) {
	resetRegistry(t)
	Register("azure", stubAnalyzer{name: "storage"})
	Register("hetzner", stubAnalyzer{name: "volumes"})

	got := map[string]bool{}
	for _, p := range Providers() {
		got[p] = true
	}
	if !got["azure"] || !got["hetzner"] {
		t.Errorf("Providers() = %v, want to contain azure and hetzner", Providers())
	}
}

func TestRun_MergesFindingsAcrossAnalyzers(t *testing.T) {
	resetRegistry(t)
	Register("azure", stubAnalyzer{name: "a", findings: []Finding{{Service: "A"}}})
	Register("azure", stubAnalyzer{name: "b", findings: []Finding{{Service: "B1"}, {Service: "B2"}}})

	result := Run(context.Background(), "azure")
	if len(result.Findings) != 3 {
		t.Errorf("Run() merged %d findings, want 3", len(result.Findings))
	}
	if len(result.Errors) != 0 {
		t.Errorf("Run() Errors = %v, want none", result.Errors)
	}
}

func TestRun_OneAnalyzerErrorDoesNotStopOthers(t *testing.T) {
	resetRegistry(t)
	Register("azure", stubAnalyzer{name: "failing", err: errors.New("boom")})
	Register("azure", stubAnalyzer{name: "ok", findings: []Finding{{Service: "OK"}}})

	result := Run(context.Background(), "azure")
	if len(result.Findings) != 1 || result.Findings[0].Service != "OK" {
		t.Errorf("Run() Findings = %v, want [{Service: OK}]", result.Findings)
	}
	if len(result.Errors) != 1 {
		t.Fatalf("Run() Errors len = %d, want 1", len(result.Errors))
	}
	if result.Errors[0].Error() != "failing: boom" {
		t.Errorf("Run() Errors[0] = %q, want %q", result.Errors[0].Error(), "failing: boom")
	}
}

func TestRun_PanicIsConvertedToError(t *testing.T) {
	resetRegistry(t)
	Register("azure", stubAnalyzer{name: "panicky", panics: true})
	Register("azure", stubAnalyzer{name: "ok", findings: []Finding{{Service: "OK"}}})

	result := Run(context.Background(), "azure")
	if len(result.Findings) != 1 {
		t.Errorf("Run() Findings len = %d, want 1 (panicking analyzer should not stop the rest)", len(result.Findings))
	}
	if len(result.Errors) != 1 {
		t.Fatalf("Run() Errors len = %d, want 1", len(result.Errors))
	}
}
