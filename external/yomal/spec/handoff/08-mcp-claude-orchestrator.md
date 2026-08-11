# Spec 8 — MCP Server + Claude Code Orchestrator (replacing metered LLM calls for Analyze)

> Scope: this spec changes how **Analyze** is generated (dashboard + a new MCP server). It does
> **not** change Chat, the Go CLI's collection pipeline, or the database schema for `raw_data` /
> `cost_data` / `usage_data`. Read fully before writing any code — the trigger design (a polling
> queue, not a single daily cron) is what makes the button still feel usable.

## Why this exists

The project has a hard constraint, not a preference: **the live system cannot use free-tier LLMs**
(no rate-limit SLA, and a real incident already surfaced garbled/corrupted output from a free
OpenRouter model — see the `cosmosdb` analysis in audit `7cacf9a8...`, which contained mixed
garbage characters in JSON string values). At the same time, **a paid Anthropic API key is not
available** (procurement/budget blocker, not a technical one). What *is* available is an existing
Claude Pro/Max subscription (the one running Claude Code).

Two options were evaluated:

| | Spawn `claude` CLI as a subprocess | MCP server + Claude Code orchestrator |
|---|---|---|
| Cost model | Subscription flat-fee | Subscription flat-fee |
| Mechanism | Unofficial: script shells out to a locally-authenticated CLI session | Official: Claude Code's supported scheduled cloud agents connect to a tool server |
| Reliability | Fragile — depends on a persistent authenticated session on the host machine | Robust — the agent authenticates itself, no session babysitting |
| ToS risk | Real — Anthropic's consumer subscription terms restrict programmatic automation at scale | None — scheduled cloud agents are a supported product feature |
| Rate limits | Pro tier ~45 msgs/5hr, shared with the account owner's own usage | Same subscription quota, but via the intended usage path |
| Hosting requirement | Needs a persistent server (subprocess + CLI auth state can't live in serverless) | Same requirement, but for a small tool server instead of a CLI wrapper |

**Decision: MCP server + Claude Code orchestrator.** Both options need a persistent host and both
run on the subscription's quota — the subprocess option has no advantage, only extra fragility and
a real ToS problem, for the same underlying cost. Since both options need a real server anyway,
this also settles the earlier open question about deploying to Vercel: **the dashboard's own
backend cannot be pure serverless as long as this feature exists** — see "Hosting" below.

## What actually changes

| Area | Today | After this spec |
|---|---|---|
| Analyze — data flow | Dashboard backend calls an LLM API directly (`callLLMWithFallback` in `llm.ts`), synchronously, inside the HTTP request | Dashboard backend writes a *request row*; a scheduled Claude Code agent picks it up, calls back through MCP tools, writes the result |
| Analyze — user experience | Click → wait ~5-15s → result | Click → "Analyzing…" → poll → result appears within ~1-10 min (poll interval, see below) |
| Analyze — cost | Metered API tokens (or free-tier model risk) | Zero token cost — subscription quota |
| Chat | Free models (Gemini/OpenRouter), synchronous, unchanged | **Unchanged.** Chat does not fit a scheduled-agent model (needs sub-second-to-a-few-second turnaround); it is explicitly out of scope here and stays on whatever model access exists until a real API key is available |
| Findings lifecycle (`saveFindings`, dedup/age/auto-resolve) | Runs inside `runAnalysis()` | **Unchanged** — reused exactly as-is, just called from a different trigger point |
| Caching (`claude_analysis` JSONB, cache-hit skip) | Exists | **Unchanged** — still the read path; nothing about how results are stored or served to the frontend changes |

## Architecture

```
[Azure] → Go CLI (collect) → Postgres: audits.raw_data / cost_data / usage_data
                                              │
                                              │ (unchanged — no changes to the CLI or its schedule)
                                              ▼
                              ┌─────────────────────────────────┐
                              │  Dashboard backend (Next.js)     │
                              │                                   │
                              │  Analyze button → POST creates    │
                              │  a row in `analysis_requests`     │
                              │  (audit_id, scope, status=pending)│
                              │                                   │
                              │  Frontend polls GET .../status    │
                              └─────────────────────────────────┘
                                              │
                                              │ (new) MCP server, bearer-token auth
                                              ▼
                              ┌─────────────────────────────────┐
                              │  btg-devops MCP server            │
                              │  tools:                           │
                              │   - list_pending_requests()       │
                              │   - get_audit_data(id, scope)     │
                              │   - save_analysis(id, scope, ...) │
                              │  (thin wrappers over the existing │
                              │   model functions in app/api/models)│
                              └─────────────────────────────────┘
                                              ▲
                                              │ polls every N minutes
                              ┌─────────────────────────────────┐
                              │  Claude Code scheduled cloud agent│
                              │  (the `schedule` skill / cron)    │
                              │                                   │
                              │  1. list_pending_requests()       │
                              │  2. get_audit_data(...)           │
                              │  3. reason (same prompt shape as  │
                              │     today's analyzeWithLLM())     │
                              │  4. save_analysis(...)            │
                              └─────────────────────────────────┘
```

The dashboard's **read side is untouched** — `AnalysisPanel.tsx` still reads `claude_analysis` off
the audit the same way it does today. Only the write path changes: instead of the Next.js backend
calling an LLM directly, a Claude Code agent calls back into the dashboard's own data layer via
MCP tools.

## New components to build

1. **`analysis_requests` table** (new migration in `CLI Engine/internal/db/schema.go` or a
   dashboard-side migration, whichever this project's convention prefers):
   `id, audit_id, scope, status ('pending'|'done'|'failed'), requested_at, completed_at`.
2. **MCP server** — a new small service exposing:
   - `list_pending_requests()` → rows from `analysis_requests` where `status='pending'`
   - `get_audit_data(auditId, scope)` → same scoping logic already in `buildChatContextData()` /
     `runAnalysis()` (single resource type, `"cost"`, `"usage:<type>"`, or `"all"`)
   - `save_analysis(auditId, scope, summary, findings)` → calls the **existing**
     `updateClaudeAnalysis()` and `saveFindings()` functions unchanged, then marks the matching
     `analysis_requests` row `done`
   - Bearer-token auth (a new secret, separate from the dashboard's JWT auth — the MCP server is
     reachable from Claude's cloud infrastructure, not just localhost)
3. **Frontend change** — `AnalysisPanel.tsx`'s Analyze button posts to a new endpoint that inserts
   a request row instead of calling the LLM route directly; add a lightweight poll (e.g. every
   5-10s while `status='pending'`) that swaps to the result once `status='done'`.
4. **Scheduled Claude Code cloud agent** — configured via the `schedule` skill, polling on a short
   interval (minutes, not once-daily) so the button doesn't feel like a 24-hour wait. The agent's
   prompt reuses the same analysis instructions currently embedded in `analyzeWithLLM()`.

## Benefits

- **Zero per-token API cost** for Analyze — runs on the existing subscription's included quota.
- **No free-model reliability/quality risk in production** — same class of output quality as using
  Claude directly, not a rate-limited or lower-quality free tier.
- **No ToS exposure** — scheduled cloud agents are a supported product feature; nothing here scripts
  around a personal subscription's intended use.
- **Almost entirely reuses existing code** — the MCP tools are thin wrappers over model functions
  that already exist (`findAuditRawData`, `insertFinding`, `updateClaudeAnalysis`); the findings
  lifecycle logic, the caching behavior, and the prompt shape are all reused unchanged.
- **Decouples Analyze's cost model from Chat's** — Chat can keep using whatever model access is
  cheapest/available today without being blocked on this migration, and can be revisited
  independently later (e.g. once a real API key is approved).

## Costs / necessary considerations — read before building

- **Analyze is no longer instant.** It becomes "ready within the poll interval," not "ready in 5
  seconds." This is a real, visible UX change users will notice — communicate it, don't let it be
  a surprise regression report.
- **New auth surface.** The MCP server is the first piece of this system reachable from outside the
  dashboard's own login flow. The bearer token needs to be treated as seriously as `JWT_SECRET` —
  rotated, not logged, not committed.
- **New hosting requirement.** This rules out a pure-serverless (Vercel) deployment for the backend
  as long as this feature exists — the MCP server needs to be a persistent, reachable process.
  Decide hosting for this *before* building, not after.
- **New failure mode with no built-in visibility.** If the scheduled agent stops running (quota
  exhausted, auth token expired, the agent itself erroring), `analysis_requests` rows will pile up
  in `pending` with no error surfaced anywhere in the dashboard UI unless alerting is built for it.
  At minimum, surface "this request has been pending for longer than expected" in the frontend.
- **Chat is explicitly not solved by this spec.** Do not treat this as a Chat migration — Chat
  stays on its current model access, and needs its own follow-up decision (see Spec discussion:
  keep on free models permanently, get a smaller API budget just for Chat's lower volume, or accept
  a narrower version of the subprocess approach for Chat's human-paced traffic only).

## Build order

| Phase | What | Blocks on |
|---|---|---|
| 1 | `analysis_requests` table + migration | Nothing |
| 2 | MCP server: `list_pending_requests` / `get_audit_data` / `save_analysis` + bearer-token auth | Nothing (parallel to Phase 1) |
| 3 | Frontend: Analyze button creates a request + polls for status | Phase 1 |
| 4 | Scheduled Claude Code cloud agent (via the `schedule` skill) | Phases 1 + 2 |
| 5 | End-to-end test against a real audit; decide hosting for the MCP server | All above |
| 6 | Event-driven trigger (superseding the daily-only cron, see below) | Phase 4 |

## Update (2026-07-11) — event-driven trigger, not just a daily cron

Phase 4's routine originally ran on a fixed daily `cron_expression` (`0 8 * * *`) alone. In
practice this meant an audit's analysis could lag a full day behind its collection: the routine's
one daily tick often fired *before* that day's audit had even finished (GitHub Actions' own
scheduling delay pushes the actual collection run to ~10:00–12:00 UTC, well after the routine's
~08:00 UTC tick), so a day's audit typically got analyzed on the *following* day's tick instead of
the same day.

**Fix:** the CLI now fires the routine directly, the moment it finishes queuing analysis requests,
via the routine's `/fire` API endpoint
([docs](https://platform.claude.com/docs/en/api/claude-code/routines-fire)) — see
`triggerAnalyzerRoutine()` in `CLI Engine/cmd/collect.go`. This is event-driven, not clock-driven,
so it works regardless of when an audit runs (scheduled or manual "Run Audit"). The daily cron on
the routine itself is kept as a fallback in case the immediate trigger fails for any reason (e.g.
the secret isn't configured, or a transient API error) — `collect` treats a trigger failure as a
non-fatal warning, never as a reason to fail the audit.

Requirements for this to work:
- A per-routine API bearer token generated from the routine's page at
  [claude.ai/code/routines](https://claude.ai/code/routines) (Add another trigger → API → Generate
  token — shown once, cannot be retrieved again)
- That token stored as the `ROUTINE_TRIGGER_TOKEN` GitHub Actions secret
- Headers required on the `/fire` call: `Authorization: Bearer <token>`, `anthropic-version:
  2023-06-01`, `anthropic-beta: experimental-cc-routine-2026-04-01` — the version header is easy
  to miss and the endpoint 400s without it
