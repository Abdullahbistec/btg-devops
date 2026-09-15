# Backend Security Live/Dynamic Test — btg-devops

**Date:** 2026-09-15
**Method:** Local `npm run dev` (bound to `http://localhost:3001`) against the local Postgres (`localhost:5432/btg_devops`, 73,657 findings, 3 real users). Non-destructive probes only — no writes committed, no real cloud/prod DB touched. Companion to `docs/security-static-review-2026-09.md`.

---

## 1. Executive summary

Live testing produced two important corrections to the static review, and both change the verdict materially.

1. **The static review missed a file.** There is a project-level [web/middleware.ts](web/middleware.ts) (committed at HEAD) that HMAC-verifies the `btg_session` cookie on **every** non-public route and redirects unauthenticated requests to `/login`. This is a real authentication perimeter that the static pass did not account for — so the "fail-open" and "unauthenticated routes" criticals never applied to a request arriving from the network, even on the committed code.

2. **The code was patched mid-session.** Between the static review and this live test, the working tree was modified (it was clean at session start) to fix exactly the issues the static report raised — `getRequestRole` no longer fails open, a new HMAC-verifying `getVerifiedIdentity()` was added (fails closed on unset `SESSION_SECRET`), and ~18 routes gained `isAdminRequest` / `isAuthenticatedRequest` guards, with two new auth test files. The running server reflects this patched code.

**Net posture of the running system:** authentication is enforced at the perimeter *and*, now, per-route. The three static "Criticals" are **refuted** on the live system. What remains are genuine but lower-severity gaps, two of them confirmed live: **no rate limiting on the public `auth/*` routes** and **session cookies lack the `Secure` flag**. The predictable-OTP issue is unremediated in code. A latent default-`SESSION_SECRET` fallback still lives in `middleware.ts`.

This is now safe to expose behind TLS to a *trusted* user base; before broad/public exposure, close the rate-limiting and cookie items.

---

## 2. Verdict table (static findings → live result)

| ID | Static claim | Live verdict | Evidence |
|----|--------------|--------------|----------|
| **C1** | Role check fails open (no cookie ⇒ admin) | **REFUTED (live)** — two layers now prevent it | `POST /api/audits/run` with no cookies → **307 →/login** (middleware). And `lib/auth.ts` working tree: `getRequestRole` now returns `viewer` by default via `resolveIdentity`. |
| **C2** | Forgeable `btg_identity`; session HMAC never verified | **REFUTED (live)** | Middleware requires `hmac(secret, identity) === btg_session`; new `getVerifiedIdentity()` does the same at route level. `GET /api/admin/users` with forged `btg_identity` + no valid `btg_session` → **307 →/login**. |
| **C3** | ~12 unauthenticated routes; anon PATCH of findings | **REFUTED (live)** | All probed routes (`settings`, `dashboard`, `findings`, `subscriptions/compare`, `audits`, `schedule`) → **307** unauthenticated. Anon `PATCH /api/findings/<uuid>` → **307**. Working tree now guards them with `isAuthenticatedRequest`/`isAdminRequest`; `admin/*` keep their fail-closed local `isAdmin`. |
| **H1** | OTP via `Math.random()`, 6 digits, in-memory | **CONFIRMED unremediated (static)** | `web/lib/otp-store.ts` is *not* among the mid-session edits; code unchanged. Not exercised live (would require observing issued OTPs). |
| **H2** | Raw error messages returned to clients | **NOT REPRODUCED (live), code pattern remains** | `GET /api/findings/not-a-uuid` → clean **404 `{"error":"Not found"}`** (`findings.id` is `text`, so no cast error); `?severity=%27` → **`[]`** (parameterized, no error). The `catch → e.message` pattern still exists but no probe triggered a SQL/internal leak. |
| **M1** | Default `SESSION_SECRET` fallback; `devOtp` in response | **PARTIALLY FIXED** | `getVerifiedIdentity()` now fails closed if `SESSION_SECRET` is unset. **But `web/middleware.ts` still uses `process.env.SESSION_SECRET ?? 'btg-devops-default-secret'`** — a deployment without the env var would accept forged tokens at the perimeter. `SESSION_SECRET` *is* set in this environment, so not exploitable here. |
| **M2** | No rate limiting on auth/expensive routes | **CONFIRMED (live)** | 10 rapid `POST /api/auth/login` with wrong password → `401 401 401 401 401 401 401 401 401 401`, **no 429**. `auth/*` is exempt from middleware (public by design), so this is directly reachable. |
| **M3** | CI actions pinned to tags not SHAs | **CONFIRMED (static)** | Not a runtime test; unchanged in workflows. |
| **L1** | Cookies lack `Secure`; `SameSite=Lax` | **CONFIRMED (live)** | Admin login `Set-Cookie`: `btg_session=…; HttpOnly; SameSite=lax` and `btg_identity=…; HttpOnly; SameSite=lax` — **no `Secure`** on either. |

---

## 3. New findings found only during live testing

