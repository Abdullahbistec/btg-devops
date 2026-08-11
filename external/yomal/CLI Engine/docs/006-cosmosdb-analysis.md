# 006 — Cosmos DB Analysis

**Command:** `btg-devops analyze cosmosdb`
**Version:** v0.6.0
**Date:** 2026-03-04

## Purpose

Analyze Azure Cosmos DB accounts for cost optimization, security misconfigurations, and operational best practices.

## Checks Performed

| # | Check | Severity | Description |
|---|-------|----------|-------------|
| 1 | Public Network Access | Warning | Flags accounts with public network access enabled |
| 2 | No IP Firewall Rules | Warning | Flags publicly accessible accounts with no IP restrictions |
| 3 | No Private Endpoint | Warning | Flags accounts without private endpoint connections |
| 4 | Backup Policy | Warning/Info | Checks periodic backup interval/retention, recommends continuous backup |
| 5 | Consistency Level | Info | Flags Strong consistency (highest cost) |
| 6 | Multi-Region Write | Info | Flags multi-region accounts without multi-region writes |
| 7 | Single Region | Info | Flags accounts with no geo-redundancy |
| 8 | Automatic Failover | Warning | Multi-region accounts without automatic failover |
| 9 | Wildcard CORS | Warning | CORS allowing all origins (*) |
| 10 | Key-Based Auth | Info | Flags accounts with key auth enabled (vs RBAC) |
| 11 | Throughput Settings | Info/Warning | Checks manual vs autoscale, high autoscale max RU/s at database and container level |
| 12 | Analytical Store | Info | Flags accounts without analytical storage (Synapse Link) |

## Usage

```bash
# Analyze all Cosmos DB accounts
btg-devops analyze cosmosdb

# Filter by resource group
btg-devops analyze cosmosdb --resource-group my-rg

# JSON output
btg-devops analyze cosmosdb --output json
```

## Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--subscription-id` | Azure Subscription ID | `AZURE_SUBSCRIPTION_ID` env var |
| `--resource-group` | Filter by resource group | (all) |
| `--output` | Output format: `table` or `json` | `table` |
