# Claude-Based Analysis Engine (Replacing the Go Rule Engine) — Design

Date: 2026-09-11
Branch: abd-production-2

## Context

Today, each of the 19 `analyze <service>` commands (13 core Azure services plus
`iam`, `sp-expiry`, `idle`, and 5 Power Platform commands) fetches raw resource
data via the Azure SDK / Microsoft Graph, then runs a hand-written Go
rule-check function (e.g. `checkStorageAccount()`) that classifies each
resource into findings with a fixed severity (`Critical`/`Warning`/`Info`).
This is deterministic and fast, but every new check, threshold, or nuance
requires a Go code change across up to 19 files — a real, growing maintenance
burden as the tool's scope has expanded (12 → 19 commands, plus Hetzner).

Separately, this repo already has a working AI-analysis path ("Path B"): the
web dashboard can spawn `claude -p` (see `web/lib/routine-trigger.ts`) to
write an executive summary *over* findings the Go rule engine already
produced, via the MCP server (`cmd/mcp.go`, tools `list_pending_requests`,
`get_audit_data`, `save_analysis`). That path is unaffected by this design —
it summarizes findings; this design changes how findings themselves are
produced.

This design was scoped through a full brainstorming session with the user.
Key decisions made along the way (kept here verbatim since they drove every
downstream choice):

- **Motivation**: reduce the maintenance burden of 19 hand-written Go
  analyzers — not chasing "rules miss things" or "want novel checks."
- **Rollout**: all 19 analyzers at once, not a staged pilot.
- **Integration**: route through the existing MCP server / `claude -p` agent
  (not a direct Anthropic API call embedded in Go) — even though this means
  the CLI is no longer 100% standalone in CI, unlike today.
- **Output schema**: same shape as today's findings, plus a new
  `confidence` and `reasoning` field (small additive schema change).
- **Failure handling**: per-service — if the Claude call fails or times out
  for one service, fall back to that service's existing Go rule-check
  function on the same fetched data. The old Go rule code is **kept**, not
  deleted; it becomes the fallback engine, not the primary one.
- **CI**: GitHub Actions gets a new `ANTHROPIC_API_KEY` secret, installs the
  Claude Code CLI, and runs the MCP server as a background step — accepting
  that as the cost of this integration approach.
- **Mechanism**: per-service Claude calls (Approach B), not one batched call
  across all services — chosen specifically because it's the only option
  consistent with the per-service failure-isolation and fallback decisions
  above. A single batched call would need to unwind those.

### A note on what this changes about the tool

Today, a finding like "resource group missing required tags → Critical" is a
deterministic, git-diffable rule: it always fires the same way, and a
reviewer can read the Go code to know exactly what will be flagged and why.
After this change, on the Claude-success path, that same finding is instead
the output of a model's judgment against a prompt — it can vary between runs,
and "why" lives in a `reasoning` string the model wrote, not in code you can
diff. The `confidence`/`reasoning` fields and the Go-rule fallback are the
two mitigations already agreed for this; this is flagged again here because
it is the central trade-off of the whole design, not a detail.

### A note on an unrelated in-flight refactor

`docs/superpowers/specs/2026-08-31-analyzer-testable-functions-design.md`
(uncommitted at the time of writing) is porting each analyzer's rule-check
logic into a pure, client-less `AnalyzeXFindings(preloadedData) []Finding`
function for unit testing — with no relation to Claude. This design directly
depends on the *fetch* half of that same split (raw data in, no live client
needed) but for a different purpose (handing that data to Claude instead of
a unit test). Whichever lands first, the other should reuse its fetch/check
split rather than re-deriving it. Also note: `cmd/analyze_all.go` (used by
the GitHub Actions workflow) still shells out to the compiled binary via
`os/exec` per command — a separate, newer `provider` package
(`provider/analyzer.go`, `provider/registry.go`) already does in-process
aggregation, but only for `analyze_azure.go` / `analyze_hetzner.go`, not
`analyze_all.go`. This design's GitHub Actions integration (below) targets
`analyze_all.go`'s existing subprocess model as it exists today; it does not
migrate `analyze_all.go` onto the `provider` package, which is out of scope.

