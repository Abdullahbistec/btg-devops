package extractors

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/cdn/armcdn"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/frontdoor/armfrontdoor"
)

// CDNData holds clean extracted data for all CDN/Azure Front Door profiles —
// closes the "no per-profile routing/WAF config" data gap (spec 11 round 2
// §2): the inventory scope only sees profile/endpoint/policy ENVELOPES
// (name, type, tags), not their actual routing or WAF attachment.
type CDNData struct {
	TotalProfiles int               `json:"total_profiles"`
	Profiles      []json.RawMessage `json:"profiles"`
}

// maxRoutesPerEndpoint caps how many routes are stored per endpoint.
const maxRoutesPerEndpoint = 20

type cdnEndpointEntry struct {
	Name         string     `json:"name"`
	HostName     string     `json:"host_name,omitempty"`
	EnabledState string     `json:"enabled_state,omitempty"`
	Routes       []cdnRoute `json:"routes"`
	RoutesError  string     `json:"routes_error,omitempty"`
}

type cdnRoute struct {
	Name string `json:"name"`
	// Actual hostnames (e.g. "app.sifma.org.sg"), not the custom domain
	// resource IDs — spec 11 round 3: without resolving these, the agent
	// could not match a specific domain name against a route, which
	// blocked confirming whether a given app/vault sits behind a WAF.
	CustomDomains      []string `json:"custom_domains"`
	ForwardingProtocol string   `json:"forwarding_protocol,omitempty"`
	HTTPSRedirect      string   `json:"https_redirect,omitempty"`
	EnabledState       string   `json:"enabled_state,omitempty"`
}

type cdnSecurityPolicyEntry struct {
	Name              string   `json:"name"`
	WafPolicyID       string   `json:"waf_policy_id,omitempty"`
	WafPolicyMode     string   `json:"waf_policy_mode,omitempty"`
	AssociatedDomains []string `json:"associated_domains"`
}

// ExtractCDN fetches all CDN/Front Door profiles and enriches each with its
// AFD endpoints (+ routes) and security policies (WAF attachment).
func ExtractCDN(ctx context.Context, subID string, cred azcore.TokenCredential) (*CDNData, error) {
	wafPoliciesClient, err := armfrontdoor.NewPoliciesClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating WAF policies client: %w", err)
	}
	profilesClient, err := armcdn.NewProfilesClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating cdn profiles client: %w", err)
	}
	endpointsClient, err := armcdn.NewAFDEndpointsClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating afd endpoints client: %w", err)
	}
	routesClient, err := armcdn.NewRoutesClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating routes client: %w", err)
	}
	securityPoliciesClient, err := armcdn.NewSecurityPoliciesClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating security policies client: %w", err)
	}
	customDomainsClient, err := armcdn.NewAFDCustomDomainsClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating custom domains client: %w", err)
	}

	var profiles []*armcdn.Profile
	pager := profilesClient.NewListPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("listing cdn profiles: %w", err)
		}
		profiles = append(profiles, page.Value...)
	}

	cleanProfiles := make([]json.RawMessage, 0, len(profiles))
	for _, profile := range profiles {
		clean, err := CleanResource(profile)
		if err != nil {
			return nil, fmt.Errorf("cleaning cdn profile %s: %w", derefStr(profile.Name), err)
		}

		extra := map[string]any{}
		if profile.ID != nil && profile.Name != nil {
			rg := extractResourceGroup(*profile.ID)
			name := *profile.Name

			domainHostnames, dErr := listCDNDomainHostnames(ctx, customDomainsClient, rg, name)
			if dErr != nil {
				extra["custom_domains_error"] = dErr.Error()
			}

			endpoints, epErr := listCDNEndpoints(ctx, endpointsClient, routesClient, rg, name, domainHostnames)
			if epErr != nil {
				extra["endpoints_error"] = epErr.Error()
			} else {
				extra["endpoints"] = endpoints
			}

			policies, spErr := listCDNSecurityPolicies(ctx, securityPoliciesClient, wafPoliciesClient, rg, name, domainHostnames)
			if spErr != nil {
				extra["security_policies_error"] = spErr.Error()
			} else {
				extra["security_policies"] = policies
			}
		}

		enriched, err := mergeIntoJSON(clean, extra)
		if err != nil {
			return nil, fmt.Errorf("enriching cdn profile %s: %w", derefStr(profile.Name), err)
		}
		cleanProfiles = append(cleanProfiles, enriched)
	}

	return &CDNData{
		TotalProfiles: len(profiles),
		Profiles:      cleanProfiles,
	}, nil
}

// listCDNDomainHostnames maps every custom domain resource ID in a profile
// to its actual hostname (e.g. "app.sifma.org.sg") — routes only reference
// domains by ID, so without this map the agent can't match a real domain
// name against a route/security policy.
func listCDNDomainHostnames(ctx context.Context, client *armcdn.AFDCustomDomainsClient, rg, profileName string) (map[string]string, error) {
	out := map[string]string{}
	pager := client.NewListByProfilePager(rg, profileName, nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return out, fmt.Errorf("listing custom domains: %w", err)
		}
		for _, d := range page.Value {
			if d == nil || d.ID == nil || d.Properties == nil || d.Properties.HostName == nil {
				continue
			}
			out[*d.ID] = *d.Properties.HostName
		}
	}
	return out, nil
}

