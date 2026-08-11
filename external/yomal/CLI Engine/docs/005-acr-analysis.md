# 005 — Container Registry (ACR) Analysis

## Command

```bash
btg-devops analyze acr
```

## Version

v0.5.0

## Description

Analyzes all Azure Container Registries in the subscription for security misconfigurations, missing best practices, and cost optimization opportunities.

## Checks Performed

| # | Check | Severity | Description |
|---|-------|----------|-------------|
| 1 | Admin Account Enabled | Critical | Admin user allows username/password auth — use service principals or managed identities instead |
| 2 | Public Network Access | Warning | Registry accessible from the internet |
| 3 | No Private Endpoint | Warning | No private endpoint connections configured |
| 4 | Retention Policy Disabled | Warning | Untagged manifests accumulate indefinitely (Premium only) |
| 5 | No Customer-Managed Key | Info | Using platform-managed encryption key (Premium only) |
| 6 | Content Trust Disabled | Info | Image signing not enabled (Premium only) |
| 7 | Export Policy Enabled | Info | Images can be exported out of the registry (Premium only) |
| 8 | Basic SKU | Info | Limited storage, throughput, no geo-replication or private endpoints |
| 9 | No Zone Redundancy | Info | Zone redundancy not enabled (Premium only) |
| 10 | No Geo-Replication | Info | Single region only (Premium only) |

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--subscription-id` | `$AZURE_SUBSCRIPTION_ID` | Azure Subscription ID |
| `--resource-group` | _(all)_ | Filter by resource group |
| `--output` | `table` | Output format: `table` or `json` |

## Usage

```bash
# Analyze all container registries
btg-devops analyze acr

# Filter by resource group
btg-devops analyze acr --resource-group my-rg

# JSON output
btg-devops analyze acr --output json
```
