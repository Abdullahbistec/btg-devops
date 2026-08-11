package extractors

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/compute/armcompute"
)

// VMData holds the clean extracted data for all Virtual Machines. This
// resource type had NO extractor at all until spec 11 round 3 — the
// deep-research agent's own inventory scope caught a live VM (with a real
// cost line) that no data collector was tracking, contradicting the
// playbook's assumption that the subscription has no VMs.
type VMData struct {
	TotalVMs int               `json:"total_vms"`
	VMs      []json.RawMessage `json:"vms"`
}

// ExtractVM fetches every Virtual Machine in the subscription and enriches
// each with its power state (not present on the list response — a separate
// InstanceView call per VM, best-effort like every other per-resource
// enrichment in this package).
func ExtractVM(ctx context.Context, subID string, cred azcore.TokenCredential) (*VMData, error) {
	client, err := armcompute.NewVirtualMachinesClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating VM client: %w", err)
	}

	var vms []*armcompute.VirtualMachine
	pager := client.NewListAllPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("listing VMs: %w", err)
		}
		vms = append(vms, page.Value...)
	}

	cleanVMs := make([]json.RawMessage, 0, len(vms))
	for _, vm := range vms {
		clean, err := CleanResource(vm)
		if err != nil {
			return nil, fmt.Errorf("cleaning VM %s: %w", derefStr(vm.Name), err)
		}

		extra := map[string]any{}
		if vm.ID != nil && vm.Name != nil {
			rg := extractResourceGroup(*vm.ID)
			if power, err := fetchPowerState(ctx, client, rg, *vm.Name); err != nil {
				extra["power_state_error"] = err.Error()
			} else {
				extra["power_state"] = power
			}
		}

		enriched, err := mergeIntoJSON(clean, extra)
		if err != nil {
			return nil, fmt.Errorf("enriching VM %s: %w", derefStr(vm.Name), err)
		}
		cleanVMs = append(cleanVMs, enriched)
	}

	return &VMData{
		TotalVMs: len(vms),
		VMs:      cleanVMs,
	}, nil
}

// fetchPowerState reads the "PowerState/*" entry out of a VM's InstanceView
// statuses — the only place Azure reports whether a VM is actually running,
// deallocated, or stopped.
func fetchPowerState(ctx context.Context, client *armcompute.VirtualMachinesClient, rg, name string) (string, error) {
	view, err := client.InstanceView(ctx, rg, name, nil)
	if err != nil {
		return "", err
	}
	codes := make([]string, 0, len(view.Statuses))
	for _, s := range view.Statuses {
		if s != nil && s.Code != nil {
			codes = append(codes, *s.Code)
		}
	}
	return powerStateFromCodes(codes), nil
}

// powerStateFromCodes extracts the value after "PowerState/" from a VM
// InstanceView's status codes — a pure function so the parsing is testable
// without a live Azure call.
func powerStateFromCodes(codes []string) string {
	const prefix = "PowerState/"
	for _, code := range codes {
		if len(code) > len(prefix) && code[:len(prefix)] == prefix {
			return code[len(prefix):]
		}
	}
	return "unknown"
}
