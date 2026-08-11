# Feature: IAM Role Assignment Analysis

**Command:** `btg-devops analyze iam`
**Version:** v0.2.0
**Date:** 2026-02-28

## Problem

Azure subscriptions accumulate RBAC role assignments over time. Orphaned assignments, overprivileged principals, and direct user assignments create security risks and compliance gaps that are tedious to audit manually.

## Solution

Scan all RBAC role assignments across the subscription, cross-reference with role definitions, and surface misalignments, security risks, and best practice violations.

## Checks Performed

### Critical
| Check | Description |
|-------|-------------|
| **Overprivileged — Subscription Owner** | Users/SPs with Owner role at subscription scope |
| **Too many Owners** | More than 3 Owner assignments at subscription level |
| **SP with Owner/Contributor** | Service Principals with elevated roles at subscription scope |

### Warning
| Check | Description |
|-------|-------------|
| **Orphaned assignments** | Role assignments where the principal no longer exists (deleted users/groups/SPs) |
| **Direct user assignments** | Users assigned roles directly instead of via security groups |
| **Duplicate assignments** | Same principal with same role at same scope |
| **Classic admin roles** | Legacy Co-Administrator or Service Administrator still in use |
| **Overly broad custom roles** | Custom role definitions with wildcard (`*`) actions |

### Info
| Check | Description |
|-------|-------------|
| **Assignment summary** | Breakdown by role, scope level, and principal type |
| **Custom roles inventory** | List of all custom role definitions in the subscription |

## Best Practices Enforced

- Use **groups** for role assignments, not individual users
- Limit **Owner** assignments at subscription scope (≤ 3)
- Avoid **Service Principal** Owner/Contributor at subscription scope
- Clean up **orphaned** assignments (deleted principals)
- Prefer **built-in roles** over custom roles where possible
- Avoid **wildcard actions** in custom role definitions

## Usage

```bash
# Analyze all IAM assignments
btg-devops analyze iam

# Filter by resource group
btg-devops analyze iam --resource-group my-rg

# JSON output
btg-devops analyze iam --output json
```

## Output

- Role assignment inventory with principal type, role, and scope
- Findings categorized as Critical / Warning / Info
- Actionable recommendations per finding
- Summary statistics

## Azure Permissions Required

- **Reader** role on the subscription
- Read access to role assignments and role definitions (included in Reader)

## Dependencies

- `github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/authorization/armauthorization/v2`
