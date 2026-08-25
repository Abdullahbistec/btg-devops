# Cost Snapshot History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Azure Cost Management history actually exist — a new additive table starts accumulating one real data point per subscription per day from ordinary manual refreshes, a new read endpoint exposes it, and a new cron (dormant until the dashboard is deployed) is ready to keep it flowing automatically.

**Architecture:** `cost_snapshots` (latest-only) and `/api/cost/spend` are left completely untouched. A new `cost_snapshot_history` table is written to inside the same `saveCostSnapshot()` call that already updates `cost_snapshots`, so there is exactly one code path that ever writes a snapshot. A new `GET /api/cost/history` route reads it through a new `getCostSnapshotHistory()` helper. A new script + workflow step request a refresh once daily, following the exact no-op-until-deployed pattern `scripts/run-scheduled-audit.js` already uses.

**Tech Stack:** Next.js 16 App Router, TypeScript, `node:sqlite` (`DatabaseSync`), Vitest, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-25-cost-snapshot-history-design.md`

## Global Constraints

- `cost_snapshots` and `web/app/api/cost/spend/route.ts` must not change at all — history is additive only.
- `cost_snapshot_history` primary key is `(subscription_id, snapshot_date)` — one row per subscription per calendar day; a same-day refresh overwrites that day's row via `ON CONFLICT ... DO UPDATE`, never inserts a duplicate.
- `snapshot_date` uses `date('now', 'localtime')`; `fetched_at` uses `datetime('now')` (UTC) — this split is deliberate (see spec), not to be "fixed" into matching time bases.
- `by_resource_group` is NOT carried into history — only `by_service`.
- No pruning/retention logic — out of scope per the spec's non-goals.
- The new cron step must no-op (exit 0, log why) when `DASHBOARD_BASE_URL` is unset, exactly like `scripts/run-scheduled-audit.js` already does — never fail the workflow because the dashboard isn't deployed yet.
- Test-file safety: any test touching `getDB()` must keep the existing in-memory-only guard pattern from `web/lib/db.test.ts` (checking `PRAGMA database_list` before running destructive `DELETE FROM` setup).

---

### Task 1: Schema + write path for cost snapshot history

**Files:**
- Modify: `web/lib/db.ts:116-137` (schema block), `web/lib/db.ts:432-443` (`saveCostSnapshot`)
- Test: `web/lib/db.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (this is the foundation task).
- Produces: `saveCostSnapshot(subscriptionId: string, data: { totalCost: number; currency: string; byService: unknown; byResourceGroup: unknown }): void` — unchanged signature, now also writes history. New table `cost_snapshot_history(subscription_id, snapshot_date, total_cost, currency, by_service, fetched_at)`. Task 2 reads this table directly via a new helper it defines itself.

- [ ] **Step 1: Write the failing tests**

First, update `web/lib/db.test.ts`'s existing import line to add `saveCostSnapshot` — it currently reads `import { getDB, insertFindings } from './db';`; change it to `import { getDB, insertFindings, saveCostSnapshot } from './db';` (keep `insertFindings`, just add the new name).

Then add this new `describe` block (do not touch the existing `insertFindings` block above it):

