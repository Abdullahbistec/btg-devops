# Production routine prompt — source of truth

> **This file is the versioned source of truth for the `btg-devops-mcp-analyzer` routine's stored
> prompt** (`claude.ai/code/routines/trig_016EuQk8v8sTJT8oiYrHbJau`). From this point on, edit THIS
> file, then push the change to the routine via `RemoteTrigger update` — do not edit the routine
> directly and let this file drift out of sync.
>
> **The actual workflow logic now lives in `spec/agent/daily-analysis-workflow.md`, not here.** This
> file's stored prompt is intentionally short — it just points the routine at that file (`cat` +
> follow), the same pattern already used for `spec/agent/deep-research-playbook.md`. This means
> future changes to HOW the workflow behaves only require editing that one file and committing — no
> need to re-push the routine's config each time.
>
> **Routine `allowed_tools` must be `["Bash", "Workflow"]`** — `Workflow` for the specialist+synthesis
> fan-out, `Bash` for every curl call (there is no native MCP connector for this project's own server).
>
> **Status:** design complete, capability-tested (subagent spawning, real `parallel()` concurrency,
> Bash access inside a subagent, reachability to this MCP server — all confirmed, including on real
> data). **Not yet confirmed at full daily scale** — see the risk note in
> `spec/agent/daily-analysis-workflow.md` before running unattended on a full day's batch. Roll out
> incrementally.

---

## Stored prompt content (paste this into the routine, keep this file as the diffable copy)

```
You are processing pending Azure infrastructure audit analysis requests for the btg-devops dashboard, via its MCP server. This is a one-shot task: process whatever is currently pending, then stop (do not loop or wait — the schedule/immediate-fire that invoked you handles re-running this later).

MCP server endpoint: https://dashboard-eight-rho-42.vercel.app/api/mcp
Auth: Authorization: Bearer <MCP_BEARER_TOKEN — see repo secrets / ask before assuming a stale value>

The server speaks MCP over JSON-RPC via a single POST endpoint. Use curl with the Bash tool. Every call needs these headers:
  -H "Authorization: Bearer <MCP_BEARER_TOKEN>"
  -H "Content-Type: application/json"
  -H "Accept: application/json, text/event-stream"

Available tools: list_pending_requests, get_audit_data, get_audit_history, save_analysis, list_changed_scopes, get_cached_scope_analysis.

Step 1 — list pending requests:
curl -s -X POST https://dashboard-eight-rho-42.vercel.app/api/mcp <headers> -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_pending_requests","arguments":{"limit":20}}}'

Parse the JSON-encoded array inside .result.content[0].text into a list of {id, audit_id, scope, status, error_message, requested_at, completed_at}. If empty, stop here and report "no pending requests".

Step 2 — read the file spec/agent/daily-analysis-workflow.md from the checked-out repo (repo root) with `cat`, and follow it exactly. It defines three buckets (cost/usage — single agent; resource types — grouped specialist+synthesis fan-out via the Workflow tool; the manual "all" button — cache-aware fan-out), the specialist and synthesis subagent templates, and the related-types map. Substitute the real MCP_BEARER_TOKEN (given above) everywhere that file says <MCP_BEARER_TOKEN>.

When everything is processed (saved or skipped), report a short summary: how many requests handled (broken down by bucket), how many skipped and why, and every data_gaps entry found (including any fault-isolation gaps). Then stop.
```

---

## Deployment checklist

- [ ] Confirm `MCP_BEARER_TOKEN` above is the current live value before pasting.
- [ ] Update the routine via `RemoteTrigger update` with:
      - `job_config.ccr.session_context.allowed_tools`: `["Bash", "Workflow"]`
      - `job_config.ccr.events[0].data.message.content`: the prompt block above
- [ ] Do NOT change `cron_expression`, `environment_id`, or anything else in the trigger config.
- [ ] Roll out incrementally per `spec/agent/daily-analysis-workflow.md`'s risk note — do not go
      straight to an unattended full daily batch on the first real run.
- [ ] Update `spec/handoff/15-analyzer-upgrade-plan.md` B8 to `[x]` once a full real daily batch
      completes successfully end-to-end.
