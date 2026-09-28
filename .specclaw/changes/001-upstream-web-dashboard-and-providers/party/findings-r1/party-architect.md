### [BLOCK] party-architect — The `web/` PR and the "Postgres migration" PR are slices of the same files, so neither stands alone
**Quotes:** > **Slice the remaining ~171 files into themed PRs** that each stand alone and
> each pass CI: the CLI/analyzer work under `cmd/` + `provider/`; the `web/`
> dashboard; the Postgres migration; the MCP server; the scheduled-audit
> workflow and `scripts/`; docs.
**Quotes:** > Merging it upstream commits the org repo to carrying a Next.js app
> plus a Postgres schema, which is a different maintenance shape than a CLI.
**Problem:** The proposal treats "the `web/` dashboard" and "the Postgres migration" as two independently reviewable slices, but by its own Open Questions the Postgres schema is part of what the Next.js app carries — the migration is a rewrite of the web app's data-access layer, not a disjoint file set. Under this split, whichever PR lands first must contain a coherent persistence layer: either the `web/` PR ships the pre-migration (SQLite) code and the second PR rewrites files the first PR's reviewer just read, or the `web/` PR already contains the migration and the second slice is empty. The "each stand alone and each pass CI" criterion is unsatisfiable for this pair, and no other slice boundary in the list is checked for the same overlap (`scripts/` and the scheduled-audit workflow plausibly invoke the same schema and the same binary).
**Fix:** State the file-set intersection for each pair of slices, and collapse `web/` + Postgres into one PR (or define the migration slice as schema/migration files only, with the web callers landing in the same commit).
**Status:** upheld

### [BLOCK] party-architect — The sequence's shared manifests are never enumerated as co-changes
**Quotes:** > **Files affected:** 171 non-vendored files to be upstreamed (674 total differ;
> 503 are vendored `external/yomal/`). Plus 1 new CI workflow.
**Quotes:** > the CLI/analyzer work under `cmd/` + `provider/`; the `web/`
> dashboard; the Postgres migration; the MCP server; the scheduled-audit
> workflow and `scripts/`; docs.
**Problem:** The Impact section accounts for the payload only as a file count. A themed split of a Go + Node payload means a small set of files is touched by nearly every PR in the sequence — `go.mod`/`go.sum` (provider abstraction, Hetzner provider, MCP server each plausibly add dependencies), and the web app's `package.json`/lockfile (dashboard, migration, tests). Those are exactly the files that make sequential PRs conflict with each other and make a mid-sequence PR fail CI on a dependency its own slice does not declare. The proposal names none of them, so an implementer slicing by directory will produce PRs whose `go.mod` state is inconsistent with their code.
**Fix:** List the cross-slice shared files (`go.mod`, `go.sum`, web lockfile, any `go.work`) and state for each PR what it adds to them, or land all manifest changes in the first PR of the sequence.
**Status:** upheld

### [BLOCK] party-architect — Upstream's existing `release.yml` is named twice but never listed as a file that must change
**Quotes:** > Upstream
> currently has only `release.yml`.
**Quotes:** > Meanwhile the org repo — the one with
> the release workflow and the name the team points at — does not contain the
> product.
**Problem:** The proposal identifies upstream's one existing automation — a release workflow built when the repo contained a single Go CLI — and then proposes landing `provider/`, a Next.js app, a Postgres schema, an MCP server, and a scheduled-audit workflow into that repo, while accounting for exactly "1 new CI workflow" and zero changes to the existing one. A release pipeline for a CLI-only repo is a caller of the repo's layout: it will either keep producing a binary that no longer reflects the product, or break on the new tree. Whether it must change is a decision the proposal makes silently by omission, and it is precisely the kind of unnamed co-change that leaves the first merge half-landed.
**Fix:** Add `release.yml` to the impacted-file list with an explicit verdict — unchanged (and why the new tree does not affect it), or changed in a named PR of the sequence.
**Status:** upheld

