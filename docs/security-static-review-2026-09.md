# Backend Security Static Review — btg-devops

**Date:** 2026-09-15
**Reviewer:** Static code review (no live requests, no servers started, no cloud/DB touched)
**Scope:** Go CLI + MCP server (`cmd/`, `main.go`, `provider/`), Next.js API layer (`web/app/api/**`, `web/lib/**`), CI (`.github/workflows/`), secret handling.
**Companion:** Every finding marked `PLAUSIBLE (static)` carries a *How to confirm live* note. Those notes are consolidated in the Appendix as a ready-to-run live test plan.

## Remediation status (2026-09-15)

Tracked by [docs/superpowers/plans/2026-09-15-security-remediation-index.md](superpowers/plans/2026-09-15-security-remediation-index.md), split into three plans (auth hardening, API hardening, dependency & supply chain).

| Finding(s) | Status |
|---|---|
| C1, C2, C3 | ✅ Fixed — `getVerifiedIdentity()` + `getRequestRole` default to viewer; guards applied to every previously-open route. |
| H1, H3, M1, L1 (Plan A) | ✅ Fixed — CSPRNG OTP, Postgres-backed OTP/attempt store, fail-closed `SESSION_SECRET`, gated `devOtp`, `Secure` cookies in prod. |
| H2, M2, roadmap §5 #6–7 (Plan B) | ✅ Fixed — `apiError()` rollout, Postgres rate limiting on auth/expensive routes, zod request validation, `audit_log` table. |
| `uuid`, `nodemailer` (Plan C Tasks 1–2) | ✅ Fixed — `uuid` removed (`node:crypto` `randomUUID`), `nodemailer` patched via `npm audit fix`. |
| CVE-2026-75604 / Next.js (Plan C Task 3) | ✅ Fixed — Next.js 14.2.35 → 15.5.25 on its own branch, React held at 18. Production is Docker/Linux-hosted, so this specific Windows RCE didn't apply, but the other ~20 Next.js advisories `npm audit` had flagged do, regardless of OS. |
| G1 — `govulncheck` findings (not in original review) | ✅ Fixed — see §3 below. Found while wiring up CI security gates. |
| M3, roadmap §5 #8 (Plan C Tasks 4–5: CI SHA pinning, Dependabot, security gates) | ⚪ **Moot** — `.github/workflows/*` was removed in a separate, concurrent move to Docker-based deployment. Nothing to pin or gate. |
| R6 (Plan C Task 6: cloud credential review) | 🔶 **Pending** — template drafted at [docs/cloud-credential-review-2026-09.md](cloud-credential-review-2026-09.md); needs someone with Azure/Hetzner/Anthropic console access to fill it in. |
| Roadmap §5 #10, #12 (deferred) | Deliberately out of scope for this programme — see the index's "Deliberately not planned" section. |

**Verified 2026-09-15:** `cd web && npm test` (208/208), `npx tsc --noEmit` (clean), `npm run build` (clean), `npm audit --audit-level=high` (0 findings), `go test ./...` (green), `govulncheck ./...` (0 reachable findings).

---

## 1. Executive summary

The Go audit engine and the MCP server are in good shape: SQL is parameterized, the Go binary is invoked without a shell, and both machine-to-machine hops (MCP bearer token, dashboard internal token) use constant-time comparison. **The problem is the web dashboard's authentication and authorization.**

Three issues make the dashboard unsafe to expose on any untrusted network today:

1. **The role check fails open** — a request with *no login cookie at all* is treated as an administrator.
2. **Identity is a plaintext, forgeable cookie** — the signed session token that exists is never actually checked, so anyone can impersonate the admin by setting one cookie value.
3. **About a dozen routes have no authentication at all** — all findings, cost data, Azure identifiers, and audit-triggering endpoints are open, and one route (`findings/[id]` PATCH) lets an anonymous caller modify records.

**Is it safe to expose publicly today? No.** If the dashboard is currently only reachable on localhost or a private network behind a separate gateway, the practical risk is lower — but the application itself provides effectively no access control. Fixing items C1–C3 is a small, well-contained change (a single shared auth helper plus applying it to the open routes) and should happen before any internet exposure. The Go/MCP side needs only least-privilege and dependency-hygiene follow-ups.

