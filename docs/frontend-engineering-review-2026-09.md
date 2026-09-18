# Frontend Engineering Review — btg-devops

**Date:** 2026-09-18
**Reviewer role:** Senior software engineer, whole-frontend review (Next.js App Router dashboard, `web/app/**`, `web/components/`, `web/hooks/`). Companion to `docs/backend-engineering-review-2026-09.md`; security is covered separately in the `docs/security-*` reports and the Playwright E2E suite.
**Scope:** 11 pages, 4 shared components, 1 hook, ~5,350 lines of page code, no CSS framework (inline styles + CSS variables + a `.glass` utility class).

---

## Overall verdict

**Solid, disciplined code with real gaps in framework usage and test coverage — no correctness or security red flags.** Zero `any` types, zero stray `console.*` in page code, no secret leakage via `NEXT_PUBLIC_*`, no `dangerouslySetInnerHTML` outside one hardcoded theme-flash script, semantic `<button>` elements used almost everywhere interaction happens. The team clearly cares about comments and correctness here, matching what the backend review found.

The gaps are all about **not using what Next.js and React already give you for free**: every page is a client component fetching its own data by hand, there's no CSS system (100%+ of styling is inline `style={{...}}` objects, hundreds per large page), the App Router's `error.tsx`/`loading.tsx` conventions were never adopted, and there is **zero frontend unit/component test coverage** (only E2E smoke tests exist). None of this is broken — it's technical debt that will slow the team down as the dashboard grows.

---

## Findings

### 🟠 F-1 — Every page is a client component; no server-side data fetching
- **Where:** 11 of 12 route pages (`app/*/page.tsx`) start with `'use client'`; only the root `app/page.tsx` (a bare redirect) is a server component.
- **Problem:** Next.js App Router's core value — fetching data on the server and streaming/hydrating HTML — is entirely unused. Every page instead: renders empty, mounts, fires `fetch()` in `useEffect`, shows a hand-rolled loading state, then renders. That's a guaranteed extra network round-trip and a visible flash-then-populate on every navigation, and it ships more JS to the client than necessary (the dashboard route is already 230 kB first-load JS).
- **Not urgent, but real:** for a small internal dashboard this is a performance/UX cost, not a bug — but it's the reason `loading.tsx` (added this pass) only covers navigation, not the in-page fetch that follows.
- **Recommendation:** For pages whose initial data doesn't depend on client-only state (auth cookie is already handled by middleware), fetch the first paint's data server-side in the page component and pass it down, keeping `'use client'` only on the interactive leaf components that need it. Not a rewrite — an incremental page-by-page migration.
- **Effort:** M per page, done incrementally.

### 🟠 F-2 — No CSS system; 100%+ styling duplication via inline objects
- **Where:** `app/cost/page.tsx` (153), `app/dashboard/page.tsx` (156), `app/admin/page.tsx` (126), `app/settings/page.tsx` (84) — inline `style={{...}}` object literals. No Tailwind, CSS modules, or styled-components; only a global `.glass` utility class and CSS custom properties (`--accent`, `--crit`, `--border`, etc.) defined in `globals.css`.
- **Problem:** The same button/card/badge shape is retyped as an inline object dozens of times across pages (some already extracted as small components like `Chip`, `SevChip`, `StatusBadge` — good instinct, just not applied consistently). Any visual tweak (spacing, radius, hover state) means find-and-replace across files instead of one shared style. Inline styles also can't express `:hover`/`:focus`/media queries, which is likely why interactive affordances are sparse.
- **Recommendation:** Not "adopt Tailwind" as a mandate — but promote the repeated inline patterns (buttons, badges, card chrome) into a small shared component library (`components/ui/`) reusing the existing `--*` CSS variables, the same way `Chip`/`SevChip` already do it inside `dashboard/page.tsx`. That single move would cut the inline-style count dramatically without a styling-system migration.
- **Effort:** M, incremental, no visual regression risk if done as pure extraction.

