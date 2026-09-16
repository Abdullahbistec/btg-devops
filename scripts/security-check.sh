#!/usr/bin/env bash
# Security & quality gates for btg-devops.
# Runs the same checks the security assessment (docs/security-assessment-2026-09.md)
# uses, so the good posture doesn't silently regress. Runnable locally, in a git
# hook, or in CI (.github/workflows/security.yml). Non-zero exit on any failure.
#
# Usage: bash scripts/security-check.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
fail=0
run() { # name, command...
  local name="$1"; shift
  echo "── $name ──────────────────────────────────────────"
  if "$@"; then echo "✓ $name"; else echo "✗ $name FAILED"; fail=1; fi
  echo
}

# ---- Web (Next.js dashboard) ----
if [ -d web ]; then
  run "web: npm ci"                bash -c "cd web && npm ci --no-audit --no-fund"
  run "web: tsc --noEmit"          bash -c "cd web && npx tsc --noEmit"
  run "web: vitest"                bash -c "cd web && npm test"
  run "web: npm audit (high+)"     bash -c "cd web && npm audit --audit-level=high"
fi

# ---- Go (CLI + MCP server) ----
if [ -f go.mod ]; then
  run "go: vet"                    go vet ./...
  run "go: test"                   go test ./...
  if command -v govulncheck >/dev/null 2>&1; then
    run "go: govulncheck"          govulncheck ./...
  else
    run "go: govulncheck (install)" bash -c "go install golang.org/x/vuln/cmd/govulncheck@latest && \"\$(go env GOPATH)/bin/govulncheck\" ./..."
  fi
fi

echo "════════════════════════════════════════════════════"
if [ "$fail" -eq 0 ]; then echo "ALL SECURITY GATES PASSED"; else echo "SECURITY GATES FAILED — see ✗ above"; fi
exit "$fail"
