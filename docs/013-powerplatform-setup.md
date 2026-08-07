# PP-1 — Power Platform Service Principal Setup

## Overview

The Power Platform commands (`pp-environments`, `pp-apps`, `pp-flows`, `pp-powerbi`, `powerplatform`) authenticate using a service principal with tenant-wide read access to Power Platform admin APIs. This setup **must be performed once by a Global Admin or Power Platform Admin**.

---

## Step 1 — App Registration in Entra ID

If you don't already have a service principal:

1. Go to [portal.azure.com](https://portal.azure.com) → **Microsoft Entra ID** → **App registrations** → **New registration**
2. Name: `btg-devops` (or your preferred name)
3. Supported account types: **Single tenant**
4. Click **Register**
5. Copy:
   - **Application (client) ID** → `AZURE_CLIENT_ID`
   - **Directory (tenant) ID** → `AZURE_TENANT_ID`
6. Go to **Certificates & secrets** → **New client secret** → set expiry → copy value → `AZURE_CLIENT_SECRET`

---

## Step 2 — Register as a Power Platform Management App

This is the critical step. Without it, the service principal cannot enumerate apps, flows, or environments across the tenant via admin APIs.

Run the following PowerShell **as a Global Admin or Power Platform Admin**:

```powershell
# Install the module (one-time)
Install-Module -Name Microsoft.PowerApps.Administration.PowerShell -Force -AllowClobber
Install-Module -Name Microsoft.PowerApps.PowerShell -Force -AllowClobber

# Authenticate as an admin
Add-PowerAppsAccount

# Register the service principal as a management app
# Replace <AZURE_CLIENT_ID> with your app's client ID
New-PowerAppManagementApp -ApplicationId "<AZURE_CLIENT_ID>"
```

**What this does:** Grants the service principal the `PowerApps.Read.All` and `Flow.Read.All` permissions at the tenant level, allowing it to enumerate resources across all environments without being explicitly added to each one.

---

## Step 3 — Assign Entra ID Admin Roles

In [admin.microsoft.com](https://admin.microsoft.com) → **Roles** → **Role assignments**:

| Role | Required for |
|---|---|
| **Power Platform Administrator** | `pp-environments`, `pp-apps`, `pp-flows` |
| **Power BI Administrator** | `pp-powerbi` |

---

## Step 4 — Grant Microsoft Graph API Permission

For the `powerplatform` licensing command:

1. In Entra ID → Your app registration → **API permissions** → **Add a permission**
2. Select **Microsoft Graph** → **Application permissions**
3. Add: `Organization.Read.All`
4. Click **Grant admin consent for [tenant]**

---

## Step 5 — Set Environment Variables

```powershell
# Windows PowerShell
$env:AZURE_TENANT_ID     = "<your-tenant-id>"
$env:AZURE_CLIENT_ID     = "<your-client-id>"
$env:AZURE_CLIENT_SECRET = "<your-client-secret>"
$env:AZURE_SUBSCRIPTION_ID = "<your-subscription-id>"  # for Azure commands only
```

```bash
# bash / Linux / macOS
export AZURE_TENANT_ID="<your-tenant-id>"
export AZURE_CLIENT_ID="<your-client-id>"
export AZURE_CLIENT_SECRET="<your-client-secret>"
export AZURE_SUBSCRIPTION_ID="<your-subscription-id>"
```

---

## Token Scopes Reference

| Command | OAuth Scope | API Endpoint |
|---|---|---|
| `pp-environments` | `https://service.powerapps.com/.default` | `api.bap.microsoft.com` |
| `pp-apps` | `https://service.powerapps.com/.default` | `api.powerapps.com` |
| `pp-flows` | `https://service.flow.microsoft.com/.default` | `api.flow.microsoft.com` |
| `pp-powerbi` | `https://analysis.windows.net/powerbi/api/.default` | `api.powerbi.com` |
| `powerplatform` | `https://graph.microsoft.com/.default` | `graph.microsoft.com` |

---

## Verify Setup

```powershell
# Test that authentication and permissions work
.\btg-devops.exe analyze pp-environments
```

Expected output: list of environments with DLP findings. If you see `403 Forbidden`, the `New-PowerAppManagementApp` step has not been completed by an admin.

---

## Security Notes

- Store credentials in a secrets manager (Azure Key Vault, GitHub Secrets) — never in source code or `.env` files committed to git
- The `.env` file is in `.gitignore` — verify before committing
- Rotate the client secret annually (or immediately if exposed)
- The service principal only needs **Reader** level access — do not grant Owner or Contributor roles
