# BTG DevOps CLI — Usage & Idle Analysis Commands

## Overview

Two new commands were added to the `btg-devops` CLI tool to help DevOps and cloud teams understand **where money is being spent** in an Azure subscription, **whether resources are being used**, and **where costs can be reduced**.

---

## 1. `analyze usage`

### What It Does

Connects to the Azure subscription, finds resources by type or name, fetches **real billing data** from Azure Cost Management API, and produces a detailed drill-down report showing:

- Actual cost for the period
- Cost trend vs previous period
- Utilization metrics from Azure Monitor
- Waste score (HEALTHY / LOW / MEDIUM / HIGH / IDLE)
- Per-sub-resource breakdown (e.g. individual databases inside a CosmosDB account)
- Saving recommendations based on 10+ rules per resource type

---

### Supported Resource Types

| Short Name | Azure Resource Type |
|---|---|
| `cosmosdb` | Microsoft CosmosDB accounts |
| `storage` | Storage accounts |
| `appserviceplan` | App Service Plans |
| `appservice` | Web Apps |
| `functions` | Function Apps |
| `keyvault` | Key Vaults |
| `acr` | Container Registries |
| `publicip` | Public IP Addresses |
| `cognitiveservices` | Cognitive Services / Azure OpenAI |

---

### Usage

```bash
# Drill down into one specific resource by name
btg-devops analyze usage --resource <resource-name> --days 30

# Analyze ALL resources of one type (no need to know account names)
btg-devops analyze usage --type cosmosdb --days 30

# Analyze every supported resource in the subscription
btg-devops analyze usage --all --days 30

# Change the time period
btg-devops analyze usage --type storage --days 7
btg-devops analyze usage --type storage --days 90

# Output as JSON
btg-devops analyze usage --type keyvault --days 30 --output json
```

---

### Sample Output — Single Resource

```
══════════════════════════════════════════════════════════════════════════════════════════
  RESOURCE USAGE DRILL-DOWN
  bisteccareltdqaacc002  |  microsoft.documentdb/databaseaccounts  |  Last 30 days
══════════════════════════════════════════════════════════════════════════════════════════

  🟢  Total Cost:  $22.33 USD    ↓ -6%  (was $23.83 prev period)
  ✓  Waste: HEALTHY   Requests/day: 30.1
       → Activity within expected range
  Period:       2026-05-19 to 2026-06-18

  🟢  BisteccareLtdQADB               $11.17/mo   RU/s: 400   autoscale: false
    → Running at minimum 400 RU/s — consider Cosmos DB Serverless for unpredictable workloads
      Save ~$4/month

  🟢  BisteccareLtdQADB001Test        $11.17/mo   RU/s: 400   autoscale: false
    → Running at minimum 400 RU/s — consider Cosmos DB Serverless for unpredictable workloads
      Save ~$4/month

──────────────────────────────────────────────────────────────────────────────────────────
  Potential Monthly Saving:  ~$34
  Free tier not enabled — first 1000 RU/s and 25 GB storage are free per subscription
══════════════════════════════════════════════════════════════════════════════════════════
```

---

### Output Explained — Section by Section

#### Header
```
bisteccareltdqaacc002  |  microsoft.documentdb/databaseaccounts  |  Last 30 days
```
Shows the **resource name**, **Azure resource type**, and the **analysis period**.

#### Cost + Trend Line
```
🟢  Total Cost:  $22.33 USD    ↓ -6%  (was $23.83 prev period)
```

| Part | Meaning |
|---|---|
| 🟢 | Severity: Green = under $50, Yellow = under $200, Red = $200+ |
| `$22.33 USD` | Real billing cost pulled from Azure Cost Management API |
| `↓ -6%` | Cost decreased 6% compared to the previous 30-day period |
| `(was $23.83 prev period)` | Previous period cost for comparison |

**Trend indicators:**

| Symbol | Meaning |
|---|---|
| `▲ +59%` | Significant spike — increase over 20% |
| `↑ +13%` | Slight increase — 5% to 20% |
| `→ stable` | No significant change — within ±5% |
| `↓ -6%` | Slight decrease — 5% to 20% |
| `▼ -35%` | Significant drop — decrease over 20% |

#### Waste Score Line
```
✓  Waste: HEALTHY   Requests/day: 30.1
     → Activity within expected range
```

