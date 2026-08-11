package extractors

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/storage/armstorage"
)

// StorageData holds the clean extracted data for all storage accounts.
type StorageData struct {
	TotalAccounts int               `json:"total_accounts"`
	Accounts      []json.RawMessage `json:"accounts"`
}

// maxStoredContainers caps how many containers are stored per account —
// total_containers and containers_public stay exact regardless (spec 11 §2).
const maxStoredContainers = 50

// storageContainer is the reduced per-container view: enough to tell whether
// a container is ACTUALLY public (vs. the account merely permitting it).
type storageContainer struct {
	Name         string `json:"name"`
	PublicAccess string `json:"public_access"`
	LastModified string `json:"last_modified,omitempty"`
	Deleted      bool   `json:"deleted,omitempty"`
}

// ExtractStorage fetches all storage accounts for the subscription and
// returns clean JSON with noise fields removed. Each account is enriched
// (spec 11 §2) with its blob containers' public-access levels and its
// lifecycle management policy — lifecycle_policy: null means CONFIRMED
// absent, as opposed to not collected.
func ExtractStorage(ctx context.Context, subID string, cred azcore.TokenCredential) (*StorageData, error) {
	client, err := armstorage.NewAccountsClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating storage client: %w", err)
	}
	containersClient, err := armstorage.NewBlobContainersClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating blob containers client: %w", err)
	}
	policiesClient, err := armstorage.NewManagementPoliciesClient(subID, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("creating management policies client: %w", err)
	}

	var accounts []*armstorage.Account
	pager := client.NewListPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("listing storage accounts: %w", err)
		}
		accounts = append(accounts, page.Value...)
	}

	cleanAccounts := make([]json.RawMessage, 0, len(accounts))
	for _, account := range accounts {
		clean, err := CleanResource(account)
		if err != nil {
			return nil, fmt.Errorf("cleaning storage account %s: %w", derefStr(account.Name), err)
		}

		extra := map[string]any{}
		if account.ID != nil && account.Name != nil {
			rg := extractResourceGroup(*account.ID)
			addContainerFields(ctx, containersClient, rg, *account.Name, extra)
			addLifecyclePolicy(ctx, policiesClient, rg, *account.Name, extra)
		}

		enriched, err := mergeIntoJSON(clean, extra)
		if err != nil {
			return nil, fmt.Errorf("enriching storage account %s: %w", derefStr(account.Name), err)
		}
		cleanAccounts = append(cleanAccounts, enriched)
	}

	return &StorageData{
		TotalAccounts: len(accounts),
		Accounts:      cleanAccounts,
	}, nil
}

// addContainerFields lists the account's blob containers and records the
// reduced container view plus exact totals. Best-effort: on failure only
// containers_error is set.
func addContainerFields(ctx context.Context, client *armstorage.BlobContainersClient, rg, account string, extra map[string]any) {
	var all []storageContainer
	publicCount := 0

	pager := client.NewListPager(rg, account, nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			extra["containers_error"] = err.Error()
			return
		}
		for _, item := range page.Value {
			if item == nil || item.Name == nil {
				continue
			}
			c := storageContainer{Name: *item.Name, PublicAccess: "None"}
			if p := item.Properties; p != nil {
				if p.PublicAccess != nil {
					c.PublicAccess = string(*p.PublicAccess)
				}
				if p.LastModifiedTime != nil {
					c.LastModified = p.LastModifiedTime.Format(time.RFC3339)
				}
				if p.Deleted != nil {
					c.Deleted = *p.Deleted
				}
			}
			if c.PublicAccess != "None" {
				publicCount++
			}
			all = append(all, c)
		}
	}

	extra["total_containers"] = len(all)
	extra["containers_public"] = publicCount
	if len(all) > maxStoredContainers {
		all = all[:maxStoredContainers]
		extra["containers_truncated"] = true
	}
	extra["containers"] = all
}

// addLifecyclePolicy records the account's lifecycle management policy rules.
// A 404 is a real answer — the account has no policy — stored as an explicit
// null so the analyzer can distinguish "confirmed absent" from "not collected".
func addLifecyclePolicy(ctx context.Context, client *armstorage.ManagementPoliciesClient, rg, account string, extra map[string]any) {
	// mergeIntoJSON skips nil values, so an explicit JSON null literal is
	// used to write "lifecycle_policy": null (confirmed absent).
	confirmedAbsent := json.RawMessage("null")

	resp, err := client.Get(ctx, rg, account, armstorage.ManagementPolicyNameDefault, nil)
	if err != nil {
		var respErr *azcore.ResponseError
		if errors.As(err, &respErr) && respErr.StatusCode == 404 {
			extra["lifecycle_policy"] = confirmedAbsent
			return
		}
		extra["lifecycle_policy_error"] = err.Error()
		return
	}
	if resp.Properties != nil && resp.Properties.Policy != nil {
		extra["lifecycle_policy"] = resp.Properties.Policy
	} else {
		extra["lifecycle_policy"] = confirmedAbsent
	}
}
