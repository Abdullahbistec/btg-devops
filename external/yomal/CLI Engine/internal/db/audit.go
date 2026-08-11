package db

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// CreateAuditParams holds the fields needed to open a new audit row.
type CreateAuditParams struct {
	SubscriptionID   string
	SubscriptionName string
	TriggerType      string  // "manual" | "scheduled"
	CreatedBy        *string // nil when triggered by scheduled cron (no user session)
}

// CreateAudit inserts a new audit row with status="running" and returns its UUID.
// Call CompleteAudit or FailAudit once data collection finishes.
func CreateAudit(ctx context.Context, pool *pgxpool.Pool, p CreateAuditParams) (string, error) {
	var id string
	err := pool.QueryRow(ctx, `
		INSERT INTO audits (subscription_id, subscription_name, trigger_type, created_by, status)
		VALUES ($1, $2, $3, $4, 'running')
		RETURNING id::text
	`, p.SubscriptionID, p.SubscriptionName, p.TriggerType, p.CreatedBy).Scan(&id)
	if err != nil {
		return "", fmt.Errorf("creating audit: %w", err)
	}
	return id, nil
}

// CompleteAudit updates an audit row to status="completed" and saves the
// collected raw_data, resource_counts, and scope_hashes JSON blobs.
// scopeHashes is one SHA-256 per resource-type scope that collected data
// (extractors.ScopeHash), used by the analyzer to detect which scopes are
// unchanged since the previous audit (spec 14).
func CompleteAudit(ctx context.Context, pool *pgxpool.Pool, auditID string, rawData json.RawMessage, resourceCounts json.RawMessage, scopeHashes json.RawMessage) error {
	tag, err := pool.Exec(ctx, `
		UPDATE audits
		SET status = 'completed', raw_data = $2, resource_counts = $3, scope_hashes = $4, current_step = NULL
		WHERE id = $1
	`, auditID, []byte(rawData), []byte(resourceCounts), []byte(scopeHashes))
	if err != nil {
		return fmt.Errorf("completing audit: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("audit %s not found", auditID)
	}
	return nil
}

// UpdateAuditStep sets a lightweight, human-readable progress string on a
// running audit (e.g. "extracting acr (3/12)") for the dashboard's live
// "Run Audit" view to poll and display. Best-effort by design at the call
// site — a step-update failure should never fail the audit itself.
func UpdateAuditStep(ctx context.Context, pool *pgxpool.Pool, auditID string, step string) error {
	if _, err := pool.Exec(ctx, `UPDATE audits SET current_step = $2 WHERE id = $1`, auditID, step); err != nil {
		return fmt.Errorf("updating audit step: %w", err)
	}
	return nil
}

// SaveCostUsageData saves the Cost and Usage extractor output into their own
// columns, separate from raw_data — so reading cost/usage later never
// requires Postgres to parse the much larger 12-resource-type blob. Either
// argument may be nil if that extractor produced no data or failed.
func SaveCostUsageData(ctx context.Context, pool *pgxpool.Pool, auditID string, costData json.RawMessage, usageData json.RawMessage) error {
	_, err := pool.Exec(ctx, `
		UPDATE audits SET cost_data = $2, usage_data = $3 WHERE id = $1
	`, auditID, []byte(costData), []byte(usageData))
	if err != nil {
		return fmt.Errorf("saving cost/usage data: %w", err)
	}
	return nil
}

// FailAudit updates an audit row to status="failed" and records the error message.
func FailAudit(ctx context.Context, pool *pgxpool.Pool, auditID string, errMsg string) error {
	tag, err := pool.Exec(ctx, `
		UPDATE audits
		SET status = 'failed', error_message = $2, current_step = NULL
		WHERE id = $1
	`, auditID, errMsg)
	if err != nil {
		return fmt.Errorf("failing audit: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("audit %s not found", auditID)
	}
	return nil
}
