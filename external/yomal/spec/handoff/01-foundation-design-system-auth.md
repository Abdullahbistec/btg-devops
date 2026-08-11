# Spec 1/5 — Foundation, Design System & Auth Shell

> Source: working prototype `btg-devops-dashboard` (Next.js, mock data only).
> Goal: rebuild this foundation in the real project, wired to the **existing backend API** (adjust endpoint paths/payloads to match it — shapes below are the prototype's assumption, not a contract you must force the backend into).
> Do this spec first — every other spec (Dashboard, Audits, Subscriptions, Users) depends on the layout shell, theme tokens, and auth context defined here.

## 1. Stack

- Next.js (App Router) + TypeScript + React
- Tailwind CSS for styling
- `lucide-react` for icons
- `recharts` for charts (needed starting from Spec 2, install now)

## 2. Folder structure to create

```
src/
  app/
    layout.tsx              # root shell: providers + Sidebar + content area
    login/page.tsx
    globals.css
  components/
    Sidebar.tsx
    Header.tsx
    Badge.tsx
  lib/
    auth.tsx                # AuthProvider, useAuth, AuthGate
    theme.tsx                # ThemeProvider, useTheme, ThemeToggle
    utils.ts                 # formatNumber, cn, shortId, badge config maps
    api.ts                   # NEW — real fetch client (see §6), replaces mock.ts
```

Do **not** port `src/data/mock.ts` as a runtime dependency — it was a stand-in for the real API. Its exported **types** (`User`, `Role`, `Audit`, `Finding`, `Subscription`, `ChatMessage`) are a good starting point for `src/types/` or wherever the project keeps shared types — copy the shapes, drop the seed arrays.

## 3. Design tokens (CSS variables) — copy verbatim into `globals.css`

The whole UI is theme-able via CSS custom properties, toggled by adding/removing a `.light` class on `<html>`. Keep this mechanism — every component below reads these variables, not hardcoded colors.

```css
:root {
  --sidebar-bg: #07090f;
  --bg: #0c1017;
  --card: #141a25;
  --card-hover: #1a2235;
  --hover: rgba(255, 255, 255, 0.04);
  --input-bg: rgba(255, 255, 255, 0.03);
  --border: rgba(255, 255, 255, 0.06);
  --border-strong: rgba(255, 255, 255, 0.1);
  --radius: 10px;
  --t1: #e2e8f0;
  --t2: #94a3b8;
  --t3: #64748b;
  --t4: #475569;
  --acc: #60a5fa;
  --acc-soft: rgba(96, 165, 250, 0.08);
  --panel: #111827;
  --chart-grid: rgba(255, 255, 255, 0.05);
}

html.light {
  --sidebar-bg: #ffffff;
  --bg: #f1f5f9;
  --card: #ffffff;
  --card-hover: #f8fafc;
  --hover: rgba(15, 23, 42, 0.04);
  --input-bg: rgba(15, 23, 42, 0.03);
  --border: rgba(15, 23, 42, 0.08);
  --border-strong: rgba(15, 23, 42, 0.14);
  --t1: #1e293b;
  --t2: #64748b;
  --t3: #94a3b8;
  --t4: #b2bdcc;
  --acc: #2563eb;
  --acc-soft: rgba(37, 99, 235, 0.08);
  --panel: #ffffff;
  --chart-grid: rgba(15, 23, 42, 0.06);
}
```

Semantic text helper classes: `.t1 .t2 .t3 .t4 .acc` map to the variables above (darkest/most-prominent → faintest).

Reusable component classes to define once in `globals.css` and reuse everywhere (full CSS is in the prototype's `globals.css` — port as-is):

- `.glass` — the card surface (blurred, semi-transparent panel with border) used for every card/section container
- `.field` — input/select/textarea styling
- `.btn-primary`, `.btn-ghost`, `.btn-danger` — the three button variants used throughout
- `.bdg` + `.bdg-info/.bdg-success/.bdg-warning/.bdg-error/.bdg-primary/.bdg-purple/.bdg-muted` — status pill badges
- `.animate-fade-in`, `.animate-scale-in`, `.stagger` — entrance animations for cards/lists
- `.row-hover` — table row hover state

Tailwind config extension (`tailwind.config.ts`):
```ts
theme: {
  extend: {
    colors: {
      surface: { 1: 'var(--sidebar-bg)', 2: 'var(--bg)', 3: 'var(--card)', 4: 'var(--card-hover)' },
    },
  },
}
```

## 4. Theme system (`lib/theme.tsx`)

- `ThemeProvider` — holds `theme: 'dark' | 'light'`, persists choice, toggles the `.light` class on `document.documentElement`.
- **Prototype persisted to `localStorage`.** In the real app, persist to the user's profile/preferences via the backend (or keep localStorage as a fast local cache with the backend as source of truth) — your call based on whether user prefs already exist as a concept in the API.
- `ThemeToggle` — small icon button (`Sun`/`Moon` from lucide-react) shown in the header and on the login page.

## 5. Auth shell (`lib/auth.tsx`)

Replace the prototype's mock (`localStorage` + hardcoded account list + plaintext password match) with real calls to your backend, but **keep the same context shape** so downstream components (Sidebar, page guards) don't need to change:

```ts
type Role = 'admin' | 'analyst' | 'viewer'
type SessionUser = { email: string; name: string; role: Role }

type AuthCtx = {
  user: SessionUser | null
  ready: boolean          // true once the initial session check has resolved
  login: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>
  logout: () => void
}
```

Requirements:
- `login()` calls the real auth endpoint, stores whatever token/session the backend issues (prefer an httpOnly cookie set by the backend over storing a raw token in localStorage — flag this to whoever owns the backend if it's not already doing that).
- On mount, `AuthProvider` checks for an existing session (e.g. call a `/me` endpoint, or read a cookie-backed session) and populates `user`/`ready` before rendering children — mirrors the prototype's `ready` flag so there's no flash of the login page for an already-authenticated user.
- `AuthGate` component wraps the whole app: redirects unauthenticated users to `/login`, and redirects an authenticated user away from `/login`. Shows a centered spinner while `ready` is false.
- Role gate pattern used on admin-only pages (Subscriptions, Users — see Specs 4 & 5): `if (user?.role !== 'admin') return <403 panel>`.

## 6. API client (`lib/api.ts` — new, not in the prototype)

The prototype has no network calls; the real app needs one place that talks to your existing backend. Set up:
- A base fetch wrapper that attaches auth (cookie or `Authorization` header), handles JSON parsing, and surfaces errors in a consistent shape (`{ ok, data, error }` or throw + catch at the call site — match whatever pattern the rest of your real codebase already uses).
- One function per resource this dashboard needs, to be filled in as each subsequent spec is implemented: `login`, `getMe`, `logout`, `listAudits`, `getAudit`, `listFindings`, `analyzeAudit`, `sendChatMessage`, `listSubscriptions`, `createSubscription`, `updateSubscription`, `deleteSubscription`, `listUsers`, `createUser`, `updateUserRole`, `deleteUser`.
- **Adjust every endpoint path/payload to whatever your existing backend actually exposes.** The data shapes referenced in later specs (`Audit`, `Finding`, `Subscription`, `User`, etc.) describe what the *UI* expects — map your real API responses into these shapes in `api.ts` (or adjust the shapes to match the backend 1:1, whichever is less friction).

## 7. Root layout (`app/layout.tsx`)

Provider nesting order (outer → inner): `ThemeProvider` → `AuthProvider` → `AuthGate` → app shell.

App shell is a CSS grid: fixed 240px sidebar + flexible content column, both `h-screen`, content column scrolls internally (`overflow-y-auto` on `<main>` inside each page, not on the shell itself):

```
grid-cols-[240px_1fr] h-screen
├─ <Sidebar />
└─ <div> (flex column, overflow-hidden, subtle mesh-gradient background)
     └─ {children}   ← each page renders its own <Header /> + <main>
```

Sidebar collapses into a top bar + slide-out drawer below the `md` breakpoint (see §8).

## 8. Sidebar (`components/Sidebar.tsx`)

- Brand mark: small gradient icon tile + "BTG DEVOPS" wordmark + "AZURE AUDIT CONSOLE" caption (swap for the real product name/tagline).
- Nav sections, exactly as grouped in the prototype:
  - **Monitor**: Dashboard (`/`), Audits (`/audits`)
  - **Administration** (entire section hidden for non-admins): Subscriptions (`/subscriptions`), Users (`/users`)
- Active-route styling: soft accent background + left accent border on the current nav item (match by exact path for `/`, by prefix for everything else).
- Footer: user avatar (initials), name, role badge, logout button — pinned to the bottom.
- Responsive: full sidebar on desktop (`md:flex`), collapses to a compact top bar with a hamburger menu opening a slide-out drawer on mobile.
- Hidden entirely on `/login`.

## 9. Header (`components/Header.tsx`)

Reusable per-page header, used as either `<Header title="Dashboard" />` or `<Header breadcrumbs={[{label:'Audits', href:'/audits'}, {label: shortId}]} />`.

Contains, left to right: title/breadcrumbs — flexible spacer — search button (`⌘K` shortcut opens a command-palette-style modal for quick-jumping to an audit; can stub this as a simple list search or defer it, it's not load-bearing) — theme toggle — notifications bell with unread badge (defer real notification data to whatever the backend exposes, or omit until there's a backend endpoint for it) — current user name + role badge.

## 10. Login page (`app/login/page.tsx`)

Centered card on a full-bleed gradient-mesh background, matching the branding used in the sidebar. Fields: email, password (both `Enter`-to-submit). Loading state on the submit button while the auth call is in flight. Inline error banner on failure. **Do not** ship a "demo accounts" hint box like the prototype has — that was prototype-only.

## 11. Shared helpers (`lib/utils.ts`)

Port these small pure helpers as-is (or your project's equivalents):
- `formatNumber(n)` → locale-formatted thousands separator
- `shortId(id)` → first 8 chars of a UUID, used everywhere IDs are displayed
- `cn(...)` → simple classnames joiner
- Config maps used by `<Badge status config />`: `statusConfig` (audit status → label/color), `triggerConfig` (scheduled/manual), `roleConfig` (admin/analyst/viewer), `severityConfig` (Critical/Warning/Info) — each mapping a raw enum value to `{ label, color }`, where `color` is one of `info | success | warning | error | primary | purple | muted` and keys into the `.bdg-*` classes from §3.

## 12. Definition of done for this spec

- App boots to `/login` when logged out, and to `/` when logged in, with no flash of the wrong screen.
- Sidebar + header render on every authenticated page, admin-only nav items hidden for non-admins.
- Theme toggle switches dark/light instantly and persists across reload.
- Logout clears the session and redirects to `/login`.
- No page content yet beyond empty placeholders — Dashboard, Audits, Subscriptions, Users pages are built in Specs 2–5.

---
**Next:** Spec 2 — Dashboard page. Ask for it once this one is implemented and reviewed.
