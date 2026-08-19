# Generic Location + Cost Fields — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface `location` and `monthly_cost`/`monthly_saving` on findings by wiring through data several analyzers already compute or extract internally but never expose — zero new API calls, zero new Azure/Hetzner permissions.

**Architecture:** Add three additive, nullable columns to SQLite's `findings` table. On the Go side, only `cmd/idle.go` needs a real code change (its `IdleFinding` struct doesn't carry the `TotalCost`/`TotalSaving` numbers its own internal report already computes). Hetzner's servers/volumes/floating-IPs commands already emit `datacenter`/`est_monthly_waste_eur`/`home_location` in their JSON today — only the TypeScript normalization layer needs to start reading them. `web/lib/btg-runner.ts` gains three extraction helpers (mirroring the existing `extractResource()` pattern) and `web/lib/db.ts` gains the schema + insert wiring.

**Tech Stack:** Go (existing `cmd/` package, `provider` package), TypeScript (Next.js `web/lib/`), Vitest (new devDependency for `web/`), SQLite (`node:sqlite`).

**Spec:** `docs/superpowers/specs/2026-08-19-yomal-azure-dashboard-integration-design.md` (Sub-project B, Phase 1)

## Global Constraints

- No new Azure or Hetzner API calls in this plan — every value wired through is already fetched or computed by existing code.
- New DB columns are additive (`ALTER TABLE ... ADD COLUMN`, wrapped in `try/catch`), matching the five existing migrations already in `web/lib/db.ts`.
- New field names must be identical (not camelCase-vs-snake_case) across `NormalizedFinding` (`web/lib/btg-runner.ts`) and `Finding` (`web/lib/db.ts`) — `insertFindings()`'s signature is `Omit<Finding, 'id' | 'audit_id' | 'created_at'>[]`, which only type-checks against `NormalizedFinding` today because every shared field name is spelled identically in both interfaces. Use `location`, `monthly_cost`, `monthly_saving` (snake_case) in **both** places — not `monthlyCost`/`monthlySaving`.
- `MonthlyCost`/`MonthlySaving` are `number | null` (TS) / `*float64` (Go, where added to `provider.Finding`) — `null`/`nil` means "not computed for this finding," never coerce to `0`.

---

### Task 1: Surface Azure `idle`'s existing cost/saving numbers

**Files:**
- Modify: `cmd/idle.go:25-33` (`IdleFinding` struct), `cmd/idle.go:209-217` (construction site), `cmd/idle.go:268-282` (`idleFindingsToProvider`)
- Modify: `provider/analyzer.go:20-29` (`Finding` struct)
- Test: `cmd/idle_test.go`

**Interfaces:**
- Consumes: `report.TotalCost float64`, `report.TotalSaving float64` — already-populated fields on the `*UsageReport` value returned by `buildUsageReport` (`cmd/usage.go:47,52`), already in scope inside `computeIdleFindings`'s loop as the `report` variable.
- Produces: `IdleFinding.MonthlyCost float64` (JSON: `monthly_cost`), `IdleFinding.MonthlySaving float64` (JSON: `monthly_saving`) — Task 2 (TypeScript) reads these two JSON keys directly. Also `provider.Finding.Location string` (JSON: `location`, omitempty), `provider.Finding.MonthlyCost *float64` (JSON: `monthly_cost`, omitempty), `provider.Finding.MonthlySaving *float64` (JSON: `monthly_saving`, omitempty) — for parity with the `provider.Run`/`analyze azure` path; no other task in this plan consumes these three `provider.Finding` fields directly, but do not omit them, since diverging the two paths further is the exact duplication `docs/consolidation-plan.md` §2 already flags.

- [ ] **Step 1: Write the failing test**

Add to `cmd/idle_test.go`:

