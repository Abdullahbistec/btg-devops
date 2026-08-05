package cmd

import (
	"encoding/json"
	"sort"
	"testing"
)

// TestMCPServiceEnum_SyncedWithAnalyzeAll guards against a newly added
// analyzer command in analyze_all.go silently going missing from the
// run_service_analysis MCP tool's enum.
func TestMCPServiceEnum_SyncedWithAnalyzeAll(t *testing.T) {
	tool := buildRunServiceAnalysisTool()

	raw, err := json.Marshal(tool)
	if err != nil {
		t.Fatalf("marshal tool: %v", err)
	}

	var parsed struct {
		InputSchema struct {
			Properties struct {
				Service struct {
					Enum []string `json:"enum"`
				} `json:"service"`
			} `json:"properties"`
		} `json:"inputSchema"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("unmarshal tool schema: %v", err)
	}

	got := append([]string{}, parsed.InputSchema.Properties.Service.Enum...)
	want := mcpServiceCatalogue()
	sort.Strings(got)
	sort.Strings(want)

	if len(got) != len(want) {
		t.Fatalf("enum has %d services, expected %d\ngot:  %v\nwant: %v", len(got), len(want), got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("enum mismatch at %d: got %q, want %q\ngot:  %v\nwant: %v", i, got[i], want[i], got, want)
		}
	}
}

func TestMCPRunAuditTool_ScopeEnum(t *testing.T) {
	tool := buildRunAuditTool()

	raw, err := json.Marshal(tool)
	if err != nil {
		t.Fatalf("marshal tool: %v", err)
	}

	var parsed struct {
		InputSchema struct {
			Properties struct {
				Scope struct {
					Enum    []string `json:"enum"`
					Default string   `json:"default"`
				} `json:"scope"`
			} `json:"properties"`
		} `json:"inputSchema"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("unmarshal tool schema: %v", err)
	}

	wantEnum := []string{"all", "azure", "pp"}
	if len(parsed.InputSchema.Properties.Scope.Enum) != len(wantEnum) {
		t.Fatalf("scope enum = %v, want %v", parsed.InputSchema.Properties.Scope.Enum, wantEnum)
	}
	for i, v := range wantEnum {
		if parsed.InputSchema.Properties.Scope.Enum[i] != v {
			t.Errorf("scope enum[%d] = %q, want %q", i, parsed.InputSchema.Properties.Scope.Enum[i], v)
		}
	}
	if parsed.InputSchema.Properties.Scope.Default != "all" {
		t.Errorf("scope default = %q, want %q", parsed.InputSchema.Properties.Scope.Default, "all")
	}
}
