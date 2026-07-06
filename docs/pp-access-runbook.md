# Power Platform Analysis Access — Service Principal Runbook

**Tool:** `btg-devops` (Power Platform analysis feature)
**Access type:** Read-only analysis / reporting only — no create, update, or delete
**Decision:** Grant required read-only permissions to the **existing service principal** rather than assigning Power Platform Administrator / Power BI Administrator roles to a user account. Lower risk, auditable, revocable.

---

## Commands the tool runs (read-only)

```
.\btg-devops.exe analyze pp-environments
.\btg-devops.exe analyze pp-apps
.\btg-devops.exe analyze pp-flows
.\btg-devops.exe analyze pp-powerbi
.\btg-devops.exe analyze powerplatform
```

---

## Values to plug in

```powershell
$tenantId = "<TENANT_ID>"
$appId    = "<EXISTING_SP_APP_ID>"          # app (client) ID of the existing service principal
$groupId  = "<POWERBI_READONLY_GROUP_ID>"   # security group used for read-only PBI admin APIs
```

---

## 1. Power Platform — environments, apps, flows

Register the existing SP as a Power Platform admin management application.
One-time setup; must be run by a tenant admin (a service principal can't self-register).

```powershell
Install-Module Microsoft.PowerApps.Administration.PowerShell -Scope CurrentUser
Add-PowerAppsAccount -Endpoint prod -TenantID $tenantId      # sign in as a Power Platform admin
New-PowerAppManagementApp -ApplicationId $appId
```

**Note:** This gives the SP admin-equivalent Power Platform access (it can't be scoped narrower). Acceptable here because the tool only reads — worth noting in the audit log.

---

## 2. Power BI / Fabric — workspaces, datasets, reports, refresh health

Add the SP to the security group, then enable the tenant setting for that group.

```powershell
Connect-MgGraph -Scopes "Group.ReadWrite.All","Application.Read.All"
$sp = Get-MgServicePrincipal -Filter "appId eq '$appId'"
New-MgGroupMember -GroupId $groupId -DirectoryObjectId $sp.Id
```

Then, in the **Fabric / Power BI Admin portal → Tenant settings → Admin API settings** (portal only — no clean API):

- Enable **"Allow service principals to use read-only admin APIs"** → scoped to the group above.
- If dataset / refresh detail is needed: also enable **"Enhance admin API responses with detailed metadata."**

No Azure RBAC delegation required — access flows entirely from the tenant setting, and is strictly read-only. Allow ~15 minutes for the setting to take effect.

---

## 3. Microsoft Graph — `Organization.Read.All`

Grant as an application permission (app-only) with tenant-wide admin consent. Run as a Privileged Role Administrator.

```powershell
Connect-MgGraph -Scopes "Application.ReadWrite.All","AppRoleAssignment.ReadWrite.All"

$graphAppId = "00000003-0000-0000-c000-000000000000"   # Microsoft Graph (well-known appId)
$graphSp = Get-MgServicePrincipal -Filter "appId eq '$graphAppId'"
$role    = $graphSp.AppRoles | Where-Object { $_.Value -eq "Organization.Read.All" -and $_.AllowedMemberTypes -contains "Application" }
$sp      = Get-MgServicePrincipal -Filter "appId eq '$appId'"

New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -PrincipalId $sp.Id -ResourceId $graphSp.Id -AppRoleId $role.Id
```

This grants and consents the permission in one step.

---

## Confirmations needed before IT runs this

- `btg-devops.exe` authenticates via **client credentials** (client ID + secret/certificate + tenant ID) against this SP — not interactive-only sign-in.
- Whether **detailed Power BI metadata** is required, or just workspace-level status, so step 2 is scoped correctly.

---

## Revocation

- **Power BI:** remove the SP from the security group, or remove the group from the tenant setting.
- **Graph:** delete the `Organization.Read.All` app role assignment.
- **Power Platform:** `Remove-PowerAppManagementApp -ApplicationId $appId`.
