package cmd

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// The comparison is constant-time (crypto/subtle) to match
// isInternalServiceRequest() in web/lib/auth.ts. These cases pin the
// accept/reject behaviour so a future rewrite of that comparison cannot
// quietly change which requests get through.
func TestRequireBearerToken(t *testing.T) {
	const secret = "s3cret-token"

	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	handler := requireBearerToken(next, secret)

	cases := []struct {
		name   string
		header string
		want   int
	}{
		{"exact token", "Bearer " + secret, http.StatusOK},
		{"wrong token, same length", "Bearer s3cret-tokeN", http.StatusUnauthorized},
		{"prefix of the token", "Bearer s3cret", http.StatusUnauthorized},
		{"token with trailing junk", "Bearer " + secret + "x", http.StatusUnauthorized},
		{"no Bearer prefix", secret, http.StatusUnauthorized},
		{"empty header", "", http.StatusUnauthorized},
		{"bearer with no token", "Bearer ", http.StatusUnauthorized},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/mcp", nil)
			if tc.header != "" {
				req.Header.Set("Authorization", tc.header)
			}
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != tc.want {
				t.Errorf("got status %d, want %d", rec.Code, tc.want)
			}
		})
	}
}
