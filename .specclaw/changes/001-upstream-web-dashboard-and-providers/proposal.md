# Proposal: Land the fork's work on bistec-oss/main as reviewable PRs

**Created:** 2026-09-01
**Status:** 🟡 Draft

## Problem

_What problem are we solving? Why does it matter?_

The org repo `bistec-oss/btg-devops` has not received a commit since **2026-07-06**
(`2e3039d`). Everything built since then lives only in the fork
`Abdullahbistec/btg-devops` on `abd-production-2`: the entire `web/` Next.js
dashboard, the Postgres migration, the provider abstraction, the Hetzner
provider, the MCP server, the analyzer testable-function port, and a round of
correctness/security fixes. Upstream is 0 commits ahead — nothing needs merging
*in*, only *out*.

**The work has already been proposed, and that is the actual problem.**
`bistec-oss#4` — "Merge fork: dashboard, Power Platform, MCP server, and all
downstream work" — has been **open since 2026-08-17 with zero reviews and zero
comments**. It carries 98 commits, 679 files, +165,406 / -146. It is not
stalled for lack of a PR; it is stalled because a 679-file, 165k-line PR is not
something a human can review, so nobody starts.

This is a pattern, not a one-off. Three of the four PRs ever opened against the
org repo are still open:

| PR | From | Opened | State |
|----|------|--------|-------|
| #4 | `Abdullahbistec:abd-production-2` | 2026-08-17 | OPEN, 0 reviews |
| #3 | `Abdullahbistec:feature/btg-power-platform` | 2026-07-14 | OPEN |
| #2 | `feat/pp-access-grant-script` | 2026-07-06 | MERGED |
| #1 | `yomal321:production` | 2026-06-17 | OPEN |

The only PR that ever merged was the small one.

**Most of that diff is not our work.** Of the 674 files that differ between
`upstream/main` and the local branch, **503 files and 129,801 of 162,260
insertions (~80%) are the vendored `external/yomal/` tree** — a second
project's source and dashboard, plus a 184-file `graphify-out/` directory of
generated graph-analysis artifacts (`graph.json`, `graph.html`,
`GRAPH_REPORT.md`). Excluding it, the genuine payload is **171 files /
~32,459 insertions**. Reviewers are being asked to read four lines of vendored
and generated code for every one line of ours.

Why it matters: every week this sits, the fork diverges further, the diff grows,
and the review gets less likely to happen. Meanwhile the org repo — the one with
the release workflow and the name the team points at — does not contain the
product.

## Proposed Solution

_What are we building? High-level approach._

Stop trying to land one merge, and land a **sequence of independently reviewable
PRs** against `bistec-oss/main`, smallest-risk first. Concretely:

1. **Decide the fate of `external/yomal/` first**, because it dominates every
   measurement and every review. It is not a dependency of the build (nothing in
   `go.mod` or `web/` imports it; it has its own `go.mod`), so the default should
   be to keep it out of upstream entirely — as its own repo, a submodule, or
   simply not vendored. The `graphify-out/` artifacts should not be committed
   anywhere. This one decision removes ~80% of the diff.

2. **Slice the remaining ~171 files into themed PRs** that each stand alone and
   each pass CI: the CLI/analyzer work under `cmd/` + `provider/`; the `web/`
   dashboard; the Postgres migration; the MCP server; the scheduled-audit
   workflow and `scripts/`; docs. Ordering matters — `cmd/` and `provider/`
   first, since `web/` shells out to the built binary.

3. **Give upstream a CI gate before the big code lands, not after.** Upstream
   currently has only `release.yml`. This branch's verification is real and
   should be enforced on every PR: `go vet ./...`, `go test ./...`,
   `npx tsc --noEmit` (clean as of `68be4ca`), and `npx vitest run` (56 tests).
   A reviewer who can see green checks reviews faster than one who cannot.

4. **Repoint or close `#4`** rather than leaving it open alongside the new PRs.
   Two competing routes for the same work is how #1 and #3 became permanent.

This proposal covers deciding and sequencing the above. It does not itself
merge anything — merging is the org's call and needs a reviewer on their side.

## Scope

### In Scope
- A written decision on `external/yomal/`: excluded, submoduled, or split out —
  with the mechanics for whichever is chosen (including whether to purge it from
  history or simply stop carrying it forward).
- A concrete PR breakdown of the ~171 non-vendored files: what goes in each PR,
  in what order, and what "this PR is reviewable on its own" means for each.
