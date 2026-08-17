# AI Analysis + Cost Refresh via MCP + a Scheduled Claude Code Routine

Adapted from Yomal's `spec/handoff/08-mcp-claude-orchestrator.md` (his `production` branch,
see `docs/consolidation-plan.md` / `external/yomal/`), applied to this dashboard's schema. Same
underlying trick, same reason for it: **the dashboard's "Summarize" button should not require a
metered Anthropic API key.** It runs on an existing Claude Pro/Max subscription's included quota
instead, via a small MCP server this repo already ships.

The same routine now services **two** unrelated queues:

1. **AI analysis** (`analysis_requests`) — genuinely uses Claude to reason over findings and write
   a summary. This is the original use case below.
2. **Cost Management refresh** (`cost_fetch_requests`) — added later, for an unrelated reason:
   Azure's Cost Management API has a tenant-wide rate limit tight enough that calling it from the
   dashboard's request path caused recurring user-visible 429s (`web/app/api/cost/spend/route.ts`
   used to call it live on every page load). Routing it through the same scheduled-routine
   mechanism means the dashboard now only ever reads a stored snapshot — the actual Azure call
   happens on the routine's own controlled cadence, not once per page view.
   **Worth being honest about:** this second use case doesn't need "AI" at all — `fetch_cost_data`
   is a single tool call that does the entire fetch-and-save server-side and returns a pass/fail
   result; there's no reasoning step for Claude to meaningfully perform. It's here because the
   scheduled-routine *infrastructure* (a process that runs periodically without living inside a
   web request) is exactly what this problem needed, and this repo already had one built for the
   AI-analysis case. If you'd rather solve just the rate-limit problem, a plain cron/GitHub
   Actions job calling the same internal route would do the identical job without touching Claude
   at all — see `.github/workflows/scheduled-audit.yml` for that pattern elsewhere in this repo.

## What changed vs. the synchronous assistant

The dashboard already has a synchronous AI assistant (`AssistantPanel.tsx` → `/api/assistant` →
Gemini). That's **unchanged** and still handles Chat — same reasoning Yomal's spec used: chat
needs sub-second-to-a-few-second turnaround, which a scheduled routine can't give you, so there's
no reason to migrate it.

**Summarize** now works differently:

```
Dashboard "Summarize" click
        │
        ▼
POST /api/analysis-requests          (creates a row: analysis_requests, status='pending')
        │
        │  (frontend polls GET /api/analysis-requests/:id every 4s)
        ▼
        …time passes…
        ▲
        │  (a Claude Code routine polls this on its own schedule)
        │
btg-devops mcp --http                (Go, Streamable HTTP, bearer-token guarded)
  tools: list_pending_requests
         get_audit_data(request_id)
         save_analysis(request_id, summary|error)
        │
        │  (calls back into the dashboard, bearer-token guarded, a DIFFERENT token)
        ▼
/api/internal/analysis-requests/*    (Next.js — the only place that touches the SQLite DB)
```

The Go MCP server never opens the SQLite database itself — it's a thin HTTP client over the
dashboard's own `/api/internal/*` routes, which call the same `web/lib/db.ts` functions everything
else uses. This avoids a second process/language writing to the same WAL-mode SQLite file.

**Cost refresh** follows the identical shape, with one difference: Azure credentials must never
leave the dashboard's own server, so there's no `get_*_data`/`save_*` split — one tool does the
whole job server-side:

```
Dashboard "Refresh" click (Cost & Usage page)
        │
        ▼
POST /api/cost-requests              (creates a row: cost_fetch_requests, status='pending')
        │
        │  (frontend polls GET /api/cost-requests/:id every 4s)
        ▼
        …time passes…
        ▲
        │  (the same Claude Code routine polls this too, on the same schedule)
        │
btg-devops mcp --http
  tools: list_pending_cost_requests
         fetch_cost_data(request_id)   ← does fetch AND save in one call
        │
        │  (bearer-guarded, MCP_INTERNAL_TOKEN)
        ▼
/api/internal/cost-requests/[id]/fetch
  → resolves the subscription's Azure credentials (server-side, never
    returned to the MCP server or the routine)
  → calls Azure Cost Management (web/lib/costManagement.ts, with its own
    retry-on-429 logic)
  → writes cost_snapshots
  → marks the request done/failed
```