```typescript
describe('saveCostSnapshot — history', () => {
  beforeEach(() => {
    const db = getDB();
    const dbList = db.prepare('PRAGMA database_list').all() as { name: string; file: string }[];
    const mainDb = dbList.find(d => d.name === 'main');
    if (mainDb && mainDb.file !== '') {
      throw new Error(`db.test.ts refusing to run destructive setup against a non-in-memory database: ${mainDb.file}`);
    }
    db.exec('DELETE FROM cost_snapshot_history');
    db.exec('DELETE FROM cost_snapshots');
    db.exec('DELETE FROM subscriptions');
    db.prepare(`
      INSERT INTO subscriptions (id, name, subscription_id, tenant_id, client_id)
      VALUES ('sub-1', 'Test Sub', 'sub-guid', 'tenant-guid', 'client-guid')
    `).run();
  });

  it('writes a history row alongside the latest-value row', () => {
    saveCostSnapshot('sub-1', {
      totalCost: 100, currency: 'USD',
      byService: [{ name: 'Virtual Machines', cost: 60 }, { name: 'Storage', cost: 40 }],
      byResourceGroup: [{ name: 'rg-1', cost: 100 }],
    });

    const history = getDB().prepare('SELECT * FROM cost_snapshot_history WHERE subscription_id = ?').all('sub-1') as {
      subscription_id: string; snapshot_date: string; total_cost: number; currency: string; by_service: string; fetched_at: string;
    }[];
    expect(history).toHaveLength(1);
    expect(history[0].total_cost).toBe(100);
    expect(history[0].currency).toBe('USD');
    expect(JSON.parse(history[0].by_service)).toEqual([{ name: 'Virtual Machines', cost: 60 }, { name: 'Storage', cost: 40 }]);
    expect(history[0].snapshot_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('overwrites the same day\'s row on a second refresh the same day, not a duplicate', () => {
    saveCostSnapshot('sub-1', { totalCost: 100, currency: 'USD', byService: [], byResourceGroup: [] });
    saveCostSnapshot('sub-1', { totalCost: 150, currency: 'USD', byService: [{ name: 'VMs', cost: 150 }], byResourceGroup: [] });

    const history = getDB().prepare('SELECT * FROM cost_snapshot_history WHERE subscription_id = ?').all('sub-1') as { total_cost: number }[];
    expect(history).toHaveLength(1);
    expect(history[0].total_cost).toBe(150);
  });

  it('does not carry by_resource_group into history', () => {
    saveCostSnapshot('sub-1', {
      totalCost: 100, currency: 'USD', byService: [],
      byResourceGroup: [{ name: 'rg-1', cost: 100 }],
    });
    const cols = getDB().prepare('PRAGMA table_info(cost_snapshot_history)').all() as { name: string }[];
    expect(cols.map(c => c.name)).not.toContain('by_resource_group');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run lib/db.test.ts`
Expected: FAIL — `cost_snapshot_history` table doesn't exist yet (SQLite error: "no such table").

- [ ] **Step 3: Add the schema**

In `web/lib/db.ts`, immediately after the existing `cost_fetch_requests` block and its index (right before the closing `` ` `` `);` of the schema template literal, i.e. directly after line 136's `CREATE INDEX IF NOT EXISTS idx_cost_fetch_requests_status ...` and before line 137's closing backtick):

```sql
    -- Append-only daily history behind cost_snapshots — that table only
    -- ever holds the latest value (ON CONFLICT DO UPDATE on
    -- subscription_id), so a trend chart has nothing to read. This table
    -- is written alongside it, from the same saveCostSnapshot() call, so
    -- there is exactly one place a snapshot is ever produced. One row per
    -- subscription per calendar day — a second same-day refresh updates
    -- that day's row rather than inserting a duplicate. See
    -- docs/superpowers/specs/2026-08-25-cost-snapshot-history-design.md.
    CREATE TABLE IF NOT EXISTS cost_snapshot_history (
      subscription_id TEXT NOT NULL,
      snapshot_date    TEXT NOT NULL,
      total_cost       REAL NOT NULL,
      currency         TEXT NOT NULL,
      by_service       TEXT NOT NULL,
      fetched_at       TEXT NOT NULL,
      PRIMARY KEY (subscription_id, snapshot_date)
    );
    CREATE INDEX IF NOT EXISTS idx_cost_snapshot_history_sub ON cost_snapshot_history(subscription_id, snapshot_date);
