package cmd

import (
	"strings"
	"testing"
)

// Metric aggregation divides the summed hourly values by flagUsageDays to get
// a daily average, so a non-positive value produced +Inf (which --output json
// then failed to marshal) or silently negated every rate.
func TestRunUsage_RejectsNonPositiveDays(t *testing.T) {
	origName, origDays := flagResourceName, flagUsageDays
	origAll, origType := flagUsageAll, flagUsageType
	t.Cleanup(func() {
		flagResourceName, flagUsageDays = origName, origDays
		flagUsageAll, flagUsageType = origAll, origType
	})

	// Enough to get past the "one of --resource/--type/--all" check, so the
	// --days check is what we actually reach. Both run before any Azure call.
	flagUsageAll = false
	flagUsageType = ""
	flagResourceName = "some-resource"

	for _, days := range []int{0, -1, -30} {
		flagUsageDays = days
		err := runUsage(nil, nil)
		if err == nil {
			t.Fatalf("--days %d: expected an error, got nil", days)
		}
		if !strings.Contains(err.Error(), "--days must be at least 1") {
			t.Errorf("--days %d: got %q, want the --days validation error", days, err)
		}
	}
}
