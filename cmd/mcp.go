package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"github.com/spf13/cobra"
)

var (
	flagMCPHTTP      bool
	flagMCPAddr      string
	flagMCPBearer    string
	flagDashboardURL string
	flagMCPInternal  string
)

var mcpCmd = &cobra.Command{
	Use:   "mcp",
	Short: "Run an MCP server exposing the analyzers as tools for Claude",
	Long: `Starts a Model Context Protocol (MCP) server exposing btg-devops's
analyzers as tools so Claude Code (or any MCP client) can run audits and
query findings directly in conversation, instead of running 'analyze' by
hand and pasting output into a chat session.

By default this serves over stdio, for a local MCP client on the same
machine. Pass --http to serve over Streamable HTTP instead — this is what a
scheduled Claude Code cloud routine needs, since it can't spawn a local
stdio subprocess. In --http mode, three additional tools
(list_pending_requests, get_audit_data, save_analysis) are exposed, backing
the dashboard's async AI-analysis feature: see
docs/ai-analysis-routine-setup.md for how to point a routine at this server.

Requires the same Azure credentials as running the CLI directly:
AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_SUBSCRIPTION_ID.`,
	RunE: runMCP,
}

func init() {
	rootCmd.AddCommand(mcpCmd)
	mcpCmd.Flags().BoolVar(&flagMCPHTTP, "http", false, "Serve over Streamable HTTP instead of stdio")
	mcpCmd.Flags().StringVar(&flagMCPAddr, "addr", ":8090", "Listen address in --http mode")
	mcpCmd.Flags().StringVar(&flagMCPBearer, "bearer-token", "", "Bearer token remote callers must present (overrides MCP_BEARER_TOKEN env var)")
	mcpCmd.Flags().StringVar(&flagDashboardURL, "dashboard-url", "", "Base URL of the web dashboard (overrides DASHBOARD_BASE_URL env var)")
	mcpCmd.Flags().StringVar(&flagMCPInternal, "internal-token", "", "Token used to call the dashboard's internal API (overrides MCP_INTERNAL_TOKEN env var)")
}

func getMCPBearerToken() string {
	if flagMCPBearer != "" {
		return flagMCPBearer
	}
	return os.Getenv("MCP_BEARER_TOKEN")
}

func getDashboardURL() string {
	if flagDashboardURL != "" {
		return flagDashboardURL
	}
	if v := os.Getenv("DASHBOARD_BASE_URL"); v != "" {
		return v
	}
	return "http://localhost:3000"
}

func getMCPInternalToken() string {
	if flagMCPInternal != "" {
		return flagMCPInternal
	}
	return os.Getenv("MCP_INTERNAL_TOKEN")
}

// mcpServiceCatalogue is the single source of truth for the run_service_analysis
// enum — deriving it from analyze_all.go's command lists means a newly added
// analyzer is automatically exposed here too.
func mcpServiceCatalogue() []string {
	return append(append([]string{}, allAzureCmds...), allPPCmds...)
}

func buildRunAuditTool() mcp.Tool {
	return mcp.NewTool("run_audit",
		mcp.WithDescription("Run all analyzers (or a scoped subset) and return a unified findings report across Azure and Power Platform services. Use this for cross-service triage — e.g. 'walk the subscription and tell me the top risks'."),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithDestructiveHintAnnotation(false),
		mcp.WithString("scope",
			mcp.Description("Which analyzers to run: 'all' (everything), 'azure' (Azure services only), or 'pp' (Power Platform only)"),
			mcp.Enum("all", "azure", "pp"),
			mcp.DefaultString("all"),
		),
	)
}

func buildRunServiceAnalysisTool() mcp.Tool {
	return mcp.NewTool("run_service_analysis",
		mcp.WithDescription("Run one specific analyzer and return its full native findings report — richer per-service detail than run_audit. Use this to drill into a service run_audit flagged as risky."),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithDestructiveHintAnnotation(false),
		mcp.WithString("service",
			mcp.Description("Which analyzer to run"),
			mcp.Enum(mcpServiceCatalogue()...),
			mcp.Required(),
		),
	)
}

func runMCP(cmd *cobra.Command, args []string) error {
	s := server.NewMCPServer("btg-devops", "1.0.0")

	s.AddTool(buildRunAuditTool(), runAuditHandler)
	s.AddTool(buildRunServiceAnalysisTool(), runServiceAnalysisHandler)

	if !flagMCPHTTP {
		return server.ServeStdio(s)
	}

	if getMCPBearerToken() == "" {
		return fmt.Errorf("--http requires a bearer token: set --bearer-token or MCP_BEARER_TOKEN env var")
	}

	// The three tools below back the dashboard's async AI-analysis feature —
	// only meaningful in --http mode, since only a remote (not local-stdio)
	// caller like a scheduled Claude Code routine needs them.
	s.AddTool(buildListPendingRequestsTool(), listPendingRequestsHandler)
	s.AddTool(buildGetAuditDataTool(), getAuditDataHandler)
	s.AddTool(buildSaveAnalysisTool(), saveAnalysisHandler)

	httpServer := server.NewStreamableHTTPServer(s)
	mux := http.NewServeMux()
	mux.Handle("/mcp", requireBearerToken(httpServer, getMCPBearerToken()))

	fmt.Fprintf(os.Stderr, "MCP server listening on %s (endpoint: /mcp)\n", flagMCPAddr)
	return http.ListenAndServe(flagMCPAddr, mux)
}