---

## 2. Attack surface map

**Trust boundaries**

| Boundary | Mechanism | Verdict |
|---|---|---|
| Browser → Next.js API | `btg_identity` + `btg_session` cookies | 🔴 broken (C1, C2) |
| Next.js API → Postgres | raw `pg`, parameterized queries | ✅ good |
| Next.js API → Go binary | `execFile` (no shell), creds via env | ✅ good |
| MCP client → Go `--http` server | Bearer token, `subtle.ConstantTimeCompare` | ✅ good |
| Go MCP → dashboard `/api/internal/*` | `MCP_INTERNAL_TOKEN`, `timingSafeEqual` | ✅ good |
| CLI → Azure / Hetzner / Power Platform | SPN client secret + Hetzner token from env | ⚠️ blast radius unreviewed (R6) |

**Route inventory (authorization posture)**

| Group | Routes | Guard | Verdict |
|---|---|---|---|
| Auth (public by design) | `auth/login`, `verify-otp`, `register`, `resend-otp`, `me`, `logout` | none | ⚠️ weak OTP/session (H1, H3) |
| Admin | `admin/users`, `admin/stats`, `admin/notify` | local `isAdmin()` — **fails closed** | ✅ check correct; ⚠️ still cookie-spoofable (C2) |
| Internal (service-to-service) | `internal/analysis-requests/*` (3), `internal/cost-requests/*` (2) | `isInternalServiceRequest()` | ✅ good |
| `isAdminRequest`-guarded | `audits/run`, `schedule` (POST/PATCH/DELETE), `subscriptions` (GET/POST), `cost-requests` (POST) | `lib/auth.getRequestRole` — **fails OPEN** | 🔴 C1 |
| **Unauthenticated** | `findings` (GET), `findings/[id]` (GET+PATCH), `dashboard`, `cost/spend`, `cost/history`, `cost/hetzner*`, `subscriptions/compare`, `analysis-requests` (GET+POST), `analysis-requests/[id]`, `cost-requests/[id]`, `settings` (GET), `settings/test` (POST), `audits` (GET), `schedule` (GET) | none | 🔴 C3 |

**MCP tools** (`cmd/mcp.go`): `run_audit`, `run_service_analysis` (stdio + http); plus http-only `list_pending_requests`, `get_audit_data`, `save_analysis`, `submit_findings`, `list_pending_cost_requests`, `fetch_cost_data`. All http exposure gated behind a required bearer token.

**Secret locations:** `.env` / `web/.env.local` (gitignored, not tracked); GitHub Actions secrets; Azure SPN secret and Hetzner token flow into the Go binary via env; stored service secrets encrypted via `crypto.ts` (AES-256-GCM).

---

## 3. Findings

### 🔴 C1 — Role check fails open: no cookie = admin

