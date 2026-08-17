# Ask Gemini for a plan based on this project's context (Azure + Power Platform findings, shared SQLite DB).
# Usage:
#   $env:GEMINI_API_KEY = "your-key"          # get one at https://aistudio.google.com/apikey
#   .\scripts\ask-gemini-plan.ps1 "What should we prioritize next?"

param(
    [Parameter(Mandatory = $true)]
    [string]$Question,

    [string]$Model = "gemini-2.5-flash"
)

if (-not $env:GEMINI_API_KEY) {
    Write-Error "GEMINI_API_KEY is not set. Run: `$env:GEMINI_API_KEY = 'your-key'"
    exit 1
}

$context = @"
Project: btg-devops - a Go CLI + Next.js web dashboard that audits Azure subscriptions
and Power Platform tenants (environments, apps, flows, Power BI) for security,
cost, and governance issues.

Findings from every audit run are stored in a shared SQLite database with this schema:
  subscriptions(id, name, subscription_id, tenant_id, client_id, client_secret, is_active, last_audit_at)
  audits(id, subscription_id, status, started_at, completed_at, total_findings,
         critical_count, warning_count, info_count, commands_run, resources_scanned)
  findings(id, audit_id, service, resource, environment, severity, category,
           description, recommendation, remediation_status)
  schedules(id, name, frequency, hour, enabled, next_run_at, subscription_id)
  users(id, email, name, role, status)

Question: $Question
"@

$body = @{
    contents = @(
        @{
            parts = @(
                @{ text = $context }
            )
        }
    )
} | ConvertTo-Json -Depth 10

$uri = "https://generativelanguage.googleapis.com/v1beta/models/$($Model):generateContent?key=$($env:GEMINI_API_KEY)"

$response = Invoke-RestMethod -Uri $uri -Method Post -ContentType "application/json" -Body $body

$response.candidates[0].content.parts[0].text
