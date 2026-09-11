package cmd

import (
	"strings"
	"testing"
)

func TestClassifyTrafficStatus_IdleWithZeroTraffic(t *testing.T) {
	report := &AppTrafficReport{
		TotalRequests: 0,
		BytesReceived: 0,
		BytesSent:     0,
	}

	ClassifyTrafficStatus(report)

	if report.Status != "Idle/Unused" {
		t.Errorf("expected Idle/Unused status for zero traffic, got %q", report.Status)
	}
}

func TestClassifyTrafficStatus_VeryLowTrafficBelow100(t *testing.T) {
	report := &AppTrafficReport{
		TotalRequests: 50,
	}

	ClassifyTrafficStatus(report)

	if report.Status != "Low Traffic" {
		t.Errorf("expected Low Traffic status for 50 requests, got %q", report.Status)
	}
	if report.Recommendation != "Very low traffic. Consider scaling down or consolidating." {
		t.Errorf("unexpected recommendation for 50 requests: %q", report.Recommendation)
	}
}

func TestClassifyTrafficStatus_LowTrafficBelow1000(t *testing.T) {
	report := &AppTrafficReport{
		TotalRequests: 500,
	}

	ClassifyTrafficStatus(report)

	if report.Status != "Low Traffic" {
		t.Errorf("expected Low Traffic status for 500 requests, got %q", report.Status)
	}
	if report.Recommendation != "Low traffic. Review if this app is still needed at current scale." {
		t.Errorf("unexpected recommendation for 500 requests: %q", report.Recommendation)
	}
}

func TestClassifyTrafficStatus_ActiveAboveThreshold(t *testing.T) {
	report := &AppTrafficReport{
		TotalRequests: 5000,
	}

	ClassifyTrafficStatus(report)

	if report.Status != "Active" {
		t.Errorf("expected Active status for 5000 requests, got %q", report.Status)
	}
}

func TestClassifyTrafficStatus_HighErrorRateAppendsWarning(t *testing.T) {
	report := &AppTrafficReport{
		TotalRequests: 1000,
		Http5xx:       200,
	}

	ClassifyTrafficStatus(report)

	if report.Status != "Active" {
		t.Errorf("expected Active status for 1000 requests, got %q", report.Status)
	}
	if !strings.Contains(report.Recommendation, "High 5xx error rate") {
		t.Errorf("expected high error rate warning in recommendation, got %q", report.Recommendation)
	}
}