func listCDNEndpoints(ctx context.Context, endpointsClient *armcdn.AFDEndpointsClient, routesClient *armcdn.RoutesClient, rg, profileName string, domainHostnames map[string]string) ([]cdnEndpointEntry, error) {
	var out []cdnEndpointEntry
	pager := endpointsClient.NewListByProfilePager(rg, profileName, nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("listing afd endpoints: %w", err)
		}
		for _, ep := range page.Value {
			if ep == nil || ep.Name == nil {
				continue
			}
			entry := cdnEndpointEntry{Name: *ep.Name}
			if p := ep.Properties; p != nil {
				if p.HostName != nil {
					entry.HostName = *p.HostName
				}
				if p.EnabledState != nil {
					entry.EnabledState = string(*p.EnabledState)
				}
			}
			routes, err := listCDNRoutes(ctx, routesClient, rg, profileName, *ep.Name, domainHostnames)
			if err != nil {
				entry.RoutesError = err.Error()
			} else {
				entry.Routes = routes
			}
			out = append(out, entry)
		}
	}
	return out, nil
}

func listCDNRoutes(ctx context.Context, client *armcdn.RoutesClient, rg, profileName, endpointName string, domainHostnames map[string]string) ([]cdnRoute, error) {
	var out []cdnRoute
	pager := client.NewListByEndpointPager(rg, profileName, endpointName, nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("listing routes for endpoint %s: %w", endpointName, err)
		}
		for _, r := range page.Value {
			if r == nil || r.Name == nil {
				continue
			}
			route := cdnRoute{Name: *r.Name}
			if p := r.Properties; p != nil {
				for _, d := range p.CustomDomains {
					if d == nil || d.ID == nil {
						continue
					}
					if hostname, ok := domainHostnames[*d.ID]; ok {
						route.CustomDomains = append(route.CustomDomains, hostname)
					} else {
						route.CustomDomains = append(route.CustomDomains, *d.ID) // fallback: unresolved
					}
				}
				if p.ForwardingProtocol != nil {
					route.ForwardingProtocol = string(*p.ForwardingProtocol)
				}
				if p.HTTPSRedirect != nil {
					route.HTTPSRedirect = string(*p.HTTPSRedirect)
				}
				if p.EnabledState != nil {
					route.EnabledState = string(*p.EnabledState)
				}
			}
			out = append(out, route)
			if len(out) >= maxRoutesPerEndpoint {
				return out, nil
			}
		}
	}
	return out, nil
}

func listCDNSecurityPolicies(ctx context.Context, client *armcdn.SecurityPoliciesClient, wafClient *armfrontdoor.PoliciesClient, rg, profileName string, domainHostnames map[string]string) ([]cdnSecurityPolicyEntry, error) {
	var out []cdnSecurityPolicyEntry
	pager := client.NewListByProfilePager(rg, profileName, nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("listing security policies: %w", err)
		}
		for _, sp := range page.Value {
			if sp == nil || sp.Name == nil {
				continue
			}
			entry := cdnSecurityPolicyEntry{Name: *sp.Name}
			if p := sp.Properties; p != nil {
				if wafParams, ok := p.Parameters.(*armcdn.SecurityPolicyWebApplicationFirewallParameters); ok && wafParams != nil {
					if wafParams.WafPolicy != nil && wafParams.WafPolicy.ID != nil {
						entry.WafPolicyID = *wafParams.WafPolicy.ID
						if mode, err := fetchWAFPolicyMode(ctx, wafClient, *wafParams.WafPolicy.ID); err == nil {
							entry.WafPolicyMode = mode
						}
					}
					for _, assoc := range wafParams.Associations {
						if assoc == nil {
							continue
						}
						for _, d := range assoc.Domains {
							if d == nil || d.ID == nil {
								continue
							}
							if hostname, ok := domainHostnames[*d.ID]; ok {
								entry.AssociatedDomains = append(entry.AssociatedDomains, hostname)
							} else {
								entry.AssociatedDomains = append(entry.AssociatedDomains, *d.ID)
							}
						}
					}
				}
			}
			out = append(out, entry)
		}
	}
	return out, nil
}

// fetchWAFPolicyMode reads a WAF policy's Mode (Prevention/Detection) from
// its resource ID — spec 11 round 3: the policy attachment was already
// captured, but not whether it's actually blocking traffic or only logging.
func fetchWAFPolicyMode(ctx context.Context, client *armfrontdoor.PoliciesClient, policyID string) (string, error) {
	rg := extractResourceGroup(policyID)
	name := lastPathSegment(policyID)
	if rg == "" || name == "" {
		return "", fmt.Errorf("could not parse resource group/name from WAF policy ID %q", policyID)
	}
	policy, err := client.Get(ctx, rg, name, nil)
	if err != nil {
		return "", err
	}
	if policy.Properties != nil && policy.Properties.PolicySettings != nil && policy.Properties.PolicySettings.Mode != nil {
		return string(*policy.Properties.PolicySettings.Mode), nil
	}
	return "", nil
}

// lastPathSegment returns the final "/"-separated segment of an ARM
// resource ID — the resource's own name.
func lastPathSegment(id string) string {
	for i := len(id) - 1; i >= 0; i-- {
		if id[i] == '/' {
			return id[i+1:]
		}
	}
	return id
}
