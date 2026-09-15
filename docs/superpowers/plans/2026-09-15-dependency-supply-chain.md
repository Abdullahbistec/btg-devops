# Dependency & Supply Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close CVE-2026-75604 (unauthenticated RCE on Windows-hosted Next.js — the most severe open finding), clear the outstanding `npm audit` advisories, pin CI actions to commit SHAs (M3), add automated dependency and vulnerability gates, and give the Azure/Hetzner least-privilege review (R6) a concrete checklist.

**Architecture:** Three of the four dependency findings are fixed by removing or upgrading a package. The fourth — `postcss` — is transitive through `next` and clears with the Next.js upgrade. The Next.js upgrade is deliberately scoped to **14.2.35 → 15.5.25 while staying on React 18**, which `next@15.5.25`'s peer range explicitly permits (`react: ^18.2.0 || ^19.0.0`). That closes the RCE without dragging React 19 and a `recharts` upgrade into a security fix. React 19 stays available as a separate, non-security follow-up.

**Tech Stack:** Next.js (14 → 15), React 18, Node 24, Go 1.25.5, GitHub Actions.

**Spec:** `docs/security-static-review-2026-09.md` — finding M3 and R6; plus [GHSA-p293-qw3h-jr36 / CVE-2026-75604](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36) and the `npm audit` output recorded in the index.

## Global Constraints

- **Task 3 is the only high-risk task in this plan.** Do it on its own branch and do not batch it with Tasks 1, 2, 4, 5 or 6. Every other task here is independently revertible in one commit.
- **Do not upgrade to React 19 as part of this work.** `next@15.5.25` accepts `react@^18.2.0`. Bundling a React major into a security patch makes the patch un-revertible and the blast radius unbounded. Task 3 Step 9 records React 19 as a separate follow-up.
- **Do not run `npm audit fix --force`.** It resolves to `next@16.3.5` and `uuid@14`, both major upgrades, chosen by a tool that cannot see this app's constraints. Every dependency change in this plan is deliberate and pinned.
- **Pinned action SHAs in Task 4 were resolved on 2026-09-15.** If a task fails because a SHA no longer exists, re-resolve it with the `gh api` command given in that step rather than reverting to a tag.
- After any dependency change: `cd web && npm test`, `cd web && npx tsc --noEmit`, `cd web && npm run build`, and for Go changes `go build ./... && go test ./...`.

---

### Task 1: Remove the `uuid` dependency entirely

`uuid` < 11.1.1 has a moderate advisory (missing buffer bounds check in v3/v5/v6). This codebase only ever calls `v4()`. Node has had `crypto.randomUUID()` built in since 14.17, and this project runs Node 24 — so the fix is to delete the dependency rather than upgrade it across two majors.

**Files:**
- Modify: `web/lib/db.ts` (10 occurrences)
- Modify: `web/app/api/schedule/route.ts` (2 occurrences)
- Modify: `web/app/api/auth/register/route.ts` (2 occurrences)
- Modify: `web/app/api/cost-requests/route.ts` (2 occurrences)
- Modify: `web/package.json` — drop `uuid` and `@types/uuid`

**Interfaces:**
- Consumes: `randomUUID` from `node:crypto`.
- Produces: no API change. `randomUUID()` returns the same RFC 4122 v4 string shape `v4()` did, so every stored id keeps its format and no migration is needed.

- [ ] **Step 1: Confirm the call sites**

Run: `cd web && grep -rn "from 'uuid'\|uuidv4(" lib app`
Expected: 16 lines across the four files above. Any other file means this plan is out of date — reconcile before continuing.

- [ ] **Step 2: Write the failing test**