// requireBearerToken rejects any request whose Authorization header doesn't
// present the expected token — this is the first hop's auth (Claude's cloud
// routine -> this server); the second hop's auth (this server -> the
// dashboard's internal API) is a separate secret, MCP_INTERNAL_TOKEN.
func requireBearerToken(next http.Handler, expected string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if auth != "Bearer "+expected {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ---------- async AI-analysis tools (--http mode only) ----------

func buildListPendingRequestsTool() mcp.Tool {
	return mcp.NewTool("list_pending_requests",
		mcp.WithDescription("List pending AI-analysis requests waiting to be reasoned over. Call this first on each polling pass."),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithDestructiveHintAnnotation(false),
	)
}

func buildGetAuditDataTool() mcp.Tool {
	return mcp.NewTool("get_audit_data",
		mcp.WithDescription("Fetch the findings context for one pending analysis request, to reason over before calling save_analysis."),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithDestructiveHintAnnotation(false),
		mcp.WithString("request_id",
			mcp.Description("The id of a pending request, from list_pending_requests"),
			mcp.Required(),
		),
	)
}

func buildSaveAnalysisTool() mcp.Tool {
	return mcp.NewTool("save_analysis",
		mcp.WithDescription("Write the finished analysis back for one request, marking it done (or failed). Call exactly once per request."),
		mcp.WithDestructiveHintAnnotation(false),
		mcp.WithString("request_id",
			mcp.Description("The id of the request being completed"),
			mcp.Required(),
		),
		mcp.WithString("summary",
			mcp.Description("The finished executive risk summary. Omit and set 'error' instead if analysis could not be completed."),
		),
		mcp.WithString("error",
			mcp.Description("If analysis failed, why — omit 'summary' in that case."),
		),
	)
}

func listPendingRequestsHandler(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	body, err := callDashboardInternalAPI(ctx, http.MethodGet, "/api/internal/analysis-requests/pending", nil)
	if err != nil {
		return mcp.NewToolResultErrorFromErr("list_pending_requests failed", err), nil
	}
	return mcp.NewToolResultText(string(body)), nil
}

func getAuditDataHandler(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	requestID, err := request.RequireString("request_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	body, err := callDashboardInternalAPI(ctx, http.MethodGet, "/api/internal/analysis-requests/"+requestID+"/context", nil)
	if err != nil {
		return mcp.NewToolResultErrorFromErr("get_audit_data failed", err), nil
	}
	return mcp.NewToolResultText(string(body)), nil
}

func saveAnalysisHandler(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	requestID, err := request.RequireString("request_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	payload, err := json.Marshal(map[string]string{
		"summary": request.GetString("summary", ""),
		"error":   request.GetString("error", ""),
	})
	if err != nil {
		return mcp.NewToolResultErrorFromErr("save_analysis failed", err), nil
	}
	body, err := callDashboardInternalAPI(ctx, http.MethodPost, "/api/internal/analysis-requests/"+requestID+"/complete", payload)
	if err != nil {
		return mcp.NewToolResultErrorFromErr("save_analysis failed", err), nil
	}
	return mcp.NewToolResultText(string(body)), nil
}

var mcpInternalHTTPClient = &http.Client{Timeout: 30 * time.Second}

// callDashboardInternalAPI is a thin wrapper over the dashboard's own
// /api/internal/* routes — the actual DB access (findings, audits,
// analysis_requests) stays entirely in web/lib/db.ts; this server never
// opens the SQLite file itself, avoiding a second writer on the same
// WAL-mode database from a different process and language.
func callDashboardInternalAPI(ctx context.Context, method, path string, body []byte) ([]byte, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, getDashboardURL()+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+getMCPInternalToken())
	req.Header.Set("Content-Type", "application/json")

	resp, err := mcpInternalHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("dashboard API %s %s returned %d: %s", method, path, resp.StatusCode, string(respBody))
	}
	return respBody, nil
}

func runAuditHandler(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	scope := request.GetString("scope", "all")
	out, err := runAnalyzeSubprocess("analyze", "all", "--scope", scope, "--output", "json")
	if err != nil {
		return mcp.NewToolResultErrorFromErr("run_audit failed", err), nil
	}
	return mcp.NewToolResultText(out), nil
}

func runServiceAnalysisHandler(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	service, err := request.RequireString("service")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	out, err := runAnalyzeSubprocess("analyze", service, "--output", "json")
	if err != nil {
		return mcp.NewToolResultErrorFromErr(fmt.Sprintf("run_service_analysis(%s) failed", service), err), nil
	}
	return mcp.NewToolResultText(out), nil
}

// runAnalyzeSubprocess shells out to this same binary, mirroring the pattern
// analyze_all.go already uses — analyzer internals stay untouched.
func runAnalyzeSubprocess(args ...string) (string, error) {
	binary, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("could not determine binary path: %w", err)
	}
	out, err := exec.Command(binary, args...).Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok && len(exitErr.Stderr) > 0 {
			return "", fmt.Errorf("%w: %s", err, string(exitErr.Stderr))
		}
		return "", err
	}
	return string(out), nil
}
