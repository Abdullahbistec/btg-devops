# BTG DevOps — Web Dashboard

A Next.js 14 web interface for the `btg-devops` CLI tool.  
Displays real Azure & Power Platform security findings in a Power BI-style dark dashboard.

---

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | 18 or later |
| btg-devops CLI | Built in the parent directory |
| Azure credentials | Service principal with Reader role |

---

## Quick Start

### 1 — Install dependencies

```powershell
cd web
npm install
```

### 2 — Configure environment

Copy the example file and fill in your values:

```powershell
copy .env.local.example .env.local
```

Edit `.env.local`:

```
# Path to the btg-devops executable (relative to web/ directory)
BTG_DEVOPS_PATH=../btg-devops.exe

# SQLite database location (created automatically)
DATABASE_PATH=./btg.db

# Azure Service Principal credentials
AZURE_TENANT_ID=your-tenant-id-here
AZURE_CLIENT_ID=your-client-id-here
AZURE_CLIENT_SECRET=your-client-secret-here
AZURE_SUBSCRIPTION_ID=your-subscription-id-here
```

> **Security**: Never commit `.env.local`. The client secret must be rotated if it was ever exposed.

### 3 — Build the CLI (if not already built)

```powershell
cd ..
go build -o btg-devops.exe .
cd web
```

### 4 — Start the development server

```powershell
npm run dev
```

Open **http://localhost:3000** — it redirects to `/dashboard`.

---

## Running an Audit

1. Click **▶ Run New Audit** in the sidebar filter panel, or on the Audits page.
2. The API returns immediately (202 Accepted) — the 17-command scan runs in the background.
3. Refresh the dashboard after ~2–3 minutes to see findings populate.

The background scan runs these btg-devops commands:

| Category | Commands |
|---|---|
| Azure | storage, keyvault, vm, appservice, sql, nsg, rbac, policy, adf, aks, cognitive, resources |
| Power Platform | powerplatform, pp-environments, pp-apps, pp-flows, pp-powerbi |

---

## Project Structure

```
web/
├── app/
│   ├── dashboard/page.tsx    ← Main dashboard with all charts + findings table
│   ├── audits/page.tsx       ← Audit history list with detail panel
│   ├── api/
│   │   ├── subscriptions/    ← GET / POST subscription management
│   │   ├── audits/           ← GET audit list
│   │   ├── audits/run/       ← POST trigger background audit
│   │   ├── findings/         ← GET findings (filter by audit/severity)
│   │   └── dashboard/        ← GET aggregated KPI + chart data
│   ├── globals.css           ← Power BI dark theme CSS variables
│   └── layout.tsx
├── components/
│   ├── Sidebar.tsx           ← Fixed left navigation
│   ├── KPICard.tsx           ← KPI tile with sparkline
│   ├── FilterPanel.tsx       ← Left filter slicer + run button
│   └── RunAuditButton.tsx    ← Standalone run button
├── lib/
│   ├── db.ts                 ← SQLite layer (better-sqlite3)
│   └── btg-runner.ts         ← CLI subprocess runner
├── .env.local.example
└── README.md
```

---

## Production Build

```powershell
npm run build
npm start
```

---

## Troubleshooting

**`btg-devops.exe` not found**  
→ Check `BTG_DEVOPS_PATH` in `.env.local`. Default is `../btg-devops.exe` (one directory up).

**Audit shows 0 findings**  
→ Check that `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` are set correctly.  
→ Run `.\btg-devops.exe analyze storage --output json` from the parent directory to test credentials directly.

**Power Platform commands return empty**  
→ A Global Admin must first run:  
```powershell
New-PowerAppManagementApp -ApplicationId "your-client-id"
```
And assign the **Power Platform Administrator** + **Power BI Administrator** roles to the service principal.

**`better-sqlite3` build error on install**  
→ Run `npm install --ignore-scripts` then `npm rebuild better-sqlite3`.  
→ Requires Python and C++ build tools (`npm install -g windows-build-tools` on Windows).
