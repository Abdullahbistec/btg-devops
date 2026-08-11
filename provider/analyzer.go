// Package provider defines the shared contract every provider's analyzers
// (Azure, and eventually Power Platform and Hetzner) implement, and a
// registry that runs them by provider name. It has no dependency on any
// specific provider's code — cmd/ imports provider, never the reverse.
package provider

import "context"

// Severity mirrors cmd's three-level scale. Kept separate (not imported from
// cmd) so this package has zero dependency on any provider's implementation.
type Severity string

const (
	Critical Severity = "Critical"
	Warning  Severity = "Warning"
	Info     Severity = "Info"
)

// Finding is the shape every provider's analyzers normalize into.
type Finding struct {
	Provider       string   `json:"provider"`
	Service        string   `json:"service"`
	Severity       Severity `json:"severity"`
	Category       string   `json:"category"`
	Resource       string   `json:"resource"`
	Environment    string   `json:"environment,omitempty"`
	Description    string   `json:"description"`
	Recommendation string   `json:"recommendation"`
}

// Analyzer is implemented by every check a provider registers. Name is the
// existing CLI command name (e.g. "storage"), unchanged from today.
type Analyzer interface {
	Name() string
	Run(ctx context.Context) ([]Finding, error)
}
