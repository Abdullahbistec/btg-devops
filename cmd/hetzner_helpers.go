package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

// Hetzner Cloud API base + auth.
//
// Unlike Azure/PP's service-principal OAuth flow, Hetzner Cloud auth is a
// single project-scoped API token generated in the Hetzner Cloud Console
// (Project → Security → API Tokens). Read permission is sufficient for
// every analyzer in this file — none of them mutate resources.
//
//	HCLOUD_TOKEN  → getHetznerToken() — used by all hetzner-* commands
const hetznerAPIBase = "https://api.hetzner.cloud/v1"

var flagHetznerToken string

// hetznerHTTPClient has an explicit timeout so a hanging/unresponsive
// endpoint fails fast instead of blocking a scan indefinitely.
var hetznerHTTPClient = &http.Client{Timeout: 30 * time.Second}

func getHetznerToken() string {
	if flagHetznerToken != "" {
		return flagHetznerToken
	}
	return os.Getenv("HCLOUD_TOKEN")
}

// hetznerFetch makes an authenticated GET request against the Hetzner Cloud
// API and unmarshals the JSON response. Mirrors ppFetch's shape
// (cmd/pp_helpers.go) since Hetzner's API is likewise plain REST/JSON with
// bearer-token auth — no SDK dependency needed.
func hetznerFetch(ctx context.Context, token, url string, out interface{}) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")

	resp, err := hetznerHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		s := string(body)
		if len(s) > 400 {
			s = s[:400]
		}
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, s)
	}
	return json.Unmarshal(body, out)
}

// hetznerPagination mirrors the Hetzner Cloud API's page-number pagination
// (as opposed to Graph/BAP's opaque nextLink cursor). NextPage is a pointer
// because the API returns a JSON null, not 0, once the last page is reached.
type hetznerPagination struct {
	NextPage *int `json:"next_page"`
}

type hetznerMeta struct {
	Pagination hetznerPagination `json:"pagination"`
}

// hetznerDaysSince returns how many days ago an RFC3339 timestamp was, or -1
// if unparseable/empty. Hetzner's API always returns RFC3339 timestamps
// (unlike Graph's mix of formats), so a single format is sufficient.
func hetznerDaysSince(s string) int {
	if s == "" {
		return -1
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return -1
	}
	d := int(time.Since(t).Hours() / 24)
	if d < 0 {
		return 0
	}
	return d
}

// hetznerDaysUntil returns how many days remain until an RFC3339 timestamp.
// The second return value is false if the timestamp is empty/unparseable.
// A negative day count means the timestamp is already in the past.
func hetznerDaysUntil(s string) (int, bool) {
	if s == "" {
		return 0, false
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return 0, false
	}
	return int(time.Until(t).Hours() / 24), true
}

// hetznerSensitivePorts flags inbound firewall rules exposing these ports to
// the entire internet as higher risk than an arbitrary open port.
var hetznerSensitivePorts = map[string]string{
	"22":    "SSH",
	"3389":  "RDP",
	"3306":  "MySQL",
	"5432":  "PostgreSQL",
	"6379":  "Redis",
	"27017": "MongoDB",
	"9200":  "Elasticsearch",
	"5984":  "CouchDB",
}

// hetznerIsOpenToInternet reports whether a firewall rule's source IP list
// includes an unrestricted IPv4 or IPv6 range.
func hetznerIsOpenToInternet(sourceIPs []string) bool {
	for _, ip := range sourceIPs {
		if ip == "0.0.0.0/0" || ip == "::/0" {
			return true
		}
	}
	return false
}

// hetznerRuleSensitivePort returns the service name and true if a firewall
// rule's port spec (a single port like "22" or a range like "1024-1030")
// covers one of hetznerSensitivePorts.
func hetznerRuleSensitivePort(portSpec string) (string, bool) {
	if svc, ok := hetznerSensitivePorts[portSpec]; ok {
		return svc, true
	}
	var lo, hi int
	if n, err := fmt.Sscanf(portSpec, "%d-%d", &lo, &hi); err == nil && n == 2 {
		for portStr, svc := range hetznerSensitivePorts {
			var p int
			if _, err := fmt.Sscanf(portStr, "%d", &p); err == nil && p >= lo && p <= hi {
				return svc, true
			}
		}
	}
	return "", false
}

// hetznerPortDescriptor renders a rule's protocol/port for a finding's
// description. Protocols like icmp have no port at all (Port == ""), so
// "protocol/port" would otherwise render as a bare trailing slash
// ("icmp/") — this reports just the protocol name in that case.
func hetznerPortDescriptor(protocol, port string) string {
	if port == "" {
		return protocol
	}
	return protocol + "/" + port
}

// hetznerPortTarget renders what a recommendation should say to restrict —
// "port 80" for a normal rule, "the icmp protocol" when there's no port.
func hetznerPortTarget(protocol, port string) string {
	if port == "" {
		return fmt.Sprintf("the %s protocol", protocol)
	}
	return "port " + port
}
