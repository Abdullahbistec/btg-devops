# Contributing to btg-devops

This guide helps you set up, build, test, and contribute to this project.
Follow each section in order if you are setting up for the first time.

---

## 1. Prerequisites

Make sure you have the following installed before you start.

| Requirement | Version | Notes |
|---|---|---|
| Go | 1.23.6 | https://go.dev/dl |
| golangci-lint | latest | See install command below |
| Git | any | https://git-scm.com |
| Azure credentials | — | See Section 2 |

**Install golangci-lint:**
```bash
go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
```

**Akzure credentials required — 4 environment variables:**

| Variable | Description |
|---|---|
| `AZURE_TENANT_ID` | Your Azure Active Directory tenant ID |
| `AZURE_CLIENT_ID` | The client ID of your Service Principal |
| `AZURE_CLIENT_SECRET` | The client secret of your Service Principal |
| `AZURE_SUBSCRIPTION_ID` | The Azure subscription you want to analyze |

> The Service Principal needs at least **Reader** role on the target subscription.

---

## 2. Clone and Setup

**Clone the repository:**
```bash
git clone https://github.com/chanbistec/btg-devops.git
cd btg-devops
```

**Set Azure environment variables:**

Windows CMD:
```cmd
set AZURE_TENANT_ID=your-tenant-id
set AZURE_CLIENT_ID=your-client-id
set AZURE_CLIENT_SECRET=your-client-secret
set AZURE_SUBSCRIPTION_ID=your-subscription-id
```

Mac/Linux:
```bash
export AZURE_TENANT_ID=your-tenant-id
export AZURE_CLIENT_ID=your-client-id
export AZURE_CLIENT_SECRET=your-client-secret
export AZURE_SUBSCRIPTION_ID=your-subscription-id
```

---

## 3. Build

**Windows:**
```cmd
go build -o btg-devops.exe .
```

**Mac/Linux:**
```bash
go build -o btg-devops .
```

**Verify the build compiles without errors:**
```bash
go build ./...
```

---

## 4. Test

**Run all tests:**
```bash
go test ./...
```

**Run all tests with verbose output:**
```bash
go test ./... -v
```

**Run a single test file:**
```bash
go test ./tests/security_analyzers/iam_test.go -v
```

---

## 5. Lint

**Check for lint issues:**
```bash
golangci-lint run ./...
```

**Auto-fix issues where possible:**
```bash
golangci-lint run --fix
```

> If no output appears, your code is clean.

---

## 6. PR Checklist

Complete all of these before opening a Pull Request:

- [ ] Code compiles without errors → `go build ./...`
- [ ] All tests pass → `go test ./...`
- [ ] No lint issues → `golangci-lint run ./...`
- [ ] `CHANGELOG.md` updated → add an entry under the next version
- [ ] No Azure credentials in code → check for hardcoded secrets
- [ ] PR has a label → `feature` / `bugfix` / `chore` / `docs` / `ci`

---

## 7. Release Process

**Tag and push a new release:**
```bash
git tag v0.x.0
git push origin v0.x.0
```

Pushing a tag automatically triggers `release.yml` which builds and publishes
cross-platform binaries for macOS, Linux, and Windows (amd64 and arm64).

The draft release notes are prepared automatically by Release Drafter
from the labels on merged PRs.
