package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// FindEnabledRoles returns every role currently toggled on in
// notification_role_settings — the roles whose active users should receive
// audit-failed alert emails.
func FindEnabledRoles(ctx context.Context, pool *pgxpool.Pool) ([]string, error) {
	rows, err := pool.Query(ctx, `SELECT role FROM notification_role_settings WHERE enabled = TRUE`)
	if err != nil {
		return nil, fmt.Errorf("finding enabled notification roles: %w", err)
	}
	defer rows.Close()

	var roles []string
	for rows.Next() {
		var role string
		if err := rows.Scan(&role); err != nil {
			return nil, fmt.Errorf("scanning notification role: %w", err)
		}
		roles = append(roles, role)
	}
	return roles, rows.Err()
}

// FindActiveUserEmailsByRoles returns the email addresses of every active
// user whose role is in the given list.
func FindActiveUserEmailsByRoles(ctx context.Context, pool *pgxpool.Pool, roles []string) ([]string, error) {
	if len(roles) == 0 {
		return nil, nil
	}

	rows, err := pool.Query(ctx, `
		SELECT email FROM users WHERE role = ANY($1) AND is_active = TRUE
	`, roles)
	if err != nil {
		return nil, fmt.Errorf("finding users by role: %w", err)
	}
	defer rows.Close()

	var emails []string
	for rows.Next() {
		var email string
		if err := rows.Scan(&email); err != nil {
			return nil, fmt.Errorf("scanning user email: %w", err)
		}
		emails = append(emails, email)
	}
	return emails, rows.Err()
}
