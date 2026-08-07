# Unified Analyzer Interface — Design

Date: 2026-08-06
Branch: abd-production

## Context

An earlier proposal suggested merging a separate "Yomal Azure" project and a
"Power Platform" project into one Go CLI with a shared `Collector` interface
and a shared SQLite database written directly by the CLI.

Investigation of the actual repository (branches `main`, `production`,
`abd-production`, `feature/btg-power-platform`) showed most of that proposal
is already true:

- There is a single active Go module (root `go.mod` + root `cmd/`). The
  `CLI Engine/` directory some diffs surfaced is a stale, pre-restructure copy
  that exists only on a colleague's fork remote (`yomal/main`,
  `yomal/production`) and is not part of the live code.
- `cmd/analyze_all.go` already runs every Azure and Power Platform analyzer
  together (`--scope all|azure|pp`) and merges their output into one
  `UnifiedFinding` shape.
- The shared database already exists, but only on the Next.js side
  (`web/lib/db.ts`, using Node's built-in `node:sqlite`, `journal_mode=WAL`
  already set). The Go CLI is stateless — it prints JSON; it never touches
  SQLite.

What is genuinely missing, and what this spec covers, is a **formal shared
Analyzer interface** on the Go side. Two things currently do the same job of
"guess which JSON field is the resource name" independently and
inconsistently:

1. `cmd/analyze_all.go`'s `extractFindings()` + `resourceFields` — a
   string-based heuristic used only by the `analyze all` CLI command.
2. `web/lib/btg-runner.ts`'s `extractResource()` — a **separate**
   TypeScript heuristic with its own field list, used by the dashboard's real
   audit-run path (`runSingleCommand`/`runAllCommands`), which does not go
   through `analyze all` at all — it shells out to each command individually.

There is also a third, unused artifact: `PPAnalyzer` / `PPBaseFinding`
(`cmd/pp_helpers.go`) — an interface documented as "the interface all Power
Platform analysis commands implement" that in fact no command implements
(confirmed by grep: no type anywhere satisfies it).

One concrete bug results from heuristic #1: `PPEnvFinding`'s JSON key is
`environment`, which is not in `resourceFields`' priority list, so every
`pp-environments` finding in `analyze all --output json` has an empty
`Resource` field today.

## Goals

- Replace the dead `PPAnalyzer` and the ad hoc `resourceFields` heuristic with
  one real `Analyzer` interface implemented by all 18 existing commands (13
  Azure + 5 Power Platform).
- Make `analyze all` call analyzers in-process instead of re-executing the
  binary as a subprocess once per command.
- Fix the `pp-environments` empty-`Resource` bug at the source by having every
  command emit a canonical `resource` JSON field, so a future pass can
  simplify `web/lib/btg-runner.ts`'s `extractResource()` to `raw.resource`.

## Non-goals

