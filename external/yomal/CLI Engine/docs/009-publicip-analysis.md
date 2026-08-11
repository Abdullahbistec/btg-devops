# 009 — Public IP Address Analysis

## Command

```bash
btg-devops analyze publicip [--subscription-id ID] [--resource-group RG] [--output table|json]
```

## Purpose

Identifies unused/unattached Public IP addresses that cost money without providing value, along with SKU and configuration best practices.

## Checks Performed

| # | Check | Severity | Description |
|---|-------|----------|-------------|
| 1 | Unattached PIP (Standard) | Critical | Standard SKU PIPs cost ~$3.65/mo even when unattached |
| 2 | Unattached PIP (Basic) | Warning | Basic PIPs not associated with any resource |
| 3 | Basic SKU | Warning | Basic SKU retiring Sept 2025; migrate to Standard |
| 4 | Dynamic allocation on Standard | Info | Standard PIPs typically use Static allocation |
| 5 | No DDoS protection settings | Info | Internet-facing resources should consider DDoS protection |
| 6 | No availability zones (Standard) | Info | Zone-redundant PIPs provide higher availability |

## Output

### Summary
- Total Public IPs count
- Unattached PIPs count
- Estimated monthly waste (USD) for unattached Standard PIPs
- Breakdown by SKU and allocation method
- Findings by severity

### Findings Table
Each finding includes: severity, category, PIP name, resource group, IP address, SKU, description, and recommendation.

## Version

Added in v0.9.0.
