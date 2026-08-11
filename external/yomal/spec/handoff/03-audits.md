# Spec 3/5 — Audits (List + Detail, Findings, AI Analysis, Chat)

> Depends on Spec 1 (foundation) and ideally Spec 2 (Dashboard) for shared patterns (KPI-style tiles, badges, table row style).
> Routes: `/audits` (list) and `/audits/[id]` (detail). All roles can view; the AI analysis + chat features are gated to `admin`/`analyst` only (viewers see a locked message).

This is the largest and most important page in the app — it has two screens (list, detail) and the detail screen has four sub-sections. Build the list first, then the detail screen section by section in the order below.

## 1. Shapes

```ts
type Role = 'admin' | 'analyst' | 'viewer'

type Audit = {
  id: string
  created_at: string
  subscription_id: string
  subscription_name: string
  trigger_type: 'scheduled' | 'manual'
  status: 'running' | 'completed' | 'failed'
  error_message: string
  resource_counts: Record<string, number>
  has_analysis: boolean
}

type Finding = {
  id: string
  audit_id: string
  severity: 'Critical' | 'Warning' | 'Info'
  category: string          // e.g. "Security", "Cost Waste", "Misconfiguration", "Governance"
  resource_type: string     // slug matching resource_counts keys, e.g. "storage", "nsg"
  resource_name: string
  issue: string
  recommendation: string
  created_at: string
}

type ChatMessage = {
  id: string
  audit_id: string
  user_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

type Resource = { slug: string; name: string; description: string }
// 12 known resource types audited: storage, iam, nsg, acr, cosmosdb, keyvault,
// functions, appservice, appserviceplan, cognitiveservices, resourcegroup, publicip
// (adjust this list to whatever your backend actually audits)
```

---

## 2. `/audits` — Audit History (list) page

