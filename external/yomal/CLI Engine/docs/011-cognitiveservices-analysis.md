# 011 — Azure AI / Cognitive Services Analysis

## Command

```bash
btg-devops analyze cognitiveservices
```

## Version

v0.11.0

## Description

Analyzes all Azure Cognitive Services and Azure AI accounts across the subscription for security misconfigurations, unused resources, and best practices.

## Checks Performed

| # | Check | Severity | Description |
|---|-------|----------|-------------|
| 1 | Public Network Access | Warning | Flags accounts with public network access enabled |
| 2 | No Private Endpoint | Warning | Flags accounts without private endpoint connections |
| 3 | No Managed Identity | Warning | Flags accounts without system/user-assigned managed identity |
| 4 | No Customer-Managed Key | Info | Flags accounts using platform-managed encryption keys |
| 5 | No Network Rules | Warning | Flags accounts with no network ACL rules configured |
| 6 | Permissive Network Default | Warning | Flags accounts with default action set to Allow |
| 7 | Outbound Access Not Restricted | Info | Flags accounts where outbound network access is unrestricted |
| 8 | Local Auth Enabled | Info | Flags accounts where key-based authentication is still enabled |
| 9 | No Deployments (OpenAI/AIServices) | Warning | Flags OpenAI accounts with zero model deployments (potentially unused) |
| 10 | Model Version Currency | Info | Lists model deployments with versions for review |
| 11 | Provisioned Capacity | Warning | Flags deployments using provisioned (PTU) capacity — verify utilization |
| 12 | Provisioning Issue | Critical | Flags accounts with non-Succeeded provisioning state |
| 13 | Free Tier | Info | Flags accounts on F0 (free) tier — not production-ready |

## Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--subscription-id` | Azure Subscription ID | `AZURE_SUBSCRIPTION_ID` env var |
| `--resource-group` | Filter by resource group | (all) |
| `--output` | Output format: `table` or `json` | `table` |

## Example

```bash
# Analyze all Cognitive Services accounts
btg-devops analyze cognitiveservices

# JSON output
btg-devops analyze cognitiveservices --output json

# Filter by resource group
btg-devops analyze cognitiveservices --resource-group my-ai-rg
```