- A CI workflow for `bistec-oss/main` running the four gates above on PRs.
- Reconciling the local branch with `origin/abd-production-2`, which is
  currently **14 commits ahead** of local (the analyzer testable-function port,
  `1f6ed9b`..`148f1b7`) while local holds **5 unpushed fix commits**
  (`9b3af4c`..`68be4ca`). They touch disjoint files, so this is a rebase, not a
  merge conflict — but it must happen before anything is pushed.
- Deciding what happens to the existing `#4`, `#3`, and `#1`.

### Out of Scope
- Actually merging into `bistec-oss/main` — requires a reviewer with write
  access on the org repo, which is a people problem this proposal cannot solve.
- Any new product feature. This is purely about getting existing, working code
  into the right repository.
- The orphaned `AssistantPanel` at `web/app/dashboard/page.tsx:312` (imported
  nowhere, so the async AI-analysis pipeline is unreachable). It is a real
  defect and it will surface in review, but rewire-vs-delete is a product
  decision that should not block this.
- Rewriting or "cleaning up" the 89–103 commits into a tidy history. Tempting,
  and out of scope: it would invalidate the review of anything already read.

## Impact

- **Files affected:** 171 non-vendored files to be upstreamed (674 total differ;
  503 are vendored `external/yomal/`). Plus 1 new CI workflow.
- **Complexity:** large — not technically hard, but it spans two repos, an
  unresolved vendoring decision, and a review process that has already failed
  three times.
- **Risk:** medium. The code itself is already running and now has 56 web tests
  plus a clean `tsc`/`go vet`/`go test`. The risk is not breakage; it is that
  this stalls exactly like `#4` did, and the fork drifts another month.

## Open Questions

- **Who upstream actually reviews this?** `#4` sat 15 days with zero comments and
  `#1`/`#3` have sat for months. Splitting into small PRs only helps if someone
  is assigned to read them. If no reviewer can be named, the honest answer may
  be to move the org repo's default branch to this work wholesale and accept
  it unreviewed — a legitimate choice, but it should be a stated one.
- **Was `external/yomal/` vendored deliberately** (a reference port source, kept
  on purpose) or incidentally? Several commits say "ported from yomal", so it
  may be serving as a working reference. If so, it should live somewhere that
  isn't the shipping repo.
- **Should the vendored tree be purged from history** or merely dropped going
  forward? Purging rewrites 89+ commits and breaks every existing PR and
  checkout; leaving it means upstream inherits ~130k lines of another project
  the first time anything merges.
- **Does the team want the `web/` dashboard in this repo at all**, or as its own
  deployable? Merging it upstream commits the org repo to carrying a Next.js app
  plus a Postgres schema, which is a different maintenance shape than a CLI.
- **`schedules.hour` changed meaning** in `1cc40ff` (server-local hour → UTC
  hour). That is unreleased and only affects the fork today, but if any
  deployment already has schedules configured, upstreaming it shifts when they
  fire.

### Raised by the party panel (verdict: CHANGES_REQUESTED — advisory)

- (party-architect) The `web/` slice and the Postgres-migration slice are the same files, so neither stands alone — state the file-set intersection per pair, or collapse them. — see party-report.md
- (party-architect) Cross-slice shared manifests (`go.mod`, `go.sum`, web lockfile) are never enumerated as co-changes; slicing by directory yields PRs whose manifest state contradicts their code. — see party-report.md
- (party-architect) Upstream's existing `release.yml` is cited twice but never given a verdict — unchanged, or changed in a named PR? — see party-report.md
- (party-architect) The four proposed gates never build the binary, so the `web/`-shells-out-to-CLI seam that justifies the ordering is untested — add `go build` and name the stub seam. — see party-report.md
- (party-architect) The CI workflow is specified only as four command strings: triggers, path filters, toolchain versions, per-gate working directory and required-vs-advisory are all unstated. — see party-report.md
- (party-architect) The vitest gate has no stated database seam, though the headline payload is a move to Postgres — either CI needs a service container or the migration lands untested. — see party-report.md
- (party-architect) `schedules.hour`'s changed meaning is filed as an open question rather than a required co-change of the migration slice; the read/convert contract is unspecified. — see party-report.md
- (party-po) Reviewer availability, not PR size, may be the real bottleneck — confirm a named reviewer before investing in the slicing and CI-gate machinery. — see party-report.md
- (party-po) The cost of doing nothing is stated as a direction, not a rate — give the historical diff-growth per week since 2026-07-06. — see party-report.md
- (party-po) A standalone `docs` PR has no stated distinct value; fold it into the PRs it documents or justify the split. — see party-report.md
- (party-po) The recurring CI cost of the new gate is unquantified — state approximate wall-clock for the full run. — see party-report.md

---

**To proceed:** Review this proposal and approve to begin planning.
