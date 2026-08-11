# Email Alerts — Secrets Checklist

Required for the audit-failed email alerts (`CLI Engine/internal/mailer`).

**Never commit real values to this file or any file in the repo.** This is a
checklist template only — fill in actual secrets directly in GitHub Actions
(Settings → Secrets and variables → Actions) or your local shell, never here.

| Secret name          | What it is                                             | Example format         | Status |
|-----------------------|---------------------------------------------------------|-------------------------|--------|
| `GMAIL_USER`           | The sender Gmail address (dedicated alerts account)     | `btgdevops.alerts@gmail.com` | [ ] |
| `GMAIL_APP_PASSWORD`   | 16-char App Password for that account (not the login password) | `abcd efgh ijkl mnop`  | [ ] |
| `ALERT_EMAIL_TO`       | The address that receives alert emails                  | `you@example.com`       | [ ] |

## Setup steps (recap)

1. Create/use a dedicated Gmail account for `GMAIL_USER`.
2. Enable 2-Step Verification on that account: myaccount.google.com → Security → 2-Step Verification.
3. Generate an App Password: myaccount.google.com/apppasswords → name it `btg-devops alerts` → Create → copy the 16-char value immediately (shown once).
4. Add all three as GitHub repo secrets: repo → Settings → Secrets and variables → Actions → New repository secret.
5. For local testing, export them as env vars in your shell instead of hardcoding anywhere:
   ```
   export GMAIL_USER="..."
   export GMAIL_APP_PASSWORD="..."
   export ALERT_EMAIL_TO="..."
   ```

## If a value is ever exposed accidentally

Revoke it immediately at myaccount.google.com/apppasswords (delete the app password) and generate a new one — then update the GitHub secret with the new value.
