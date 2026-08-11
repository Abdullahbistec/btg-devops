// Package mailer sends best-effort email alerts via Gmail SMTP. Sending is
// always fail-soft: a missing config or a failed send is logged to stderr
// and never returned as an error, so alerting can never make an
// otherwise-successful (or already-failing) audit run look worse than it is.
package mailer

import (
	"fmt"
	"net/smtp"
	"os"
	"strings"
)

// SendAlert emails subject/body to every address in recipients, using
// GMAIL_USER/GMAIL_APP_PASSWORD for auth against smtp.gmail.com. If
// recipients is empty (e.g. no notification roles are enabled, or none of
// those roles currently have an active user), this falls back to the
// ALERT_EMAIL_TO env var so a failure still reaches someone. If GMAIL_USER/
// GMAIL_APP_PASSWORD are unset, no recipients can be resolved, or the send
// itself fails, this logs a warning and returns without error.
func SendAlert(subject, body string, recipients []string) {
	user := os.Getenv("GMAIL_USER")
	pass := os.Getenv("GMAIL_APP_PASSWORD")
	if user == "" || pass == "" {
		fmt.Fprintf(os.Stderr, "  warning: alert email skipped (GMAIL_USER/GMAIL_APP_PASSWORD not set)\n")
		return
	}

	to := recipients
	if len(to) == 0 {
		if fallback := os.Getenv("ALERT_EMAIL_TO"); fallback != "" {
			to = []string{fallback}
		}
	}
	if len(to) == 0 {
		fmt.Fprintf(os.Stderr, "  warning: alert email skipped (no notification recipients resolved and ALERT_EMAIL_TO not set)\n")
		return
	}

	msg := fmt.Sprintf("From: %s\r\nTo: %s\r\nSubject: %s\r\n\r\n%s\r\n", user, strings.Join(to, ", "), subject, body)

	auth := smtp.PlainAuth("", user, pass, "smtp.gmail.com")
	if err := smtp.SendMail("smtp.gmail.com:587", auth, user, to, []byte(msg)); err != nil {
		fmt.Fprintf(os.Stderr, "  warning: failed to send alert email: %v\n", err)
	}
}
