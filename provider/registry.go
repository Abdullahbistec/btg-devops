package provider

import (
	"context"
	"fmt"
)

var registry = map[string][]Analyzer{}

// Register adds an analyzer under the given provider name (e.g. "azure").
// Called once per analyzer, from that analyzer's own init(), alongside the
// cobra command registration that already happens there.
func Register(providerName string, a Analyzer) {
	registry[providerName] = append(registry[providerName], a)
}

// Analyzers returns every analyzer registered for a provider, in
// registration order.
func Analyzers(providerName string) []Analyzer {
	return registry[providerName]
}

// Providers returns every provider name that has at least one registered
// analyzer.
func Providers() []string {
	names := make([]string, 0, len(registry))
	for name := range registry {
		names = append(names, name)
	}
	return names
}

// RunResult is the outcome of running every analyzer for one provider.
type RunResult struct {
	Findings []Finding
	Errors   []error
}

// Run executes every analyzer registered for a provider, in order. One
// analyzer's error or panic does not stop the rest — matching the fault
// isolation the subprocess-per-command model gives the existing `analyze
// all` command for free.
func Run(ctx context.Context, providerName string) RunResult {
	var result RunResult
	for _, a := range registry[providerName] {
		findings, err := runSafely(ctx, a)
		if err != nil {
			result.Errors = append(result.Errors, fmt.Errorf("%s: %w", a.Name(), err))
			continue
		}
		result.Findings = append(result.Findings, findings...)
	}
	return result
}

func runSafely(ctx context.Context, a Analyzer) (findings []Finding, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("panic: %v", r)
		}
	}()
	return a.Run(ctx)
}