- **Severity:** Critical · **CONFIRMED by code reading**, PLAUSIBLE live
- **Location:** [web/lib/auth.ts:26-32](web/lib/auth.ts#L26-L32)

```ts
export async function getRequestRole(req: NextRequest): Promise<'admin' | 'viewer'> {
  const identity = (req.cookies.get('btg_identity')?.value ?? '').toLowerCase();
  const adminEmail = (process.env.ADMIN_EMAIL ?? '').toLowerCase();
  if (!identity || (adminEmail && identity === adminEmail)) return 'admin';   // ← !identity ⇒ admin
  ...
}
```

The `!identity` term means a request carrying **no `btg_identity` cookie at all** returns `'admin'`. Every route guarded by `isAdminRequest()` — `audits/run`, `schedule` (POST/PATCH/DELETE), `subscriptions` (GET/POST), `cost-requests` (POST) — therefore grants admin to a completely unauthenticated client.

- **Attack scenario:** An attacker sends `POST /api/audits/run` (or `POST /api/schedule`) with no cookies. `getRequestRole` returns `admin`, the guard passes, and they trigger scans / create scheduled jobs / enumerate and mutate subscriptions at will.
- **Fix:** Default to the least privilege and require a *verified* session (see C2 for the verification piece):

```ts
export async function getRequestRole(req: NextRequest): Promise<'admin' | 'viewer'> {
  const identity = await getVerifiedIdentity(req);   // returns '' if session invalid
  if (!identity) return 'viewer';                     // no identity ⇒ NOT admin
  const adminEmail = (process.env.ADMIN_EMAIL ?? '').toLowerCase();
  if (adminEmail && identity === adminEmail) return 'admin';
  const user = await getUserByEmail(identity);
  if (!user || user.status !== 'active') return 'viewer';
  return user.role === 'admin' ? 'admin' : 'viewer';
}
```

Also add an explicit `requireAuth` that rejects unauthenticated requests before any handler logic. **The `admin/*` routes already do this correctly** with their local `isAdmin()` (`if (!identity) return false`) — that is the pattern to standardize on.
- **Effort:** S · **How to confirm live:** `curl -X POST http://localhost:3000/api/audits/run -H 'Content-Type: application/json' -d '{"subscription_id":"..."}'` with **no cookies** → expect 403; a vulnerable build returns 202/500.

---

### 🔴 C2 — Identity is a forgeable plaintext cookie; the session HMAC is never verified

- **Severity:** Critical · **CONFIRMED by code reading**, PLAUSIBLE live
- **Location:** [web/lib/auth.ts:24](web/lib/auth.ts#L24), [web/app/api/auth/verify-otp/route.ts:40-41](web/app/api/auth/verify-otp/route.ts#L40-L41), and every route that reads `btg_identity`

Authorization decisions read the **`btg_identity`** cookie, which is set to the raw email:

```ts
res.cookies.set('btg_identity', pendingEmail, { httpOnly: true, sameSite: 'lax', ... });
```

A signed token, **`btg_session`** (`HMAC-SHA256(secret, email)`), is issued alongside it — but a repo-wide search shows it is **never read or verified anywhere**. All checks (`getRequestRole`, `admin/*` local `isAdmin`, `auth/me`) trust `btg_identity` alone.

- **Attack scenario:** An attacker crafts a request with `Cookie: btg_identity=<admin-email>`. `httpOnly` is irrelevant — it only stops browser JS from reading the cookie; it does nothing to stop an attacker who *sets* the header on their own request (curl, Burp, script). They are now admin on every route, including the "correctly" guarded `admin/users` (which can change roles, delete users, activate accounts). Even without knowing the admin email, `btg_identity=any-active-user@example.com` impersonates that user.
- **Fix:** Make the signed token the source of truth and stop trusting the plaintext identity cookie. Verify the HMAC and derive identity from it:

```ts
// helper used by getRequestRole and all guards
export function getVerifiedIdentity(req: NextRequest): string {
  const identity = (req.cookies.get('btg_identity')?.value ?? '').toLowerCase();
  const session  = req.cookies.get('btg_session')?.value ?? '';
  if (!identity || !session) return '';
  const secret = process.env.SESSION_SECRET;
  if (!secret) return '';                       // fail closed if unconfigured (see M1)
  const expected = makeSessionToken(secret, identity);
  const a = Buffer.from(session), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return '';
  return identity;
}
```

Better still, put identity *inside* a signed/encrypted token (or a server-side session record) so it cannot be desynced from the signature at all. Note the current HMAC binds only the email with no expiry or nonce baked into the signed payload — a leaked token is valid until the cookie's `maxAge`, with no server-side revocation.
- **Effort:** S–M · **How to confirm live:** `curl http://localhost:3000/api/admin/users -H 'Cookie: btg_identity=<admin-email>'` with **no valid `btg_session`** → expect 403; a vulnerable build returns the user list.

---

### 🔴 C3 — ~12 routes have no authentication; one allows anonymous data tampering

- **Severity:** Critical · **CONFIRMED by code reading**, PLAUSIBLE live
- **Locations:** [web/app/api/findings/[id]/route.ts](web/app/api/findings/[id]/route.ts) (GET + **PATCH**), [web/app/api/findings/route.ts](web/app/api/findings/route.ts), [web/app/api/dashboard/route.ts](web/app/api/dashboard/route.ts), `cost/spend`, `cost/history`, `cost/hetzner*`, `subscriptions/compare`, `analysis-requests` (GET+POST), `analysis-requests/[id]`, `cost-requests/[id]`, [web/app/api/settings/route.ts](web/app/api/settings/route.ts), [web/app/api/settings/test/route.ts](web/app/api/settings/test/route.ts), `audits` (GET), `schedule` (GET).

None of these call any guard. Impact tiers:

- **Anonymous write:** `PATCH /api/findings/[id]` lets anyone change a finding's `remediation_status` / `support_ticket_ref` — an attacker can mark real Critical findings as `resolved` or `suppressed`, hiding them from operators.
- **Sensitive disclosure:** `GET /api/settings` returns `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_SUBSCRIPTION_ID`, and PP equivalents (the secret itself is masked to a boolean, but tenant/client/subscription IDs are reconnaissance-grade). `findings`, `dashboard`, `cost/*`, `subscriptions/compare` expose the entire security & cost posture of the estate.
- **Unauthenticated action:** `POST /api/settings/test` runs the Azure binary (`analyze iam`) on demand; `POST /api/analysis-requests` queues work and kicks a drain.

Because the data model appears **global** (findings/audits are not scoped per user), this is unauthenticated data exposure rather than classic per-user IDOR — but the effect is the same: any caller sees and edits everything.

- **Attack scenario:** Attacker reachable on the dashboard's network runs `GET /api/dashboard` and `GET /api/settings` to map the estate, then `PATCH /api/findings/<critical-id>` with `{"remediation_status":"suppressed"}` to bury findings before an exfiltration attempt on the underlying cloud resources.
- **Fix:** Introduce one middleware/helper and apply it uniformly. In Next.js App Router, a project-level [`middleware.ts`](web/middleware.ts) matching `/api/:path*` (allowlisting only the `auth/*` and `internal/*` prefixes) is the least error-prone approach — it makes "no guard" fail closed by default instead of per-route opt-in. Mutating routes (`findings/[id]` PATCH, `analysis-requests` POST) should additionally require the appropriate role.
- **Effort:** M · **How to confirm live:** `curl http://localhost:3000/api/settings` and `curl -X PATCH http://localhost:3000/api/findings/<id> -H 'Content-Type: application/json' -d '{"remediation_status":"suppressed"}'` with no cookies → both should be 401/403.

---

### 🟠 H1 — OTP generated with `Math.random()`

- **Severity:** High · PLAUSIBLE (static)
- **Location:** [web/lib/otp-store.ts:15-17](web/lib/otp-store.ts#L15-L17)

```ts
export function generateOTP(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}
```

`Math.random()` is not a CSPRNG; its output is not suitable for security tokens. Combined with a 6-digit space and `MAX_ATTEMPTS = 3`, the primary protection is the attempt limit — but that limit lives in an **in-memory `Map`** (H3), so it does not hold across multiple instances or restarts.

- **Attack scenario:** In a multi-instance deployment, an attacker who has a victim's password spreads OTP guesses across instances (each keeps its own attempt counter), defeating the 3-attempt lockout and brute-forcing the 6-digit code.
- **Fix:** `import { randomInt } from 'crypto'; return String(randomInt(0, 1_000_000)).padStart(6, '0');` and move attempt-counting + the OTP store to shared storage (Postgres/Redis) so throttling is global.
- **Effort:** S (RNG) / M (shared store) · **How to confirm live:** unit test can assert distribution/entropy; live, verify lockout survives across instances.

---

### 🟠 H2 — Internal error messages returned to clients

- **Severity:** High (info disclosure) · PLAUSIBLE (static)
- **Locations:** pervasive — e.g. [web/app/api/findings/[id]/route.ts:11](web/app/api/findings/[id]/route.ts#L11), [web/app/api/findings/route.ts](web/app/api/findings/route.ts), `dashboard`, `schedule`, `audits/run`, others: `catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }); }`

Raw exception text — including Postgres error strings (table/column names, constraint details) and file paths — is returned to the caller, aiding SQL/schema reconnaissance and injection probing.

- **Fix:** Return a generic message and a correlation id; log the detail server-side. Centralize with a small `apiError(e)` helper. Combine with C3 so this is only reachable by authenticated users.
- **Effort:** S · **How to confirm live:** send a malformed body / bad id to any listed route and inspect whether the 500 body contains SQL text.

---

### 🟠 H3 — OTP/attempt state is in-memory only

- **Severity:** High in multi-instance, Low single-instance · PLAUSIBLE (static)
- **Location:** [web/lib/otp-store.ts:8-10](web/lib/otp-store.ts#L8-L10) (`global` `Map`)

A per-process `Map` means OTP validity and the attempt counter are not shared. On any horizontally-scaled or restart-prone deployment this breaks both correctness (a login OTP issued by instance A can't be verified by instance B) and the brute-force protection (H1). See H1 fix.
- **Effort:** M · **How to confirm live:** run two instances behind a balancer; issue OTP on one, verify on the other.

---

### 🟡 M1 — Weak default secrets and dev-OTP leakage

- **Severity:** Medium · PLAUSIBLE (static)
- **Locations:** [web/app/api/auth/verify-otp/route.ts:37](web/app/api/auth/verify-otp/route.ts#L37) and login: `process.env.SESSION_SECRET ?? 'btg-devops-default-secret'`; [web/app/api/auth/login/route.ts](web/app/api/auth/login/route.ts) `devOtp` in response.

If `SESSION_SECRET` is unset, a hardcoded fallback is used — an attacker who knows it (it's in the repo) can forge valid `btg_session` tokens for any email once C2 is fixed. Separately, when SMTP is unconfigured (`devMode`), the login response includes `devOtp` — the OTP in the HTTP body. If that state ever reaches a real deployment, MFA is fully bypassed.
- **Fix:** Fail closed if `SESSION_SECRET` is missing (throw at startup); never emit `devOtp` unless an explicit `NODE_ENV !== 'production'` **and** a separate `BTG_DEV_OTP=1` flag are both set.
- **Effort:** S · **How to confirm live:** unset `SESSION_SECRET` and confirm the app refuses to authenticate rather than using the fallback; confirm no `devOtp` in prod-config responses.

---

### 🟡 M2 — No rate limiting on auth and expensive routes

- **Severity:** Medium · PLAUSIBLE (static)
- **Locations:** `auth/login`, `auth/resend-otp`, `auth/register`, `audits/run`, `cost/hetzner/backfill`.

No throttling on password guessing, OTP resend (email-bomb / cost), self-registration (DB flooding — anyone can register, pending admin approval), or the expensive scan/backfill triggers. Ties into H1/H3.
- **Fix:** Per-IP + per-account rate limiting at the boundary (middleware or a shared store); a resend cooldown; CAPTCHA or invite-only registration if abuse is a concern.
- **Effort:** M · **How to confirm live:** bounded burst (≈50 reqs) at `auth/login` and `auth/resend-otp`; observe absence of 429s.

---

### 🟡 M3 — CI actions pinned to tags, not commit SHAs

- **Severity:** Medium (supply chain) · PLAUSIBLE (static)
- **Locations:** [.github/workflows/release.yml](.github/workflows/release.yml), [.github/workflows/scheduled-audit.yml](.github/workflows/scheduled-audit.yml) — `actions/checkout@v4`, `setup-go@v5`, `softprops/action-gh-release@v2`, etc.

Tag references are mutable; a compromised third-party action tag (notably the third-party `softprops/action-gh-release`) could run arbitrary code in a workflow that holds `contents: write` and, in `scheduled-audit.yml`, the Azure/Hetzner/Anthropic secrets.
- **Good:** `release.yml` scopes `permissions: contents: write` (not broad); no `pull_request_target` anywhere; secrets are passed via the `secrets.` context (not echoed).
- **Fix:** Pin actions to full commit SHAs (especially the third-party one); add an explicit least-privilege `permissions:` block to `scheduled-audit.yml`; enable Dependabot for `github-actions`.
- **Effort:** S.

---

### 🟢 L1 — Cookies lack `Secure`; `SameSite=Lax` only

- **Severity:** Low · PLAUSIBLE (static)
- **Location:** all `res.cookies.set(...)` in auth routes.

`httpOnly` and `sameSite: 'lax'` are set but `secure: true` is not, so cookies can ride over plain HTTP if the app is ever reached without TLS. `SameSite=Lax` leaves top-level-navigation CSRF exposure for any state-changing `GET` (there are none that mutate today, but `findings/[id]` PATCH and others rely on non-GET which Lax largely covers). Add `secure: true` (behind a prod flag) and consider explicit CSRF tokens once sessions are real.
- **Effort:** S.

---

### 🟢 G1 — `govulncheck` findings in the Go module (not in the original static review)

- **Severity:** Low-Medium (mostly stdlib DoS/parsing bugs, none reachable with attacker-controlled input in this codebase's call paths) · **FIXED 2026-09-15**
- **Found while executing** `docs/superpowers/plans/2026-09-15-dependency-supply-chain.md` Task 5 — this review's own §6 method note says "no code changes," so `govulncheck` was never run against `cmd/` until the CI gate work called for it.

`govulncheck ./...` reported 9 reachable vulnerabilities: 6 in the Go 1.26.4 standard library (`net/url`, `crypto/tls` ×2, `net/http` ×2, `encoding/xml`, `encoding/asn1` — fixed in go1.26.5/.6) and 2 in `golang.org/x/net` (idna Punycode bypass, HTTP/2 infinite loop) plus 1 in `golang.org/x/text` (infinite loop on invalid input), all reachable from `cmd/powerplatform.go`'s Azure AD token/HTTP calls and `cmd/mcp.go`'s `--http` listener.

- **Fix:** `go get -u golang.org/x/net golang.org/x/text` (→ v0.59.0 / v0.42.0) plus `go mod tidy`; added `toolchain go1.26.6` to `go.mod` to pin a patched Go toolchain rather than relying on whatever the CI runner or a contributor's machine happens to have installed. `govulncheck ./...` now reports 0 reachable vulnerabilities; `go build ./...` and `go test ./...` both clean.
- **Effort:** S.

---

## 4. What's already done well

Not padding — these are genuinely correct and worth keeping:

- **SQL injection: not present.** Every query in [web/lib/db.ts](web/lib/db.ts) and the routes uses `pg` parameterization (`$1, $2 …`). The few template-literal SQL fragments (`findings` scope lists, `getDashboardStats` filter clause) interpolate only server-controlled constants or fixed clause strings, never request input, and the service-label lists are `''`-escaped.
- **Command injection: not present.** [web/lib/btg-runner.ts](web/lib/btg-runner.ts) and `settings/test` use `execFile` with a fixed argument array (`['analyze', command, '--output', 'json', ...]`) — no shell — and `command` is constrained to the `Command` union / `ALL_COMMANDS` allowlist. Credentials are passed via `env`, not argv.
- **MCP server auth is solid.** [cmd/mcp.go:156-170](cmd/mcp.go#L156-L170) requires a bearer token in `--http` mode (refuses to start without one) and compares with `subtle.ConstantTimeCompare`.
- **Internal service auth is solid.** [web/lib/auth.ts:44-52](web/lib/auth.ts#L44-L52) (`isInternalServiceRequest`) uses `timingSafeEqual`, treats an unset token as "disabled, never authorize", and length-checks before comparing.
- **Crypto for stored secrets is correct.** [web/lib/crypto.ts](web/lib/crypto.ts) uses AES-256-GCM (authenticated), a random 12-byte IV per encryption, validates a 32-byte key, and now throws on undecryptable ciphertext instead of silently returning it.
- **`admin/*` routes fail closed** with a correct local `isAdmin()` — the model the rest of the app should adopt.
- **Secret hygiene in git:** `.env`, `web/.env.local`, `web/*.db`, `/out/`, `/state/` are gitignored; only `.env.local.example` is tracked; a history scan for `CLIENT_SECRET` in env files found nothing.
- **Passwords** are hashed with `scrypt` + per-user 16-byte salt and compared with `timingSafeEqual`.

---

## 5. Roadmap — security improvements to build

Ordered cheap-high-leverage first.

### Now (this sprint)
1. **Fix C1 + C2 + C3 as one change: a single auth layer.** Add `getVerifiedIdentity()` (verify `btg_session` HMAC, fail closed), rewrite `getRequestRole` to default to `viewer`, and add a project `middleware.ts` that requires auth on `/api/*` except an explicit allowlist (`auth/*`, `internal/*`). *Adopt now — this is the whole ballgame.*
2. **Centralized error handler (H2)** — one `apiError()` returning generic text + a logged correlation id. *Adopt now — trivial, stops recon.*
3. **CSPRNG OTP + fail-closed `SESSION_SECRET` + kill `devOtp` in prod (H1, M1).** *Adopt now — small, removes MFA-bypass paths.*
4. **Add `secure: true` to cookies behind a prod flag (L1).** *Adopt now.*

### Next (this quarter)
5. **Shared OTP/attempt + rate-limit store (H3, M2)** — move OTP and throttling to Postgres or Redis; add per-IP/per-account limits and a resend cooldown at the middleware. *Adopt — required before multi-instance or public exposure.*
6. **Request schema validation at the boundary** — introduce `zod` as a standing pattern; every route parses `req.json()` into a schema (rejects extra fields → closes mass-assignment, type confusion). *Adopt — cheap once the middleware exists.*
7. **Audit logging of privileged & cost-affecting actions** — who triggered scans, changed schedules, mutated findings, changed user roles. *Adopt — needed for any incident response.*
8. **Pin CI actions to SHAs + least-privilege `permissions:` on `scheduled-audit.yml` + Dependabot (M3).** Add `npm audit` and `govulncheck` as CI gates. *Adopt — low effort.*

### Later
9. **Least-privilege review of the Azure SPN and Hetzner token (R6).** Confirm the SPN holds only `Reader` (+ `Cost Management Reader`) and no write/delete; scope the Hetzner token to read-only if the API supports it. *Adopt — this bounds the blast radius if the runner or CI secrets leak; needs cloud-side access to verify, hence Later.* **Tracking:** [docs/cloud-credential-review-2026-09.md](cloud-credential-review-2026-09.md) — template drafted 2026-09-15, still PENDING actual Azure/Hetzner/Anthropic console access to fill in.
10. **Real sessions + revocation + MFA posture** — server-side session records (or signed tokens with `exp`/`jti`), a logout that invalidates server-side, and a decision on TOTP vs. email OTP. *Adopt later — larger change; the Now items make the current scheme safe enough in the interim.*
11. **Security regression tests** — one authz test per route (anonymous → 401/403, viewer → 403 on admin routes) and a secret-leak test asserting no route returns raw error text or secrets. *Adopt — locks in the fixes.*
12. **Threat-model refresh cadence** — revisit on each new external boundary (new MCP tool, new public route); assign an owner. *Adopt as process.*

**Skip for this project's size:** a full WAF/API-gateway product, and per-user row-level data isolation *unless* the product moves to multi-tenant (today the data model is intentionally global to one estate).

---

## 6. Appendix

### Method & tools
- Pure static review: `git grep`/`grep`, file reads, `git log`/`git ls-files` for secret history. No servers started, no HTTP requests, no DB or cloud calls, no code changes.
- Files examined: all `web/app/api/**/route.ts`, `web/lib/{auth,crypto,otp-store,btg-runner,audit-executor,db,schedule-time}.ts`, `cmd/mcp.go`, both workflow files, `.gitignore`, `go.mod`, `web/package.json`.

### Live test plan (hand this to the dynamic pass)
1. **C1** — `POST /api/audits/run` (and `/api/schedule`) with **no cookies** → must be 403.
2. **C2** — `GET /api/admin/users` with `Cookie: btg_identity=<admin-email>` and no valid `btg_session` → must be 403.
3. **C3** — `GET /api/settings`, `GET /api/dashboard`, and `PATCH /api/findings/<id>` with no cookies → must be 401/403; confirm PATCH does not mutate.
4. **H1/H3** — brute-force lockout across a restart / two instances; assert OTP entropy.
5. **H2** — malformed body / bad id to `findings/[id]`, `dashboard`, `schedule` → assert no SQL/internal text in the 500 body.
6. **M1** — unset `SESSION_SECRET`; assert app refuses auth (no fallback); assert no `devOtp` in responses under prod config.
7. **M2** — bounded 50-request burst at `auth/login` and `auth/resend-otp`; assert 429s appear.
8. Create two users (A, B) to check whether any per-user scoping exists once auth is enforced.

### Could not determine from code alone
- **R6 — actual Azure RBAC / Hetzner token scope** granted to the runner (needs cloud portal access). Listed as a Later roadmap item.
- Whether the dashboard is currently exposed publicly or only on localhost/private network — this materially changes the *real-world* severity of C1–C3 (the code-level severity stands regardless).
- Runtime confirmation of every finding — all are code-reading verdicts; see the live test plan.
