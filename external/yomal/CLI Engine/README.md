# btg-devops

A DevOps CLI tool that uses an Azure Service Principal to examine Azure subscriptions and provide insights on anomalies, cost savings, misconfigurations, and best practices.

## Features

- **App Service Traffic Analysis** — Analyzes Azure App Service network traffic over the last 14 days to identify idle/unused apps, helping reduce costs.
- **IAM Role Assignment Analysis** — Examines RBAC role assignments for overprivileged, orphaned, duplicate, and misconfigured assignments.
- **Storage Account Analysis** — Checks Storage Accounts for public access, HTTPS enforcement, lifecycle policies, TLS version, network rules, and encryption settings.
- **NSG Analysis** — Analyzes Network Security Groups for overly permissive rules, open management ports (RDP/SSH/SQL) to the internet, and unassociated NSGs.
- **Container Registry (ACR) Analysis** — Checks Container Registries for admin account usage, public access, missing private endpoints, retention policies, encryption, and SKU recommendations.
- **Cosmos DB Analysis** — Analyzes Cosmos DB accounts for throughput optimization (manual vs autoscale), backup policies, network security, consistency settings, and multi-region configuration.
- **Key Vault Analysis** — Checks Key Vaults for access model (RBAC vs access policies), soft-delete, purge protection, network access, expired/expiring secrets and keys, and permission hygiene.
- **Azure Functions Analysis** — Analyzes Function Apps for runtime version currency, always-on configuration, HTTPS enforcement, managed identity, TLS settings, remote debugging, and plan optimization.
- **Public IP Address Analysis** — Identifies unused/unattached Public IPs wasting money, Basic SKU deprecation, DDoS protection gaps, and zone redundancy recommendations.
- **App Service Plan Analysis** — Detects empty plans wasting money, over-provisioned workers based on CPU/memory metrics, SKU right-sizing opportunities, and autoscale recommendations.
- **Azure AI / Cognitive Services Analysis** — Checks Cognitive Services and Azure OpenAI accounts for network security, managed identity, unused deployments, model version currency, provisioned capacity waste, and encryption configuration.
- **Resource Group Analysis** — Detects empty resource groups, tag compliance violations (environment, owner, project), naming convention issues, and missing management locks on critical groups.

## Prerequisites

- Go 1.21+
- Azure Service Principal with **Reader** role on the target subscription

## Installation

Download the latest binary from [Releases](https://github.com/chanbistec/btg-devops/releases).

| Platform | Binary |
|----------|--------|
| macOS (Apple Silicon) | `btg-devops-darwin-arm64` |
| macOS (Intel) | `btg-devops-darwin-amd64` |
| Windows (x64) | `btg-devops-windows-amd64.exe` |
| Windows (ARM) | `btg-devops-windows-arm64.exe` |
| Linux (x64) | `btg-devops-linux-amd64` |
| Linux (ARM) | `btg-devops-linux-arm64` |

### macOS Note

The binaries are not signed with an Apple Developer certificate. After downloading:

```bash
# Remove quarantine flag
xattr -d com.apple.quarantine btg-devops-darwin-arm64
chmod +x btg-devops-darwin-arm64
```

Or right-click the file in Finder → Open → click "Open" on the Gatekeeper prompt.

## Setup

### 1. Set environment variables

```bash
export AZURE_TENANT_ID="your-tenant-id"
export AZURE_CLIENT_ID="your-client-id"
export AZURE_CLIENT_SECRET="your-client-secret"
export AZURE_SUBSCRIPTION_ID="your-subscription-id"
```

### 2. Build

```bash
go build -o btg-devops .
```

## Usage

### Analyze App Service Traffic

```bash
# Analyze all App Services in the subscription
btg-devops analyze appservice-traffic

# Filter by resource group
btg-devops analyze appservice-traffic --resource-group my-rg

# Override subscription ID
btg-devops analyze appservice-traffic --subscription-id xxx

# JSON output
btg-devops analyze appservice-traffic --output json
```

### Analyze Storage Accounts

```bash
# Analyze all Storage Accounts
btg-devops analyze storage

# Filter by resource group
btg-devops analyze storage --resource-group my-rg

# JSON output
btg-devops analyze storage --output json
```

### Analyze Network Security Groups

```bash
# Analyze all NSGs
btg-devops analyze nsg

# Filter by resource group
btg-devops analyze nsg --resource-group my-rg

# JSON output
btg-devops analyze nsg --output json
```

### Analyze Container Registries (ACR)

```bash
# Analyze all container registries
btg-devops analyze acr

# Filter by resource group
btg-devops analyze acr --resource-group my-rg

# JSON output
btg-devops analyze acr --output json
```

### Analyze Cosmos DB

```bash
# Analyze all Cosmos DB accounts
btg-devops analyze cosmosdb

# Filter by resource group
btg-devops analyze cosmosdb --resource-group my-rg

# JSON output
btg-devops analyze cosmosdb --output json
```

### Analyze Key Vaults

```bash
# Analyze all Key Vaults
btg-devops analyze keyvault

# Filter by resource group
btg-devops analyze keyvault --resource-group my-rg

# JSON output
btg-devops analyze keyvault --output json
```

### Analyze Azure Functions

```bash
# Analyze all Function Apps
btg-devops analyze functions

# Filter by resource group
btg-devops analyze functions --resource-group my-rg

# JSON output
btg-devops analyze functions --output json
```

### Analyze Public IP Addresses

```bash
# Analyze all Public IPs
btg-devops analyze publicip

# Filter by resource group
btg-devops analyze publicip --resource-group my-rg

# JSON output
btg-devops analyze publicip --output json
```

### Analyze App Service Plans

```bash
# Analyze all App Service Plans
btg-devops analyze appserviceplan

# Filter by resource group
btg-devops analyze appserviceplan --resource-group my-rg

# JSON output
btg-devops analyze appserviceplan --output json
```

### Analyze Azure AI / Cognitive Services

```bash
# Analyze all Cognitive Services accounts
btg-devops analyze cognitiveservices

# Filter by resource group
btg-devops analyze cognitiveservices --resource-group my-rg

# JSON output
btg-devops analyze cognitiveservices --output json
```

### Analyze Resource Groups

```bash
# Analyze all Resource Groups
btg-devops analyze resourcegroup

# Override subscription ID
btg-devops analyze resourcegroup --subscription-id xxx

# JSON output
btg-devops analyze resourcegroup --output json
```

### Output (App Service Traffic)

The tool classifies each App Service as:

| Status | Criteria | Recommendation |
|--------|----------|----------------|
| **Idle/Unused** | Zero requests and zero network traffic | Shut down or delete |
| **Low Traffic** | < 1,000 requests in 14 days | Scale down or consolidate |
| **Active** | ≥ 1,000 requests | Normal operation |

It also flags apps with high 5xx error rates (>10%).

## License

MIT