```

- [ ] **Step 4: Update `saveCostSnapshot` to dual-write**

Replace the current function body (`web/lib/db.ts:432-443`) with:

```typescript
export function saveCostSnapshot(subscriptionId: string, data: { totalCost: number; currency: string; byService: unknown; byResourceGroup: unknown }): void {
  const db = getDB();
  db.prepare(`
    INSERT INTO cost_snapshots (subscription_id, total_cost, currency, by_service, by_resource_group, fetched_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(subscription_id) DO UPDATE SET
      total_cost = excluded.total_cost,
      currency = excluded.currency,
      by_service = excluded.by_service,
      by_resource_group = excluded.by_resource_group,
      fetched_at = excluded.fetched_at
  `).run(subscriptionId, data.totalCost, data.currency, JSON.stringify(data.byService), JSON.stringify(data.byResourceGroup));

  db.prepare(`
    INSERT INTO cost_snapshot_history (subscription_id, snapshot_date, total_cost, currency, by_service, fetched_at)
    VALUES (?, date('now', 'localtime'), ?, ?, ?, datetime('now'))
    ON CONFLICT(subscription_id, snapshot_date) DO UPDATE SET
      total_cost = excluded.total_cost,
      currency = excluded.currency,
      by_service = excluded.by_service,
      fetched_at = excluded.fetched_at
  `).run(subscriptionId, data.totalCost, data.currency, JSON.stringify(data.byService));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run lib/db.test.ts`
Expected: PASS — all tests in both the existing `insertFindings` block and the new `saveCostSnapshot — history` block.

- [ ] **Step 6: Commit**

```bash
git add web/lib/db.ts web/lib/db.test.ts
git commit -m "feat(db): add cost_snapshot_history, dual-write from saveCostSnapshot"
```

---

### Task 2: Read helper + `GET /api/cost/history`

**Files:**
- Modify: `web/lib/db.ts` (add new function, near `getCostSnapshot`)
- Create: `web/app/api/cost/history/route.ts`
- Test: `web/lib/db.test.ts`

**Interfaces:**
- Consumes: `cost_snapshot_history` table from Task 1 (exact columns: `subscription_id, snapshot_date, total_cost, currency, by_service, fetched_at`).
- Produces: `getCostSnapshotHistory(subscriptionId: string, days: number): { snapshot_date: string; total_cost: number; currency: string; by_service: string }[]` (ordered oldest→newest) — used only by this task's own route; no later task consumes it.

- [ ] **Step 1: Write the failing test**

Add to `web/lib/db.test.ts`, in the same `describe('saveCostSnapshot — history', ...)` block as Task 1 (append after the existing three `it(...)` blocks, same `beforeEach`):

```typescript
  it('getCostSnapshotHistory returns rows oldest-to-newest within the day window', () => {
    const db = getDB();
    // Insert two history rows directly, one 5 days ago (in-window for days=7,
    // out for days=3) and one today, to test both ordering and the day filter.
    db.prepare(`
      INSERT INTO cost_snapshot_history (subscription_id, snapshot_date, total_cost, currency, by_service, fetched_at)
      VALUES ('sub-1', date('now', '-5 days'), 80, 'USD', '[]', datetime('now', '-5 days'))
    `).run();
    saveCostSnapshot('sub-1', { totalCost: 120, currency: 'USD', byService: [{ name: 'VMs', cost: 120 }], byResourceGroup: [] });

    const sevenDays = getCostSnapshotHistory('sub-1', 7);
    expect(sevenDays).toHaveLength(2);
    expect(sevenDays[0].total_cost).toBe(80);   // older row first
    expect(sevenDays[1].total_cost).toBe(120);  // today's row last

    const threeDays = getCostSnapshotHistory('sub-1', 3);
    expect(threeDays).toHaveLength(1);
    expect(threeDays[0].total_cost).toBe(120);
  });
```

Add `getCostSnapshotHistory` to the test file's import line (`import { getDB, saveCostSnapshot, getCostSnapshotHistory } from './db';` — adjust whatever the existing import line already has rather than replacing it wholesale).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run lib/db.test.ts`
Expected: FAIL — `getCostSnapshotHistory is not a function` (or a TypeScript error if run through a type-checked path; either way, it must fail before Step 3).

- [ ] **Step 3: Implement `getCostSnapshotHistory`**

In `web/lib/db.ts`, immediately after the existing `getCostSnapshot` function (`web/lib/db.ts:428-430`):

```typescript
export interface CostSnapshotHistoryRow {
  subscription_id: string;
  snapshot_date: string;
  total_cost: number;
  currency: string;
  by_service: string; // JSON-encoded { name, cost }[]
  fetched_at: string;
}

export function getCostSnapshotHistory(subscriptionId: string, days: number): CostSnapshotHistoryRow[] {
  return getDB().prepare(`
    SELECT * FROM cost_snapshot_history
    WHERE subscription_id = ? AND snapshot_date >= date('now', '-' || ? || ' days')
    ORDER BY snapshot_date ASC
  `).all(subscriptionId, days) as unknown as CostSnapshotHistoryRow[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run lib/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Create the route**

Create `web/app/api/cost/history/route.ts`, mirroring `web/app/api/cost/spend/route.ts`'s exact subscription-resolution pattern:

```typescript
import { NextResponse } from 'next/server';
import { getDB, getSubscription, getCostSnapshotHistory } from '@/lib/db';

// Sibling to /api/cost/spend — that route reads the latest-only
// cost_snapshots row; this one reads the additive cost_snapshot_history
// table (see docs/superpowers/specs/2026-08-25-cost-snapshot-history-design.md).
// Same subscription-resolution fallback as /api/cost/spend, kept identical
// on purpose so the two routes behave consistently for the same caller.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const subParam = url.searchParams.get('subscription_id');
    const daysParam = url.searchParams.get('days');
    const days = daysParam ? Math.max(1, parseInt(daysParam, 10) || 90) : 90;
    const db = getDB();

    const resolvedSubId = subParam ||
      (db.prepare("SELECT id FROM subscriptions WHERE is_active = 1 ORDER BY created_at LIMIT 1").get() as { id: string } | undefined)?.id || '';
    const sub = getSubscription(resolvedSubId);
    if (!sub) {
      return NextResponse.json({ error: 'No active subscription found. Add one in Settings.' }, { status: 404 });
    }

    const rows = getCostSnapshotHistory(resolvedSubId, days);
    return NextResponse.json({
      subscription: { id: sub.id, name: sub.name },
      currency: rows[0]?.currency ?? 'USD',
      points: rows.map(r => ({
        date: r.snapshot_date,
        totalCost: r.total_cost,
        byService: JSON.parse(r.by_service),
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
```

- [ ] **Step 6: Manually verify the route**

With the dev server running (`cd web && npm run dev`) and at least one subscription with a cost snapshot already saved (via the existing "Refresh" button on the Cost & Usage page):

Run: `curl -s "http://localhost:3000/api/cost/history?days=90" -H "Cookie: <your session cookie>"`
Expected: JSON with `subscription`, `currency`, and a `points` array containing at least one entry with today's date, matching the total shown on the "Actual Spend" view.

- [ ] **Step 7: Commit**

```bash
git add web/lib/db.ts web/lib/db.test.ts web/app/api/cost/history/route.ts
git commit -m "feat(cost): add getCostSnapshotHistory + GET /api/cost/history"
```

---

### Task 3: Scheduled cost-refresh script

**Files:**
- Create: `scripts/run-scheduled-cost-refresh.js`

**Interfaces:**
- Consumes: `GET /api/subscriptions` (existing, admin-only, returns `Subscription[]` with `is_active: number`), `POST /api/cost-requests` (existing, body `{ subscriptionId: string }`), `POST /api/auth/login` (existing, body `{ email, password }`, sets a session cookie) — all pre-existing routes, unchanged by this task.
- Produces: nothing consumed by a later task — Task 4 invokes this script by filename only.

- [ ] **Step 1: Create the script**

Create `scripts/run-scheduled-cost-refresh.js`:

```javascript
#!/usr/bin/env node
'use strict';
// Requests a cost refresh for every active subscription through the real
// /api/cost-requests endpoint — the exact same one the dashboard's
// "Refresh" button calls, so there is no second code path to keep correct.
// Mirrors scripts/run-scheduled-audit.js's login/no-op pattern; see
// docs/superpowers/specs/2026-08-25-cost-snapshot-history-design.md.
//
// Deliberately a no-op (exit 0) if DASHBOARD_BASE_URL isn't set, rather
// than a failure — the dashboard isn't deployed anywhere yet, so this step
// stays harmless until that changes.

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

function loadDotEnvLocalIfPresent() {
  const envPath = path.join(ROOT, 'web', '.env.local');
  if (!fs.existsSync(envPath)) return; // fine in CI — real env vars are already set
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = value;
  }
}
loadDotEnvLocalIfPresent();

async function main() {
  const baseUrl = process.env.DASHBOARD_BASE_URL;
  if (!baseUrl) {
    console.log('DASHBOARD_BASE_URL not set — dashboard not deployed yet. Skipping (not a failure).');
    return;
  }
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
    console.error('DASHBOARD_BASE_URL is set but ADMIN_EMAIL/ADMIN_PASSWORD are missing.');
    process.exit(1);
  }

  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
  });
  if (!loginRes.ok) {
    console.error('Login failed:', loginRes.status);
    process.exit(1);
  }
  const setCookie = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [loginRes.headers.get('set-cookie')];
  const cookieHeader = setCookie.map(c => c.split(';')[0]).join('; ');

  const subsRes = await fetch(`${baseUrl}/api/subscriptions`, { headers: { Cookie: cookieHeader } });
  if (!subsRes.ok) {
    console.error('Listing subscriptions failed:', subsRes.status);
    process.exit(1);
  }
  const subs = await subsRes.json();
  const active = Array.isArray(subs) ? subs.filter(s => s.is_active) : [];
  if (active.length === 0) {
    console.log('No active subscriptions — nothing to refresh.');
    return;
  }

  let anyFailed = false;
  for (const sub of active) {
    const res = await fetch(`${baseUrl}/api/cost-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ subscriptionId: sub.id }),
    });
    const body = await res.json();
    if (!res.ok) {
      console.error(`Cost refresh request failed for ${sub.name} (${sub.id}):`, res.status, body);
      anyFailed = true;
      continue;
    }
    console.log(`Cost refresh requested for ${sub.name} (${sub.id}):`, body);
  }
  if (anyFailed) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Manually verify the no-op path**

Run: `node scripts/run-scheduled-cost-refresh.js` (with `DASHBOARD_BASE_URL` unset in your shell)
Expected: prints `DASHBOARD_BASE_URL not set — dashboard not deployed yet. Skipping (not a failure).` and exits 0. Confirm with: `echo $?` (bash) immediately after — must print `0`.

- [ ] **Step 3: Commit**

```bash
git add scripts/run-scheduled-cost-refresh.js
git commit -m "feat(scripts): add run-scheduled-cost-refresh.js, no-ops until deployed"
```

---

### Task 4: Wire the daily cron into `scheduled-audit.yml`

**Files:**
- Modify: `.github/workflows/scheduled-audit.yml`

**Interfaces:**
- Consumes: `scripts/run-scheduled-cost-refresh.js` from Task 3 (exact filename, no arguments, reads `DASHBOARD_BASE_URL`/`ADMIN_EMAIL`/`ADMIN_PASSWORD` from `env:`).
- Produces: nothing — this is the last task in the plan.

- [ ] **Step 1: Add the new step**

In `.github/workflows/scheduled-audit.yml`, immediately after the existing "Push results into the live dashboard, if deployed" step (currently the last step before "Report failure"), insert:

```yaml
      - name: Request a daily cost refresh, if deployed
        env:
          DASHBOARD_BASE_URL: ${{ vars.DASHBOARD_BASE_URL }}
          ADMIN_EMAIL: ${{ secrets.ADMIN_EMAIL }}
          ADMIN_PASSWORD: ${{ secrets.ADMIN_PASSWORD }}
        run: node scripts/run-scheduled-cost-refresh.js
```

This must land as its own step, after the existing dashboard-push step and before "Report failure" — the file's final three steps should read: dashboard-push, this new step, then "Report failure".

- [ ] **Step 2: Validate the YAML**

Run: `cd "c:\Users\MohaideenAbdullahBIS\OneDrive - BISTEC Global\Documents\GitHub\btg-devops" && node -e "require('js-yaml') ? console.log('has js-yaml') : 0" 2>/dev/null; python -c "import yaml; yaml.safe_load(open('.github/workflows/scheduled-audit.yml')); print('YAML OK')"`

If neither `js-yaml` (Node) nor `PyYAML` (Python) is available in the environment, instead visually confirm the new step's indentation matches the sibling steps exactly (6 spaces for `- name:`, keys nested one level under it) by comparing against the existing "Push results into the live dashboard" step immediately above it.

Expected: `YAML OK` (or, if using the visual check, indentation matches exactly).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/scheduled-audit.yml
git commit -m "feat(ci): wire daily cost-refresh cron into scheduled-audit.yml"
```
