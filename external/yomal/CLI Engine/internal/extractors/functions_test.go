package extractors

import "testing"

func TestExtractHTTPTriggerAuth_FindsAuthLevelOnTriggerBinding(t *testing.T) {
	config := map[string]any{
		"bindings": []any{
			map[string]any{"type": "httpTrigger", "direction": "in", "authLevel": "anonymous"},
			map[string]any{"type": "http", "direction": "out"},
		},
	}
	triggerType, authLevel := extractHTTPTriggerAuth(config)
	if triggerType != "httpTrigger" || authLevel != "anonymous" {
		t.Errorf("got (%q, %q), want (httpTrigger, anonymous)", triggerType, authLevel)
	}
}

func TestExtractHTTPTriggerAuth_MalformedConfigReturnsEmpty(t *testing.T) {
	for _, c := range []any{nil, "not a map", map[string]any{}, map[string]any{"bindings": "not a list"}} {
		triggerType, authLevel := extractHTTPTriggerAuth(c)
		if triggerType != "" || authLevel != "" {
			t.Errorf("input %#v: expected empty results, got (%q, %q)", c, triggerType, authLevel)
		}
	}
}

func TestExtractHTTPTriggerAuth_NonHTTPTriggerHasNoAuthLevel(t *testing.T) {
	config := map[string]any{
		"bindings": []any{map[string]any{"type": "timerTrigger", "direction": "in"}},
	}
	triggerType, authLevel := extractHTTPTriggerAuth(config)
	if triggerType != "timerTrigger" {
		t.Errorf("expected triggerType %q, got %q", "timerTrigger", triggerType)
	}
	if authLevel != "" {
		t.Errorf("timerTrigger has no authLevel field — expected empty, got %q", authLevel)
	}
}

func TestErrString(t *testing.T) {
	if errString(nil) != "" {
		t.Error("expected empty string for nil error")
	}
}
