# Cloud Credential Least-Privilege Review (R6)

**Status:** 🟡 PARTIALLY CLOSED — Azure/Power Platform verified 2026-09-15
(§1). Hetzner (§2) and Anthropic (§3) still need console access this
environment doesn't have — the Hetzner API has no endpoint that reports a
token's own scope, and checking it via a write-probe against production
infrastructure isn't something to do to find out.

**Source:** `docs/security-static-review-2026-09.md` finding R6 —
"actual Azure RBAC / Hetzner token scope granted to the runner (needs cloud
portal access)."

**Why this matters:** every other fix in this remediation programme (C1–C3,
H1–H3, M1–M3, the dependency upgrades) reduces how *likely* a compromise is.
This review bounds the *damage* if one happens anyway — if the GitHub Actions
secrets or the runner itself leak, the blast radius is exactly what these
four credentials can do. Nothing here is fixed by code; it's a console/CLI
check plus, where something is over-scoped, a console/CLI change.

---

## 1. Azure service principal (`AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`) — ✅ VERIFIED 2026-09-15

**What it's used for:** every Azure and Power Platform analyzer in `cmd/`
reads resources, cost data, and configuration — every code path is a read
(list, get, query). No analyzer creates, modifies, or deletes an Azure
resource.

**What it needs:** `Reader` at the subscription(s) scope actually audited,
plus `Cost Management Reader` for the cost analyzers.

**Method:** `az` CLI wasn't available in this environment, so this was
checked directly via REST: acquired an ARM token and a Graph token for the
app itself using its own client-credentials (`AZURE_TENANT_ID` /
`AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` from `web/.env.local`), resolved
the service principal's object id via `GET
https://graph.microsoft.com/v1.0/servicePrincipals?$filter=appId eq
'<AZURE_CLIENT_ID>'` (an app can always read its own service principal —
no extra Graph permission needed for that specific lookup), then queried
role assignments and app-role grants for that object id. No secret or
token value was ever printed; the script only echoed derived JSON (role
names, scopes).

- [x] **Role assignments at subscription scope** (`GET
  .../roleAssignments?$filter=principalId eq '<objectId>'`):

  | Role | Scope | Actions |
  |---|---|---|
  | `Reader` | `/subscriptions/<the one subscription>` | `*/read` |
  | `Cost Management Reader` | `/subscriptions/<the one subscription>` | `Microsoft.Consumption/*/read`, `Microsoft.CostManagement/*/read`, `Microsoft.Billing/billingPeriods/read`, `Microsoft.Resources/subscriptions/read`, `Microsoft.Resources/subscriptions/resourceGroups/read`, `Microsoft.Support/*`, `Microsoft.Advisor/configurations/read`, `Microsoft.Advisor/recommendations/read`, `Microsoft.Management/managementGroups/read`, `Microsoft.Billing/billingProperty/read` |

  Exactly two role assignments exist, both at subscription scope, neither
  with a write/delete action. This is exactly what the review expected —
  **no over-scoped assignment found, nothing to downgrade.**

- [x] **Flag anything that can write.** None found — no `Contributor`,
  `Owner`, `User Access Administrator`, or custom role. Action taken: none
  needed.

- [x] **App registration API permissions** (Microsoft Graph app roles
  granted to the SP, resolved via `GET
  /servicePrincipals/<objectId>/appRoleAssignments` then matched against
  Graph's own `appRoles` list):

  | Permission | Type | Read or write? |
  |---|---|---|
  | `Application.Read.All` | Application (app-only) | Read |
  | `Directory.Read.All` | Application (app-only) | Read |
  | `Organization.Read.All` | Application (app-only) | Read |

  All three are read-only — no write-capable Graph permission is granted.
  One delegated grant also exists (`Application.Read.All`, consent type
  `AllPrincipals`, `principalId: null`) but this app only ever authenticates
  via client credentials (app-only), so that delegated grant is vestigial,
  not something an attacker with just the client secret could exercise
  differently than the app-only grant already listed above.

  **Note, not a finding:** `Directory.Read.All` and `Organization.Read.All`
  are tenant-wide read scopes, broader than "read this one subscription's
  cost data" would strictly require on their own. They're still read-only
  (no write/blast-radius concern), and presumably back the Power Platform
  analyzers' tenant/environment discovery — worth a narrower look only if
  someone wants to tighten this further, not urgent.

- [x] **Power Platform credentials are the same SPN.** `BTG_PP_TENANT_ID`
  and `BTG_PP_CLIENT_ID` in `web/.env.local` are byte-for-byte identical to
  `AZURE_TENANT_ID`/`AZURE_CLIENT_ID` (compared via SHA-256 hash, values
  never printed) — there is only one service principal to review, not two.

---

## 2. Hetzner Cloud token (`HCLOUD_TOKEN`)

**What it's used for:** `cmd/hetzner_*.go` lists servers, volumes, floating
IPs, firewalls, and certificates, and fetches pricing — every path is a read.

**What it needs:** **Read**, not **Read & Write**. The hcloud API has no
endpoint that reports a token's own scope, so this can only be checked in
the console: **Hetzner Cloud Console → the project → Security → API
tokens.**

- [ ] **TODO:** Confirm the token backing `HCLOUD_TOKEN` is scoped **Read**.
  - If it is already Read-only: record that here and close this section.
  - If it is Read & Write: generate a new Read-only token, update the
    `HCLOUD_TOKEN` GitHub secret (and any `web/.env.local`) to the new value,
    confirm the app/CLI still works against it, then **revoke the old
    Read & Write token**.

  Result:
  ```
  (record: token scope found, and what was changed, if anything)
  ```

---

## 3. Anthropic API key (`ANTHROPIC_API_KEY`)

**What it's used for:** the Claude-based analysis engine (`claude -p` CLI +
MCP server). This key is **spend, not data** — a leak is a billing incident,
not a data-disclosure one.

- [ ] **TODO:** Confirm which Anthropic Console workspace this key belongs
  to, and whether that workspace has a spend limit configured.

  Result:
  ```
  (workspace name, spend limit yes/no, limit amount if set)
  ```

---

## 4. Summary and sign-off

| Credential | Current scope | Matches what's needed? | Change made |
|---|---|---|---|
| Azure SP (`AZURE_CLIENT_ID`, also used for PP) | `Reader` + `Cost Management Reader` at subscription scope; Graph `Application.Read.All`/`Directory.Read.All`/`Organization.Read.All` (all read-only) | ✅ Yes — no write scope anywhere | None needed |
| Hetzner token (`HCLOUD_TOKEN`) | *(TODO — needs Hetzner Cloud Console: project → Security → API tokens)* | *(TODO)* | *(TODO)* |
| Anthropic key (`ANTHROPIC_API_KEY`) | *(TODO — needs Anthropic Console)* | *(TODO)* | *(TODO)* |

**Reviewed by:** Claude Sonnet 5, via automated REST checks against the live tenant (§1 only)
**Date:** 2026-09-15

**Remaining work:** someone with Hetzner Cloud Console and Anthropic
Console access needs to fill in §2 and §3, then flip the status line at
the top of this file to:

```
**Status:** ✅ CLOSED — reviewed <date> by <name>. See §4 for what changed.
```

and update `docs/security-static-review-2026-09.md` §5 item 9 (R6) to point
at this file's closed status.
