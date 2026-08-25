# Cost Snapshot History — Design

Date: 2026-08-25
Branch: abd-production-2

## Context

`web/lib/db.ts`'s `cost_snapshots` table has `subscription_id` as its
`PRIMARY KEY` — every refresh (`saveCostSnapshot`, called from
`refreshCostSnapshot` in `web/lib/costManagement.ts`) does an
`ON CONFLICT(subscription_id) DO UPDATE`, overwriting the previous value.
There is no history at all today: exactly one row per subscription, always
the latest.

This followed directly from shipping a real-data "Actual Spend" view
(`web/app/cost/page.tsx`) earlier the same day: the view was scoped down to
what a single snapshot can honestly show (current month-to-date total, a
by-service breakdown, a "last refreshed" timestamp) with the daily chart,
period selector, and budget line explicitly dropped rather than faked. This
spec is the follow-up that makes those dropped pieces buildable for real,
by making history actually exist.

Two things were confirmed while scoping this out, both load-bearing for the
design below:

- **Refresh is currently manual-only.** Nothing schedules a refresh; a row
  in `cost_snapshots` only changes when a user clicks "Refresh" on the Cost
  & Usage page. A history built from that alone would be sparse and
  irregular — dense on some days, empty for weeks at a time.
- **The dashboard isn't deployed anywhere reachable.** It only ever runs via
  `npm run dev` on a local machine. `.github/workflows/scheduled-audit.yml`
  already has this exact problem for its own dashboard-push step, and
  already solves it the same way: the step runs unconditionally but reads
  `vars.DASHBOARD_BASE_URL`, which is unset today, so it no-ops cleanly
  (`node scripts/run-scheduled-audit.js` exits 0 without doing anything).
  This design's new cron step follows the identical pattern.

## Goals

- `cost_snapshots` keeps meaning exactly what it means today — "the latest
  known value" — and nothing that reads it (`/api/cost/spend`,
  `web/app/cost/page.tsx`) changes at all.
- A new, additive history table starts accumulating real daily data points
  the moment this ships, from ordinary manual refreshes alone — no
  dependency on the cron actually running anywhere yet.
- A new daily scheduled refresh exists in the repo, ready to activate
  automatically (zero further code changes) the moment the dashboard is
  ever deployed somewhere with `DASHBOARD_BASE_URL` set — exactly mirroring
  how the existing scheduled-audit dashboard-push already behaves today.
- A new read endpoint exposes the accumulated history for a future chart to
  consume. Building that chart itself is explicitly not part of this spec.

## Non-goals

- **No chart UI.** There is zero history at ship time (this spec is what
  makes history start existing) — building a chart against data that
  doesn't exist yet would mean testing against fabricated data again,
  exactly what the "ship the honest scoped-down view" work was for. The
  chart is its own follow-up, once real days of history have actually
  accumulated.
- **No pruning/retention policy.** One row per subscription per day is tiny
  (a year ≈ 365 rows per subscription). Not worth the complexity until it's
  demonstrably a real problem.
- **No change to `cost_snapshots` or `/api/cost/spend`.** Explicitly kept
  as two separate concerns (latest-value vs. history) rather than merged
  into one table, to keep this change's blast radius to "additive only."

## Schema

Appended to the existing schema block in `web/lib/db.ts` (same
`CREATE TABLE IF NOT EXISTS` pattern already used for every other table
there):

```sql
CREATE TABLE IF NOT EXISTS cost_snapshot_history (
  subscription_id TEXT NOT NULL,
  snapshot_date    TEXT NOT NULL,  -- 'YYYY-MM-DD', local date of the refresh
  total_cost       REAL NOT NULL,
  currency         TEXT NOT NULL,
  by_service       TEXT NOT NULL,  -- JSON, same shape as cost_snapshots.by_service
  fetched_at       TEXT NOT NULL,
  PRIMARY KEY (subscription_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_cost_snapshot_history_sub ON cost_snapshot_history(subscription_id, snapshot_date);
```

