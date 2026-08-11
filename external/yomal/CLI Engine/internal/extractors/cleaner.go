package extractors

import (
	"encoding/json"
	"fmt"
	"regexp"
)

// noiseFields are top-level fields removed from every Azure SDK resource response.
// These carry no analytical value — they are internal Azure metadata. "id" is
// removed only AFTER resourceGroup has been parsed out of it (see
// extractResourceGroup) — it's the only place that name lives for most
// resource types, so it can't just be dropped outright.
var noiseFields = []string{
	"etag",
	"systemData",
	"type",
}

// resourceGroupPattern pulls the resource group name out of a standard Azure
// resource ID, e.g. "/subscriptions/xxx/resourceGroups/My-RG/providers/...".
// Case-insensitive because ARM accepts "resourcegroups" in either case.
var resourceGroupPattern = regexp.MustCompile(`(?i)/resourceGroups/([^/]+)`)

// extractResourceGroup reads the resource group name out of an ARM resource
// ID string. Returns "" if id isn't a string or doesn't match the expected
// shape (e.g. a subscription-level or management-group-level resource).
func extractResourceGroup(id any) string {
	s, ok := id.(string)
	if !ok {
		return ""
	}
	m := resourceGroupPattern.FindStringSubmatch(s)
	if len(m) < 2 {
		return ""
	}
	return m[1]
}

// CleanResource marshals any Azure SDK struct to JSON, strips top-level noise
// fields, and returns clean JSON bytes ready to store in the database.
func CleanResource(resource any) ([]byte, error) {
	if resource == nil {
		return nil, fmt.Errorf("resource is nil")
	}

	raw, err := json.Marshal(resource)
	if err != nil {
		return nil, fmt.Errorf("marshal resource: %w", err)
	}

	var data map[string]any
	if err := json.Unmarshal(raw, &data); err != nil {
		return nil, fmt.Errorf("unmarshal to map: %w", err)
	}

	// Most resource types (everything except App Service Plans, which
	// happen to carry it natively under properties.resourceGroup) have no
	// other way to know which resource group they belong to — the ARM "id"
	// field is the only place that name lives. Parse it out before "id"
	// itself is dropped as noise below, so callers can group resources by
	// resourceGroup without needing to know each type's quirks.
	if rg := extractResourceGroup(data["id"]); rg != "" {
		if _, exists := data["resourceGroup"]; !exists {
			data["resourceGroup"] = rg
		}
	}

	for _, field := range noiseFields {
		delete(data, field)
	}
	delete(data, "id")

	clean, err := json.Marshal(data)
	if err != nil {
		return nil, fmt.Errorf("marshal clean data: %w", err)
	}

	return clean, nil
}

// CleanResources applies CleanResource to a typed slice of Azure SDK structs
// and returns a slice of cleaned JSON objects.
func CleanResources[T any](resources []T) ([]json.RawMessage, error) {
	result := make([]json.RawMessage, 0, len(resources))
	for _, r := range resources {
		clean, err := CleanResource(r)
		if err != nil {
			return nil, err
		}
		result = append(result, json.RawMessage(clean))
	}
	return result, nil
}
