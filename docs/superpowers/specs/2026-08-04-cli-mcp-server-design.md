# CLI MCP Server — Design

## Problem

Investigating an Azure subscription today means running `btg-devops analyze
<service>` (or `analyze all`) by hand and reading table/JSON output yourself,
or pasting that output into a separate chat session for Claude to reason
about. There's no way for Claude to query live findings directly and
correlate them across services in one conversation.

## Scope (confirmed with user)

- Expose the existing analyzers as MCP tools so Claude Code (running
  interactively, authenticated via the user's own Claude login) can call
  them directly and reason over live Azure data.
- Primary use case is **cross-service triage**: "walk the subscription and
  tell me the top risks" — correlating findings across services in one
  conversation, not just running one analyzer at a time.
- Ships as a new subcommand (`btg-devops mcp`) in the existing Go binary —
  no new language/runtime, consistent with the current Cobra CLI project.
- This eliminates the need for an Anthropic/Gemini API key for *this*
  workflow. It does **not** eliminate the need for Azure credentials — the
  Service Principal env vars (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
  `AZURE_CLIENT_SECRET`, `AZURE_SUBSCRIPTION_ID`) are still required, same as
  running the CLI directly.
- Explicitly **not** a replacement for the web dashboard's chat/summarize
  assistant (`web/app/api/assistant/route.ts`, currently Gemini-backed per
  `docs/superpowers/specs/2026-08-04-gemini-assistant-design.md`). That's a
  headless server-side feature hit by other users through a web UI with no
  human driving an interactive Claude Code session — MCP routing can't stand
  in for that; it still needs its own credentialed LLM access. Out of scope
  here.

## Architecture

- **New file `cmd/mcp.go`** registers `btg-devops mcp` under the existing
  root Cobra command. Running it starts an MCP server over **stdio
  transport** — the standard way Claude Code launches local MCP servers as
  a subprocess (via `.mcp.json` / `claude mcp add`).
- Uses a Go MCP server library (e.g. `mark3labs/mcp-go`) for protocol
  handling — hand-rolling JSON-RPC/MCP framing is unnecessary.
- **Reuses the existing `exec`-based pattern from `cmd/analyze_all.go`**
  rather than refactoring analyzers to be called in-process: each tool
  shells out via `os.Executable()` to `btg-devops analyze <x> --output
  json`, same as `analyze all` already does today. Analyzer internals don't
  change.
- Azure credentials flow through exactly as they do for direct CLI use: the
  four `AZURE_*` env vars are set once in the MCP server's env config in
  Claude Code, inherited by the subprocess. One subscription per server
  instance — no multi-tenant switching, matching current CLI behavior.

## Tools

Two tools, not one-per-analyzer — keeps the tool list small while the enum
descriptions still tell Claude exactly what each service checks.

1. **`run_audit`**
   - Param: `scope` (`all` | `azure` | `pp`, default `all`)
   - Runs `btg-devops analyze all --scope <scope> --output json`
   - Returns the existing `AllReport` JSON (`summary` + unified `findings`)
     produced by `analyze_all.go` — no new serialization format.
   - This is the main tool for the cross-service triage use case.

2. **`run_service_analysis`**
   - Param: `service` — enum built from the existing
     `allAzureCmds`/`allPPCmds` catalogue in `cmd/analyze_all.go` (nsg,
     storage, iam, acr, cosmosdb, keyvault, functions, publicip,
     appserviceplan, cognitiveservices, resourcegroup, sp-expiry,
     powerplatform, pp-environments, pp-apps, pp-flows, pp-powerbi)
   - Runs `btg-devops analyze <service> --output json`
   - Returns that analyzer's full native JSON (richer per-service schema
     than the unified report) — used for drilling into one service after
     `run_audit` flags something worth investigating further.

## Error handling

- Missing/invalid Azure credentials produce the same error the CLI already
  raises today; returned as an MCP tool error result (not a process crash)
  so Claude can surface what's missing to the user.
- An invalid `service` value is rejected by MCP schema validation before
  any subprocess runs.
- Partial failures inside `run_audit` (one analyzer erroring, e.g. a
  permissions gap on one service) are already collected into `errors[]` by
  `analyze_all.go` — that list passes through in the tool response, so
  Claude knows what failed and why while still getting findings from
  everything that succeeded.
- No new timeout logic: relies on the MCP client's own call timeout.
  `run_audit --scope all` runs ~17 sequential Azure API calls and can be
  slow — `scope` (or calling `run_service_analysis` directly) is the lever
  for keeping individual calls fast.

## Setup / config

- Document a `.mcp.json` snippet (or equivalent `claude mcp add` command)
  pointing at the `btg-devops` binary with `mcp` as the argument and the
  four `AZURE_*` vars in its `env` block, so this is a one-time,
  copy-pasteable setup step.

## Testing

- Unit test asserting the `run_service_analysis` enum stays in sync with
  `allAzureCmds`/`allPPCmds` in `analyze_all.go`, so a newly added analyzer
  command doesn't silently go missing from the MCP tool.
- Manual smoke test: run `btg-devops mcp` directly to confirm it starts
  cleanly, then a real Claude Code session against a test subscription
  asking a cross-service question, confirming both tools return usable
  results and errors surface correctly when a credential is missing.

## Out of scope

- HTTP/SSE transport — stdio only.
- Multi-subscription/tenant switching within one server instance.
- Any change to the web dashboard or its Gemini-backed assistant.
- Persisting MCP conversation/tool-call history anywhere.
