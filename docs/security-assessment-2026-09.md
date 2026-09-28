# Backend Security Assessment — btg-devops

**Date:** 2026-09-16
**Method:** Full static review of both backend surfaces + live probing of the running dashboard (local, non-destructive) + independent build/test/scanner gates. Consolidates and supersedes the working notes in `security-static-review-2026-09.md`, `security-live-test-2026-09.md`, and `security-verification-2026-09.md`.
**Scope:** Go CLI + MCP server (`cmd/`, `main.go`, `provider/`), Next.js dashboard (`web/app/api/**`, `web/middleware.ts`, `web/lib/**`), secrets/deps/deploy config.

---

## 1. Executive summary

The backend is in **good** security shape. Both machine-to-machine hops (MCP bearer token, dashboard internal token) and the browser→API boundary now enforce authentication and fail closed. A prior remediation programme fixed a set of serious dashboard auth flaws (fail-open role check, forgeable identity, unauthenticated routes); this assessment **independently verified those fixes landed in committed code and hold at runtime**, and found no regressions.

Top three things that matter now (all low/medium, none blocking):
1. **Cloud credential blast radius** — the Hetzner and Anthropic token scopes are still unreviewed (the Azure/PP SPN was verified least-privilege). This is the largest residual risk because a leaked over-scoped token has impact beyond the app.
2. **Secrets still live in `.env` as long-lived SPN client secrets** — no managed identity / vault. Fine for now; the highest-value hardening to build next.
3. **Minor hygiene** — a stray untracked `web/role_assignments.json` (IDs, no secrets) isn't gitignored.

**Safe to expose publicly today?** Behind TLS to a trusted user base, yes — authentication, rate limiting, CSPRNG OTP, and hardened sessions are all in place and tested. Before broad public exposure, close R6 (token scopes) and adopt vault-based secrets.

**Gates run this assessment:** `tsc` clean · `npm test` 223/223 · `npm audit --audit-level=high` 0 · `go vet` clean · `go test ./...` ok · `govulncheck ./...` 0 reachable.

---

## 2. Attack surface map

| Boundary | Mechanism | Verdict |
|---|---|---|
| Browser → Next.js API | `btg_session` HMAC verified in `middleware.ts`; per-route `isAuthenticatedRequest`/`isAdminRequest` | ✅ fail-closed |
| Next.js API → Postgres | raw `pg`, parameterized throughout | ✅ |
| Next.js API → Go binary | `execFile`, fixed argv, no shell, creds via env | ✅ |
| MCP client → Go `--http` | bearer token, `subtle.ConstantTimeCompare` | ✅ |
| Go MCP → dashboard `/api/internal/*` | `MCP_INTERNAL_TOKEN`, `timingSafeEqual`, checked first | ✅ |
| CLI → Azure / Hetzner / Power Platform | SPN secret + Hetzner token from env; `0600` writes; no secret logging | ✅ SPN least-priv; ⚠️ Hetzner/Anthropic scope unverified (R6) |

**Route authz posture (current):** all `/api/*` gated by `middleware.ts` except public prefixes (`auth/*`, `internal/*` which carry their own token check); admin routes use `isAdminRequest` (fail-closed) or a local `isAdmin`; read/write data routes use `isAuthenticatedRequest`. **MCP tools** exposed over HTTP all sit behind a required bearer token.

---

## 3. Findings

No Critical or High findings. The serious issues from the earlier review are fixed and verified (§4). What remains:

### 🟡 M-1 — Long-lived SPN client secret in environment (no vault / managed identity)
- **Severity:** Medium · CONFIRMED (code + config)
- **Where:** Azure/PP credentials read from `AZURE_CLIENT_SECRET` / `BTG_PP_CLIENT_SECRET` env (`web/lib/btg-runner.ts`, `cmd/*`), and `HCLOUD_TOKEN` (`cmd/hetzner_helpers.go:33`).
- **Problem:** A static client secret in `.env` / container env is long-lived, rotated manually, and readable by anything with process/file access. A leak = standing cloud access until someone notices and rotates.
- **Solution:** Move Azure auth to a **workload/managed identity** (no secret at rest) where the runtime supports it, or store secrets in **Azure Key Vault** and fetch at boot. Keep the `crypto.ts` AES-256-GCM at-rest encryption for any secret that must live in the DB. Rotate the existing SPN secret and Hetzner token as part of the switch.
- **Effort:** M.

### 🟡 M-2 — Cloud credential blast radius partly unverified (R6)
- **Severity:** Medium · PLAUSIBLE (needs console access)
- **Where:** Hetzner `HCLOUD_TOKEN`, Anthropic `ANTHROPIC_API_KEY`.
- **Problem:** The Azure/PP SPN was verified as least-privilege (Reader-class, no Graph write) on 2026-09-15. The Hetzner token and Anthropic key scopes were not — a Hetzner token with write/delete would let a leak destroy or alter infrastructure a read-only audit tool never needs to touch.
- **Solution:** In the Hetzner console, confirm the token is **read-only** (or issue a read-only one and swap); cap the Anthropic key's spend/rate. Record in `docs/cloud-credential-review-2026-09.md`.
- **Effort:** S (once console access is available).

### 🟢 L-1 — Stray `web/role_assignments.json` not gitignored
- **Severity:** Low (hygiene) · CONFIRMED
- **Problem:** ~1.8 KB artifact from the R6 review, untracked and not ignored — no secrets, but principal/role IDs, and it could be committed by accident.
- **Solution:** Add to `.gitignore` or delete.
- **Effort:** S.

