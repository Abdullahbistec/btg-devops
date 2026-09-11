package cmd

import (
	"reflect"
	"testing"
)

// TestSubprocessArgs_ForwardsEngineFlag guards against `analyze all
// --engine rules` silently no-op'ing: analyze_all.go re-execs each analyzer
// as a brand-new subprocess, which never inherits the parent process's
// --engine flag value unless subprocessArgs explicitly forwards it.
func TestSubprocessArgs_ForwardsEngineFlag(t *testing.T) {
	originalEngine := flagEngine
	defer func() { flagEngine = originalEngine }()

	flagEngine = "rules"
	got := subprocessArgs("storage")
	want := []string{"analyze", "storage", "--output", "json", "--engine", "rules"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("subprocessArgs(%q) = %v, want %v", "storage", got, want)
	}

	flagEngine = "claude"
	got = subprocessArgs("nsg")
	want = []string{"analyze", "nsg", "--output", "json", "--engine", "claude"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("subprocessArgs(%q) = %v, want %v", "nsg", got, want)
	}
}