- No change to the Go CLI's relationship with SQLite — it stays stateless.
  (The doc's `pkg/db` idea is explicitly out of scope for this pass.)
- No change to `web/lib/btg-runner.ts` itself. It keeps working unchanged
  because existing domain-specific JSON fields (`account_name`, `environment`,
  `flow_name`, etc.) are not renamed or removed — `resource` is additive.
- No change to any individual command's standalone CLI output (table or JSON)
  — `btg-devops analyze storage`, `btg-devops analyze pp-environments`, etc.
  keep their existing rich, domain-specific `Report`/table shape.
- No shared credential/auth abstraction. Each analyzer keeps acquiring its own
  credential/token exactly as its `runXxx` does today — introducing a shared
  auth session type is not needed to formalize the interface and would be
  scope creep.
- No change to the `CLI Engine/` directory on `yomal`'s fork — it is not part
  of the active module and is not touched by this work.

## Design

### 1. The `Analyzer` interface and self-registration

New file `cmd/analyzer.go`:

```go
type Analyzer interface {
    Name() string
    Run(ctx context.Context) ([]UnifiedFinding, error)
}

var azureAnalyzers []Analyzer
var ppAnalyzers []Analyzer

func registerAzureAnalyzer(a Analyzer) { azureAnalyzers = append(azureAnalyzers, a) }
func registerPPAnalyzer(a Analyzer)    { ppAnalyzers = append(ppAnalyzers, a) }
```

`cmd/pp_helpers.go`'s unused `PPAnalyzer` and `PPBaseFinding` are deleted.

Each of the 18 command files gets one line added to its existing `init()`
(which already registers the cobra command), e.g. `cmd/storage.go`:

```go
func init() {
    analyzeCmd.AddCommand(storageCmd)
    storageCmd.Flags().StringVar(&flagSubscriptionID, "subscription-id", "", "...")
    storageCmd.Flags().StringVar(&flagResourceGroup, "resource-group", "", "...")
    storageCmd.Flags().StringVar(&flagOutput, "output", "table", "...")
    registerAzureAnalyzer(storageAnalyzer{})   // NEW
}
```

No manual slice-of-18 to maintain — each file stays self-contained, matching
the existing convention where every command already self-registers with
`analyzeCmd` in its own `init()`.

### 2. Splitting fetch/analyze from output, per command

Each `runXxx` cobra function currently does auth → fetch → analyze → print, in
one function, using package-level flag variables. To let `analyze all` call
the same analysis logic in-process without printing that command's own table,
each of the 18 files splits into:

- `computeXxxFindings(ctx, <same auth args runXxx already builds>) (XxxReport, error)`
  — the existing fetch+analyze body, verbatim, just returning the report
  instead of falling through into the `switch flagOutput` print block.
- `runXxx` — unchanged behavior: builds auth args, calls
  `computeXxxFindings`, then prints table/JSON exactly as today.
- A small adapter implementing `Analyzer`, e.g. in `cmd/storage.go`:

  ```go
  type storageAnalyzer struct{}

  func (storageAnalyzer) Name() string { return "storage" }

  func (storageAnalyzer) Run(ctx context.Context) ([]UnifiedFinding, error) {
      subID := getSubscriptionID()
      if subID == "" {
          return nil, fmt.Errorf("subscription ID required: set AZURE_SUBSCRIPTION_ID env var")
      }
      cred, err := azidentity.NewDefaultAzureCredential(nil)
      if err != nil {
          return nil, fmt.Errorf("azure auth failed: %w", err)
      }
      report, err := computeStorageFindings(ctx, cred, subID)
      if err != nil {
          return nil, err
      }
      out := make([]UnifiedFinding, len(report.Findings))
      for i, f := range report.Findings {
          out[i] = UnifiedFinding{
              Service:        "Storage",
              Severity:       string(f.Severity),
              Category:       f.Category,
              Resource:       f.Resource,
              Description:    f.Description,
              Recommendation: f.Recommendation,
          }
      }
      return out, nil
  }
  ```

This is applied identically across all 13 Azure commands (`acr`,
`appservice-traffic`, `appserviceplan`, `cognitiveservices`, `cosmosdb`,
`functions`, `iam`, `keyvault`, `nsg`, `publicip`, `resourcegroup`,
`sp-expiry`, `storage`) and all 5 Power Platform commands (`powerplatform`,
`pp-environments`, `pp-apps`, `pp-flows`, `pp-powerbi`), registering Azure
ones with `registerAzureAnalyzer` and PP ones with `registerPPAnalyzer`.

### 3. `analyze_all.go` rewiring

`runAnalyzeAll` drops `os/exec` and `os.Executable()` and calls analyzers
in-process:

```go
func runAnalyzeAll(cmd *cobra.Command, args []string) error {
    ctx := context.Background()

    var selected []Analyzer
    switch flagAllScope {
    case "azure":
        selected = azureAnalyzers
    case "pp":
        selected = ppAnalyzers
    default:
        selected = append(append([]Analyzer{}, azureAnalyzers...), ppAnalyzers...)
    }

    // ...summary/startedAt setup unchanged...

    for _, a := range selected {
        fmt.Fprintf(os.Stderr, "  ▶ analyze %s\n", a.Name())
        findings, err := runAnalyzerSafely(ctx, a)
        if err != nil {
            msg := fmt.Sprintf("analyze %s: %v", a.Name(), err)
            fmt.Fprintf(os.Stderr, "    ✗ %s\n", msg)
            errors = append(errors, msg)
            summary.CommandsFailed++
            continue
        }
        summary.CommandsRun++
        allFindings = append(allFindings, findings...)
    }

    // ...rest (severity/service tallying, table/json output, --fail-on-critical) unchanged...
}
```

`runAnalyzerSafely` preserves the fault isolation the current
subprocess-per-command model gives for free — one analyzer panicking must not
abort the whole `analyze all` run:

```go
func runAnalyzerSafely(ctx context.Context, a Analyzer) (findings []UnifiedFinding, err error) {
    defer func() {
        if r := recover(); r != nil {
            err = fmt.Errorf("panic: %v", r)
        }
    }()
    return a.Run(ctx)
}
```

`extractFindings`, `resourceFields`, and `strField` are deleted — no longer
needed, since `Run()` returns `UnifiedFinding` directly with `Resource`
already correctly populated by each adapter.

Net effect: `analyze all` runs in a single process (no 18x binary re-exec, no
JSON round-trip through stdout), and the `pp-environments` empty-`Resource`
bug is fixed as a side effect.

### 4. The additive `resource` JSON field

Every per-command `Finding` struct (`StorageFinding`, `PPEnvFinding`, the bare
`Finding` in `cmd/iam.go`, and the other 15) gains one new field, set
alongside the existing domain-specific field at every construction site.
Nothing existing is renamed or removed. Example, `cmd/storage.go`:

```go
type StorageFinding struct {
    Severity       Severity `json:"severity"`
    Category       string   `json:"category"`
    Resource       string   `json:"resource"`         // NEW — mirrors StorageAccount
    StorageAccount string   `json:"storage_account"`
    ResourceGroup  string   `json:"resource_group"`
    Description    string   `json:"description"`
    Recommendation string   `json:"recommendation"`
}
```

and at each finding literal, `Resource: name` is added alongside the existing
`StorageAccount: name`. Because this is purely additive, `web/lib/btg-runner.ts`
requires no change and keeps working exactly as it does today — the only
effect is that its own `extractResource()` heuristic could, in a future pass,
be simplified to read `raw.resource` directly instead of guessing across 15
possible field names.

### 5. Testing

`cmd/pp_test.go` currently covers only pure helper functions (`ppDaysSince`,
`isPowerPlatformSKU`, `isManagedEnvironment`, DLP helpers) — no test mocks the
Azure/Graph/Power Platform HTTP calls, and this design doesn't change that.
New tests added in this pass, matching that existing style (pure-logic units,
no live API calls):

- A test-only stub `Analyzer` (declared inline in the test file) whose `Run`
  panics, asserting `runAnalyzerSafely` converts the panic to an `error`
  rather than crashing the test process.
- Scope selection: registering stub analyzers via
  `registerAzureAnalyzer`/`registerPPAnalyzer` and asserting `--scope
  azure|pp|all` selects the expected sets.
- Per-command conversion: for a representative sample (at least
  `storageAnalyzer`, `iam`'s analyzer, and `pp-environments`'s analyzer),
  feed a known domain `Finding` value through the adapter's conversion logic
  and assert the resulting `UnifiedFinding.Resource` is non-empty and correct
  — this is the regression test for the bug this design fixes.

No changes are needed to any Next.js/dashboard test, since `btg-runner.ts`'s
contract is unchanged.