| Part | Meaning |
|---|---|
| `✓ HEALTHY` | Resource is being used at a reasonable level relative to cost |
| `Requests/day: 30.1` | Average database requests per day from Azure Monitor |
| `→ Activity within expected range` | Explanation of how the score was determined |

**Waste score levels:**

| Score | Icon | Meaning |
|---|---|---|
| HEALTHY | ✓ | Good utilization relative to cost |
| LOW | ℹ | Some underutilization — worth monitoring |
| MEDIUM | ⚠ | Low activity relative to cost — review capacity |
| HIGH | ⚠⚠ | Severely under-utilized — right-size immediately |
| IDLE | 💤 | Zero activity — still being billed |

#### Sub-Resource Rows
```
🟢  BisteccareLtdQADB    $11.17/mo   RU/s: 400   autoscale: false
  → Running at minimum 400 RU/s — consider Cosmos DB Serverless
    Save ~$4/month
```
Each row is one **individual resource inside the account** (e.g. a database inside a CosmosDB account, a container inside a Storage account). Shows:
- Estimated cost share
- Key configuration properties
- Top recommendation with estimated saving

#### Saving Summary
```
Potential Monthly Saving:  ~$34
Free tier not enabled — first 1000 RU/s and 25 GB storage are free per subscription
```
Total estimated saving if all recommendations are followed.

---

### Sample Output — Type Scan with Summary

```
══════════════════════════════════════════════════════════════════════════════════════════
  SUMMARY — COSMOSDB
  Resources Analyzed       : 5
  Grand Total Cost         : $393.41
  Potential Monthly Saving : ~$257
══════════════════════════════════════════════════════════════════════════════════════════
```

When using `--type` or `--all`, a summary footer is printed at the end showing the total cost and total potential saving across all analyzed resources.

---

### How Recommendations Work

Each resource handler contains **10+ rules** based on Azure best practices. Rules check configuration properties fetched live from Azure and generate specific tips. Examples for CosmosDB:

| Rule | Tip Generated |
|---|---|
| RU/s = 400 and autoscale = false | Consider Serverless for unpredictable workloads |
| autoscale max > 10,000 RU/s | Autoscale ceiling is very high — review to control runaway cost |
| Consistency = Strong | Strong consistency doubles RU consumption — use Session if possible |
| Free tier not enabled | First 1000 RU/s + 25 GB free per subscription — enable if eligible |
| No databases found | Account is empty — delete to eliminate base cost |
| Total cost > $200 | High-cost account — enable autoscale to save ~20% |

---

## 2. `analyze idle`

### What It Does

Scans all supported resource types (or one specific type) and **filters only the resources that are wasting money** — either completely idle with no activity, or severely under-utilized relative to their cost. This gives a focused list of deletion and right-sizing candidates.

---

### Usage

```bash
# Scan ALL resource types for idle and waste
btg-devops analyze idle --days 30

# Scan only one resource type
btg-devops analyze idle --type cosmosdb --days 30
btg-devops analyze idle --type storage --days 30
btg-devops analyze idle --type publicip --days 30

# Output as JSON
btg-devops analyze idle --days 30 --output json
```

---

### Sample Output

```
══════════════════════════════════════════════════════════════════════════════════════════
  IDLE & WASTE RESOURCE SCAN  (5 resources scanned, last 30 days)
══════════════════════════════════════════════════════════════════════════════════════════

  💤  IDLE  —  Zero activity detected (still billed or provisioned)
  ──────────────────────────────────────────────────────────────────────────────────────
  bisteccareltdpreprodacc002     microsoft.documentdb/databaseaccounts    $0.27/mo
      Utilization: Requests/day: 0
      → Zero activity detected but $0.27/month still billed — resource may be unused
      ★ Free tier not enabled — first 1000 RU/s and 25 GB storage are free per subscription

  ⚠⚠  HIGH WASTE  —  Very low utilization relative to cost
  ──────────────────────────────────────────────────────────────────────────────────────
  bisteccareltdprodacc002        microsoft.documentdb/databaseaccounts    $335.61/mo
      Utilization: Requests/day: 65.9
      → Low activity (66/day) at $335.61/month — review whether capacity matches actual demand
      Save ~$134/month

══════════════════════════════════════════════════════════════════════════════════════════
  Idle Resources     : 1    ($0.27/month)
  High Waste         : 1    ($335.61/month)
  Total Wasted Spend : ~$335.88/month
══════════════════════════════════════════════════════════════════════════════════════════
```