### 🟡 N1 — `/api/internal/*` returns 500 (HTML error page), not a clean 401, to unauthenticated callers
- **Severity:** Low–Medium · CONFIRMED (live)
- **Evidence:** `GET /api/internal/analysis-requests/pending` with no `Authorization` header → **500** with a Next.js HTML error document, rather than the expected `401 {"error":"unauthorized"}` from `isInternalServiceRequest`. These routes are (correctly) exempt from the login-redirect middleware, so the route handler runs — but something throws before or around the token check.
- **Impact:** A 500 HTML page can carry framework/stack detail in some configs (dev returns a verbose page); and an auth guard that errors instead of cleanly denying is fragile. No data was exposed (not a 200).
- **Fix:** Ensure `isInternalServiceRequest` runs first and returns a JSON 401 before any DB/work; wrap the handler so a missing/short token can never reach a throwing code path. Add a test asserting `401` (not 500) for a tokenless internal request.
- **How reproduced:** `curl -i http://localhost:3001/api/internal/analysis-requests/pending`

### 🟢 N2 — `GET /api/auth/me` reports `role: "admin"` to an anonymous caller
- **Severity:** Low · CONFIRMED (static+live path)
- **Location:** [web/app/api/auth/me/route.ts:15-17](web/app/api/auth/me/route.ts#L15-L17) — when no `btg_identity` cookie is present it returns `{ email: adminEmail, name: adminName, role: 'admin' }`.
- **Impact:** `auth/me` is public (exempt from middleware). It grants no privileged *action* (every real route independently verifies the session), but it leaks the configured `ADMIN_EMAIL` to any anonymous caller and could mislead a client into showing admin UI. Cosmetic/info-leak, not an escalation.
- **Fix:** Return `401`/`{authenticated:false}` when there is no verified session, rather than defaulting to the admin identity.

---

## 4. Evidence appendix

### Environment
- Server: `npm run dev` → Next.js 14.2.5 on `http://localhost:3001` (port 3000 was taken).
- DB: `postgresql://postgres@localhost:5432/btg_devops`, `sslmode` none, local only. Confirmed reachable (findings=73657, users=3). No production/remote DB was contacted.
- Auth used for authenticated probes: the env-var admin (`ADMIN_EMAIL`/`ADMIN_PASSWORD` from `web/.env.local`, my own system) via the `skipOtp` admin-login path. No new users were created; no rows were written.

### Key commands (sanitized)
```
# Perimeter (unauthenticated) — all 307 → /login
curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:3001/api/audits/run -d '{}'      # 307
curl -s -o /dev/null -w '%{http_code}' http://localhost:3001/api/settings                         # 307
curl -s -o /dev/null -w '%{http_code}' -X PATCH http://localhost:3001/api/findings/<uuid> -d '…'  # 307
curl -s http://localhost:3001/api/admin/users -H 'Cookie: btg_identity=<admin-email>'             # 307 (no valid btg_session)

# Authenticated (admin) — allowed through
curl -s -D - .../api/auth/login -d '{"email":"<admin>","password":"<redacted>"}'                  # 200; Set-Cookie HttpOnly SameSite=lax (no Secure)
curl -s -b jar .../api/settings                                                                    # 200 (admin-gated; returns tenant/client/subscription IDs)
curl -s -b jar .../api/findings/not-a-uuid                                                          # 404 {"error":"Not found"}  (no SQL leak)
curl -s -b jar '.../api/findings?severity=%27'                                                      # 200 []                    (parameterized)

# Rate limit
for i in 1..10: POST /api/auth/login {wrong pw}  ->  401 x10, no 429

# Internal route, no token
curl -i .../api/internal/analysis-requests/pending                                                 # 500 (HTML) — see N1
```

### Not verified / limitations
- **Viewer-vs-admin separation was not exercised with a real viewer session** — creating an active viewer requires a DB write (register + admin approval). From code, admin-only routes use `isAdminRequest` and read routes use `isAuthenticatedRequest`, so a viewer would see read routes and be blocked from admin routes; this was confirmed by code, not by a live viewer login (to keep the run non-destructive).
- **H1 (OTP entropy) not exercised live** — would require capturing issued OTPs across instances; verdict is from code (unchanged file).
- **Cloud RBAC blast radius (static R6)** — still requires Azure/Hetzner portal access; not testable locally.
- The working tree was changing during the session; verdicts above reflect the code as loaded by the running dev server at test time. The **committed HEAD** still contains the pre-fix `lib/auth.ts` and route files — the fixes are uncommitted. Commit them to make this posture durable.

---

## 5. What to do next (short list)
1. **Commit the mid-session fixes** — they are currently uncommitted working-tree changes; HEAD is still vulnerable. Run the new `auth.test.ts` / `route-auth.test.ts` first.
2. **Remove the default-secret fallback in `middleware.ts`** (M1 residual) — fail closed if `SESSION_SECRET` is unset, matching `getVerifiedIdentity`.
3. **Add rate limiting to `auth/*`** (M2) — login, resend-otp, register.
4. **Add `Secure` to cookies** behind a prod flag (L1).
5. **Swap OTP to `crypto.randomInt`** and move the OTP/attempt store to shared storage (H1/H3).
6. **Fix N1** (internal route → clean 401) and **N2** (`auth/me` anonymous admin).
