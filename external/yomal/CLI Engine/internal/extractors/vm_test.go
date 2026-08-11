package extractors

import "testing"

func TestPowerStateFromCodes(t *testing.T) {
	cases := []struct {
		codes []string
		want  string
	}{
		{[]string{"ProvisioningState/succeeded", "PowerState/running"}, "running"},
		{[]string{"ProvisioningState/succeeded", "PowerState/deallocated"}, "deallocated"},
		{[]string{"ProvisioningState/succeeded"}, "unknown"},
		{[]string{}, "unknown"},
		{[]string{"PowerState/"}, "unknown"}, // exactly the prefix, nothing after it
	}
	for _, c := range cases {
		if got := powerStateFromCodes(c.codes); got != c.want {
			t.Errorf("powerStateFromCodes(%v) = %q, want %q", c.codes, got, c.want)
		}
	}
}
