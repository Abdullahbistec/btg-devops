package extractors

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

// ScopeHash returns a hex-encoded SHA-256 digest of a resource-type scope's
// cleaned config data (e.g. one extractor's output), used to detect whether
// that scope's configuration is unchanged since a prior audit (spec 14 —
// per-scope analysis cache). encoding/json.Marshal already produces a
// deterministic byte stream for a given Go value — map keys are sorted and
// struct fields are emitted in declaration order — so two runs that collect
// identical data always hash the same, regardless of map iteration order.
// The one caveat is slice element order (e.g. resource list order from the
// Azure SDK); if that ever proves unstable in practice, sort before hashing.
func ScopeHash(data any) (string, error) {
	b, err := json.Marshal(data)
	if err != nil {
		return "", fmt.Errorf("marshaling scope data for hashing: %w", err)
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}
