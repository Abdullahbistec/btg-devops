# 004 — Network Security Group (NSG) Analysis

**Command:** `btg-devops analyze nsg`
**Version:** v0.4.0

## Overview

Analyzes all Network Security Groups in the subscription for overly permissive rules, open management ports, and unassociated NSGs.

## Checks Performed

| Check | Severity | Description |
|-------|----------|-------------|
| Any-Any Allow Rule | Critical | Inbound rule allows all traffic from any source on all ports |
| Management Port Open to Internet | Critical | Dangerous ports (SSH, RDP, SQL, etc.) exposed to 0.0.0.0/0 or Internet |
| Internet-Facing Rule | Warning | Non-management ports open to the internet |
| Unassociated NSG | Warning | NSG not attached to any subnet or NIC |

### Dangerous Ports Tracked

| Port | Service |
|------|---------|
| 22 | SSH |
| 3389 | RDP |
| 445 | SMB |
| 1433 | SQL Server |
| 3306 | MySQL |
| 5432 | PostgreSQL |
| 27017 | MongoDB |
| 6379 | Redis |

## Usage

```bash
btg-devops analyze nsg
btg-devops analyze nsg --resource-group my-rg
btg-devops analyze nsg --output json
```

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--subscription-id` | `$AZURE_SUBSCRIPTION_ID` | Target subscription |
| `--resource-group` | (all) | Filter by resource group |
| `--output` | `table` | Output format: `table` or `json` |
