<#
.SYNOPSIS
    Grants read-only Power Platform / Power BI / Graph access to an existing
    service principal for btg-devops Power Platform analysis.

    Implements docs runbook: docs/pp-access-runbook.md
    - Step 1: Register SP as Power Platform admin management application
    - Step 2: Add SP to the Power BI read-only admin API security group
    - Step 3: Grant Microsoft Graph Organization.Read.All (app role + consent)

.NOTES
    Cross-platform (PowerShell 7 + Azure CLI). The runbook's
    Microsoft.PowerApps.Administration.PowerShell module only supports Windows
    PowerShell 5.x, so step 1 calls the same BAP admin REST API directly.

    Prerequisites:
    - az login as a user who is BOTH a Power Platform Administrator and a
      Privileged Role Administrator (or Global Admin).
    - After running: enable "Allow service principals to use read-only admin
      APIs" in Fabric Admin portal -> Tenant settings -> Admin API settings,
      scoped to the security group (portal only - no API).

.EXAMPLE
    ./grant-pp-access.ps1 -AppId <sp-app-id> -GroupId <security-group-id>
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$AppId,      # app (client) ID of the existing service principal

    [Parameter(Mandatory = $true)]
    [string]$GroupId     # security group scoped to PBI read-only admin APIs
)

$ErrorActionPreference = 'Stop'

function Invoke-Az {
    param([string[]]$Arguments)
    $result = az @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "az $($Arguments -join ' ') failed: $result"
    }
    return $result
}

Write-Host "==> Verifying az session..." -ForegroundColor Cyan
$account = Invoke-Az @('account', 'show', '--output', 'json') | ConvertFrom-Json
$tenantId = $account.tenantId
Write-Host "    Signed in as $($account.user.name) (tenant $tenantId)"

Write-Host "==> Resolving service principal $AppId..." -ForegroundColor Cyan
$sp = Invoke-Az @('ad', 'sp', 'show', '--id', $AppId, '--output', 'json') | ConvertFrom-Json
Write-Host "    $($sp.displayName) (object id $($sp.id))"

# ---------------------------------------------------------------------------
# Step 1: Power Platform - register as admin management application.
# Same call New-PowerAppManagementApp makes. Requires Power Platform admin.
# ---------------------------------------------------------------------------
Write-Host "==> Step 1: Registering SP as Power Platform management app..." -ForegroundColor Cyan
$bapUrl = "https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/adminApplications/$($AppId)?api-version=2020-06-01"
Invoke-Az @('rest', '--method', 'put', '--url', $bapUrl,
    '--resource', 'https://service.powerapps.com/', '--output', 'none')
Write-Host "    Registered (idempotent - safe to re-run)."

# ---------------------------------------------------------------------------
# Step 2: Power BI - add SP to the read-only admin API security group.
# ---------------------------------------------------------------------------
Write-Host "==> Step 2: Adding SP to security group $GroupId..." -ForegroundColor Cyan
$isMember = (Invoke-Az @('ad', 'group', 'member', 'check', '--group', $GroupId,
        '--member-id', $sp.id, '--query', 'value', '--output', 'tsv')) -eq 'true'
if ($isMember) {
    Write-Host "    Already a member - skipping."
}
else {
    Invoke-Az @('ad', 'group', 'member', 'add', '--group', $GroupId, '--member-id', $sp.id)
    Write-Host "    Added."
}

# ---------------------------------------------------------------------------
# Step 3: Microsoft Graph - Organization.Read.All app role with admin consent.
# ---------------------------------------------------------------------------
Write-Host "==> Step 3: Granting Graph Organization.Read.All (app-only)..." -ForegroundColor Cyan
$graphAppId = '00000003-0000-0000-c000-000000000000'
$graphSp = Invoke-Az @('ad', 'sp', 'show', '--id', $graphAppId, '--output', 'json') | ConvertFrom-Json
$role = $graphSp.appRoles | Where-Object { $_.value -eq 'Organization.Read.All' -and $_.allowedMemberTypes -contains 'Application' }
if (-not $role) { throw "Organization.Read.All app role not found on Graph service principal" }

$existing = Invoke-Az @('rest', '--method', 'get',
    '--url', "https://graph.microsoft.com/v1.0/servicePrincipals/$($sp.id)/appRoleAssignments",
    '--output', 'json') | ConvertFrom-Json
if ($existing.value | Where-Object { $_.appRoleId -eq $role.id -and $_.resourceId -eq $graphSp.id }) {
    Write-Host "    Already assigned - skipping."
}
else {
    $body = @{ principalId = $sp.id; resourceId = $graphSp.id; appRoleId = $role.id } | ConvertTo-Json -Compress
    Invoke-Az @('rest', '--method', 'post',
        '--url', "https://graph.microsoft.com/v1.0/servicePrincipals/$($sp.id)/appRoleAssignments",
        '--body', $body, '--headers', 'Content-Type=application/json', '--output', 'none')
    Write-Host "    Assigned and consented."
}

Write-Host ""
Write-Host "Done. Remaining MANUAL step (portal only):" -ForegroundColor Yellow
Write-Host "  Fabric Admin portal -> Tenant settings -> Admin API settings:"
Write-Host "   1. Enable 'Allow service principals to use read-only admin APIs' -> scope to group $GroupId"
Write-Host "   2. (If dataset/refresh detail needed) Enable 'Enhance admin API responses with detailed metadata'"
Write-Host "  Allow ~15 minutes for tenant settings to take effect."