Create `web/lib/uuid-free.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');

describe('the uuid package is not a dependency', () => {
  it('is absent from package.json', () => {
    // uuid <11.1.1 carries GHSA-w5hq-g745-h8pq, and this app only ever needed
    // v4 — which node:crypto provides with no dependency at all.
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('uuid');
    expect(Object.keys(pkg.devDependencies ?? {})).not.toContain('@types/uuid');
  });
});

describe('ids are still RFC 4122 v4', () => {
  it('createAudit produces an id of the same shape the old v4() did', async () => {
    const { getDB, createAudit } = await import('./db');
    const db = await getDB();
    const { rows } = await db.query('SELECT current_database() as name');
    if (!String(rows[0].name).endsWith('_test')) {
      throw new Error(`refusing to run destructive setup against ${rows[0].name}`);
    }
    await db.query('DELETE FROM findings');
    await db.query('DELETE FROM audits');
    await db.query('DELETE FROM subscriptions');
    await db.query(
      `INSERT INTO subscriptions (id, name, subscription_id, tenant_id, client_id)
       VALUES ('sub-uuid-test', 'Test Sub', 'g', 't', 'c')`
    );

    const audit = await createAudit('sub-uuid-test', 'UUID shape check');
    expect(audit.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
```

- [ ] **Step 3: Run the test and watch it fail**

Run: `cd web && npx vitest run lib/uuid-free.test.ts`
Expected: the package.json test FAILS (`uuid` is still listed). The id-shape test passes — it is the guard that proves the swap is behaviour-preserving, so it must pass both before and after.

- [ ] **Step 4: Swap the import in all four files**

In each of `web/lib/db.ts`, `web/app/api/schedule/route.ts`, `web/app/api/auth/register/route.ts` and `web/app/api/cost-requests/route.ts`, replace:

```ts
import { v4 as uuidv4 } from 'uuid';
```

with:

```ts
import { randomUUID } from 'crypto';
```

then replace every `uuidv4()` call with `randomUUID()`. In `web/lib/db.ts` there are ten; the others have one call each.

Run this to confirm none were missed: `cd web && grep -rn "uuidv4\|from 'uuid'" lib app || echo "NONE FOUND"`

- [ ] **Step 5: Drop the packages**

Run: `cd web && npm uninstall uuid @types/uuid`

- [ ] **Step 6: Run the tests and watch them pass**

Run: `cd web && npx vitest run lib/uuid-free.test.ts && npx tsc --noEmit && npm test`
Expected: all green. The id-shape test passing after the swap is what proves nothing downstream depends on the old implementation.

- [ ] **Step 7: Commit**

```bash
git add web/package.json web/package-lock.json web/lib/db.ts web/lib/uuid-free.test.ts \
        web/app/api/schedule/route.ts web/app/api/auth/register/route.ts \
        web/app/api/cost-requests/route.ts
git commit -m "$(cat <<'EOF'
fix(deps): replace the uuid package with node:crypto randomUUID

uuid <11.1.1 carries GHSA-w5hq-g745-h8pq and this codebase only ever used v4.
Removing the dependency is a better fix than upgrading across two majors.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Upgrade `nodemailer`

Four advisories against `nodemailer` <= 9.1.0, including two that allow mail to be delivered to an attacker-controlled domain via address-parsing bypasses. This app sends OTP codes by email, so a delivery bypass is an authentication bypass. `npm audit` reports this one as fixable without a breaking change.

**Files:**
- Modify: `web/package.json`, `web/package-lock.json`
- Touches (no code change expected): `web/lib/mailer.ts`, `web/app/api/admin/notify/route.ts`

**Interfaces:**
- Consumes: `nodemailer.createTransport(...)` and `transporter.sendMail(...)` — both stable across this upgrade.
- Produces: no API change.

- [ ] **Step 1: See what is currently resolved**

Run: `cd web && npm ls nodemailer && npm view nodemailer version`
Note both numbers before changing anything.

- [ ] **Step 2: Upgrade**

Run: `cd web && npm install nodemailer@latest`

- [ ] **Step 3: Confirm the advisories cleared**

Run: `cd web && npm audit --audit-level=high`
Expected: no `nodemailer` entry. `next`/`postcss` entries may remain — Task 3 clears those.

- [ ] **Step 4: Check the two call sites still type-check**

Run: `cd web && npx tsc --noEmit`
Expected: clean. `web/lib/mailer.ts` uses `createTransport({ host, port, secure, auth, tls })` and `sendMail({ from, to, subject, html, text })`; `web/app/api/admin/notify/route.ts` uses the same shapes. If `@types/nodemailer` now conflicts with the bundled types, remove `@types/nodemailer` from `devDependencies` — recent nodemailer ships its own.

- [ ] **Step 5: Verify a real send path in dev mode**

`web/lib/mailer.ts` short-circuits to a console log when `SMTP_PASS` is unset (`DEV_MODE`). With `SMTP_PASS` unset, run `cd web && npm run dev`, attempt a login as a non-admin DB user, and confirm the OTP block still prints to the terminal. This exercises `sendOTPEmail` up to the dev-mode branch and proves the import still resolves.

- [ ] **Step 6: Run everything and commit**

Run: `cd web && npm test && npm run build`

```bash
git add web/package.json web/package-lock.json
git commit -m "$(cat <<'EOF'
fix(deps): upgrade nodemailer past the address-parsing bypasses