```go
func TestIdleFindingsToProvider_CarriesCostAndSaving(t *testing.T) {
	findings := []IdleFinding{
		{
			Severity:       Critical,
			Category:       "Zero Usage",
			ResourceName:   "unused-ip",
			ResourceType:   "microsoft.network/publicipaddresses",
			ResourceGroup:  "rg-test",
			Description:    "Idle for 30 days",
			Recommendation: "Delete it",
			MonthlyCost:    12.5,
			MonthlySaving:  12.5,
		},
	}

	out := idleFindingsToProvider(findings)

	if len(out) != 1 {
		t.Fatalf("expected 1 finding, got %d", len(out))
	}
	if out[0].MonthlyCost == nil || *out[0].MonthlyCost != 12.5 {
		t.Errorf("expected MonthlyCost 12.5, got %v", out[0].MonthlyCost)
	}
	if out[0].MonthlySaving == nil || *out[0].MonthlySaving != 12.5 {
		t.Errorf("expected MonthlySaving 12.5, got %v", out[0].MonthlySaving)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./cmd/... -run TestIdleFindingsToProvider_CarriesCostAndSaving -v`
Expected: FAIL — compile error, `IdleFinding` has no field `MonthlyCost`/`MonthlySaving`.

- [ ] **Step 3: Add the two fields to `IdleFinding` and populate them**

In `cmd/idle.go`, change:

```go
type IdleFinding struct {
	Severity       Severity `json:"severity"`
	Category       string   `json:"category"`
	ResourceName   string   `json:"resource_name"`
	ResourceType   string   `json:"resource_type"`
	ResourceGroup  string   `json:"resource_group"`
	Description    string   `json:"description"`
	Recommendation string   `json:"recommendation"`
}
```

to:

```go
type IdleFinding struct {
	Severity       Severity `json:"severity"`
	Category       string   `json:"category"`
	ResourceName   string   `json:"resource_name"`
	ResourceType   string   `json:"resource_type"`
	ResourceGroup  string   `json:"resource_group"`
	Description    string   `json:"description"`
	Recommendation string   `json:"recommendation"`
	MonthlyCost    float64  `json:"monthly_cost"`
	MonthlySaving  float64  `json:"monthly_saving"`
}
```

Then change the construction site (inside `computeIdleFindings`):

```go
			findings = append(findings, IdleFinding{
				Severity:       report.Severity,
				Category:       category,
				ResourceName:   report.ResourceName,
				ResourceType:   report.ResourceType,
				ResourceGroup:  report.ResourceGroup,
				Description:    report.WasteReason,
				Recommendation: report.TopRecommendation,
			})
```

to:

```go
			findings = append(findings, IdleFinding{
				Severity:       report.Severity,
				Category:       category,
				ResourceName:   report.ResourceName,
				ResourceType:   report.ResourceType,
				ResourceGroup:  report.ResourceGroup,
				Description:    report.WasteReason,
				Recommendation: report.TopRecommendation,
				MonthlyCost:    report.TotalCost,
				MonthlySaving:  report.TotalSaving,
			})
```

- [ ] **Step 4: Add the same two fields to `provider.Finding` and wire the adapter**

In `provider/analyzer.go`, change:

```go
type Finding struct {
	Provider       string   `json:"provider"`
	Service        string   `json:"service"`
	Severity       Severity `json:"severity"`
	Category       string   `json:"category"`
	Resource       string   `json:"resource"`
	Environment    string   `json:"environment,omitempty"`
	Description    string   `json:"description"`
	Recommendation string   `json:"recommendation"`
}
```

to:

```go
type Finding struct {
	Provider       string   `json:"provider"`
	Service        string   `json:"service"`
	Severity       Severity `json:"severity"`
	Category       string   `json:"category"`
	Resource       string   `json:"resource"`
	Environment    string   `json:"environment,omitempty"`
	Description    string   `json:"description"`
	Recommendation string   `json:"recommendation"`
	Location       string   `json:"location,omitempty"`
	MonthlyCost    *float64 `json:"monthly_cost,omitempty"`
	MonthlySaving  *float64 `json:"monthly_saving,omitempty"`
}
```

In `cmd/idle.go`, change `idleFindingsToProvider`:

```go
func idleFindingsToProvider(findings []IdleFinding) []provider.Finding {
	out := make([]provider.Finding, len(findings))
	for i, f := range findings {
		out[i] = provider.Finding{
			Provider:       "azure",
			Service:        "Idle & Waste",
			Severity:       provider.Severity(f.Severity),
			Category:       f.Category,
			Resource:       f.ResourceName,
			Description:    f.Description,
			Recommendation: f.Recommendation,
		}
	}
	return out
}
```

to:

