package db

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

type SubscriptionCredentials struct {
	SubscriptionID   string
	TenantID         string
	ClientID         string
	ClientSecretEnc  string
	SubscriptionName string
}

// FindSubscriptionCredentials looks up a subscription by its Azure subscription ID
// and returns the encrypted credentials. Returns nil if not found or inactive.
func FindSubscriptionCredentials(ctx context.Context, pool *pgxpool.Pool, subscriptionID string) (*SubscriptionCredentials, error) {
	row := pool.QueryRow(ctx,
		`SELECT subscription_id, tenant_id, client_id, client_secret_enc, name
		 FROM subscriptions
		 WHERE subscription_id = $1 AND is_active = TRUE`,
		subscriptionID,
	)

	var creds SubscriptionCredentials
	err := row.Scan(&creds.SubscriptionID, &creds.TenantID, &creds.ClientID, &creds.ClientSecretEnc, &creds.SubscriptionName)
	if err != nil {
		return nil, nil // not found — caller falls back to env vars
	}
	return &creds, nil
}

// FindAllActiveSubscriptions returns all active subscriptions from the DB.
func FindAllActiveSubscriptions(ctx context.Context, pool *pgxpool.Pool) ([]SubscriptionCredentials, error) {
	rows, err := pool.Query(ctx,
		`SELECT subscription_id, tenant_id, client_id, client_secret_enc, name
		 FROM subscriptions WHERE is_active = TRUE ORDER BY created_at ASC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var subs []SubscriptionCredentials
	for rows.Next() {
		var s SubscriptionCredentials
		if err := rows.Scan(&s.SubscriptionID, &s.TenantID, &s.ClientID, &s.ClientSecretEnc, &s.SubscriptionName); err != nil {
			return nil, err
		}
		subs = append(subs, s)
	}
	return subs, nil
}

// TouchLastAudit updates last_audit_at for a subscription.
func TouchLastAudit(ctx context.Context, pool *pgxpool.Pool, subscriptionID string) error {
	_, err := pool.Exec(ctx,
		`UPDATE subscriptions SET last_audit_at = NOW() WHERE subscription_id = $1`,
		subscriptionID,
	)
	return err
}