Two of the four advisories allow delivery to an attacker-controlled domain.
This app mails OTP codes, so a delivery bypass is an auth bypass.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Next.js 14.2.35 → 15.5.25 (CVE-2026-75604)

**Do this on its own branch.** [GHSA-p293-qw3h-jr36](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36) is a Windows-specific path-traversal leading to **unauthenticated remote code execution**, affecting `>=13.4 <15.5.24`. Linux and macOS are unaffected, and the advisory states there is no workaround — only the upgrade. This repository's `BTG_DEVOPS_PATH` defaults to `../btg-devops.exe` and there is no Dockerfile or systemd unit, which strongly suggests a Windows host. **Confirm the production hosting OS before scheduling this**: on Windows it is the highest-priority item in the whole programme; on Linux it is important hygiene but not urgent.

Target `15.5.25` — the newest of the `15.5.x` backport line, which is past the `15.5.24` fix. Staying on React 18 keeps this a single-concern change.

**Files:**
- Modify: `web/package.json`, `web/package-lock.json`
- Modify: `web/next.config.mjs` — remove `experimental.instrumentationHook`
- Modify (async `params`): `web/app/api/findings/[id]/route.ts`, `web/app/api/analysis-requests/[id]/route.ts`, `web/app/api/cost-requests/[id]/route.ts`, `web/app/api/internal/analysis-requests/[id]/context/route.ts`, `web/app/api/internal/analysis-requests/[id]/complete/route.ts`, `web/app/api/internal/cost-requests/[id]/fetch/route.ts`
- Modify (test call sites): `web/lib/route-auth.test.ts`

**Interfaces:**
- Consumes: Next.js 15's route handler contract.
- Produces: every dynamic route handler's second argument changes from `{ params: { id: string } }` to `{ params: Promise<{ id: string }> }`. Callers — including tests — must pass a promise.

- [ ] **Step 1: Branch**

```bash
git checkout -b nextjs-15-upgrade
```

- [ ] **Step 2: Record the baseline**

Run and save the output of:

```bash
cd web && npm test && npx tsc --noEmit && npm run build
```

Everything must be green *before* the upgrade, so any breakage afterwards is unambiguously caused by it.

- [ ] **Step 3: Upgrade Next.js, keeping React 18**

Run: `cd web && npm install next@15.5.25`

Then confirm React was not dragged along:

```bash
cd web && npm ls react react-dom next
```

Expected: `next@15.5.25`, `react@18.x`, `react-dom@18.x`. If npm pulled React 19, run `npm install react@^18 react-dom@^18` to put it back — React 19 is explicitly out of scope here (see Global Constraints).

- [ ] **Step 4: Remove the now-invalid experimental flag**

`instrumentation.ts` is stable in Next 15 and the experimental flag is gone; leaving it produces an "Invalid next.config.mjs options detected" warning. Replace the whole of `web/next.config.mjs` with:

```js
/** @type {import('next').NextConfig} */
const nextConfig = {};
export default nextConfig;
```

`web/instrumentation.ts` itself needs no change — it is picked up automatically, and its `NEXT_RUNTIME === 'nodejs'` guard is still exactly right.

- [ ] **Step 5: Build, and read the errors**

Run: `cd web && npm run build`
Expected: FAIL, with type errors on the six dynamic route files of the form:

```
Type '{ params: { id: string; }; }' is not assignable to type '{ params: Promise<{ id: string; }>; }'
```

This is the migration's real work, and the build enumerates it for you.

