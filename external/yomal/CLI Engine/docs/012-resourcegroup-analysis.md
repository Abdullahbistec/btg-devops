# 012 — Resource Group Analysis

## Command

```bash
btg-devops analyze resourcegroup [--subscription-id ID] [--output table|json]
```

## Checks Performed

| # | Check | Severity | Description |
|---|-------|----------|-------------|
| 1 | Empty Resource Groups | Warning | Groups with zero resources — clutter and governance noise |
| 2 | Tag Compliance | Critical/Warning | Missing required tags (environment, owner, project); Critical if no tags at all |
| 3 | Naming Convention | Info | Names not matching lowercase-alphanumeric-with-hyphens pattern |
| 4 | Management Locks | Info | Non-empty resource groups without CanNotDelete or ReadOnly locks |

## Required Tags

The following tags are checked for compliance:
- `environment` — dev, staging, production, etc.
- `owner` — team or individual responsible
- `project` — associated project or workload

## Naming Convention

Expected pattern: `^[a-z][a-z0-9-]*[a-z0-9]$`

Recommended format: `rg-<project>-<env>-<region>`

## Output

- Summary: total RGs, empty count, tag violations, lock gaps, naming issues
- Findings table with severity, category, resource group, location, description
- Deduplicated recommendations

## Version

Added in v0.12.0
