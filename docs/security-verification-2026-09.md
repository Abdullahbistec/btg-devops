# Security Remediation Verification — btg-devops

**Date:** 2026-09-15
**Purpose:** Independent re-audit (static + live) confirming the remediation programme actually landed, rather than trusting the status table in `docs/security-static-review-2026-09.md`. Companion to that file and `docs/security-live-test-2026-09.md`.
**Result:** ✅ All originally-reported Critical/High/Medium findings verified fixed in committed code. No regressions found.

---

## Static verification (committed code, branch `abd-production-2`)

| Finding | Claim | Independently verified | Evidence |
|---|---|---|---|
| C1 fail-open | Fixed | ✅ | `lib/auth.ts` — `getRequestRole` resolves via `getVerifiedIdentity`; no `!identity ⇒ admin` path remains. |
| C2 forgeable identity | Fixed | ✅ | `getVerifiedIdentity()` HMAC-verifies `btg_session` with `timingSafeEqual` (`lib/auth.ts:60-70`). |
| C3 open routes | Fixed | ✅ | Every previously-open route now carries `isAuthenticatedRequest`/`isAdminRequest`; `admin/*` keep fail-closed local `isAdmin`. |
| M1 default secret | Fixed | ✅ | `middleware.ts` uses `process.env.SESSION_SECRET` and **rejects every authenticated request when unset** (no `'btg-devops-default-secret'` fallback). |
| H1 predictable OTP | Fixed | ✅ | `lib/otp-store.ts` uses `crypto.randomInt(0, 1_000_000)`; store moved to Postgres `otp_codes` (hashed code, attempts, expiry). |
| L1 cookie flags | Fixed | ✅ | `secure: process.env.NODE_ENV === 'production'` on session cookies (`lib/auth.ts:47`). |
| M2 rate limiting | Fixed | ✅ | `lib/rate-limit.ts` applied to `auth/login`, `auth/register`, `auth/resend-otp`, `auth/verify-otp`, `audits/run`, `cost/*`. |
| Next.js CVE | Fixed | ✅ | `package.json` → `next: ^15.5.25`. |
| M3 CI pinning | Moot | ✅ | `.github/workflows/*` removed (commit `57172c2`); replaced by Docker scheduling. Nothing to pin. |

**Build/test gates (run here, not quoted):**
- `npx tsc --noEmit` → exit 0 (clean).
- `npm test` (vitest) → **25 files, 208/208 passing**.

### Re-run 2026-09-16
- Delta since 2026-09-15: one commit, `e0a8cb6` — **N1 closed**. It traced all 5 `/api/internal/*` handlers (each checks `isInternalServiceRequest` before params/DB, so a tokenless call always returns 401, never 500) and added 15 regression tests (tokenless / wrong token / `MCP_INTERNAL_TOKEN` unset). This retro-confirms the 500 I saw in the earlier live test was a Next.js dev-mode transient, not the route code.
- `npx tsc --noEmit` clean; `npm test` → **26 files, 223/223** (a first run reported 213/223 with `child_process onexit` noise — a flaky interrupted worker; a clean re-run passed all 223).
- No other web/security changes. Prior verdicts stand.
- **Hygiene note:** `web/role_assignments.json` (R6 artifact, ~1.8 KB) is untracked and **not gitignored** — no secrets in it, but it holds principal/role IDs. Add it to `.gitignore` or delete it so it isn't committed by accident.

---

## Live verification (local `npm run dev`, `http://localhost:3002`, local Postgres)

| Check | Expected | Observed | Verdict |
|---|---|---|---|
| Unauth `GET /api/settings`,`/dashboard`,`/findings`; `POST /audits/run`; `GET /admin/users` | 307/401 | **307** (→/login) all | ✅ |
| Unauth `PATCH /api/findings/<uuid>` | blocked | **307** | ✅ |
| M2 — 12 rapid wrong-password logins | 429 appears | `401×10` then **`429 429`** | ✅ rate limiting live |
| N2 — anonymous `GET /api/auth/me` | not admin | **`{"error":"Not signed in"}`** | ✅ fixed (was `role:"admin"`) |

Server stopped and port released after testing. No rows written; no production or remote systems contacted.

---

## Residual / not verifiable here
- **R6 (Hetzner + Anthropic credential scope):** Azure/PP SPN verified least-privilege (commit `227aadb`); Hetzner and Anthropic still need console access — carried in `docs/cloud-credential-review-2026-09.md`.
- **N1 (`/api/internal/*` 500 vs 401 for tokenless calls):** not re-checked this pass; confirm a clean JSON 401 and add a regression test if not already covered by `rate-limit-routes.test.ts`/route-auth tests.
- **Go side:** `go test ./...` and `govulncheck ./...` were reported green by the remediation programme; not re-run in this verification pass (web-focused).

**Bottom line:** the dashboard that the static review flagged as "not safe to expose" is now enforcing authentication at both the middleware perimeter and per route, with rate limiting, CSPRNG OTP, and hardened session handling — all confirmed against the running server and the committed source.
