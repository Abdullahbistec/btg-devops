# Spec 12 — Remaining data gaps that need your approval, not more code

> Status: **awaiting decision.** Everything code-fixable from the round-2 `data_gaps` review
> (spec 11 round 2) is done: Retail Prices lookup, CDN/Front Door profile detail. The three items
> below cannot be closed by writing more Go — each is either an Azure permission grant that widens
> what the audit service principal can read, or a privacy call. Read this, then tell me which (if
> any) to proceed with.

## 1. App Settings 403 (`appservice`, `functions`, `keyvault` scopes)

**What's happening:** `WebAppsClient.ListApplicationSettings` returns
`403 AuthorizationFailed: 'Microsoft.Web/sites/config/list/action' not permitted` for every App
Service and Function App. This is not a bug — Azure deliberately excludes the `.../config/list/action`
**Action** from the built-in **Reader** role (which is all the audit SP currently holds), because
this specific API call returns full application setting **values**, including any secrets stored
as plain settings. Reader is designed to never expose that.

**Why it matters:** without it, the analyzer can only infer plaintext-credential risk indirectly
(via `keyvault_reference_count`), not confirm it directly.

**The fix, least-privilege version:** a custom RBAC role that grants *only* the one `list` action
needed — nothing else Contributor-level. This still lets the SP read real setting values (that's
inherent to the API), but our code only ever keeps setting **names** and never persists a value
(see [`site_enrich.go`](../../CLI%20Engine/internal/extractors/site_enrich.go) `reduceAppSettings`) —
that guarantee is enforced in code, not by the Azure permission itself.

```bash
# 1. Create a custom role scoped to exactly this one action, on this one subscription.
az role definition create --role-definition '{
  "Name": "btg-devops App Settings Reader",
  "Description": "Allows listing App Service/Function App application settings (names only kept by the audit tool).",
  "Actions": [
    "Microsoft.Web/sites/config/list/action",
    "Microsoft.Web/sites/slots/config/list/action"
  ],
  "AssignableScopes": ["/subscriptions/<SUBSCRIPTION_ID>"]
}'

# 2. Assign it to the existing audit service principal (same one already holding Reader).
az role assignment create \
  --assignee "<AZURE_CLIENT_ID>" \
  --role "btg-devops App Settings Reader" \
  --scope "/subscriptions/<SUBSCRIPTION_ID>"
```

**Decision needed:** grant this role to the audit SP? (If yes, I'll fill in the two placeholders
and you run it — this changes IAM on your subscription, so I won't run it myself.) If declined,
the gap stays open indefinitely and the playbook already tells the agent to expect that (spec 11
round 2 addendum).

## 2. Principal display-name resolution (`iam`, `keyvault` scopes)

**What's happening:** IAM role assignments and Key Vault access policies only carry the
principal's **object ID** (a GUID) — resolving that to a human name/email requires Microsoft Graph,
a completely different API surface than the ARM Reader role covers.

**The fix:** two steps, both outside code:
1. **Grant the app registration a Graph API permission** — `Directory.Read.All` (Application
   permission, not delegated) is the standard choice; a narrower alternative is
   `User.Read.All` + `Application.Read.All` if you want to avoid full directory read.
2. **Admin consent** — a Global Administrator or Privileged Role Administrator must grant consent
   for that permission (self-service consent won't cover Directory.Read.All).

```bash
# Add the Graph permission to the existing app registration (App ID = AZURE_CLIENT_ID).
az ad app permission add --id "<AZURE_CLIENT_ID>" \
  --api 00000003-0000-0000-c000-000000000000 \
  --api-permissions 7ab1d382-f21e-4acd-a863-ba3e13f7da61=Role   # Directory.Read.All (Application)

# Requires a Global Admin / Privileged Role Admin to run this next step:
az ad app permission admin-consent --id "<AZURE_CLIENT_ID>"
```

Once granted, I'd add a small extractor calling
`POST https://graph.microsoft.com/v1.0/directoryObjects/getByIds` (batches up to 1000 IDs per call)
to resolve every principal ID seen in `iam`/`keyvault` data to a display name — implementation is
maybe an hour of work once the permission exists.

**Decision needed:** request this Graph permission + admin consent? This is the Step B item cited
most often in `data_gaps` (2 of 11 gap reports so far), so it's the single highest-value grant if
you're going to approve one.

## 3. Blob content inspection (`storage` scope) — recommend declining permanently

**What's happening:** the agent flagged a publicly-readable container and noted it "could not
verify whether the contents actually include real patient/consultation data."

**Why this should stay unautomated:** confirming that requires reading actual blob **contents**
via the storage data plane (a separate permission from the ARM `Reader` role, e.g. Storage Blob
Data Reader). The data behind a publicly-readable container could be genuinely sensitive business
or customer data — we have no way to know without reading it, which is exactly the point. Having
an unattended, scheduled AI agent read that content automatically — even just to "check" — is a
different risk category than reading Azure *configuration* metadata, which is all this tool does
everywhere else.

**Recommendation:** do not grant data-plane storage access for this purpose. Keep the current
behavior — the agent flags the *configuration* fact (container is publicly readable) and
recommends "a manual sample check" by a human, which is what it already does. This has been
recorded as an intentional non-goal in the playbook (spec 11 round 2 addendum), not a gap to close.

**Decision needed:** confirm this stays declined (default if you say nothing), or tell me if you
want it revisited — e.g. a narrower automated check that only confirms blob *count*/*size* without
reading content, if that would be useful without reading actual data.

## Summary — what I need from you

| # | Item | Action if approved |
|---|---|---|
| 1 | App Settings 403 | You run the two `az` commands above (I won't run IAM-changing commands myself) |
| 2 | Principal name resolution | You request Graph permission + get admin consent; I then build the resolver extractor |
| 3 | Blob content inspection | Recommend: leave declined |

Nothing here blocks anything else — the deep-research system works fully without these; they only
close the last few named gaps in `data_gaps`.
