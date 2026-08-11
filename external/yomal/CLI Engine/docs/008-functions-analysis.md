# 008 — Azure Functions Analysis

## Command

```bash
btg-devops analyze functions [--subscription-id ID] [--resource-group RG] [--output table|json]
```

## Version

v0.8.0

## Purpose

Analyze Azure Function Apps for runtime version currency, configuration best practices, security settings, and plan optimization.

## Checks Performed

| # | Check | Severity | Description |
|---|-------|----------|-------------|
| 1 | Functions Extension Version | Critical/Warning | Flags outdated runtime versions (~1, ~2, ~3); recommends ~4 |
| 2 | Runtime Version Currency | Info | Compares language runtime version against current recommendations |
| 3 | HTTPS Enforcement | Warning | Flags Function Apps not enforcing HTTPS-only |
| 4 | Managed Identity | Warning | Flags apps without system-assigned or user-assigned managed identity |
| 5 | Always-On (Dedicated Plans) | Warning | Flags dedicated/premium plans without Always-On enabled |
| 6 | Consumption Plan Cold Starts | Info | Notes apps on Consumption plan subject to cold starts |
| 7 | Premium Without VNET | Info | Notes Premium plan apps not using VNET integration |
| 8 | Minimum TLS Version | Warning | Flags TLS versions below 1.2 |
| 9 | App State | Info | Flags Function Apps not in Running state |
| 10 | Remote Debugging | Critical | Flags remote debugging enabled in production |
| 11 | FTP State | Warning | Flags plain FTP allowed (should be FTPS-only or disabled) |

## Current Recommended Runtimes

| Language | Version |
|----------|---------|
| .NET | v8.0 |
| Node.js | ~20 |
| Python | 3.11 |
| Java | 17 |
| PowerShell | 7.4 |

## Output

### Table (default)
Summary with counts by runtime, SKU, and OS, followed by findings table and recommendations.

### JSON
Structured report with `summary` and `findings` arrays.
