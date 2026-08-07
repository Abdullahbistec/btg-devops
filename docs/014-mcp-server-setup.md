# MCP-1 — Claude Code MCP Server Setup

## Overview

`btg-devops mcp` starts a [Model Context Protocol](https://modelcontextprotocol.io)
server over stdio, exposing the analyzers as tools so Claude Code can run
audits and query findings directly in conversation — no more running
`analyze` by hand and pasting output into a chat.

This eliminates the need for an Anthropic/Gemini API key for this
workflow (Claude Code's own login handles auth). It does **not** eliminate
the need for Azure credentials — the same Service Principal env vars
required to run the CLI directly are still required here.

---

## Tools exposed

| Tool | Use for |
|---|---|
| `run_audit` | Cross-service triage — "walk the subscription and tell me the top risks." Runs `analyze all` scoped by `all` / `azure` / `pp`, returns the unified findings report. |
| `run_service_analysis` | Drilling into one service after `run_audit` flags something — richer, service-native detail. |

---

## Setup

### 1 — Build the binary

```powershell
go build -o btg-devops.exe .
```

### 2 — Register the server with Claude Code

```powershell
claude mcp add btg-devops --env AZURE_TENANT_ID=<your-tenant-id> --env AZURE_CLIENT_ID=<your-client-id> --env AZURE_CLIENT_SECRET=<your-client-secret> --env AZURE_SUBSCRIPTION_ID=<your-subscription-id> -- <full-path-to>\btg-devops.exe mcp
```

Or add it directly to `.mcp.json`:

```json
{
  "mcpServers": {
    "btg-devops": {
      "command": "<full-path-to>/btg-devops.exe",
      "args": ["mcp"],
      "env": {
        "AZURE_TENANT_ID": "<your-tenant-id>",
        "AZURE_CLIENT_ID": "<your-client-id>",
        "AZURE_CLIENT_SECRET": "<your-client-secret>",
        "AZURE_SUBSCRIPTION_ID": "<your-subscription-id>"
      }
    }
  }
}
```

### 3 — Verify

Restart Claude Code (or run `/mcp` to check server status), then ask
something like:

> Walk my Azure subscription and tell me the top risks.

Claude will call `run_audit`, then `run_service_analysis` for any service
worth digging into further.

---

## Notes

- One subscription per server instance — no multi-tenant switching within
  a single MCP server. Register additional `.mcp.json` entries (different
  names, different env blocks) for additional subscriptions.
- `run_audit --scope all` runs ~17 sequential Azure API calls and can be
  slow — use `scope: azure` / `scope: pp`, or call `run_service_analysis`
  directly, to keep individual calls fast.
- Same credential requirements as [PP-1 setup](013-powerplatform-setup.md)
  — Power Platform analyzers additionally need the service principal
  registered as a Power Platform management app.
