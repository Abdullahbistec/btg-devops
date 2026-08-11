# 010 — App Service Plan Analysis

**Command:** `btg-devops analyze appserviceplan`
**Version:** v0.10.0

## Overview

Analyzes Azure App Service Plans for cost optimization opportunities including empty plans, over-provisioned instances, and SKU right-sizing.

## Checks Performed

| # | Check | Severity | Description |
|---|-------|----------|-------------|
| 1 | Empty Plans | Critical | Plans with zero apps deployed (wasting money) |
| 2 | Over-Provisioned Workers | Warning | Multiple workers with low CPU (<20%) and memory (<30%) over 7 days |
| 3 | Premium/Isolated with Few Apps | Info | High-tier SKUs hosting only 1-2 apps |
| 4 | Free/Shared Tier in Use | Warning | No SLA guarantee for production workloads |
| 5 | High Fixed Worker Count | Info | 4+ workers without autoscale |

## Metrics

- **CPU Percentage** — 7-day average hourly CPU utilization
- **Memory Percentage** — 7-day average hourly memory utilization

## Cost Estimation

Empty plans are flagged with estimated monthly waste based on SKU pricing and worker count.

## Usage

```bash
btg-devops analyze appserviceplan
btg-devops analyze appserviceplan --resource-group my-rg
btg-devops analyze appserviceplan --output json
```

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--subscription-id` | `$AZURE_SUBSCRIPTION_ID` | Azure Subscription ID |
| `--resource-group` | (all) | Filter by resource group |
| `--output` | `table` | Output format: `table` or `json` |