- [ ] **Step 6: Migrate the three public dynamic routes**

In `web/app/api/findings/[id]/route.ts`, both handlers change. `GET`:

```ts
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAuthenticatedRequest(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  try {
    const db = await getDB();
    const { rows } = await db.query('SELECT * FROM findings WHERE id = $1', [id]);
    ...
```

and `PATCH` the same way — add `const { id } = await params;` after the auth guard and replace every `params.id` with `id`.

In `web/app/api/analysis-requests/[id]/route.ts`:

```ts
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAuthenticatedRequest(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  const request = await getAnalysisRequest(id);
  ...
```

In `web/app/api/cost-requests/[id]/route.ts`:

```ts
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAuthenticatedRequest(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  const request = await getCostFetchRequest(id);
  ...
```

- [ ] **Step 7: Migrate the three internal dynamic routes**

Same change, and these have several `params.id` uses each — destructure once at the top of the handler, immediately after the existing `isInternalServiceRequest` guard, then replace every use.

- `web/app/api/internal/analysis-requests/[id]/context/route.ts` — 1 use (line ~12)
- `web/app/api/internal/analysis-requests/[id]/complete/route.ts` — 3 uses (lines ~12, ~22, ~24)
- `web/app/api/internal/cost-requests/[id]/fetch/route.ts` — 4 uses (lines ~20, ~28, ~33, ~42)

In each file, change **only two things** — leave the existing
`isInternalServiceRequest` guard byte-for-byte as it is, including its exact
error message and status (they differ slightly from the public routes':
`{ error: 'unauthorized' }` lowercase):

1. the type annotation: `{ params }: { params: { id: string } }` → `{ params }: { params: Promise<{ id: string }> }`
2. add `const { id } = await params;` on the line immediately after the guard's closing brace, then replace every `params.id` in the body with `id`

So `context/route.ts` (a `GET`) becomes:

```ts
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isInternalServiceRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  const request = await getAnalysisRequest(id);
  ...
```

and the two `POST` handlers follow the same shape with their own method keyword.

Confirm none were missed: `cd web && grep -rn "params\.id" app/api || echo "NONE FOUND"`

- [ ] **Step 8: Update the test call sites**

`web/lib/route-auth.test.ts` passes plain objects where a promise is now expected. Change the three dynamic-route cases:

```ts
    ['GET /api/findings/:id', () => findingByIdGet(anonRequest('/api/findings/f1'), { params: Promise.resolve({ id: 'f1' }) })],
    ['PATCH /api/findings/:id', () => findingByIdPatch(
      anonRequest('/api/findings/f1', { method: 'PATCH', body: JSON.stringify({ remediation_status: 'suppressed' }) }),
      { params: Promise.resolve({ id: 'f1' }) },
    )],
    ['GET /api/analysis-requests/:id', () => analysisRequestByIdGet(anonRequest('/api/analysis-requests/r1'), { params: Promise.resolve({ id: 'r1' }) })],
    ['GET /api/cost-requests/:id', () => costRequestByIdGet(anonRequest('/api/cost-requests/r1'), { params: Promise.resolve({ id: 'r1' }) })],
```

- [ ] **Step 9: Build, type-check and test**

Run: `cd web && npx tsc --noEmit && npm test && npm run build`
Expected: all clean and green. If the build reports further breaking changes, work them one at a time against the official guide at `https://nextjs.org/docs/app/guides/upgrading/version-15` — but the async-`params` change and the config flag are the only two this codebase is expected to hit. It uses `req.cookies` on `NextRequest` (unchanged), never `cookies()`/`headers()` from `next/headers` (which became async), and has no `pages/` directory.

- [ ] **Step 10: Confirm the advisory cleared**

Run: `cd web && npm audit --audit-level=high`
Expected: no `next` or `postcss` entries. `postcss` was transitive through `next` and clears with it.

- [ ] **Step 11: Exercise the app end to end**

