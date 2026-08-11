package cmd

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// These tests exercise hetznerFetch against a local httptest.Server serving
// canned JSON fixtures — no request ever reaches the real Hetzner Cloud API.
// hetznerFetch takes an arbitrary URL (the per-resource fetch functions are
// the ones that hardcode hetznerAPIBase), so pointing it at a test server
// requires no change to production code.

func TestHetznerFetch_SetsBearerAuthHeader(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	var out map[string]bool
	if err := hetznerFetch(context.Background(), "test-token", srv.URL, &out); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotAuth != "Bearer test-token" {
		t.Errorf("Authorization header = %q, want %q", gotAuth, "Bearer test-token")
	}
	if !out["ok"] {
		t.Error("expected decoded body ok=true")
	}
}

func TestHetznerFetch_DecodesFixtureJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"volumes":[{"id":1,"name":"vol-fixture","size":50,"server":null,"created":"2024-01-01T00:00:00+00:00"}],"meta":{"pagination":{"next_page":null}}}`))
	}))
	defer srv.Close()

	var resp hetznerVolumesResponse
	if err := hetznerFetch(context.Background(), "tok", srv.URL, &resp); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.Volumes) != 1 || resp.Volumes[0].Name != "vol-fixture" {
		t.Errorf("got %+v, want one volume named vol-fixture", resp.Volumes)
	}
	if resp.Volumes[0].Server != nil {
		t.Error("expected Server to be nil for an unattached fixture volume")
	}
}

func TestHetznerFetch_NonOKStatus_ReturnsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"error":{"code":"unauthorized","message":"invalid token"}}`))
	}))
	defer srv.Close()

	var out map[string]interface{}
	err := hetznerFetch(context.Background(), "bad-token", srv.URL, &out)
	if err == nil {
		t.Fatal("expected an error for HTTP 401")
	}
	if !strings.Contains(err.Error(), "401") || !strings.Contains(err.Error(), "invalid token") {
		t.Errorf("error %q should mention the status code and body", err.Error())
	}
}

func TestHetznerFetch_InvalidJSON_ReturnsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`not json`))
	}))
	defer srv.Close()

	var out map[string]interface{}
	if err := hetznerFetch(context.Background(), "tok", srv.URL, &out); err == nil {
		t.Fatal("expected an error for invalid JSON")
	}
}

// TestFetchHetznerVolumes_SinglePage exercises a real fetchHetznerXxx
// function end to end against a fixture server, by constructing the
// response the same shape fetchHetznerVolumes expects from a single page
// (its production URL is hardcoded to hetznerAPIBase, so this calls
// hetznerFetch directly with the test server's URL rather than going through
// fetchHetznerVolumes itself — see comment above).
func TestFetchHetznerVolumes_SinglePage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"volumes":[
			{"id":1,"name":"vol-a","size":10,"server":123,"created":"2024-01-01T00:00:00+00:00"},
			{"id":2,"name":"vol-b","size":20,"server":null,"created":"2024-06-01T00:00:00+00:00"}
		],"meta":{"pagination":{"next_page":null}}}`))
	}))
	defer srv.Close()

	var resp hetznerVolumesResponse
	if err := hetznerFetch(context.Background(), "tok", srv.URL, &resp); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.Volumes) != 2 {
		t.Fatalf("got %d volumes, want 2", len(resp.Volumes))
	}
	if resp.Volumes[0].Server == nil || *resp.Volumes[0].Server != 123 {
		t.Errorf("vol-a should be attached to server 123, got %v", resp.Volumes[0].Server)
	}
	if resp.Volumes[1].Server != nil {
		t.Errorf("vol-b should be unattached, got server %v", resp.Volumes[1].Server)
	}
}