---

### Output Explained

#### IDLE Section
```
💤  IDLE  —  Zero activity detected (still billed or provisioned)
```
Resources with **zero requests, zero utilization, but still provisioned and billed**. These are the strongest candidates for deletion.

| Field | Meaning |
|---|---|
| Resource name | The Azure resource name |
| Resource type | ARM resource type |
| `$0.27/mo` | How much it costs per month even with no activity |
| `Requests/day: 0` | Confirmed zero activity from Azure Monitor |
| `→` | Waste reason — why the tool classified it as IDLE |
| `★` | Top cost recommendation from the rule engine |

#### HIGH WASTE Section
```
⚠⚠  HIGH WASTE  —  Very low utilization relative to cost
```
Resources that **are receiving some traffic** but the cost is disproportionately high compared to the activity level.

#### Summary Footer
```
Idle Resources     : 1    ($0.27/month)
High Waste         : 1    ($335.61/month)
Total Wasted Spend : ~$335.88/month
```
Total count and cost of all idle and wasteful resources found in the scan.

---

### Difference Between `analyze usage` and `analyze idle`

| | `analyze usage` | `analyze idle` |
|---|---|---|
| Purpose | Full cost + utilization drill-down for every resource | Show only the wasteful resources |
| Output | Detailed report per resource | Concise list of problem resources only |
| Best used for | Regular cost review, monthly reports | Quick scan to find what to delete or right-size |
| Resources shown | All resources analyzed | Only IDLE and HIGH WASTE resources |

---

## 3. New Features Added to Both Commands

### Waste Score
Every resource now gets a waste score combining **real cost** from Cost Management API and **utilization metrics** from Azure Monitor:

```
✓  Waste: HEALTHY   Requests/day: 30.1
⚠  Waste: MEDIUM    CPU %: 8.3  |  Memory %: 42.1
⚠⚠  Waste: HIGH    RU %: 3.2  |  Requests/day: 65.9
💤  Waste: IDLE     Requests/day: 0
```

**Utilization metrics per resource type:**

| Resource | Metrics Shown |
|---|---|
| CosmosDB | Requests/day |
| Storage | Transactions/day, Used GB |
| App Service Plan | CPU %, Memory % |
| App Service | CPU %, Memory %, Requests/day |
| Function App | Executions/day |
| Key Vault | API Hits/day |
| Container Registry | Storage GB, Pulls/day, Pushes/day |
| Public IP | Packets/day |
| Cognitive Services | API Calls/day, Errors/day |

### Cost Trending
Every resource compares the current period against the previous equivalent period:

```
↑ +13%  (was $296.10 prev period)   ← cost is rising
↓ -6%   (was $23.83 prev period)    ← cost is falling
→ stable  (was $22.10 prev period)  ← no significant change
```

### Rate Limit Handling
Azure Cost Management API has request limits. When the limit is hit, the tool automatically retries with increasing wait times instead of failing:

```
Rate limited (429) — retrying in 2s...
Rate limited (429) — retrying in 4s...
Rate limited (429) — retrying in 8s...
```

---

## Authentication Setup

The tool uses an **Azure Service Principal** — an application identity with read-only access to billing and resource data.

Set these environment variables before running any command:

```powershell
# Windows PowerShell
$env:AZURE_TENANT_ID="<tenant-id>"
$env:AZURE_CLIENT_ID="<client-id>"
$env:AZURE_CLIENT_SECRET="<client-secret>"
$env:AZURE_SUBSCRIPTION_ID="<subscription-id>"
```

```bash
# Linux / macOS
export AZURE_TENANT_ID="<tenant-id>"
export AZURE_CLIENT_ID="<client-id>"
export AZURE_CLIENT_SECRET="<client-secret>"
export AZURE_SUBSCRIPTION_ID="<subscription-id>"
```

The Service Principal requires the **Cost Management Reader** role on the subscription.

---

## Quick Reference

```bash
# Usage analysis
btg-devops analyze usage --resource <name> --days 30
btg-devops analyze usage --type cosmosdb --days 30
btg-devops analyze usage --type storage --days 7
btg-devops analyze usage --all --days 30

# Idle and waste detection
btg-devops analyze idle --days 30
btg-devops analyze idle --type cosmosdb --days 30

# Output formats
btg-devops analyze usage --type keyvault --days 30 --output table
btg-devops analyze usage --type keyvault --days 30 --output json
```
