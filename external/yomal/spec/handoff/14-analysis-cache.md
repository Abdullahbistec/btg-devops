# Spec 14 — Per-scope analysis cache (skip re-analysis when config hasn't changed)

> Status: **idea stage — agreed direction, nothing built yet.** Companion to
> `13-parallel-resource-agents.md`; the two ideas compose (see §Composition below) but this one
> stands alone and should be built **first**.

## The problem

Audits run daily (scheduled) plus on demand. On a stable subscription, most days the configuration
data is identical to the previous day's — same NSG rules, same Key Vault policies, same storage
settings. Yet every Analyze request today re-runs the full 5-stage deep-research playbook on that
unchanged data, spending the system's scarcest resource (a scheduled Claude Code agent run) to
re-derive findings it already produced yesterday.

## The idea

Cache at the **scope** (resource type) level: if a scope's config data is unchanged since the last
analyzed audit, don't re-analyze it — carry its findings forward instead.

1. **Fingerprint on save.** When the CLI saves an audit, compute a hash per scope over that scope's
   cleaned config data (`raw_data` per resource type) and store the hashes on the audit row.
2. **Compare on analyze.** When an analysis request is processed, compare each scope's hash against
   the most recent *analyzed* audit's hash for the same subscription.
   - **Hash identical** → skip the agent for that scope; carry the existing findings forward.
   - **Hash differs** → analyze that scope normally.
3. **Carry-forward is an active step, not a no-op.** The findings lifecycle in `claude.ts`
   (dedup by `resource_type+resource_name+category`, age tracking, "open for N audits", sticky
   dismissals, auto-resolve) must still advance: skipped scopes' findings get re-linked to the new
   audit with their age/first-seen preserved and their "audits open" count incremented. A cache hit
   means "same findings, still open, one audit older" — not a frozen snapshot.

## Deliberately out of scope: cost & usage

Cost and usage data changes every day by nature (rolling 90-day cost history, 30-day metrics), so
it would never cache — and it doesn't need to. The Cost & Usage page runs entirely on the
deterministic TypeScript detectors (`costInsights.ts` / `usageInsights.ts` — zombie spend, spend
spikes, idle resources), which cost no agent time and recompute on every audit regardless. **The
cache applies only to the AI analysis path over config data.** This keeps the design simple:
config data is exactly the slice that rarely changes, so hashing it as-is (no normalization games)
gives a high hit rate with no false "unchanged" risk.

## Safety valve: staleness ceiling

Even with identical hashes, force a real re-analysis after N audits/days (suggested: 7). Two
reasons: (a) playbook/checklist improvements should eventually reach unchanged resources too —
better prompts produce better findings on the same data; (b) belt-and-braces against any future
hashing bug silently pinning stale findings forever. The forced run resets the scope's cache clock.

## Where the pieces live

- **Hashing**: in the Go CLI at save time (`CLI Engine`), since it already owns writing `raw_data`
  per audit. New column(s) on the audit row (e.g. `scope_hashes JSONB`) via the idempotent
  `db.ApplySchema` migration — **remember the schema gotcha**: schema.go changes only apply when
  the CLI actually runs, never on a dashboard deploy (this bit us on 2026-07-11 with
  `fix_effort`/`finding_type`).
- **Comparison + skip decision**: in the dashboard's analysis-request path, before/around what the
  MCP agent sees — either the request-creation controller marks scopes as `cached` up front, or a
  new MCP tool lets the agent ask "which scopes changed since the last analyzed audit?" and the
  playbook tells it to only analyze those. (Decide during implementation; the former keeps the
  agent simpler.)
- **Carry-forward**: extends the existing lifecycle logic in `saveFindings`/`getScopedAuditData`
  (`dashboard/app/api/utils/claude.ts`) — same code path both the sync and MCP paths share.

## Composition with spec 13 (parallel per-resource agents)

The two ideas multiply: per-scope hashes tell the spec-13 orchestrator exactly **which of the 12
agents to spawn**. A typical day becomes "storage and IAM changed → run 2 agents + a light
synthesis pass; carry the other 10 scopes' findings forward." Caching alone already delivers most
of the daily savings (the cheapest analysis is the one skipped entirely), which is why it goes
first: it's simpler, touches less, works with the current single-agent routine today, and produces
the change-detection signal spec 13 wants as input.

## Open questions

- Hash granularity: per scope is the plan — is per *resource* worth it later (so one changed
  storage account doesn't re-analyze all storage)? Probably premature now; scopes are small.
- Exact hash input: the cleaned per-scope JSON as stored — confirm key ordering is stable in the
  stored JSON (hash after a canonical re-marshal if not).
- Chain findings (`finding_type: "chain"`) span multiple scopes: a chain finding should carry
  forward only if **every** scope it touches (`affected_resources`' types) is unchanged; if any hop's
  scope changed, that scope's re-analysis must be able to re-derive or retire the chain.
- Where the "N audits" staleness counter lives (per scope, on the audit row vs. a small table).