### 🟢 L-2 — Session HMAC has no expiry/nonce in the signed payload
- **Severity:** Low · CONFIRMED (code)
- **Where:** `makeSessionToken` = `HMAC(secret, email)`; validity bounded only by the cookie's `maxAge`, no server-side revocation list.
- **Problem:** A stolen `btg_session` cookie is replayable until it expires (8h); logout clears the cookie client-side but the token stays valid if captured. Acceptable for the current trust model, not for high-value multi-tenant use.
- **Solution:** Bake an `exp` + `jti` into a signed token (or move to server-side session records) so tokens can expire independently and be revoked. Pairs with the MFA/session item in the roadmap.
- **Effort:** M.

---

## 4. What's already done well (verified this pass)

- **Authentication fails closed.** `middleware.ts` HMAC-verifies `btg_session` on every non-public route and **rejects all requests if `SESSION_SECRET` is unset** (no default-secret fallback). Live: unauthenticated requests to every guarded route → 307/401.
- **Authorization is verified, not spoofable.** `getVerifiedIdentity()` recomputes the HMAC with `timingSafeEqual`; `getRequestRole` defaults to `viewer`. The old "no cookie ⇒ admin" and "plaintext identity cookie trusted" flaws are gone.
- **Rate limiting is real and multi-instance-safe.** Postgres fixed-window counter (`lib/rate-limit.ts`) on login/register/resend-otp/verify-otp/audits/cost routes. Live: 10× wrong-password logins → 401, then **429**.
- **OTP hardened.** `crypto.randomInt` over the full 6-digit space; hashed, atomic, expiring Postgres store with attempt limits.
- **SQL injection: none.** Fully parameterized `pg` throughout; the few template fragments interpolate only server constants.
- **Command injection: none.** `execFile` with fixed argv, no shell; command constrained to an allowlist; creds via env.
- **Both service tokens** (MCP bearer, dashboard internal) use constant-time comparison; internal-token checked before params/DB (regression-tested).
- **Crypto** for stored secrets: AES-256-GCM, random IV, authenticated, key-length validated.
- **Cookies:** HttpOnly, SameSite=Lax, `Secure` in production.
- **Go side:** no secrets logged; file writes `0600` with internal paths; secrets from env, not hardcoded.
- **Dependencies:** `npm audit` 0, `govulncheck` 0 reachable, Next.js on 15.5.25 (CVE-patched).
- **Secrets in git:** `.env`/`web/.env.local`/DBs gitignored; nothing sensitive tracked.

---

## 5. Roadmap — what to build for a stronger platform

Phased; cheap-high-leverage first. Each with a recommendation.

### Now (this sprint) — small, high-leverage
- **Close R6 (M-2):** verify/rotate Hetzner token to read-only; cap Anthropic key. *Adopt.*
- **Gitignore/remove `role_assignments.json` (L-1).** *Adopt.*
- **Re-introduce CI security gates** (the old GitHub Actions were removed for Docker): run `npm audit`, `govulncheck`, `npm test`, `go test` on every push/PR — wherever the pipeline now lives. *Adopt — this is how the good posture stays good.*

### Next (this quarter)
- **Vault / managed identity for secrets (M-1).** Biggest single risk-reducer. *Adopt.*
- **Audit logging** of privileged and cost-affecting actions (who ran a scan, changed a schedule, mutated a finding, changed a role) — an `audit_log` table exists per the remediation; make sure every such route writes to it and that it's reviewable. *Adopt.*
- **Session hardening (L-2):** signed tokens with `exp`/`jti` or server-side sessions + real revocation on logout. *Adopt.*
- **Standing schema validation** at the boundary (zod) on every route body, as a required pattern for new routes. *Adopt — partly in place; make it the default.*

### Later
- **MFA posture decision** — email OTP today; evaluate TOTP for admins. *Adopt later.*
- **Per-route authz regression tests as a gate** — the `route-auth`/`rate-limit-routes`/internal-route suites already exist; require that any new `/api/*` route ships with an anonymous-and-viewer authz test. *Adopt as process.*
- **Threat-model refresh cadence** — revisit on each new external boundary (new MCP tool, new public route); name an owner. *Adopt as process.*
- **Per-user data isolation** — only if the product goes multi-tenant; today the data model is intentionally one estate. *Skip for now.*

---

## 6. Appendix

### Commands run (with results)
```
web:  npx tsc --noEmit            -> clean (exit 0)
web:  npm test (vitest)           -> 26 files, 223/223 pass
web:  npm audit --audit-level=high-> 0 vulnerabilities
go:   go vet ./...                -> clean
go:   go test ./...               -> ok (cmd 1.89s, provider cached)
go:   govulncheck ./...           -> 0 reachable (1 in unreached required module)
live: npm run dev (local :300x), non-destructive probes:
      - unauth GET/POST/PATCH to every guarded route -> 307/401 (never 200)
      - 12 rapid wrong-password logins -> 401×10 then 429×2
      - GET /api/auth/me anonymous -> {"error":"Not signed in"}
      server stopped, port freed, no rows written
static: read web/app/api/**, web/middleware.ts, web/lib/{auth,crypto,otp-store,
        rate-limit,db,btg-runner,audit-executor}.ts, cmd/mcp.go, cmd/*claude*.go,
        cmd/hetzner_helpers.go; git history + tracked-file scan for secrets
```

### Could not verify (needs external access)
- Hetzner token & Anthropic key scopes (R6 / M-2) — cloud consoles.
- Runtime behavior of the production Docker deployment (assessed the source, not the deployed container).
- `Secure`-cookie flag only engages when `NODE_ENV=production`; confirmed by code, exercised in dev where it is intentionally off.
