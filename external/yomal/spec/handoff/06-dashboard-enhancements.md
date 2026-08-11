# Spec 6 — Dashboard Enhancements (Polish, Trends, Top Issues, Comparison)

> Depends on Specs 1–5 being fully implemented (they are). This spec upgrades the existing
> dashboard with visual polish and three new insight features. Implement in the order below —
> each phase is independently shippable, so stop and review after each one.

## Why

The v1 dashboard works but feels thin: single-audit views only, generic spinners, plain cards,
and no way to see change over time. These four phases address visual polish, feature depth,
and data insight together.

---

## Phase 1 — Visual Polish Pass

No new features. Make the existing UI feel sharper.

### 1a. Skeleton loaders (replace spinners)

New `app/components/Skeleton.tsx` exporting:
- `Skeleton` — base shimmer block (width/height/radius props), animated with a `shimmer`
  keyframe (add to `globals.css`: background-position sweep on a 3-stop gradient of
  `--input-bg` → `--hover` → `--input-bg`).
- `KPISkeletonRow` — 4 ghost KPI cards matching the real KPI grid.
- `ChartSkeleton` — ghost bar chart (8 bars of varied heights).
- `TableSkeleton` — configurable rows × cols of ghost lines inside a `.glass` card.

Replace the centered spinner on: Dashboard home (KPI row + chart + table), Audits list
(table), Audit detail (summary + panels), Subscriptions (table), Users (table).
Keep the small inline spinners for in-flight actions (Analyze button, chat typing dots).

### 1b. Resource type icons

New `app/lib/resourceMeta.tsx` — one map from resource slug → `{ label, icon }` using
lucide-react icons:

| slug | icon | label |
|---|---|---|
| storage | `HardDrive` | Storage Accounts |
| iam | `UserCheck` | IAM Role Assignments |
| nsg | `Shield` | Network Security Groups |
| acr | `Container` | Container Registries |
| cosmosdb | `Database` | Cosmos DB |
| keyvault | `KeyRound` | Key Vaults |
| functions | `Zap` | Function Apps |
| appservice | `Globe` | App Services |
| appserviceplan | `Layers` | App Service Plans |
| cognitiveservices | `Brain` | Cognitive Services |
| resourcegroup | `FolderTree` | Resource Groups |
| publicip | `Network` | Public IPs |

Use it in: audit detail resource tiles, Raw Data accordion rows, the Analyze dropdown line,
and anywhere a resource slug is displayed as a label. Fallback icon: `Box`.

### 1c. Card/微-interaction polish

- KPI cards: number counts up on load (simple requestAnimationFrame count-up hook, ~600ms).
- Cards get a subtle hover lift (`transform: translateY(-1px)` + slightly stronger border)
  via a `.glass-hover` class — apply to clickable cards only.
- Table rows: keep `.row-hover`, add a left accent border on hover.
- Page transitions: keep the existing `animate-fade-in` / `stagger` — extend stagger to 8 items.

**Definition of done:** no full-page spinners remain on the five main pages; resource slugs
everywhere show an icon; KPI numbers animate in.

---

## Phase 2 — Trends Over Time (Dashboard)

A line/area chart on the Dashboard home showing how the subscription evolves across audits.

### Data
No new endpoint needed — `GET /api/audits` already returns every audit with
`resource_counts` and `created_at`. Client-side: take all `completed` audits, sort
ascending by date, map to `{ date, totalResources, perType... }`.

### UI
New `app/components/TrendChart.tsx` (recharts `AreaChart`):
- X axis: audit date (short format `MM/DD`), Y axis: total resource count.
- One primary area series: total resources (blue `#3b82f6`, gradient fill fading to transparent).
- Theme-aware ticks/grid/tooltip exactly like `ResourceChart`.
- A small `<select>` in the card header to switch the metric: "Total resources" (default)
  or any single resource type (populated from the union of `resource_counts` keys).
- If fewer than 2 completed audits: show the card with a friendly empty state
  ("Trends appear once you have at least two completed audits.").

Placement: Dashboard home, full-width card between the KPI row and the Resource Breakdown
chart (or side-by-side with Resource Breakdown on `xl` screens: 1/2 + 1/2 grid).

**Definition of done:** with ≥2 completed audits the chart renders and the metric switcher
works; with fewer it shows the empty state; theme toggle doesn't break colors.

---

## Phase 3 — Top Issues Digest (Dashboard)

Surface the most important findings across recent audits without opening each audit.

### Data
New endpoint: `GET /api/findings/top` →
```
[{ id, audit_id, severity, resource_type, resource_name, issue, recommendation, created_at }]
```
SQL: latest N findings ordered by severity rank (Critical → Warning → Info) then
`created_at DESC`, `LIMIT 8`, joined with nothing (audit_id is enough — link to the audit).
Model function `findTopFindings(limit)` in `models/findings.ts`, controller + route follow
the existing MVC pattern. Auth: any logged-in role (read-only).

### UI
New `app/components/TopIssues.tsx` on the Dashboard home, below the trends/breakdown charts:
- `.glass` card, header "Top Issues" + caption "most severe findings across recent audits".
- Each row: severity icon + badge, issue text (1 line, ellipsis), resource `type · name`
  in mono, audit short-id link → `/audits/{audit_id}`.
- Empty state: "No findings yet — run an analysis on an audit to populate this."
- If >8 findings exist, footer link "View all audits →".

**Definition of done:** dashboard shows real findings ranked by severity; each row links to
its audit; empty state when the findings table is empty.

---

## Phase 4 — Audit Comparison Tool

Compare two audits side-by-side to see what changed (drift).

### Route
`/audits/compare?a={id}&b={id}` — new page. Entry points:
1. "Compare" button on the Audits list page header → opens the page with the two most
   recent completed audits preselected.
2. Two dropdowns on the compare page itself (audit A = older/base, audit B = newer/target),
   listing completed audits as "`shortId` · date".

### Data
No new endpoint — fetch both audits with the existing `GET /api/audits/[id]` (parallel).
All diffing is client-side in a pure helper `app/lib/compareAudits.ts`:

```ts
type ResourceDiff = { slug: string; before: number; after: number; delta: number }
compareCounts(a, b): ResourceDiff[]   // union of keys from both resource_counts
```

### UI
- Header breadcrumbs: `Audits > Compare`.
- Top: the two audit pickers + a swap button (⇄).
- Summary strip: 3 KPI-style tiles — "Resources added" (sum of positive deltas, green),
  "Resources removed" (sum of negative deltas, red), "Types changed" (count of non-zero rows).
- Main table: one row per resource type — icon + slug · count in A · count in B · delta
  (badge: green `+n`, red `−n`, muted `0`). Sort: biggest absolute delta first.
- "Ask Claude about this change" button (analyst/admin): navigates to audit B's detail page
  chat with a prefilled question ("Compare this audit with audit {shortId(a)} — what changed
  and does anything look wrong?"). Implementation: pass via query param `?ask=...` that the
  ChatPanel reads once on mount and sends. (Keeps Method-2 chat as the single AI path —
  no new Claude endpoint.)
- Handle: same audit selected twice (hint text), failed audits excluded from pickers,
  <2 completed audits → empty state.

**Definition of done:** picking any two completed audits renders the delta table and summary
tiles; swap works; the "Ask Claude" handoff lands in audit B's chat with the prefilled
question sent; direct URL with `?a=&b=` works (shareable).

---

## Rollout order

1 → 2 → 3 → 4, one phase per review cycle. `npx tsc --noEmit && npm run build` must pass
after each phase. No backend changes except the one new endpoint in Phase 3.