## Goals

- Replace the primary decision-making step (raw data → findings + severity)
  in all 19 `analyze <service>` commands with a Claude-based judgment,
  while keeping every existing consumer (Postgres schema, dashboard UI,
  `--fail-on-critical`, GitHub Actions artifacts) working with only additive
  changes.
- Keep every existing Go rule-check function as a fallback, invoked
  automatically when the Claude call fails, times out, or returns
  schema-invalid output for that service.
- Keep the CLI's per-service failure isolation: one service's Claude/MCP
  failure never blocks or fails the rest of an audit run.
- Extend the findings schema additively with `confidence` (0–1) and
  `reasoning` (short string), populated only on the Claude-success path;
  `NULL`/absent on the Go-fallback path.
- Wire GitHub Actions to support this: new `ANTHROPIC_API_KEY` secret,
  Claude Code CLI installed in the runner, MCP server started as a
  background step before the analyze step.

## Non-goals

- **No direct Anthropic API integration in Go.** Explicitly rejected in
  favor of routing through the MCP server / `claude -p`, per the user's
  choice — even though it costs CLI standalone-ness in CI.
- **No batched/single-call design.** Rejected (Approach A) because it
  conflicts with the per-service fallback and failure-isolation decisions.
- **No deletion of existing Go rule-check functions.** They remain in the
  codebase permanently as the fallback engine — this design does not reduce
  the Go analyzer line count, only reduces which path runs by default.
- **No changes to Path B** (the existing dashboard "Summarize" /
  `list_pending_requests` / `save_analysis` flow). That path summarizes
  findings after the fact; this design only changes how findings are
  produced in the first place.
- **No migration of `analyze_all.go` onto the `provider` package.** Out of
  scope — see the note above.
- **No new dashboard UI** for the `confidence`/`reasoning` fields in this
  pass — they are stored and available via the API, but surfacing them
  visually in `web/app/` is a separate, follow-on UI task.
- **No changes to the 5 Power Platform commands' underlying Graph API
  fetch logic**, or to Hetzner — only the decision step (fetch → findings)
  is touched, for all 19 commands uniformly, per the "all at once" decision.

## Architecture

```
runAllCommands() [web/lib/btg-runner.ts]  — orchestration loop, UNCHANGED
   │
   ├─ for each of 19 services:
   │     1. `btg-devops fetch-raw <service> --output json`
   │        — NEW subcommand; reuses each cmd/<service>.go's existing
   │          SDK/Graph fetch calls (auth, pagination), stops before the
   │          existing rule-check function, prints raw resource JSON.
   │     2. spawn `claude -p` with:
   │          - a per-service prompt file (docs/prompts/<service>.md)
   │          - --allowedTools mcp__btg-devops__submit_findings
   │          - the raw JSON from step 1 as input
   │          - a timeout (default 60s per service; configurable)
   │     3a. success: submit_findings validates + returns findings in the
   │         existing schema plus confidence/reasoning
   │     3b. failure (timeout / non-zero exit / schema-invalid output):
   │         run the existing Go rule-check function in-process on the
   │         same raw JSON — confidence/reasoning left absent
   │
   └─ findings (Claude-sourced or fallback-sourced, uniform shape) →
      insertFindings() → Postgres, UNCHANGED
```

GitHub Actions (`analyze all --scope azure`) exercises the identical
per-service loop internally (via `analyze_all.go`'s existing subprocess
re-exec model), so no separate design is needed for that path beyond the new
CI setup below.

## Components

**Go CLI (`cmd/`)**
- New subcommand: `btg-devops fetch-raw <service> --output json`, one per
  service, extracted from each `cmd/<service>.go` — keeps only the
  SDK/Graph fetch calls, stopping before today's rule-check function. This
  is a refactor (split fetch from check), not new Azure/Graph logic.
- Existing rule-check functions (`checkStorageAccount()`, etc.) are
  untouched, just called only from the fallback path.
- New flag on `analyze <service>`: `--engine=claude|rules` (default
  `claude`) — lets the Go-rules path be forced manually, independent of
  failure, for debugging/comparison.

