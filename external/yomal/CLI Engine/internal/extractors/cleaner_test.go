package extractors

import (
	"encoding/json"
	"testing"
)

type fakeResource struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Location string `json:"location"`
	Etag     string `json:"etag"`
}

func TestCleanResource_ExtractsResourceGroupFromID(t *testing.T) {
	r := fakeResource{
		ID:       "/subscriptions/abc-123/resourceGroups/BistecCare-Ltd-QA/providers/Microsoft.DocumentDB/databaseAccounts/mydb",
		Name:     "mydb",
		Location: "Southeast Asia",
		Etag:     `"00000000-0000-0000-0000-000000000000"`,
	}

	clean, err := CleanResource(r)
	if err != nil {
		t.Fatalf("CleanResource returned error: %v", err)
	}

	var out map[string]any
	if err := json.Unmarshal(clean, &out); err != nil {
		t.Fatalf("failed to unmarshal cleaned resource: %v", err)
	}

	if out["resourceGroup"] != "BistecCare-Ltd-QA" {
		t.Errorf("expected resourceGroup %q, got %v", "BistecCare-Ltd-QA", out["resourceGroup"])
	}
	if _, exists := out["id"]; exists {
		t.Errorf("expected id field to be stripped, but it's still present: %v", out["id"])
	}
	if _, exists := out["etag"]; exists {
		t.Errorf("expected etag field to be stripped, but it's still present")
	}
	if out["name"] != "mydb" {
		t.Errorf("expected name to be preserved, got %v", out["name"])
	}
}

func TestCleanResource_LowercaseResourceGroupsSegment(t *testing.T) {
	r := fakeResource{ID: "/subscriptions/abc/resourcegroups/lowercase-rg/providers/Microsoft.Storage/storageAccounts/x"}
	clean, err := CleanResource(r)
	if err != nil {
		t.Fatalf("CleanResource returned error: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(clean, &out); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}
	if out["resourceGroup"] != "lowercase-rg" {
		t.Errorf("expected resourceGroup %q, got %v", "lowercase-rg", out["resourceGroup"])
	}
}

func TestCleanResource_NoResourceGroupInID(t *testing.T) {
	// Subscription-level resources have no /resourceGroups/ segment at all.
	r := fakeResource{ID: "/subscriptions/abc-123"}
	clean, err := CleanResource(r)
	if err != nil {
		t.Fatalf("CleanResource returned error: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(clean, &out); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}
	if _, exists := out["resourceGroup"]; exists {
		t.Errorf("expected no resourceGroup field, got %v", out["resourceGroup"])
	}
}
