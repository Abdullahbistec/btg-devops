package db

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// CacheStalenessCeiling forces a real re-analysis of a scope after this many
// CONSECUTIVE cache hits (spec 14 A5) — protects against a hashing bug (or
// future data normalization) silently pinning stale findings forever, and
// lets playbook/checklist improvements eventually reach unchanged resources
// too. Keep in sync with the dashboard's CACHE_STALENESS_CEILING
// (dashboard/app/api/models/analysisRequests.ts) — both sides must agree so
// a scope doesn't cache-hit indefinitely on one path while capped on the
// other.
const CacheStalenessCeiling = 7

// ScopeToQueue is one resource-type scope (or "cost"/"usage:<type>") queued
// for analysis, along with whether its config hash matched a prior analyzed
// audit's hash for the same scope (spec 14 — per-scope analysis cache).
type ScopeToQueue struct {
	Scope    string
	CacheHit bool
}

// QueueAnalysisRequests inserts one pending analysis_requests row per scope
// in scopes, recording each one's CacheHit flag. Called after a successful
// audit so the scheduled MCP-server analyzer (spec 8) picks up every
// resource type automatically — without this, analysis only ever happens if
// a human clicks "Analyze" in the dashboard, which defeats the point of a
// scheduled, unattended audit.
func QueueAnalysisRequests(ctx context.Context, pool *pgxpool.Pool, auditID string, scopes []ScopeToQueue) error {
	for _, s := range scopes {
		if _, err := pool.Exec(ctx, `
			INSERT INTO analysis_requests (audit_id, scope, cache_hit)
			VALUES ($1, $2, $3)
		`, auditID, s.Scope, s.CacheHit); err != nil {
			return fmt.Errorf("queuing analysis request for scope %q: %w", s.Scope, err)
		}
	}
	return nil
}

// PreviousAnalyzedScopeHash returns the scope_hashes[scope] value from the
// most recent PRIOR audit of the same subscription that has a 'done'
// analysis_requests row for this exact scope — i.e. the last audit whose
// analysis of this scope actually completed, not just any audit that
// happened to collect data for it. Returns ("", false, nil) if no such
// audit exists (e.g. this is the subscription's first audit, or this scope
// has never finished analysis before).
func PreviousAnalyzedScopeHash(ctx context.Context, pool *pgxpool.Pool, subscriptionID, currentAuditID, scope string) (string, bool, error) {
	var hash *string
	err := pool.QueryRow(ctx, `
		SELECT prev.scope_hashes ->> $3 AS prev_hash
		FROM audits prev
		WHERE prev.subscription_id = $1
		  AND prev.id != $2
		  AND prev.created_at < (SELECT created_at FROM audits WHERE id = $2)
		  AND EXISTS (
		    SELECT 1 FROM analysis_requests ar
		    WHERE ar.audit_id = prev.id AND ar.scope = $3 AND ar.status = 'done'
		  )
		ORDER BY prev.created_at DESC
		LIMIT 1
	`, subscriptionID, currentAuditID, scope).Scan(&hash)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", false, nil
		}
		return "", false, fmt.Errorf("looking up previous analyzed hash for scope %q: %w", scope, err)
	}
	if hash == nil {
		return "", false, nil
	}
	return *hash, true, nil
}

// TrailingCacheHitStreak counts how many of the most recent PRIOR audits of
// this subscription (going backward from currentAuditID) have a cache_hit=
// true analysis_requests row for this exact scope, stopping at the first
// audit whose request for this scope was a real (non-cached) analysis, or
// once it reaches CacheStalenessCeiling (no need to count further — the
// caller only cares whether the streak has already hit the ceiling).
func TrailingCacheHitStreak(ctx context.Context, pool *pgxpool.Pool, subscriptionID, currentAuditID, scope string) (int, error) {
	rows, err := pool.Query(ctx, `
		SELECT ar.cache_hit
		FROM analysis_requests ar
		JOIN audits a ON a.id = ar.audit_id
		WHERE a.subscription_id = $1
		  AND a.created_at < (SELECT created_at FROM audits WHERE id = $2)
		  AND ar.scope = $3
		ORDER BY a.created_at DESC
		LIMIT $4
	`, subscriptionID, currentAuditID, scope, CacheStalenessCeiling)
	if err != nil {
		return 0, fmt.Errorf("counting trailing cache-hit streak for scope %q: %w", scope, err)
	}
	defer rows.Close()

	streak := 0
	for rows.Next() {
		var hit bool
		if err := rows.Scan(&hit); err != nil {
			return 0, fmt.Errorf("scanning cache-hit streak row for scope %q: %w", scope, err)
		}
		if !hit {
			break
		}
		streak++
	}
	return streak, rows.Err()
}