This is the step that catches what types cannot. Run `cd web && npm run dev`, then:
1. Sign in at `/login` as the `ADMIN_EMAIL` account → lands on `/dashboard`
2. `/dashboard` renders its charts (this is the recharts-on-React-18 check)
3. `/reports` lists findings, and changing one finding's remediation status succeeds — exercises `PATCH /api/findings/[id]`, the route whose signature just changed
4. `/cost` loads and the Refresh button completes — exercises `GET /api/cost-requests/[id]` polling
5. `/settings` loads the schedule list and the user list
6. Sign out, then confirm `/dashboard` redirects to `/login` — exercises `middleware.ts` under the new version

Any failure here is a blocker; do not merge past it.

- [ ] **Step 12: Commit**

```bash
git add web/package.json web/package-lock.json web/next.config.mjs web/app/api web/lib/route-auth.test.ts
git commit -m "$(cat <<'EOF'
fix(deps): upgrade Next.js to 15.5.25 for CVE-2026-75604

GHSA-p293-qw3h-jr36 is an unauthenticated RCE on Windows-hosted servers
affecting >=13.4 <15.5.24, with no workaround. Dynamic route params are a
Promise in Next 15, and experimental.instrumentationHook is now stable.
React stays on 18 — next@15.5.25 accepts it, and a React major does not
belong in a security patch.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 13: Record the React 19 follow-up**

React 19 is *not* required by this upgrade and is not a security fix. If it is wanted later it is its own piece of work: `react@19`, `react-dom@19`, `@types/react@19`, `@types/react-dom@19`, and `recharts` from `2.12.7` to at least `2.15.4` (the first 2.x whose peer range includes `react@^19`). Staying within recharts 2.x avoids its own v3 breaking changes. Open an issue for it rather than doing it here.

---

### Task 4: Pin CI actions to commit SHAs and scope permissions (M3)

A tag like `@v4` is mutable — whoever controls the action's repository can move it. `release.yml` runs with `contents: write`, and `scheduled-audit.yml` holds the Azure, Power Platform, Hetzner and Anthropic secrets, so a moved tag on any of these is a credential compromise.

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/scheduled-audit.yml`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. Behaviour is identical; only the resolution of each action changes from mutable to immutable.

- [ ] **Step 1: Re-resolve the SHAs**

These were resolved on 2026-09-15. Re-run this to confirm they still match before trusting them:

```bash
for spec in "actions/checkout@v4" "actions/setup-go@v5" "actions/upload-artifact@v4" \
            "actions/download-artifact@v4" "actions/setup-node@v4" "softprops/action-gh-release@v2"; do
  repo="${spec%@*}"; tag="${spec#*@}"
  echo "$spec -> $(gh api "repos/$repo/commits/$tag" --jq '.sha')"
done
```

Resolved values:

| Action | Commit SHA |
|---|---|
| `actions/checkout@v4` | `11d5960a326750d5838078e36cf38b85af677262` |
| `actions/setup-go@v5` | `40f1582b2485089dde7abd97c1529aa768e1baff` |
| `actions/upload-artifact@v4` | `ea165f8d65b6e75b540449e92b4886f43607fa02` |
| `actions/download-artifact@v4` | `d3f86a106a0bac45b974a628896c90dbdf5c8093` |
| `actions/setup-node@v4` | `49933ea5288caeca8642d1e84afbd3f7d6820020` |
| `softprops/action-gh-release@v2` | `3bb12739c298aeb8a4eeaf626c5b8d85266b0e65` |

If a value differs, use the one your command returns — the tag has moved since, which is exactly the mutability this task removes.

- [ ] **Step 2: Pin `release.yml`**

In `.github/workflows/release.yml`, replace each `uses:` line. Keep the human-readable tag as a trailing comment so the next reader knows what the SHA is, and so Dependabot (Task 5) can bump both together:

```yaml
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
```

```yaml
      - uses: actions/setup-go@40f1582b2485089dde7abd97c1529aa768e1baff # v5
```

```yaml
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
```

```yaml
      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4
```

```yaml
      - name: Create Release
        uses: softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65 # v2
```

`softprops/action-gh-release` is the one to care most about: it is third-party and runs in the job that holds `contents: write`.

- [ ] **Step 3: Pin `scheduled-audit.yml` and give it least privilege**

Replace the three `uses:` lines the same way — `actions/checkout`, `actions/setup-go`, `actions/upload-artifact` and `actions/setup-node`, using the SHAs above.