```go
func idleFindingsToProvider(findings []IdleFinding) []provider.Finding {
	out := make([]provider.Finding, len(findings))
	for i, f := range findings {
		cost := f.MonthlyCost
		saving := f.MonthlySaving
		out[i] = provider.Finding{
			Provider:       "azure",
			Service:        "Idle & Waste",
			Severity:       provider.Severity(f.Severity),
			Category:       f.Category,
			Resource:       f.ResourceName,
			Description:    f.Description,
			Recommendation: f.Recommendation,
			MonthlyCost:    &cost,
			MonthlySaving:  &saving,
		}
	}
	return out
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./cmd/... -run TestIdleFindingsToProvider_CarriesCostAndSaving -v`
Expected: PASS

- [ ] **Step 6: Run the full Go test suite to check for regressions**

Run: `go test ./...`
Expected: PASS (no existing test asserts `IdleFinding`'s or `provider.Finding`'s exact field set, since both changes are additive)

- [ ] **Step 7: Commit**

```bash
git add cmd/idle.go cmd/idle_test.go provider/analyzer.go
git commit -m "feat(idle): surface existing TotalCost/TotalSaving on findings"
```

---

### Task 2: Read location + cost from Go JSON in `btg-runner.ts`

**Files:**
- Modify: `web/lib/btg-runner.ts:70-79` (`NormalizedFinding`), `web/lib/btg-runner.ts:81-115` (`RawFinding`), `web/lib/btg-runner.ts` (new helpers near `extractResource`), `web/lib/btg-runner.ts:218-227` (mapping in `runSingleCommand`)
- Modify: `web/package.json` (add `vitest` devDependency)
- Test: `web/lib/btg-runner.test.ts`

