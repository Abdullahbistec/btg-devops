package main

import (
	"context"
	"fmt"
	"os"

	"github.com/chanbistec/btg-devops/internal/db"
)

func main() {
	ctx := context.Background()
	pool, err := db.Connect(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		fmt.Fprintf(os.Stderr, "connect failed: %v\n", err)
		os.Exit(1)
	}
	defer pool.Close()

	tag, err := pool.Exec(ctx, `DELETE FROM audits WHERE subscription_id = 'test-fake-subscription-000'`)
	if err != nil {
		fmt.Fprintf(os.Stderr, "delete failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Deleted %d test audit row(s)\n", tag.RowsAffected())
}