Then add a `permissions` block. The workflow currently declares none, so it inherits the repository default, which may be read/write on every scope. It only reads the repository and uploads artifacts (which use the Actions runtime token, not `GITHUB_TOKEN`), so `contents: read` is sufficient. Insert it immediately after the `on:` block, before `jobs:`:

```yaml
# This job holds the Azure, Power Platform, Hetzner and Anthropic secrets.
# It only needs to read the repository — artifact upload uses the Actions
# runtime token, not GITHUB_TOKEN — so nothing here should be able to write.
permissions:
  contents: read
```

- [ ] **Step 4: Verify the workflows still parse**

Run: `gh workflow list`
Then push the branch and confirm both workflows still appear and are not marked invalid. Alternatively, if `actionlint` is available: `actionlint .github/workflows/*.yml`.

- [ ] **Step 5: Trigger the scheduled workflow manually**

`scheduled-audit.yml` declares `workflow_dispatch: {}`. Run it once from the Actions tab (or `gh workflow run "Scheduled Governance Audit"`) and confirm it completes with the same result as before the pin. This is the only way to prove a SHA is fetchable and the reduced permissions are sufficient.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/release.yml .github/workflows/scheduled-audit.yml
git commit -m "$(cat <<'EOF'
build(ci): pin actions to commit SHAs and scope scheduled-audit permissions

Tags are mutable. release.yml runs with contents:write and scheduled-audit.yml
holds every cloud credential, so a moved tag on either is a compromise.
scheduled-audit.yml also had no permissions block and inherited the default.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Automated dependency and vulnerability gates

Everything in Tasks 1–3 was found by running `npm audit` by hand. Nothing in CI would have caught it, and nothing will catch the next one.

**Files:**
- Create: `.github/dependabot.yml`
- Create: `.github/workflows/security.yml`

**Interfaces:**
- Consumes: the pinned action SHAs from Task 4.
- Produces: a `security` workflow that fails on a high-or-worse npm advisory or any `govulncheck` finding.

- [ ] **Step 1: Add Dependabot**

Create `.github/dependabot.yml`:

```yaml
version: 2
updates:
  # Keeps the SHA pins from .github/workflows/*.yml current. Without this,
  # pinning to a SHA means never getting the action's own security fixes.
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 5

  - package-ecosystem: npm
    directory: /web
    schedule:
      interval: weekly
    open-pull-requests-limit: 10
    groups:
      # One PR for the routine bumps, so a real security PR stands out.
      minor-and-patch:
        update-types: [minor, patch]

  - package-ecosystem: gomod
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
```

Pinning actions to SHAs without this is strictly worse than tags — the pin freezes the action at a known commit and nothing ever moves it forward. The two changes belong together.

- [ ] **Step 2: Add the security workflow**

Create `.github/workflows/security.yml`:

```yaml
name: Security

on:
  push:
    branches: [main]
  pull_request:
  schedule:
    # Weekly, so a newly published advisory against unchanged code is still
    # found — most vulnerabilities arrive without anyone touching the repo.
    - cron: '0 6 * * 1'

permissions:
  contents: read

jobs:
  npm-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4

      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: '20'
          cache: npm
          cache-dependency-path: web/package-lock.json

      - name: Install
        working-directory: web
        run: npm ci

      - name: Audit
        working-directory: web
        run: npm audit --audit-level=high

  govulncheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4

      - uses: actions/setup-go@40f1582b2485089dde7abd97c1529aa768e1baff # v5
        with:
          go-version-file: go.mod
          cache: true

      - name: Install govulncheck
        run: go install golang.org/x/vuln/cmd/govulncheck@latest

      - name: Run govulncheck
        run: govulncheck ./...
```

- [ ] **Step 3: Run both gates locally first**

Run:

```bash
cd web && npm audit --audit-level=high
```

Expected: no findings — Tasks 1–3 cleared them. If any remain, fix them before adding a gate that will fail on every PR from now on.

```bash
go install golang.org/x/vuln/cmd/govulncheck@latest
govulncheck ./...
```

