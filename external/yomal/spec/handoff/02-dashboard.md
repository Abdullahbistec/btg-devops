# Spec 2/5 — Dashboard Page

> Depends on Spec 1 (foundation, layout shell, auth, theme, API client) already being implemented.
> Route: `/` (index page), admin + analyst + viewer all have access (read-only page, no role gate).

## 1. Data this page needs from the API

- The most recent **completed** audit (used for the KPI tiles + resource breakdown chart). If your backend has a "latest audit" or "latest audit per subscription" concept, use that; otherwise fetch recent audits and take the first with `status === 'completed'`.
- Count of active subscriptions (`is_active: true`) vs total subscriptions.
- Count of audits created in the current calendar month.
- The 5 most recent audits (any status) for the "Recent Audits" table.

Prefer a single dashboard-summary endpoint if your backend can provide one (`GET /api/dashboard`) returning `{ latestAudit, activeSubscriptions, totalSubscriptions, auditsThisMonth, recentAudits }` — cheaper than 3–4 round trips from the client. If not, compose it client-side from `listAudits()` + `listSubscriptions()` (defined in Spec 1's `api.ts`).

## 2. Shapes referenced below

```ts
type Audit = {
  id: string
  created_at: string              // display string or ISO — your call, format at render time
  subscription_id: string
  subscription_name: string
  trigger_type: 'scheduled' | 'manual'
  status: 'running' | 'completed' | 'failed'
  resource_counts: Record<string, number>   // keyed by resource type slug, e.g. { storage: 23, iam: 197, ... }
  has_analysis: boolean
}

function totalResources(a: Audit): number {
  return Object.values(a.resource_counts).reduce((s, n) => s + n, 0)
}
```

## 3. Layout, top to bottom

### 3a. KPI tile row (4 tiles, responsive grid: 1 col mobile → 2 col small → 4 col desktop)

Build a reusable `<KPICard>` component (used again in later specs if you add more dashboards):

```ts
type KPICardProps = {
  label: string
  value: string | React.ReactNode
  trend?: string          // e.g. "↑ daily" — optional badge next to the value
  trendDir?: 'up' | 'down'
  sub?: string             // small caption below the value
  accent?: 'cyan' | 'emerald' | 'violet' | 'amber'   // tints a top border + glow shadow
}
```

Visual: `.glass` card, small uppercase label at top, large bold monospace value, optional trend badge (green if `up`, red if `down`), small muted caption below. `accent` adds a colored 2px top border and a matching soft glow shadow — used to visually distinguish the four tiles from each other, no semantic meaning beyond that.

The four tiles for this page:
1. **Total Resources** — `totalResources(latestAudit)`, caption "from latest audit", accent `cyan`
2. **Last Audit** — the date part of `latestAudit.created_at` as the value, time + subscription name as caption, accent `emerald`
3. **Subscriptions** — count of active subscriptions as the value, caption "`{total} total, {active} active`", accent `violet`
4. **Audits This Month** — count, with an "↑ daily" trend badge (`trendDir="up"`), caption "scheduled at [your audit cadence] time", accent `amber`

### 3b. Resource Breakdown chart

`.glass` card, header row: "Resource Breakdown" title + small caption showing the short ID of the audit the chart represents (`shortId(latestAudit.id)`).

Body: a `recharts` `<BarChart>`, ~300px tall, full width (`<ResponsiveContainer>`), one bar per resource type from `latestAudit.resource_counts` (`Object.entries(...).map(([type, count]) => ({ type, count }))`).

Chart styling to match the rest of the UI:
- Grid: `<CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />`
- X axis: resource type labels, angled -28°, small font, theme-aware tick color (`#64748b` dark / `#94a3b8` light — read from your `useTheme()` hook)
- Y axis: plain count, no axis line
- Tooltip: dark/light-aware background using `var(--panel)` / `var(--border-strong)` / `var(--t1)` / `var(--t2)` so it matches the card it floats over
- Bars: single blue fill (`#3b82f6`), rounded top corners, capped max width (~38px) so a handful of resource types don't render as giant blocks

### 3c. Recent Audits table

`.glass` card, header row: "Recent Audits" title + a "View all →" link/button that navigates to `/audits`.

Table columns: **Audit ID** (short, monospace, accent color) · **Date & Time** · **Trigger** (badge: scheduled/manual) · **Status** (badge: completed/failed/running) · **Resources** (total count, or "—" if failed) · **Analysis** (✓ "Cached" in green if `has_analysis`, else a neutral "Not yet") · trailing **View** link.

Show the 5 most recent audits. Each row is clickable (whole row, not just the link) and navigates to `/audits/{id}`.

## 4. Empty / loading / error states

- While the summary data is loading: skeleton or spinner in place of the KPI row + chart + table (don't block the whole page — the Header should render immediately since it has no data dependency).
- If there is no completed audit yet (new tenant, first-run): show a friendly empty state instead of the KPI/chart section — something like "No completed audits yet — audits will appear here once the first scheduled run finishes," with the Recent Audits table still rendering (it can show `running`/`failed` audits even with zero completed ones).
- If the summary fetch fails: inline error message with a retry button, not a full-page crash.

## 5. Definition of done

- Visiting `/` as any role shows the KPI tiles, chart, and recent-audits table populated from real backend data (no mock data left).
- Clicking a table row or the audit ID navigates to `/audits/{id}` (built in Spec 3).
- "View all" navigates to `/audits`.
- Chart and KPI values update correctly across a light/dark theme toggle (no hardcoded colors that ignore the CSS variables).
- Handles the zero-completed-audits case without crashing.

---
**Next:** Spec 3 — Audits (list + detail, findings, Claude/AI analysis panel, filters, chat). Ask for it once this one is implemented and reviewed.
