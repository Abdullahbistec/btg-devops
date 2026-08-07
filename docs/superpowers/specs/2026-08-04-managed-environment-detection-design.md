# Managed Environment Detection — Design

## Problem

`pp-environments` already checks DLP policy gaps (No DLP Policy, Weak DLP —
HTTP not blocked, Permissive default connector class) but does not check
whether an environment has Microsoft's **Managed Environment** governance
layer enabled (usage insights, sharing limits, maker welcome content). This
is a separate governance feature from DLP and is currently unchecked.

## Data source

The BAP API (`api.bap.microsoft.com`) environments list — already called by
`fetchPPEnvironments` — includes a `properties.governanceConfiguration.protectionLevel`
field on each environment. `"Standard"` means Managed Environment is enabled;
`"Basic"` or absent means it is not. No new API call, scope, or permission
is required — this is additional parsing of a response already fetched.

## Changes

1. **`cmd/pp_helpers.go`** — add to `ppEnvironmentProps`:
   ```go
   GovernanceConfiguration *ppGovernanceConfig `json:"governanceConfiguration"`
   ```
   ```go
   type ppGovernanceConfig struct {
       ProtectionLevel string `json:"protectionLevel"`
   }
   ```

2. **`cmd/pp_helpers.go`** — add helper (same style as `isPowerPlatformSKU`):
   ```go
   func isManagedEnvironment(env ppEnvironment) bool {
       return env.Properties.GovernanceConfiguration != nil &&
           strings.EqualFold(env.Properties.GovernanceConfiguration.ProtectionLevel, "Standard")
   }
   ```

3. **`cmd/pp_environments.go`** — in the per-environment loop, after the
   existing DLP/default/trial/disabled/expiring/dormant checks, add:
   - Skip Trial and disabled environments (matches existing exclusions —
     trial/disabled envs already get their own findings and governance
     doesn't apply to them).
   - If not a Managed Environment:
     - **Warning** if the environment has Dataverse linked
       (`LinkedEnvironmentMetadata != nil`) or `EnvironmentSku` is
       `"Production"` — i.e. it looks like a real workload.
     - **Info** otherwise (e.g. empty Sandbox/Developer environments).
   - Category: `"Not a Managed Environment"`.
   - Recommendation: enable Managed Environment via Power Platform admin
     center → Environments → the environment → "Enable Managed Environment"
     for usage insights, sharing limits, and maker onboarding controls.

4. **`cmd/pp_environments.go`** — add `ManagedEnvironmentCount int` to
   `PPEnvSummary`, incremented when `isManagedEnvironment(env)` is true.

## Testing

- Unit tests for `isManagedEnvironment` in `pp_test.go`, following the
  existing table-test style used for `isPowerPlatformSKU`:
  - `protectionLevel: "Standard"` → true
  - `protectionLevel: "Basic"` → false
  - `GovernanceConfiguration` nil → false
- `go build ./...` and `go test ./...` must pass.
- No integration test against the live API (existing pattern for this file
  — `runPPEnvironments` itself is not unit tested, only its helpers are).

## Out of scope

- No changes to `pp_apps.go`, `pp_flows.go`, or `pp_powerbi.go`.
- No new docs/permission changes (docs/013-powerplatform-setup.md is
  unaffected — same scope, same endpoint).
- No web dashboard changes — this surfaces through the existing
  `findings` table/API automatically once the CLI writes it, same as every
  other PP finding category.
