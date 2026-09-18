# End-to-End Test Report (Playwright) — Frontend + Backend

**Date:** 2026-09-17
**Tooling added:** Playwright (`@playwright/test` + Chromium) → `web/playwright.config.ts`, specs in `web/e2e/`, run with `npm run test:e2e` (from `web/`).
**Environment:** dev server auto-started on `http://localhost:3100`, local Postgres (`btg_devops`, 73k findings, 3 users). Non-destructive — no rows written.
**Result:** ✅ **20/20 E2E pass** · unit suite still **223/223** · no functional bugs in the app. Two environment/DX issues found (below).

---

## What was tested

### Functional — everything loads and works
| Flow | Result |
|---|---|
| 12 protected pages (`/dashboard`, `/admin`, `/settings`, `/audits`, `/cost`, `/reports`, `/compare`, `/power-automate`, …) redirect to `/login` when logged out | ✅ |
| Root `/` → `/dashboard` → `/login` when logged out | ✅ |
| Login page renders the sign-in form (email/password) | ✅ |
| Admin login (env-var admin, OTP-bypass) reaches `/dashboard` | ✅ |
| All 8 main pages load with no 5xx and no React error boundary | ✅ |
| No console errors / no 5xx across the whole admin journey (benign RSC prefetch aborts filtered) | ✅ |

### Security — enforced through the browser + HTTP
| Check | Result |
|---|---|
| Guarded API routes reject unauthenticated callers (settings/dashboard/findings/audits/subscriptions/cost + POST audits/run + PATCH findings) | ✅ 307/401 |
| Forged `btg_identity` cookie without a valid session | ✅ rejected |
| Internal service route without bearer token → clean **401** (not 500) | ✅ |
| Login rate limiting — burst of 12 yields **429** | ✅ |
| Anonymous `/api/auth/me` does not claim admin | ✅ |
| Reflected-XSS probe in login error (`<img onerror>`) never becomes a live DOM node | ✅ not reflected |
| No secret material (`CLIENT_SECRET`/`ENCRYPTION_KEY`/`SESSION_SECRET`/private keys) shipped in login HTML | ✅ |

---

## Issues found (none are app-logic bugs)

### 🟠 I-1 — Repo lives under a OneDrive-synced path; `.next` dev cache corrupts
- **Symptom:** the dev server crashed on start with `EINVAL: invalid argument, readlink '…\.next\server\app\api\auth\users\route_client-reference-manifest.js'` after two dev servers had written `.next`. Deleting `.next` fixed it.
- **Cause:** the project path is `…\OneDrive - BISTEC Global\Documents\GitHub\btg-devops`. OneDrive sync locks/rewrites files under `.next` (and can do the same to `node_modules`), which Next.js's dev manifest reads via `readlink`.
- **Impact:** flaky/failed local dev and E2E for anyone on this repo; not a production issue (prod builds in Docker).
- **Fix:** move the working copy outside OneDrive (e.g. `C:\src\btg-devops`), **or** exclude `.next` and `node_modules` from OneDrive sync (right-click → *Always keep off this device* / add to the OneDrive ignore list). Low effort, high daily payoff.

### 🟡 I-2 — `npm run dev` runs the scheduler and makes live Azure calls on boot
- **Symptom:** on dev-server start the scheduler ran a daily cost refresh and hit **Azure Cost Management rate limiting** (`fetchLiveCostSpend`, `lib/costManagement.ts:114`) — it retried and failed, as designed.
- **Impact:** every local `npm run dev` reaches out to real Azure and can consume rate budget; noisy logs; not a security bug.
- **Fix (optional):** gate the scheduler behind an env flag (e.g. `ENABLE_SCHEDULER=1`) so it's off in local dev by default.

### Not tested (scoped out, non-destructive run)
- **Regular-user OTP login** end to end — needs an email inbox; only the env-var admin path (OTP-bypass) is fully automatable here.
- **Admin mutations** (approve/reject/delete users, run audit, change schedule) — these write to the DB; asserting them E2E would mutate real local data. The backend authz for them is covered by the vitest `route-auth`/`rate-limit-routes` suites.

---

## How to run
```
cd web
npm run test:e2e            # all specs, auto-starts dev server on :3100
npx playwright test --ui    # interactive
```
Specs: `web/e2e/auth.spec.ts` (access control + XSS), `web/e2e/admin-flow.spec.ts` (functional journey + console/5xx watch), `web/e2e/security.spec.ts` (backend security over HTTP). Playwright artifacts are gitignored.

**Bottom line:** the platform works end to end — every page loads, auth is enforced at the browser and API layers, and the previously-fixed security controls (perimeter auth, no identity forgery, rate limiting, clean internal 401, no anon-admin) all hold in a real browser. The only findings are a OneDrive/`​.next` dev-environment hazard and the dev scheduler making live Azure calls — both easy to address.
