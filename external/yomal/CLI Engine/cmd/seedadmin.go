package cmd

import (
	"context"
	"fmt"
	"os"

	"github.com/chanbistec/btg-devops/internal/db"
	"github.com/spf13/cobra"
	"golang.org/x/crypto/bcrypt"
)

var (
	seedEmail    string
	seedPassword string
)

var seedAdminCmd = &cobra.Command{
	Use:   "seed-admin",
	Short: "Create the first admin user in the database",
	Long: `Inserts the first admin user into the database.
Does nothing if an admin already exists — safe to run multiple times.

Reads credentials from flags or environment variables:
  --email     / ADMIN_EMAIL
  --password  / ADMIN_PASSWORD

DATABASE_URL must also be set.`,
	RunE: runSeedAdmin,
}

func init() {
	rootCmd.AddCommand(seedAdminCmd)
	seedAdminCmd.Flags().StringVar(&seedEmail, "email", "", "Admin email address (or set ADMIN_EMAIL)")
	seedAdminCmd.Flags().StringVar(&seedPassword, "password", "", "Admin password (or set ADMIN_PASSWORD)")
}

func runSeedAdmin(_ *cobra.Command, _ []string) error {
	ctx := context.Background()

	// Resolve email and password from flags or env
	email := seedEmail
	if email == "" {
		email = os.Getenv("ADMIN_EMAIL")
	}
	password := seedPassword
	if password == "" {
		password = os.Getenv("ADMIN_PASSWORD")
	}

	if email == "" {
		return fmt.Errorf("admin email required: use --email flag or set ADMIN_EMAIL env var")
	}
	if password == "" {
		return fmt.Errorf("admin password required: use --password flag or set ADMIN_PASSWORD env var")
	}
	if len(password) < 8 {
		return fmt.Errorf("password must be at least 8 characters")
	}

	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		return fmt.Errorf("DATABASE_URL env var is required")
	}

	// Connect
	fmt.Fprintf(os.Stderr, "Connecting to database...\n")
	pool, err := db.Connect(ctx, databaseURL)
	if err != nil {
		return fmt.Errorf("database connection failed: %w", err)
	}
	defer pool.Close()

	// Ensure schema exists
	if err := db.ApplySchema(ctx, pool); err != nil {
		return fmt.Errorf("schema setup failed: %w", err)
	}

	// Hash password
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("hashing password: %w", err)
	}

	// Seed
	created, err := db.SeedAdmin(ctx, pool, email, string(hash))
	if err != nil {
		return fmt.Errorf("seeding admin: %w", err)
	}

	if created {
		fmt.Fprintf(os.Stderr, "Admin user created: %s\n", email)
	} else {
		fmt.Fprintf(os.Stderr, "Admin already exists — no changes made.\n")
	}

	return nil
}