`GET /api/cost/spend` reads only `cost_snapshots` — it never calls Azure. A rate-limit hit inside
`fetch_cost_data` marks that one `cost_fetch_requests` row failed; it does not surface to whoever
is looking at the dashboard at that moment, and the next routine poll just tries again.

## Two secrets, not one

| Secret | Set where | Used for |
|---|---|---|
| `MCP_BEARER_TOKEN` | Wherever `btg-devops mcp --http` runs, **and** pasted into the routine's config at claude.ai/code/routines | Authenticates the *routine → MCP server* hop |
| `MCP_INTERNAL_TOKEN` | `web/.env.local`, **and** passed to `btg-devops mcp --http --internal-token ...` (or its own env var on that host) | Authenticates the *MCP server → dashboard* hop |

Generate both as random strings (e.g. `openssl rand -hex 32`). Treat them like `JWT_SECRET` —
not logged, not committed, rotated if ever exposed.

## Setup steps

1. **Deploy/run the MCP server as a persistent process.** It cannot be serverless — the routine
   polls it, so something must be listening continuously:

   ```
   btg-devops mcp --http \
     --addr :8090 \
     --bearer-token "$MCP_BEARER_TOKEN" \
     --dashboard-url "https://your-dashboard-host" \
     --internal-token "$MCP_INTERNAL_TOKEN"
   ```

   (Flags shown for clarity — in practice set `MCP_BEARER_TOKEN`, `DASHBOARD_BASE_URL`, and
   `MCP_INTERNAL_TOKEN` as env vars instead and drop the flags.) The server listens at
   `POST http://<host>:8090/mcp`.

2. **Make that address reachable from Claude's cloud infrastructure** — not just localhost. If
   you're running this on a machine without a public IP, you need a tunnel (e.g. `cloudflared`,
   `ngrok`) or a real deployment target. This is the same hosting requirement Yomal's spec flags:
   *"the dashboard's own backend cannot be pure serverless as long as this feature exists."*

3. **Set `MCP_INTERNAL_TOKEN`** to the same value in `web/.env.local` — this is what
   `/api/internal/*` checks incoming requests against (`isInternalServiceRequest` in
   `web/lib/auth.ts`).

4. **Create the scheduled routine** at [claude.ai/code/routines](https://claude.ai/code/routines):
   - Add an MCP server connection pointing at your reachable `https://<host>/mcp` URL, with
     `Authorization: Bearer <MCP_BEARER_TOKEN>`.
   - Set the routine's prompt to cover both queues, e.g.: *"First, call list_pending_requests. For
     each pending request, call get_audit_data with its request_id, write a 3-5 sentence executive
     risk summary of the findings context returned, then call save_analysis with that request_id
     and your summary — or an error message instead of a summary if get_audit_data or the analysis
     itself fails. Second, call list_pending_cost_requests. For each pending request, call
     fetch_cost_data with its request_id — this does the entire refresh itself, so there's nothing
     further to do for that request either way."*
   - Set the schedule to poll every few minutes (not once-daily) — both queues are meant to resolve
     within the dashboard's 10-minute poll timeouts (`POLL_TIMEOUT_MS` in `AssistantPanel.tsx`,
     `REFRESH_TIMEOUT_MS` in `web/app/cost/page.tsx`), not next-business-day.

5. **Test end-to-end**: open the dashboard, click Summarize on an audit with findings (and
   separately, click Refresh on the Cost & Usage page's Actual Spend tab), and confirm the routine
   picks up both kinds of request within one polling interval.

## Known gaps vs. Yomal's original spec (not carried over yet)

- **No event-driven `/fire` trigger.** His spec's later update has the CLI call the routine's
  `/fire` API immediately after collection, instead of waiting for its own poll tick. Not built
  here — the routine's own schedule is the only trigger for now. If the poll interval feels slow,
  this is the next thing to add (needs a `ROUTINE_TRIGGER_TOKEN`, generated from the routine's own
  page, and a call from `web/lib/audit-executor.ts` or wherever a request is created).
- **No pending-request staleness alerting.** If the routine stops running (quota exhausted, token
  expired, routine erroring), requests pile up in `pending` with only the dashboard's own
  10-minute client-side timeout surfacing anything — and only to whoever has the panel open at the
  time. Worth adding a background check if this becomes a real operational issue.
