# Feature: App Service Traffic Analysis

**Command:** `btg-devops analyze appservice-traffic`
**Version:** v0.1.0
**Date:** 2026-02-28

## Problem

DevOps teams often lose track of which Azure App Services are actively used. Idle or low-traffic apps continue to incur costs and increase the attack surface unnecessarily.

## Solution

Analyze Azure Monitor network metrics for all App Services in a subscription over the last 14 days to classify usage levels and surface actionable recommendations.

## Metrics Collected

| Metric | Source |
|--------|--------|
| Total Requests | Azure Monitor |
| Bytes Received (RX) | Azure Monitor |
| Bytes Sent (TX) | Azure Monitor |
| HTTP 2xx responses | Azure Monitor |
| HTTP 4xx responses | Azure Monitor |
| HTTP 5xx responses | Azure Monitor |

## Classification

| Status | Criteria | Action |
|--------|----------|--------|
| **Idle/Unused** | Zero requests + zero network traffic in 14 days | Shut down or delete |
| **Low Traffic** | < 1,000 requests in 14 days | Scale down or consolidate |
| **Active** | ≥ 1,000 requests in 14 days | No action needed |

## Additional Checks

- **High 5xx error rate** — Flagged when > 10% of total requests return 5xx

## Usage

```bash
# All App Services in subscription
btg-devops analyze appservice-traffic

# Filter by resource group
btg-devops analyze appservice-traffic --resource-group my-rg

# Override subscription
btg-devops analyze appservice-traffic --subscription-id xxx

# JSON output
btg-devops analyze appservice-traffic --output json
```

## Output

- Table view with per-app metrics and status classification
- Summary counts (Active / Low Traffic / Idle)
- Recommendations for non-active apps

## Azure Permissions Required

- **Reader** role on the subscription (or target resource groups)
- Access to Azure Monitor metrics (included in Reader)

## Dependencies

- `github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/appservice/armappservice/v2`
- `github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/monitor/armmonitor`
