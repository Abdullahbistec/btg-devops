package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// SeedAdmin inserts the first admin user if no admin exists yet.
// Returns (true, nil) if created, (false, nil) if an admin already exists.
func SeedAdmin(ctx context.Context, pool *pgxpool.Pool, email, passwordHash string) (created bool, err error) {
	var count int
	err = pool.QueryRow(ctx, `SELECT COUNT(*) FROM users WHERE role = 'admin'`).Scan(&count)
	if err != nil {
		return false, fmt.Errorf("checking existing admins: %w", err)
	}
	if count > 0 {
		return false, nil
	}

	_, err = pool.Exec(ctx, `
		INSERT INTO users (email, password_hash, role, is_active)
		VALUES ($1, $2, 'admin', TRUE)
	`, email, passwordHash)
	if err != nil {
		return false, fmt.Errorf("inserting admin user: %w", err)
	}
	return true, nil
}