### Filter bar
Three dropdowns + a live result count, all client-side filters over the fetched page of audits (or server-side query params if your backend supports filtered/paginated audit queries — prefer that if available so you're not pulling the whole history to the client):
- **Status**: All statuses / Completed / Failed / Running
- **Trigger**: All triggers / Scheduled / Manual
- **Date**: All dates / current month / previous month (or a proper date-range picker if the backend can filter by date range — the prototype only had a crude month-substring match, don't copy that literally)

Changing any filter resets pagination to page 1. Show `"{n} audits"` on the right of the filter row.

### Empty state
If the filtered result set is empty: centered message, e.g. "No audits match these filters." — mention your actual audit schedule/cadence if useful.

### Table
Columns: **Audit ID** (short, monospace) · **Subscription** · **Date & Time** · **Trigger** (badge) · **Status** (badge) · **Resource Counts** (a compact summary — top 3 non-zero resource types by count, e.g. "iam: 197, resourcegroup: 31, appservice: 26, …" — or the failed audit's truncated error message in red if `status === 'failed'`) · **Analysis** (✓ "Yes" / "No" indicator for `has_analysis`) · trailing "View Details" link.

Whole row is clickable → `/audits/{id}`.

### Pagination
Standard page-size (e.g. 10 or 20 — match whatever the backend returns per page). Prev/next chevron buttons, "Page X of Y" label. If the backend supports server-side pagination, wire it directly instead of slicing a full client-side array.

---

## 3. `/audits/[id]` — Audit Detail page

Route param `id`. If not found, show a simple "Audit not found" state under the page header.

### Layout shell
- Header with breadcrumbs: `Audits > {shortId(id)}`.
- **Section A** (full width, top): Audit summary card.
- Below that, if `status !== 'failed'`: a two-column layout — left column (wider, ~60%) stacks **Section B** (AI Analysis) above **Section D** (Raw Resource Data); right column (narrower, ~40%, sticky on scroll) is **Section C** (Chat).
- If `status === 'failed'`: only Section A renders, showing the error — no findings/chat/raw-data sections make sense for a failed run.
- On narrow viewports, columns stack (chat panel below, not sticky).

### Section A — Audit Summary
`.glass` card. Left side: short ID (monospace) + status badge + trigger badge, then a line of metadata (date/time, subscription name, truncated subscription ID). Right side (or below on mobile): total resource count, large and bold, with "total resources" caption underneath — omitted if the audit failed.

If failed: replace the resource-count area with a red-tinted monospace block showing `error_message` in full.

If not failed: a responsive grid of small tiles, one per known resource type, each showing the slug (uppercase, muted) and the count for that type from `resource_counts` (default 0 if the type is absent from this particular audit's counts).

### Section B — AI Analysis panel

Header row: sparkle icon + "AI Analysis" (or your product's name for this feature) title, plus a cached/fresh indicator badge once analysis exists (e.g. "Analysis cached · {date}").

States, in order of precedence:
1. **Viewer role, no analysis yet** → locked message: "Analysis has not been run yet. Ask an analyst or admin to run it." (lock icon, centered, no button).
2. **Admin/analyst role, no analysis yet, not currently running** → centered prompt + a primary button "Analyze" (or "Run Analysis") that kicks off the real backend analysis call for this audit.
3. **Analysis in progress** → centered spinner + "Sending audit data for analysis…" (or whatever accurately describes your backend's async flow — if analysis is truly async/long-running, poll or subscribe for completion rather than a fixed timeout like the prototype used).
4. **Analysis ready** → render the findings (see below).

#### Findings — severity summary + filters (this is the part we just built in the prototype — replicate it exactly)

Three clickable tiles showing counts by severity (Critical / Warning / Info), each tinted (red/amber/blue respectively). **Clicking a tile toggles it as an active filter** — clicking the same tile again clears it back to "all". Active tile gets a colored border to show it's selected.

Below the tiles, a filter bar with:
- A **resource type** `<select>` populated dynamically from the distinct `resource_type` values present in this audit's findings (not the full 12-type list — only types that actually have findings), default option "All resource types".
- A **priority** `<select>` mirroring the same three severities plus "All priorities" — an alternate control for the same filter the tiles drive (keep both in sync to the same state).
- A "Clear filters" link, shown only when at least one filter is active.
- A live count on the right: `"{filtered} of {total} findings"`.

Both filters combine with AND logic. Filtered list below renders each finding as a card:
- Row of: severity icon + severity badge + category badge (muted) + right-aligned `resource_type · resource_name` in small monospace/muted text.
- The issue description as the main body text.
- A highlighted "Fix:" box below with the recommendation text.

If the filtered list is empty (filters too narrow), show "No findings match the selected filters." instead of an empty list.

### Section C — Chat panel

Header: chat icon + "Ask about this audit" (or your assistant's real name) title + "scoped to this audit" caption.

- **Viewer role** → locked message: "Chat is available for analysts and admins only."
- **Admin/analyst**, no messages yet → show 3–4 clickable suggested-question chips (e.g. "What is my biggest cost problem?", "Are there any security risks I should fix immediately?", "Compare this audit with the previous one", "Which resources are unused or idle?") that pre-fill and send that question when clicked.
- Message list: user messages right-aligned (accent-colored bubble), assistant messages left-aligned (neutral bubble), auto-scrolls to the latest message on new content. Assistant messages should render **bold** markdown (`**text**`) at minimum — a small inline parser is fine, you don't need a full markdown renderer for this.
- Typing/thinking indicator (three pulsing dots) while waiting for the assistant's real response from the backend.
- Input box + send button at the bottom, `Enter` submits, disabled while a response is in flight or the input is empty.
- **This must call your real backend's chat/RAG endpoint for this audit** — no mock keyword-matched responses. Pass the audit ID so responses are scoped to that audit's findings/resource data, same as the panel implies.

### Section D — Raw Resource Data

`.glass` card, one row per known resource type, each an accordion:
- Collapsed row: chevron + resource type slug (monospace) + full name (hidden on small screens) + count badge on the right.
- Expanded: a scrollable, monospaced, pretty-printed JSON block of the raw sample data for that resource type in this audit (pull from wherever your backend stores the actual scanned resource payloads — this is likely a bigger payload than the mock had, so consider fetching each resource type's raw data lazily, only when its accordion is expanded, rather than loading everything up front).

## 4. AI Analysis trigger — real backend contract

Replace the prototype's fake 2.2s `setTimeout`. Real flow should be:
1. User (admin/analyst) clicks "Analyze".
2. Call your backend's analyze endpoint for this audit ID.
3. If synchronous: show the spinner until the response returns, then render findings.
4. If asynchronous (more likely for a real AI pipeline): show the spinner, poll a status endpoint or use a websocket/SSE subscription, and transition to the findings view once analysis completes. Handle a failure state too (analysis errored — show a retry option, don't just spin forever).

## 5. Definition of done

- `/audits` list: filters, pagination, and row navigation all work against real backend data.
- `/audits/[id]`: summary, resource tiles, and (for non-failed audits) the AI analysis section with working severity + resource-type filters exactly as described in §3's findings sub-section.
- Chat sends real messages to the backend and displays real responses, scoped per audit, gated by role.
- Raw resource data accordion shows real scanned data per resource type.
- Role gating (viewer locked out of analysis-trigger and chat) enforced both in the UI and — critically — re-checked on the backend (don't rely on the frontend hiding a button as your only access control).

---
**Next:** Spec 4 — Subscriptions management (admin-only CRUD page). Ask for it once this one is implemented and reviewed.
