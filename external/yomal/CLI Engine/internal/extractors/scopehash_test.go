package extractors

import "testing"

func TestScopeHash_StableAcrossRuns(t *testing.T) {
	data := []map[string]any{
		{"name": "storage1", "publicNetworkAccess": "Enabled"},
		{"name": "storage2", "publicNetworkAccess": "Disabled"},
	}

	h1, err := ScopeHash(data)
	if err != nil {
		t.Fatalf("ScopeHash returned error: %v", err)
	}
	h2, err := ScopeHash(data)
	if err != nil {
		t.Fatalf("ScopeHash returned error: %v", err)
	}
	if h1 != h2 {
		t.Fatalf("hash differs across identical runs: %s vs %s", h1, h2)
	}
}

func TestScopeHash_UnaffectedByMapKeyOrder(t *testing.T) {
	a := map[string]any{"name": "x", "publicNetworkAccess": "Enabled", "sku": "Standard"}
	b := map[string]any{"sku": "Standard", "name": "x", "publicNetworkAccess": "Enabled"}

	ha, err := ScopeHash(a)
	if err != nil {
		t.Fatalf("ScopeHash returned error: %v", err)
	}
	hb, err := ScopeHash(b)
	if err != nil {
		t.Fatalf("ScopeHash returned error: %v", err)
	}
	if ha != hb {
		t.Fatalf("hash differs by map key order: %s vs %s", ha, hb)
	}
}

func TestScopeHash_ChangesWithData(t *testing.T) {
	a := map[string]any{"publicNetworkAccess": "Enabled"}
	b := map[string]any{"publicNetworkAccess": "Disabled"}

	ha, err := ScopeHash(a)
	if err != nil {
		t.Fatalf("ScopeHash returned error: %v", err)
	}
	hb, err := ScopeHash(b)
	if err != nil {
		t.Fatalf("ScopeHash returned error: %v", err)
	}
	if ha == hb {
		t.Fatalf("expected different hashes for different data, got same: %s", ha)
	}
}
