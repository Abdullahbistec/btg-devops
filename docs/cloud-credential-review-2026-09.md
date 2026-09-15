# Cloud Credential Least-Privilege Review (R6)

**Status:** 🔶 PENDING — template only. This review needs someone with Azure
portal/CLI access, Hetzner Cloud Console access, and the Anthropic Console,
none of which are reachable from this environment. Fill in each `TODO` below
and flip the status line to CLOSED once done.

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

## 1. Azure service principal (`AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`)

**What it's used for:** every Azure and Power Platform analyzer in `cmd/`
reads resources, cost data, and configuration — every code path is a read
(list, get, query). No analyzer creates, modifies, or deletes an Azure
resource.

**What it needs:** `Reader` at the subscription(s) scope actually audited,
plus `Cost Management Reader` for the cost analyzers.

- [ ] **TODO: Run and record the output**

  ```bash
  az ad sp show --id "$AZURE_CLIENT_ID" --query "{displayName:displayName, appId:appId}" -o json
  az role assignment list --assignee "$AZURE_CLIENT_ID" --all -o table
  ```

  Paste the real output here:
  ```
  (paste az role assignment list output)
  ```

- [ ] **TODO: Flag anything that can write.** Any `Contributor`, `Owner`,
  `User Access Administrator`, or a custom role whose `actions` include
  anything beyond `*/read` is more privilege than every Azure code path in
  this repo needs. For each over-scoped assignment found, record:
  | Role | Scope | Needed? | Action taken |
  |---|---|---|---|
  | *(e.g. Contributor)* | *(e.g. subscription X)* | No — only Reader is used | *(e.g. downgraded to Reader on 2026-09-XX)* |

- [ ] **TODO: Check app registration API permissions**

  ```bash
  az ad app permission list --id "$AZURE_CLIENT_ID" -o table
  ```

  The Power Platform analyzers need read access to the PP admin APIs.
  Record anything granting write, and anything granted but unused:
  ```
  (paste output / findings)
  ```

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
| Azure SP (`AZURE_CLIENT_ID`) | *(TODO)* | *(TODO)* | *(TODO)* |
| Hetzner token (`HCLOUD_TOKEN`) | *(TODO)* | *(TODO)* | *(TODO)* |
| Anthropic key (`ANTHROPIC_API_KEY`) | *(TODO)* | *(TODO)* | *(TODO)* |

**Reviewed by:** _____________
**Date:** _____________

Once every row above is filled in and any over-scoped credential has been
narrowed, flip the status line at the top of this file to:

```
**Status:** ✅ CLOSED — reviewed <date> by <name>. See §4 for what changed.
```

and update `docs/security-static-review-2026-09.md` §5 item 9 (R6) to point
at this file's closed status.