**MCP server (`cmd/mcp.go`)**
- New tool `submit_findings(service, findings[])` — validates each finding
  against the schema (required fields present, `severity` in
  `{Critical,Warning,Info}`, `confidence` in `[0,1]` if present) before
  accepting; rejects (triggering the fallback) on any violation.

**Prompt files (new: `docs/prompts/<service>.md`, 19 files)**
- One per service. Each ports the existing Go rule-check function's actual
  criteria and severities into prose — a faithful port of current judgment,
  not new/different criteria — plus room for the model's own judgment
  beyond the fixed rules (this is the actual point of the change).

**Orchestration (`web/lib/btg-runner.ts`, and `analyze_all.go`'s equivalent
loop for the CI path)**
- Per-service step becomes: `fetch-raw` → spawn `claude -p` with that
  service's prompt → success: done; failure/timeout/malformed: run the
  existing Go rule-check function on the same raw data.

**GitHub Actions (`.github/workflows/scheduled-audit.yml`)**
- New secret: `ANTHROPIC_API_KEY`.
- New steps (before "Run Azure analyzers"): install Claude Code CLI; start
  `btg-devops mcp --http --addr :8090` as a background step; tear down
  after the analyze step.
- The existing `analyze all --scope azure --output json > azure-findings.json`
  step, and everything after it (upload-artifact, push-to-dashboard,
  cost-refresh), is unchanged — `analyze all` absorbs the new logic
  internally.

**Postgres schema**
- Additive migration on the `findings` table: nullable `confidence REAL` and
  `reasoning TEXT` columns. No existing column changes.

## Error Handling

| Failure | Behavior |
|---|---|
| `claude -p` exceeds timeout (default 60s) | Kill process; fall back to Go rule-check on already-fetched raw JSON |
| `claude -p` exits non-zero | Same — fall back |
| `submit_findings` receives schema-invalid data | MCP tool rejects; treated as a Claude failure → fall back |
| `fetch-raw` itself fails (Azure/Graph API error) | Unchanged from today — error recorded, no Claude call attempted for that service |
| `ANTHROPIC_API_KEY` missing/invalid (CI) | Every service falls back to Go rules; the audit still completes fully rule-based — matches today's behavior exactly |
| MCP server unreachable | Falls back per-service; each spawn's failure is independent, matching the failure-isolation decision |

This preserves the existing property that one bad dependency never blocks a
full audit — worst case, a run silently becomes 100% rule-based, identical
to today's output.

## Testing Strategy

1. **Fallback logic (unit tests, no live calls)** — fixture raw-JSON files
   per service (captured once from a real subscription, checked into
   `testdata/`) feed the per-service flow with a stubbed `claude -p` spawn
   returning canned success/timeout/malformed responses. Assert: success
   stores Claude's findings; every failure mode falls back to the existing
   Go rule-check function and produces the same findings the current
   `cmd/*_test.go` suite already expects. This is the key regression
   guarantee — existing Go rule-check tests do not change, since that code
   only moves to a different call site.
2. **Prompt/schema conformance (manual/nightly, not part of the normal CI
   gate)** — for each of the 19 prompt files, run once against fixture data
   and validate the returned findings against the schema via
   `submit_findings`'s own validation. Catches prompt drift producing
   malformed output, without needing a live Azure subscription.
3. **End-to-end smoke (manual, pre-release)** — direct MCP protocol calls
   (`initialize` → `tools/list` → `tools/call run_service_analysis` or the
   new per-service flow) against a live subscription, as already exercised
   manually this session. Not scheduled/automated.

## Open Questions

- **Per-service timeout value**: 60s was proposed as a starting default in
  this design but not explicitly confirmed by the user — worth revisiting
  once real latency data exists from the pilot runs, especially for
  resource-heavy services (e.g. `storage`, `iam`) that may have more data
  for Claude to reason over than lighter ones.
- **`--fail-on-critical` semantics on the fallback path**: unchanged
  mechanically (severity is severity regardless of source), but worth
  confirming whether CI consumers should be told, e.g. via the run summary,
  when a run's findings partially or fully came from the fallback engine
  rather than Claude, since that changes what "Critical" means for that run
  (rule-certain vs. model-judged).