`PRIMARY KEY (subscription_id, snapshot_date)` means a second manual
refresh on the same calendar day overwrites that day's row (`ON CONFLICT
... DO UPDATE`) rather than creating a duplicate — the history stays
one-point-per-day even under repeated manual clicking, which is exactly
what a daily trend chart needs.

`snapshot_date` deliberately uses `date('now', 'localtime')` while
`fetched_at` uses plain `datetime('now')` (UTC, matching `cost_snapshots`'
existing `fetched_at` default) — `snapshot_date` is "which calendar day a
human would say this is," `fetched_at` is a precise audit timestamp. Two
different jobs, two different time bases; not an oversight.

`by_resource_group` is deliberately not carried into history — the
"Actual Spend" view's by-service breakdown is the one that would plausibly
ever need a historical trend; by-resource-group is a today-only detail.
This can be added later if a real need shows up.

## Write path

`saveCostSnapshot` in `web/lib/db.ts` gains one additional statement,
executed unconditionally alongside its existing upsert into
`cost_snapshots`:

```sql
INSERT INTO cost_snapshot_history (subscription_id, snapshot_date, total_cost, currency, by_service, fetched_at)
VALUES (?, date('now', 'localtime'), ?, ?, ?, datetime('now'))
ON CONFLICT(subscription_id, snapshot_date) DO UPDATE SET
  total_cost = excluded.total_cost,
  currency   = excluded.currency,
  by_service = excluded.by_service,
  fetched_at = excluded.fetched_at;
```

Both statements run in the same function, on the same `DatabaseSync`
connection, back-to-back — no transaction wrapper needed beyond what
`node:sqlite` already gives a single synchronous call. `refreshCostSnapshot`
itself needs no changes; it already calls `saveCostSnapshot` once per
successful fetch, and this is purely inside that function.

## Read path

New route, `web/app/api/cost/history/route.ts`, sibling to the existing
`web/app/api/cost/spend/route.ts`:

```
GET /api/cost/history?subscription_id=<id>&days=<n>   (days defaults to 90)
```

Response:
```json
{
  "subscription": { "id": "...", "name": "..." },
  "currency": "USD",
  "points": [
    { "date": "2026-08-20", "totalCost": 118.42, "byService": [{ "name": "Virtual Machines", "cost": 61.2 }, ...] },
    ...
  ]
}
```

Query: `SELECT * FROM cost_snapshot_history WHERE subscription_id = ? AND snapshot_date >= date('now', '-' || ? || ' days') ORDER BY snapshot_date ASC`.
Same subscription-resolution fallback as `/api/cost/spend` (explicit
`subscription_id` param, else the oldest active subscription) for
consistency between the two routes.

## Cron

New step appended to `.github/workflows/scheduled-audit.yml` (same job,
after the existing "Push results into the live dashboard" step, since both
depend on the same `DASHBOARD_BASE_URL`/admin-login precondition):

```yaml
- name: Request a daily cost refresh, if deployed
  env:
    DASHBOARD_BASE_URL: ${{ vars.DASHBOARD_BASE_URL }}
    ADMIN_EMAIL: ${{ secrets.ADMIN_EMAIL }}
    ADMIN_PASSWORD: ${{ secrets.ADMIN_PASSWORD }}
  run: node scripts/run-scheduled-cost-refresh.js
```

`scripts/run-scheduled-cost-refresh.js` mirrors the shape of the existing
`scripts/run-scheduled-audit.js`: no-ops (exits 0, logs why) if
`DASHBOARD_BASE_URL` is unset; otherwise logs in as the admin, lists active
subscriptions via the dashboard's own API, and `POST`s
`/api/cost-requests` for each one — the exact same endpoint the "Refresh"
button already calls, so there is no second code path to keep correct.

## Testing

- `saveCostSnapshot`: existing tests (if any) plus a new one asserting a
  second call on the same simulated day updates `cost_snapshot_history`'s
  existing row rather than inserting a second one, and a call on a
  different day inserts a new row.
- `GET /api/cost/history`: returns points ordered oldest→newest, respects
  `days`, 404s the same way `/api/cost/spend` does when no subscription
  resolves.
- `scripts/run-scheduled-cost-refresh.js`: unit-testable no-op-when-unset
  path; the deployed path is realistically only verifiable once an actual
  `DASHBOARD_BASE_URL` exists (same limitation the existing scheduled-audit
  script already has).

## Risks

| Risk | Mitigation |
|---|---|
| Cron step silently does nothing forever if `DASHBOARD_BASE_URL` is never set, giving false confidence that history is accumulating on schedule | Manual refreshes alone still populate real history regardless of cron status — this is why "ship value from Day 1 via manual refreshes" was a goal, not just a fallback |
| `by_service` JSON shape drifts between `cost_snapshots` and `cost_snapshot_history` over time since they're two separate columns written by the same call | Both are written from the exact same `data.byService` value in one `saveCostSnapshot` call — same source, same serialization, no separate code path to drift |