Expected: no findings. If `govulncheck` reports something in the Go CLI, that is a genuine new finding not covered by the original review — triage it before merging this task, and note it in `docs/security-static-review-2026-09.md`.

- [ ] **Step 4: Push and confirm the workflow runs green**

Push the branch and check the Actions tab. Both jobs must pass. A red gate on its first run means Step 3 was skipped.

- [ ] **Step 5: Commit**

```bash
git add .github/dependabot.yml .github/workflows/security.yml
git commit -m "$(cat <<'EOF'
build(ci): add Dependabot and npm audit / govulncheck gates

Every dependency finding in this remediation was found by running npm audit
by hand. Dependabot also keeps the Task 4 SHA pins from freezing forever.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Least-privilege review of the cloud credentials (R6)

This is the one open finding with no code change. It needs someone with Azure portal and Hetzner console access, and it bounds the blast radius of everything else: if the GitHub Actions secrets or the runner leak, the damage is exactly what these credentials can do.

**Files:**
- Create: `docs/cloud-credential-review-2026-09.md` (the record of what was found)

**Interfaces:** none — this task produces a document and, where needed, changes made in the cloud consoles.

- [ ] **Step 1: List what the Azure service principal can actually do**

With the Azure CLI, signed in as someone who can read role assignments:

```bash
az ad sp show --id "$AZURE_CLIENT_ID" --query "{displayName:displayName, appId:appId}" -o json
az role assignment list --assignee "$AZURE_CLIENT_ID" --all -o table
```

Expected, for what this tool actually does: `Reader` at subscription scope, plus `Cost Management Reader`. Record the real answer, whatever it is.

- [ ] **Step 2: Flag anything that can write**

Any assignment of `Contributor`, `Owner`, `User Access Administrator`, or a custom role whose `actions` include anything other than `*/read` is more than the analyzers need — every Azure code path in `cmd/` is a read. Record each one with the scope it applies at.

- [ ] **Step 3: Check the app registration's API permissions**

```bash
az ad app permission list --id "$AZURE_CLIENT_ID" -o table
```

The Power Platform analyzers need read access to the PP admin APIs. Note anything granting write, and anything granted but unused.

- [ ] **Step 4: Check the Hetzner token's scope**

The hcloud API has no endpoint that reports a token's own permissions, so this must be read from the console: Hetzner Cloud Console → the project → Security → API tokens. Confirm the token used by `HCLOUD_TOKEN` is **Read**, not **Read & Write**.

Every Hetzner code path in this repository is a read (`cmd/hetzner_*.go` lists servers, volumes, floating IPs, firewalls, certificates, and fetches pricing). If the token is Read & Write, generate a Read token, update the `HCLOUD_TOKEN` GitHub secret and any `.env.local`, and revoke the old one.

- [ ] **Step 5: Confirm the blast radius of the Anthropic key**

`ANTHROPIC_API_KEY` is spend, not data — note the workspace it belongs to and whether it has a spend limit set. A leaked key with no limit is a billing incident.

- [ ] **Step 6: Write it down**

Create `docs/cloud-credential-review-2026-09.md` recording, for each credential: what it is, where it is stored, what it can currently do, what it needs to do, and what was changed. Date it and name the reviewer. Close R6 in `docs/security-static-review-2026-09.md` by pointing at this file.

- [ ] **Step 7: Commit**

```bash
git add docs/cloud-credential-review-2026-09.md docs/security-static-review-2026-09.md
git commit -m "$(cat <<'EOF'
docs: record the cloud credential least-privilege review (R6)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Done when

- [ ] `cd web && npm audit --audit-level=high` — no findings
- [ ] `cd web && npm ls next` shows `15.5.25` or later
- [ ] `cd web && npm ls uuid` reports the package is absent
- [ ] `govulncheck ./...` — no findings
- [ ] `cd web && npm test`, `npx tsc --noEmit`, `npm run build` — all green
- [ ] Every `uses:` line in `.github/workflows/` is a 40-character SHA
- [ ] `scheduled-audit.yml` declares `permissions: contents: read`
- [ ] A manual `workflow_dispatch` run of the scheduled audit completes green
- [ ] `docs/cloud-credential-review-2026-09.md` exists and R6 is closed