### [BLOCK] party-architect — The proposal names a binary-shellout seam and then specifies four gates that never build the binary
**Quotes:** > Ordering matters — `cmd/` and `provider/`
> first, since `web/` shells out to the built binary.
**Quotes:** > `go vet ./...`, `go test ./...`,
> `npx tsc --noEmit` (clean as of `68be4ca`), and `npx vitest run` (56 tests).
**Problem:** The ordering rationale rests on a subprocess seam: `web/` invokes a compiled artifact. None of the four proposed gates produces that artifact — `go vet` and `go test` do not leave a binary on disk, and `tsc`/`vitest` do not build Go. So the CI gate cannot exercise the one coupling the proposal cites as its ordering constraint, and a PR that changes the binary's flags, output shape, or exit codes passes all four gates while breaking `web/` at runtime. This is the seam question: the contract between `web/` and the CLI lives in neither layer's test suite as specified.
**Fix:** Add `go build` to the gate list, and state whether the 56 web tests stub the shellout or invoke the real binary — if they stub it, name the stub seam and how it stays in sync with the CLI's actual flags and exit codes.
**Status:** upheld

### [WARN] party-architect — The new CI workflow is specified as four command strings and nothing else
**Quotes:** > A CI workflow for `bistec-oss/main` running the four gates above on PRs.
**Quotes:** > `go vet ./...`, `go test ./...`,
> `npx tsc --noEmit` (clean as of `68be4ca`), and `npx vitest run` (56 tests).
**Problem:** This is a new shared contract between every PR in the sequence and the reviewer who reads its checkmark, and it is specified only as a list of commands. Unstated: trigger events (PR only, or push to main too), Go and Node versions, working directory for the `npx` gates, whether the web gates run when a PR touches only `cmd/`, whether the checks are advisory or required status checks on `main`, and what service dependencies the job provisions. Two implementers hand this paragraph produce materially different workflows — one where a `cmd/`-only PR is blocked by an unrelated `vitest` failure, one where it is not — and the whole value claimed ("A reviewer who can see green checks reviews faster") depends on which one they built.
**Fix:** Specify the workflow's triggers, path filters, toolchain versions, per-gate working directory, and whether each gate is a required check before the first sliced PR opens.
**Status:** upheld

### [WARN] party-architect — The `vitest` gate has no stated database seam, in a payload whose defining change is a move to Postgres
**Quotes:** > `npx vitest run` (56 tests)
**Quotes:** > the entire `web/` Next.js
> dashboard, the Postgres migration, the provider abstraction, the Hetzner
> provider, the MCP server, the analyzer testable-function port, and a round of
> correctness/security fixes.
**Problem:** The proposal makes 56 web tests a merge gate on a foreign repo while its own headline payload is a migration from an embedded database to a networked one. Those two facts interact: if any of the 56 tests touch the data layer, the gate requires a provisioned Postgres in CI (service container, connection string, schema load, teardown) — none of which is named — and if none of them touch it, then the migration that dominates the payload lands with no deterministic test at all. Either reading is a defect the proposal does not resolve, and the "clean as of `68be4ca`" evidence was gathered on a developer machine where a database happened to exist.
**Fix:** State which of the 56 tests exercise persistence and how — service container in the workflow, or an in-process fake at a named seam — and whether the migration slice adds tests of its own.
**Status:** upheld

### [WARN] party-architect — `schedules.hour` is a semantic change to a persisted field, filed as an open question instead of a co-change
**Quotes:** > **`schedules.hour` changed meaning** in `1cc40ff` (server-local hour → UTC
> hour). That is unreleased and only affects the fork today, but if any
> deployment already has schedules configured, upstreaming it shifts when they
> fire.
**Quotes:** > The code itself is already running and now has 56 web tests
**Problem:** A stored column's interpretation changed without, per the proposal, any accompanying migration, version marker, or read-time compatibility shim — the same integer now means a different instant. The proposal concedes the fork is "already running", so rows written under the old meaning exist, then routes the consequence to Open Questions rather than to the migration slice as a required co-change. That leaves the implementer of the Postgres/migration PR with no instruction: silently reinterpret existing rows, or convert them. It also silently couples this slice to the scheduled-audit workflow slice, which is the consumer of the field.
**Fix:** Decide in the artifact whether the migration slice carries a conversion for existing `schedules.hour` rows or explicitly declares the field's prior values invalid, and name the scheduled-audit workflow as the co-changing consumer.
**Status:** upheld
