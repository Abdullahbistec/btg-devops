# 007 — Key Vault Analysis

**Command:** `btg-devops analyze keyvault`
**Version:** v0.7.0

## Purpose

Analyze Azure Key Vaults for security misconfigurations, expired/expiring secrets and keys, access model issues, and best practices.

## Checks Performed

| # | Check | Severity | Description |
|---|-------|----------|-------------|
| 1 | RBAC vs Access Policies | Warning | Flags vaults using legacy access policies instead of Azure RBAC |
| 2 | Soft-Delete Disabled | Critical | Detects vaults with soft-delete disabled |
| 3 | No Purge Protection | Warning | Flags vaults without purge protection enabled |
| 4 | Unrestricted Network Access | Warning | Public network access with no firewall rules |
| 5 | Overly Broad Permissions | Warning | Access policies granting 'All' key or secret permissions |
| 6 | Expired Keys | Critical | Keys past their expiration date |
| 7 | Keys Expiring Soon | Warning | Keys expiring within 30 days |
| 8 | Expired Secrets | Critical | Secrets past their expiration date |
| 9 | Secrets Expiring Soon | Warning | Secrets expiring within 30 days |
| 10 | No Private Endpoints | Info | No private endpoint connections configured |
| 11 | Short Retention Period | Info | Soft-delete retention less than 90 days |

## Usage

```bash
# Analyze all Key Vaults
btg-devops analyze keyvault

# Filter by resource group
btg-devops analyze keyvault --resource-group my-rg

# JSON output
btg-devops analyze keyvault --output json
```

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--subscription-id` | `$AZURE_SUBSCRIPTION_ID` | Azure Subscription ID |
| `--resource-group` | (all) | Filter by resource group |
| `--output` | `table` | Output format: `table` or `json` |