**Interfaces:**
- Consumes: raw JSON keys already present in Go output today — `datacenter` (Hetzner servers), `home_location` (Hetzner floating IPs), `est_monthly_waste_eur` (Hetzner volumes), plus the new `monthly_cost`/`monthly_saving` keys Task 1 added for `idle`. No `location` key exists yet anywhere (Power Platform's is Phase 3, a separate task, not in this plan) — the helper must still accept it for forward compatibility.
- Produces: `NormalizedFinding.location: string`, `NormalizedFinding.monthly_cost: number | null`, `NormalizedFinding.monthly_saving: number | null` — Task 3 (`db.ts`) consumes exactly these three field names on the objects passed into `insertFindings()`.

- [ ] **Step 1: Add vitest as a devDependency**

Run (from `web/`): `npm i -D vitest`

- [ ] **Step 2: Write the failing tests**

Add to `web/lib/btg-runner.test.ts`:

```ts
import { extractLocation, extractMonthlyCost, extractMonthlySaving } from './btg-runner';

describe('extractLocation', () => {
  it('prefers the generic location field', () => {
    expect(extractLocation({ location: 'eastus', datacenter: 'fsn1-dc14' } as any)).toBe('eastus');
  });
  it('falls back to datacenter (Hetzner servers)', () => {
    expect(extractLocation({ datacenter: 'fsn1-dc14' } as any)).toBe('fsn1-dc14');
  });
  it('falls back to home_location (Hetzner floating IPs)', () => {
    expect(extractLocation({ home_location: 'nbg1' } as any)).toBe('nbg1');
  });
  it('returns empty string when nothing is present', () => {
    expect(extractLocation({} as any)).toBe('');
  });
});

describe('extractMonthlyCost', () => {
  it('prefers the generic monthly_cost field', () => {
    expect(extractMonthlyCost({ monthly_cost: 12.5, est_monthly_waste_eur: 4 } as any)).toBe(12.5);
  });
  it('falls back to est_monthly_waste_eur (Hetzner volumes)', () => {
    expect(extractMonthlyCost({ est_monthly_waste_eur: 4 } as any)).toBe(4);
  });
  it('returns null when nothing is present', () => {
    expect(extractMonthlyCost({} as any)).toBeNull();
  });
});

describe('extractMonthlySaving', () => {
  it('returns the monthly_saving field when present', () => {
    expect(extractMonthlySaving({ monthly_saving: 8 } as any)).toBe(8);
  });
  it('returns null when absent', () => {
    expect(extractMonthlySaving({} as any)).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run (from `web/`): `npx vitest run lib/btg-runner.test.ts`
Expected: FAIL — `extractLocation`/`extractMonthlyCost`/`extractMonthlySaving` are not exported (or don't exist).

- [ ] **Step 4: Extend `RawFinding` and add the extraction helpers**

In `web/lib/btg-runner.ts`, add three fields to `RawFinding` (near the top of the interface, alongside `severity?`/`category?`):

```ts
interface RawFinding {
  severity?: string;
  category?: string;
  description?: string;
  recommendation?: string;
  owner?: string;
  location?: string;
  monthly_cost?: number;
  monthly_saving?: number;
  // Azure fields
  account_name?: string;
  resource_name?: string;
  plan_name?: string;
  function_app_name?: string;
  ip_name?: string;
  vault_name?: string;
  nsg_name?: string;
  registry_name?: string;
  group_name?: string;
  resource_group?: string;
  // PP fields
  environment?: string;
  flow_name?: string;
  app_name?: string;
```

(leave everything after `app_name?: string;` unchanged), then add two more fields near the existing Hetzner fields further down (`server_name?`, `volume_name?`, etc. — find that block and add alongside it):

```ts
  datacenter?: string;
  home_location?: string;
  est_monthly_waste_eur?: number;
```

Then add these three exported functions directly after `extractResource()`'s closing brace:

```ts
export function extractLocation(raw: RawFinding): string {
  return raw.location || raw.datacenter || raw.home_location || '';
}

export function extractMonthlyCost(raw: RawFinding): number | null {
  return raw.monthly_cost ?? raw.est_monthly_waste_eur ?? null;
}

export function extractMonthlySaving(raw: RawFinding): number | null {
  return raw.monthly_saving ?? null;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run (from `web/`): `npx vitest run lib/btg-runner.test.ts`
Expected: PASS (all `extractLocation`/`extractMonthlyCost`/`extractMonthlySaving` cases, plus the existing `getPPCredentials` suite still passing)

- [ ] **Step 6: Wire the helpers into `NormalizedFinding` and the mapping**

In `web/lib/btg-runner.ts`, change:

```ts
export interface NormalizedFinding {
  service: string;
  resource: string;
  environment: string;
  severity: string;
  category: string;
  description: string;
  recommendation: string;
  owner: string;
}
```

to:

```ts
export interface NormalizedFinding {
  service: string;
  resource: string;
  environment: string;
  severity: string;
  category: string;
  description: string;
  recommendation: string;
  owner: string;
  location: string;
  monthly_cost: number | null;
  monthly_saving: number | null;
}
```

Then change the mapping inside `runSingleCommand`:

```ts
    findings: parsed.findings.map((f: RawFinding): NormalizedFinding => ({
      service,
      resource: extractResource(f),
      environment: f.environment || '',
      severity: f.severity || 'Info',
      category: f.category || '',
      description: f.description || '',
      recommendation: f.recommendation || '',
      owner: f.owner || '',
    })),
```

to:

```ts
    findings: parsed.findings.map((f: RawFinding): NormalizedFinding => ({
      service,
      resource: extractResource(f),
      environment: f.environment || '',
      severity: f.severity || 'Info',
      category: f.category || '',
      description: f.description || '',
      recommendation: f.recommendation || '',
      owner: f.owner || '',
      location: extractLocation(f),
      monthly_cost: extractMonthlyCost(f),
      monthly_saving: extractMonthlySaving(f),
    })),
```

- [ ] **Step 7: Run the full test file once more**

Run (from `web/`): `npx vitest run lib/btg-runner.test.ts`
Expected: PASS

- [ ] **Step 8: Type-check the whole web app**

Run (from `web/`): `npx tsc --noEmit`
Expected: no new errors (this will surface any other call site assuming `NormalizedFinding`'s old shape — there should be none, since the new fields are additive, but this is the cheapest way to be sure)

- [ ] **Step 9: Commit**

```bash
git add web/lib/btg-runner.ts web/lib/btg-runner.test.ts web/package.json web/package-lock.json
git commit -m "feat(btg-runner): extract location and monthly cost/saving from finding JSON"
```

---

### Task 3: Persist `location`/`monthly_cost`/`monthly_saving` in SQLite

**Files:**
- Modify: `web/lib/db.ts:49-61` (schema), `web/lib/db.ts:140-145` (migrations), `web/lib/db.ts:280-292` (`Finding` interface), `web/lib/db.ts:294-306` (`insertFindings`)
- Test: `web/lib/db.test.ts` (new file)

**Interfaces:**
- Consumes: `NormalizedFinding` objects (Task 2) with `location: string`, `monthly_cost: number | null`, `monthly_saving: number | null` — passed into `insertFindings(auditId, findings)` exactly as today, just with three more fields present.
- Produces: `findings` rows with `location TEXT`, `monthly_cost REAL`, `monthly_saving REAL` columns, readable via the existing `SELECT * FROM findings` used by `/api/findings` and `/api/dashboard` with zero route changes (both already select `*` and cast to `Finding[]`).

- [ ] **Step 1: Write the failing test**

Create `web/lib/db.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';

process.env.DATABASE_PATH = ':memory:';

import { getDB, insertFindings } from './db';

function seedAuditAndSubscription() {
  const db = getDB();
  db.prepare(`
    INSERT INTO subscriptions (id, name, subscription_id, tenant_id, client_id)
    VALUES ('sub-1', 'Test Sub', 'sub-guid', 'tenant-guid', 'client-guid')
  `).run();
  db.prepare(`
    INSERT INTO audits (id, subscription_id, name, status)
    VALUES ('audit-1', 'sub-1', 'Test Audit', 'completed')
  `).run();
}

describe('insertFindings — location and cost columns', () => {
  beforeEach(() => {
    const db = getDB();
    db.exec('DELETE FROM findings');
    db.exec('DELETE FROM audits');
    db.exec('DELETE FROM subscriptions');
    seedAuditAndSubscription();
  });

  it('round-trips location, monthly_cost, and monthly_saving', () => {
    insertFindings('audit-1', [{
      service: 'Idle & Waste',
      resource: 'unused-ip',
      environment: '',
      severity: 'Critical',
      category: 'Zero Usage',
      description: 'Idle for 30 days',
      recommendation: 'Delete it',
      owner: '',
      location: 'eastus',
      monthly_cost: 12.5,
      monthly_saving: 12.5,
    }]);

    const db = getDB();
    const row = db.prepare('SELECT * FROM findings').get() as any;
    expect(row.location).toBe('eastus');
    expect(row.monthly_cost).toBe(12.5);
    expect(row.monthly_saving).toBe(12.5);
  });

  it('defaults location to empty string and cost/saving to null when absent', () => {
    insertFindings('audit-1', [{
      service: 'IAM',
      resource: 'some-role',
      environment: '',
      severity: 'Warning',
      category: 'Overprivileged',
      description: 'desc',
      recommendation: 'rec',
      owner: '',
      location: '',
      monthly_cost: null,
      monthly_saving: null,
    }]);

    const db = getDB();
    const row = db.prepare('SELECT * FROM findings').get() as any;
    expect(row.location).toBe('');
    expect(row.monthly_cost).toBeNull();
    expect(row.monthly_saving).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `web/`): `npx vitest run lib/db.test.ts`
Expected: FAIL — `insertFindings`'s parameter type doesn't have `location`/`monthly_cost`/`monthly_saving` (TS error) or the columns don't exist (SQLite error), depending on which fails first.

- [ ] **Step 3: Add the schema migrations**

In `web/lib/db.ts`, add three lines alongside the existing migrations block:

```ts
  try { db.exec(`ALTER TABLE findings ADD COLUMN remediation_status TEXT DEFAULT 'open'`); } catch {}
  try { db.exec(`ALTER TABLE audits ADD COLUMN resources_scanned INTEGER DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE findings ADD COLUMN owner TEXT DEFAULT ''`); } catch {}
  try { db.exec(`ALTER TABLE audits ADD COLUMN current_step TEXT DEFAULT ''`); } catch {}
  try { db.exec(`ALTER TABLE audits ADD COLUMN total_steps INTEGER DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE audits ADD COLUMN completed_steps INTEGER DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE findings ADD COLUMN location TEXT DEFAULT ''`); } catch {}
  try { db.exec(`ALTER TABLE findings ADD COLUMN monthly_cost REAL DEFAULT NULL`); } catch {}
  try { db.exec(`ALTER TABLE findings ADD COLUMN monthly_saving REAL DEFAULT NULL`); } catch {}
```

- [ ] **Step 4: Extend the `Finding` interface and `insertFindings`**

Change:

```ts
export interface Finding {
  id: string;
  audit_id: string;
  service: string;
  resource: string;
  environment: string;
  severity: string;
  category: string;
  description: string;
  recommendation: string;
  owner: string;
  created_at: string;
}

export function insertFindings(auditId: string, findings: Omit<Finding, 'id' | 'audit_id' | 'created_at'>[]) {
  const db = getDB();
  const stmt = db.prepare(`
    INSERT INTO findings (id, audit_id, service, resource, environment, severity, category, description, recommendation, owner)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.exec('BEGIN');
  try {
    for (const f of findings) {
      stmt.run(uuidv4(), auditId, f.service, f.resource, f.environment, f.severity, f.category, f.description, f.recommendation, f.owner || '');
    }
    db.exec('COMMIT');
```

to:

```ts
export interface Finding {
  id: string;
  audit_id: string;
  service: string;
  resource: string;
  environment: string;
  severity: string;
  category: string;
  description: string;
  recommendation: string;
  owner: string;
  location: string;
  monthly_cost: number | null;
  monthly_saving: number | null;
  created_at: string;
}

export function insertFindings(auditId: string, findings: Omit<Finding, 'id' | 'audit_id' | 'created_at'>[]) {
  const db = getDB();
  const stmt = db.prepare(`
    INSERT INTO findings (id, audit_id, service, resource, environment, severity, category, description, recommendation, owner, location, monthly_cost, monthly_saving)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.exec('BEGIN');
  try {
    for (const f of findings) {
      stmt.run(uuidv4(), auditId, f.service, f.resource, f.environment, f.severity, f.category, f.description, f.recommendation, f.owner || '', f.location || '', f.monthly_cost ?? null, f.monthly_saving ?? null);
    }
    db.exec('COMMIT');
```

- [ ] **Step 5: Run test to verify it passes**

Run (from `web/`): `npx vitest run lib/db.test.ts`
Expected: PASS

- [ ] **Step 6: Run the whole vitest suite and type-check**

Run (from `web/`): `npx vitest run` then `npx tsc --noEmit`
Expected: all PASS / no errors

- [ ] **Step 7: Commit**

```bash
git add web/lib/db.ts web/lib/db.test.ts
git commit -m "feat(db): add location, monthly_cost, monthly_saving columns to findings"
```

---

### Task 4: Manual end-to-end verification

No live Azure or Hetzner credentials are available in this environment, so this task is a manual checklist to run once, in an environment that has them — not an automated test.

**Files:** none (verification only)

- [ ] **Step 1: Rebuild the Go binary**

Run (from repo root): `go build -o btg-devops.exe .` (or `btg-devops` on non-Windows)

- [ ] **Step 2: Run a real Hetzner scan, if `HCLOUD_TOKEN` is set**

Run: `./btg-devops.exe analyze hetzner-servers --output json | head -c 2000`
Expected: at least one finding object contains a non-empty `"datacenter"` key (confirms Task 2/3 will pick it up — this key already existed before this plan, this step just confirms the live shape matches the test's assumptions)

- [ ] **Step 3: Run a real Azure `idle` scan, if Azure credentials are set**

Run: `./btg-devops.exe analyze idle --output json | head -c 2000`
Expected: findings now include `"monthly_cost"` and `"monthly_saving"` keys with numeric values (new — did not exist before Task 1)

- [ ] **Step 4: Run a full audit through the web app and inspect the database directly**

With the Next.js dev server running (`npm run dev` from `web/`) and at least one subscription configured, trigger `POST /api/audits/run` with `commands: ["idle"]` (or `["hetzner-servers"]`), wait for it to complete, then run:

```bash
sqlite3 web/btg-devops.db "SELECT service, resource, location, monthly_cost, monthly_saving FROM findings ORDER BY created_at DESC LIMIT 10"
```

Expected: `idle` rows show non-null `monthly_cost`/`monthly_saving`; `hetzner-servers` rows show non-empty `location`.

- [ ] **Step 5: Confirm the existing dashboard still renders with no errors**

Open `/dashboard` (any `?scope=`) in a browser and confirm the KPI cards, charts, and findings table still render — the new columns are additive and unused by any UI code yet, so this is a pure regression check, not a feature check.