### 🟡 F-3 — No data-fetching library; every page hand-rolls fetch/loading/error/refetch
- **Where:** `app/cost/page.tsx` (43 `useState`/`useEffect` occurrences), `app/dashboard/page.tsx` (21), `app/admin/page.tsx` (15) — no SWR, React Query, or equivalent in `package.json`.
- **Problem:** Each page reimplements the same shape: `useState` for data/loading/error, `useEffect` to fetch on mount, manual refetch-after-mutation calls (e.g. `admin/page.tsx`'s `loadAll()` re-called after every PATCH/DELETE). No request deduping, no caching between pages that hit the same endpoint (e.g. `/api/audits` is fetched independently by more than one page), no built-in revalidation-on-focus.
- **Recommendation:** Adopt a small data-fetching library (SWR is the lower-footprint fit for this app's size) incrementally, page by page, starting with the highest-traffic ones (`dashboard`, `cost`). Not urgent — nothing is wrong today — but it's the highest-leverage single dependency to add as more pages/features are added.
- **Effort:** M, incremental.

### 🟡 F-4 — Zero frontend unit/component tests
- **Where:** no `*.test.tsx` anywhere under `app/`, `components/`, or `hooks/` (confirmed: only `web/lib/*.test.ts` backend-logic tests and the Playwright E2E specs exist).
- **Problem:** The 20 E2E tests are valuable but coarse (page loads, no 5xx, auth redirects) — they don't exercise component logic (e.g. `computeNextRun`-style date math embedded in a page, form validation, the remediation-status control's state machine) at the unit level. A regression in, say, `RemediationControl`'s optimistic-update logic would only surface as a flaky E2E failure, if at all.
- **Recommendation:** Add React Testing Library + Vitest (already the test runner) for the components with real logic — `RemediationControl`, `SupportTicketControl`, the OTP input in `verify-otp/page.tsx`, `computeNextRun`-adjacent UI. Not every presentational component needs a test.
- **Effort:** S to start (infra), ongoing.

### 🟢 F-5 — Missing Next.js `error.tsx`/`loading.tsx` conventions — ✅ fixed this pass
- **Where:** no `app/error.tsx`, `app/global-error.tsx`, or `app/loading.tsx` existed.
- **Problem:** An uncaught render/data error in any page fell through to Next's generic dev overlay or a blank/minimal error in production, with no way back to the app short of a manual URL edit. No route-transition loading state existed either.
- **Fix applied:** Added all three, matching the existing dark-glass visual language and CSS variables. `global-error.tsx` is intentionally self-contained (literal colors, no CSS-variable dependency) per Next's own constraint that it replaces the root layout when active. `loading.tsx`'s doc comment is explicit that it only covers the navigation gap, not each page's own in-flight fetch (see F-1/F-3).

### 🟢 F-6 — Slide-over panels had no keyboard dismissal — ✅ fixed this pass
- **Where:** `app/dashboard/page.tsx`'s two `createPortal`-based slide-overs (recent-audits panel, finding-detail panel) closed only on backdrop click, no `Escape` key handling.
- **Fix applied:** Added a small reusable `hooks/useEscapeToClose.ts` (mirrors the existing `useTheme` hook's style) and wired it into both panels. The backdrop `<div onClick>` pattern itself is standard/acceptable for a modal scrim, not a real interactive-control-as-div issue.

---

## What's already done well

- **Type safety:** zero `any` in the entire frontend; props are explicitly typed throughout.
- **No secret leakage:** zero `NEXT_PUBLIC_*` usage — nothing meant to stay server-side is exposed to the client bundle.
- **No stray debug output:** zero `console.*` calls left in page code.
- **Accessible interaction primitives:** real `<button>` elements for actions (not `<div onClick>` masquerading as controls) almost everywhere; the two exceptions found are modal backdrops, the conventionally-acceptable exception.
- **Deliberate, well-reasoned theme handling:** `app/layout.tsx`'s `suppressHydrationWarning` is scoped to exactly the element it needs to be, with a comment explaining why the server/client markup difference is intentional rather than a bug — the same quality of reasoning the backend review praised.
- **Recharts imported via named/tree-shakeable imports**, not a blanket namespace import.
- **Existing internal decomposition:** the two largest pages (`cost`, `dashboard`, ~1,250 lines each) already break down into 16–17 named sub-components internally (`Card`, `Chip`, `SevChip`, `RemediationControl`, etc.) — this is file-organization debt (everything lives in one file per route), not a monolithic, unstructured blob.

---

## Suggested sequencing

1. **Now (done this pass):** F-5 (`error.tsx`/`global-error.tsx`/`loading.tsx`), F-6 (Escape-to-close on the two slide-overs). Zero risk, verified against tsc/unit/build/E2E.
2. **Next:** F-4 (component test infra + tests for the handful of components with real logic) — cheapest way to catch a regression before it reaches E2E or production. Extract the repeated inline-style patterns into `components/ui/` (F-2) opportunistically whenever touching a page that has them.
3. **Later:** F-3 (SWR adoption, page by page, highest-traffic pages first), F-1 (server-side data fetching where it doesn't fight the auth/client-state model) — both real wins, neither urgent, both best done incrementally rather than as a big-bang migration.

None of this blocks anything currently working. It's the frontend's equivalent of the backend review's `db.ts`/scheduler findings: healthy today, and worth addressing before the dashboard gets meaningfully bigger.
