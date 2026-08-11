package cmd

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

// ---------- getHetznerToken ----------

func TestGetHetznerToken_FlagOverridesEnv(t *testing.T) {
	t.Setenv("HCLOUD_TOKEN", "env-token")
	old := flagHetznerToken
	flagHetznerToken = "flag-token"
	defer func() { flagHetznerToken = old }()

	if got := getHetznerToken(); got != "flag-token" {
		t.Errorf("got %q, want flag-token", got)
	}
}

func TestGetHetznerToken_FallsBackToEnv(t *testing.T) {
	t.Setenv("HCLOUD_TOKEN", "env-token")
	old := flagHetznerToken
	flagHetznerToken = ""
	defer func() { flagHetznerToken = old }()

	if got := getHetznerToken(); got != "env-token" {
		t.Errorf("got %q, want env-token", got)
	}
}

func TestGetHetznerToken_Empty(t *testing.T) {
	os.Unsetenv("HCLOUD_TOKEN")
	old := flagHetznerToken
	flagHetznerToken = ""
	defer func() { flagHetznerToken = old }()

	if got := getHetznerToken(); got != "" {
		t.Errorf("got %q, want empty string", got)
	}
}

// ---------- hetznerDaysSince ----------

func TestHetznerDaysSince_ValidRFC3339(t *testing.T) {
	ts := time.Now().Add(-48 * time.Hour).UTC().Format(time.RFC3339)
	days := hetznerDaysSince(ts)
	if days < 1 || days > 3 {
		t.Errorf("expected ~2 days, got %d", days)
	}
}

func TestHetznerDaysSince_Empty(t *testing.T) {
	if hetznerDaysSince("") != -1 {
		t.Error("empty string should return -1")
	}
}

func TestHetznerDaysSince_Unparseable(t *testing.T) {
	if hetznerDaysSince("not-a-date") != -1 {
		t.Error("unparseable string should return -1")
	}
}

func TestHetznerDaysSince_FutureDate(t *testing.T) {
	ts := time.Now().Add(24 * time.Hour).UTC().Format(time.RFC3339)
	if hetznerDaysSince(ts) != 0 {
		t.Errorf("future date should return 0, got %d", hetznerDaysSince(ts))
	}
}

// ---------- hetznerDaysUntil ----------

func TestHetznerDaysUntil_Future(t *testing.T) {
	ts := time.Now().Add(45 * 24 * time.Hour).UTC().Format(time.RFC3339)
	days, ok := hetznerDaysUntil(ts)
	if !ok {
		t.Fatal("expected ok=true")
	}
	if days < 43 || days > 45 {
		t.Errorf("expected ~45 days, got %d", days)
	}
}

func TestHetznerDaysUntil_Past(t *testing.T) {
	ts := time.Now().Add(-10 * 24 * time.Hour).UTC().Format(time.RFC3339)
	days, ok := hetznerDaysUntil(ts)
	if !ok {
		t.Fatal("expected ok=true")
	}
	if days > -9 || days < -11 {
		t.Errorf("expected ~-10 days, got %d", days)
	}
}

func TestHetznerDaysUntil_Empty(t *testing.T) {
	if _, ok := hetznerDaysUntil(""); ok {
		t.Error("empty string should return ok=false")
	}
}

func TestHetznerDaysUntil_Unparseable(t *testing.T) {
	if _, ok := hetznerDaysUntil("not-a-date"); ok {
		t.Error("unparseable string should return ok=false")
	}
}

// ---------- hetznerIsOpenToInternet ----------

func TestHetznerIsOpenToInternet_IPv4Any(t *testing.T) {
	if !hetznerIsOpenToInternet([]string{"0.0.0.0/0"}) {
		t.Error("0.0.0.0/0 should be open to the internet")
	}
}

func TestHetznerIsOpenToInternet_IPv6Any(t *testing.T) {
	if !hetznerIsOpenToInternet([]string{"::/0"}) {
		t.Error("::/0 should be open to the internet")
	}
}

func TestHetznerIsOpenToInternet_MixedWithRestricted(t *testing.T) {
	if !hetznerIsOpenToInternet([]string{"10.0.0.0/8", "0.0.0.0/0"}) {
		t.Error("a list containing 0.0.0.0/0 should be open to the internet")
	}
}

func TestHetznerIsOpenToInternet_RestrictedOnly(t *testing.T) {
	if hetznerIsOpenToInternet([]string{"10.0.0.0/8", "192.168.1.0/24"}) {
		t.Error("restricted-only source IPs should not be open to the internet")
	}
}

func TestHetznerIsOpenToInternet_Empty(t *testing.T) {
	if hetznerIsOpenToInternet(nil) {
		t.Error("empty source IP list should not be open to the internet")
	}
}

// ---------- hetznerRuleSensitivePort ----------

func TestHetznerRuleSensitivePort_ExactMatch(t *testing.T) {
	svc, ok := hetznerRuleSensitivePort("22")
	if !ok || svc != "SSH" {
		t.Errorf("got (%q, %v), want (SSH, true)", svc, ok)
	}
}

func TestHetznerRuleSensitivePort_RangeMatch(t *testing.T) {
	// 3300-3350 covers only MySQL (3306), not the nearby RDP (3389), so the
	// match is unambiguous regardless of map iteration order.
	svc, ok := hetznerRuleSensitivePort("3300-3350")
	if !ok || svc != "MySQL" {
		t.Errorf("got (%q, %v), want (MySQL, true)", svc, ok)
	}
}

func TestHetznerRuleSensitivePort_NoMatch(t *testing.T) {
	if _, ok := hetznerRuleSensitivePort("8080"); ok {
		t.Error("8080 should not be a sensitive port")
	}
}

func TestHetznerRuleSensitivePort_RangeNoMatch(t *testing.T) {
	if _, ok := hetznerRuleSensitivePort("8000-8100"); ok {
		t.Error("8000-8100 should not cover any sensitive port")
	}
}

func TestHetznerRuleSensitivePort_Malformed(t *testing.T) {
	if _, ok := hetznerRuleSensitivePort("not-a-port"); ok {
		t.Error("malformed port spec should not match")
	}
}

// ---------- hetznerMeta / pagination JSON decoding ----------
//
// The Hetzner Cloud API returns a JSON null (not 0) for next_page once the
// last page is reached, which is why NextPage is *int rather than int — a
// plain int would make "no next page" indistinguishable from "next page 0".
// This is a pure JSON-fixture test: no network involved.

func TestHetznerMeta_NextPageNull_DecodesToNilPointer(t *testing.T) {
	var meta hetznerMeta
	fixture := `{"pagination":{"page":3,"next_page":null}}`
	if err := json.Unmarshal([]byte(fixture), &meta); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}
	if meta.Pagination.NextPage != nil {
		t.Errorf("expected nil NextPage, got %v", *meta.Pagination.NextPage)
	}
}

func TestHetznerMeta_NextPageSet_DecodesToPointerValue(t *testing.T) {
	var meta hetznerMeta
	fixture := `{"pagination":{"page":1,"next_page":2}}`
	if err := json.Unmarshal([]byte(fixture), &meta); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}
	if meta.Pagination.NextPage == nil || *meta.Pagination.NextPage != 2 {
		t.Errorf("expected NextPage=2, got %v", meta.Pagination.NextPage)
	}
}
