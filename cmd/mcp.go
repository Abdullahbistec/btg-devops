package cmd

import (
	"context"
	"fmt"
	"os"
	"os/exec"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"github.com/spf13/cobra"
)

var mcpCmd = &cobra.Command{
	Use:   "mcp",
	Short: "Run an MCP server exposing the analyzers as tools for Claude",
	Long: `Starts a Model Context Protocol (MCP) server over stdio, exposing
btg-devops's analyzers as tools so Claude Code (or any MCP client) can run
audits and query findings directly in conversation, instead of running
'analyze' by hand and pasting output into a chat session.

Requires the same Azure credentials as running the CLI directly:
AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_SUBSCRIPTION_ID.`,
	RunE: runMCP,
}

func init() {
	rootCmd.AddCommand(mcpCmd)
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

	return server.ServeStdio(s)
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
