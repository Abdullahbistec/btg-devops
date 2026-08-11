package extractors

import "testing"

func TestLastPathSegment(t *testing.T) {
	cases := map[string]string{
		"/subscriptions/abc/resourceGroups/rg1/providers/Microsoft.Network/frontdoorwebapplicationfirewallpolicies/BcProdWafPolicy": "BcProdWafPolicy",
		"just-a-name": "just-a-name",
		"":            "",
		"trailing/":   "",
	}
	for input, want := range cases {
		if got := lastPathSegment(input); got != want {
			t.Errorf("lastPathSegment(%q) = %q, want %q", input, got, want)
		}
	}
}
