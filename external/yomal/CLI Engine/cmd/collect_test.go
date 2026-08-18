package cmd

import (
	"testing"

	"github.com/chanbistec/btg-devops/internal/db"
	"github.com/stretchr/testify/assert"
)

func TestExtractorKeysForType(t *testing.T) {
	azureKeys := extractorKeysForType(db.SubscriptionCredentials{Type: "azure"})
	assert.Contains(t, azureKeys, "storage")
	assert.Contains(t, azureKeys, "vm")
	assert.NotContains(t, azureKeys, "pp-environments")

	ppKeys := extractorKeysForType(db.SubscriptionCredentials{Type: "power_platform"})
	assert.Equal(t, []string{"pp-environments", "pp-apps", "pp-flows", "pp-powerbi"}, ppKeys)
}
