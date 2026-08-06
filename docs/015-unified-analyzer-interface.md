# 015 — Unified Analyzer Interface

## Status

**Design complete, not yet implemented.** Full design rationale and code-level
detail: [docs/superpowers/specs/2026-08-06-unified-analyzer-interface-design.md](superpowers/specs/2026-08-06-unified-analyzer-interface-design.md).
This page is the short summary; the spec is the source of truth.

## Command

Affects `analyze all` internals only. No new command, and no change to any
existing command's own flags or output:

```bash
btg-devops analyze all [--scope all|azure|pp] [--output table|json] [--fail-on-critical]
```

## Problem

Three independent implementations currently exist for the same job — turning
each command's domain-specific finding shape into one normalized shape:

1. `cmd/analyze_all.go`'s `extractFindings()` + `resourceFields` — a
   string-matching heuristic, used only by `analyze all`.
2. `web/lib/btg-runner.ts`'s `extractResource()` — a separate TypeScript
   heuristic with its own field list, used by the dashboard's actual audit-run
   path (which calls each command individually, not `analyze all`).
3. `PPAnalyzer` / `PPBaseFinding` (`cmd/pp_helpers.go`) — an interface
   documented as implemented by every Power Platform command, but in fact
   implemented by none.

One concrete bug results from heuristic #1: `pp-environments` findings have an
**empty `Resource` field** in `analyze all --output json` today, because
`PPEnvFinding`'s JSON key (`environment`) isn't in `resourceFields`.

## Design summary

- A real `Analyzer` interface (`Name() string`, `Run(ctx) ([]UnifiedFinding, error)`)
  replaces the unused `PPAnalyzer`. All 18 existing commands (13 Azure, 5
  Power Platform) implement it via a small per-command adapter.
- Each command self-registers its adapter in its existing `init()` (which
  already registers its cobra command), via `registerAzureAnalyzer(...)` /
  `registerPPAnalyzer(...)` — no manual list of 18 to maintain.
- `analyze all` calls analyzers in-process instead of re-executing the binary
  as a subprocess once per command, wrapped in panic recovery so one
  analyzer's failure can't abort the whole run.
- Every per-command `Finding` struct gains an additive `resource` JSON field
  (nothing renamed or removed), fixing the `pp-environments` bug at the
  source and setting up a future simplification of
  `web/lib/btg-runner.ts`'s `extractResource()`.

## Non-goals

- No change to the Go CLI's relationship with SQLite (it stays stateless).
- No change to any command's standalone table/JSON output.
- No change to `web/lib/btg-runner.ts` in this pass.
- No shared credential/auth abstraction.

See the linked spec for the full interface code, the `analyze_all.go`
rewiring, and the testing plan.

## Version

Design written 2026-08-06. Target version TBD at implementation time.
