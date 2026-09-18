# Security Remediation — Plan Index

**Source:** `docs/security-static-review-2026-09.md` (+ findings discovered while fixing C1–C3 on `abd-production-2`)

This is an index, not a plan. The work is split across three executable plans
because they touch independent subsystems, have different risk profiles, and
one of them (the Next.js major upgrade) can break the whole app while the
others cannot.

---

## Already shipped (branch `abd-production-2`, not yet merged)

Do **not** re-do these — they are done and covered by tests.

| ID | Finding | Where |
|---|---|---|
| C1 | Role check failed open (`!identity ⇒ admin`) | `web/lib/auth.ts` — `getRequestRole` now defaults to `viewer` |
| C2 | `btg_session` HMAC never verified | `web/lib/auth.ts` — new `getVerifiedIdentity()` |
| C3 | ~12 routes with no auth check | Guards added to 17 route handlers |
| — | `/api/auth/users` had **no** guard at all (not in the report) | `isAdminRequest` added |
| — | `/api/auth/me` had its own copy of the C1 bug | Uses `getVerifiedIdentity`, returns 401 |
| — | Admin login signed the session over `ADMIN_USERNAME`, not the email | `login/route.ts` signs over `normalEmail` |
| — | CVE-2025-29927 (Next.js middleware bypass) | `next` 14.2.5 → 14.2.35 |

Tests: `web/lib/auth.test.ts`, `web/lib/route-auth.test.ts`. Suite: 152 passing.

---

## The three plans

### Plan A — [Auth & session hardening](2026-09-15-auth-hardening.md)
**Covers:** H1 (OTP RNG), H3 (in-memory OTP state), M1 (default secret + `devOtp` leak), L1 (`Secure` cookie flag)
**Risk:** Low. Self-contained, well-tested, no dependency changes.
**Blocks:** Plan B Task 2 reuses the Postgres-store pattern established here.

### Plan B — [API hardening](2026-09-15-api-hardening.md)
**Covers:** H2 (raw error leakage), M2 (no rate limiting), roadmap #6 (schema validation), roadmap #7 (audit logging)
**Risk:** Low–medium. Rate limiting can break the scheduled GitHub Actions workflow if mis-sized — Task 3 documents the exact call volumes it must not break.
**Depends on:** Plan A (shares the `getDB()`-backed store pattern; no hard code dependency).

### Plan C — [Dependency & supply chain](2026-09-15-dependency-supply-chain.md)
**Covers:** CVE-2026-75604 (Windows RCE — **the most severe open item**), `npm audit` findings (`uuid`, `nodemailer`, `postcss`), M3 (CI action pinning), Dependabot + CI security gates, R6 (cloud IAM review checklist)
**Risk:** High for Task 3 (Next.js 14 → 15 major upgrade: async `params`, React 19, recharts). Every other task is low risk.
**Independent:** Can run in parallel with A and B, but see sequencing below.

---

## Sequencing

```
Plan C Task 1–2 (uuid, nodemailer)   ─┐  cheap, do first, unblocks nothing
Plan A (all tasks)                   ─┼─ can run in parallel
Plan B (all tasks)                   ─┘
                                      │
Plan C Task 3 (Next.js 15)  ──────────┴─► do LAST
Plan C Tasks 4–6 (CI, Dependabot, R6) ──► any time
```

**Why Next.js 15 goes last:** it rewrites the signature of every dynamic route
handler (`params` becomes a `Promise`). Plans A and B both add guards and
helpers to those same handlers. Doing the upgrade first means re-doing the
merge by hand; doing it last means the codemod runs over finished code once.

**The one exception:** if this dashboard is already deployed on a **Windows
host and reachable from an untrusted network**, CVE-2026-75604 is an
unauthenticated RCE and Plan C Task 3 becomes the immediate priority over
everything else here. Confirm the hosting OS before choosing the order.

**One file both plans touch:** `web/app/api/auth/login/route.ts` is edited by
Plan A (Tasks 3, 4 and 5) and Plan B (Task 3). The edits are additive and land
in different parts of the handler, but if the two plans run on separate
branches, merge Plan A first — Plan B Task 3 changes the handler's signature
from `Request` to `NextRequest`, which is easier to apply on top of Plan A's
changes than underneath them.

---

## Deliberately not planned

Two roadmap items from the review are out of scope for this programme, with
the review's own reasoning:

| Item | Why deferred |
|---|---|
| Roadmap §5 #10 — server-side sessions with revocation, `exp`/`jti`, TOTP-vs-email-OTP decision | The review itself says "larger change; the Now items make the current scheme safe enough in the interim." The current scheme is an HMAC over the identity with an 8-hour cookie `maxAge` and no server-side revocation — a known, accepted limitation, not an oversight. Revisit once Plans A–C land. |
| Roadmap §5 #12 — threat-model refresh cadence | Process, not code. Needs an owner and a trigger ("revisit on each new external boundary: a new MCP tool, a new public route"), which is a decision for whoever owns this service rather than something a plan can implement. |

Both should be raised as issues rather than silently dropped.

---

## Definition of done for the whole programme

- [x] `cd web && npm test` — green (208/208, verified 2026-09-15)
- [x] `cd web && npx tsc --noEmit` — clean
- [x] `cd web && npm run build` — succeeds
- [x] `cd web && npm audit --audit-level=high` — no findings
- [x] `go test ./...` — green
- [x] `govulncheck ./...` — no findings
- [x] Every finding in `docs/security-static-review-2026-09.md` §3 is either fixed or has a written, dated decision not to fix — all fixed except R6 (pending, see below)
- [x] `docs/security-static-review-2026-09.md` updated with a "Remediation status" section pointing at this index

**Two items are not "fixed" in the usual sense, deliberately:**
- **Plan C Tasks 4–5** (CI SHA pinning, Dependabot, security workflow gates) are **moot**: `.github/workflows/*` was removed entirely in a separate, concurrent move to Docker-based deployment. There is nothing left to pin or gate.
- **R6** (cloud credential least-privilege review) is **partially closed**: the Azure/Power Platform service principal was verified 2026-09-15 via direct REST calls (no `az` CLI needed — the app's own client-credentials from `web/.env.local` were enough to check its own role assignments and Graph permissions). Exactly `Reader` + `Cost Management Reader` at subscription scope, no write/delete, and only read-only Graph permissions. Hetzner and Anthropic still need real console access this environment doesn't have. See [docs/cloud-credential-review-2026-09.md](../../cloud-credential-review-2026-09.md).

Also fixed along the way, found while wiring up the (now-moot) CI security gates rather than in the original review: **9 `govulncheck` findings** in the Go 1.26.4 standard library and `golang.org/x/net`/`x/text` — see finding G1 in the static review.
