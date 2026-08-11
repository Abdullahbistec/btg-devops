# 003 — Storage Account Analysis

## Command

```bash
btg-devops analyze storage [--subscription-id ID] [--resource-group RG] [--output table|json]
```

## Description

Analyzes all Azure Storage Accounts in the subscription for security misconfigurations, best practice violations, and optimization opportunities.

## Checks Performed

| # | Check | Severity | Description |
|---|-------|----------|-------------|
| 1 | HTTPS Not Enforced | Critical | Storage account allows non-HTTPS traffic |
| 2 | Blob Public Access Enabled | Critical | Account-level blob public access is enabled |
| 3 | Weak TLS Version | Critical/Warning | Minimum TLS version below 1.2 |
| 4 | Unrestricted Network Access | Warning | Public network access with no firewall rules |
| 5 | Shared Key Access Enabled | Info | Storage account key access is enabled (prefer Azure AD) |
| 6 | No Lifecycle Policy | Warning | No lifecycle management policy for blob tiering/deletion |
| 7 | No Infrastructure Encryption | Info | Double encryption not enabled |

## Output

- **Summary**: Total accounts, breakdown by kind and replication SKU
- **Findings**: Each finding includes severity, category, affected account, resource group, and recommendation
- **Recommendations**: Deduplicated actionable recommendations grouped by severity

## Version

Added in v0.3.0
