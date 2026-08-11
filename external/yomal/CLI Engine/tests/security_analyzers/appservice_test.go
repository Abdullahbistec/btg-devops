package security_analyzers_test

import (
	"testing"

	"github.com/chanbistec/btg-devops/cmd"
	"github.com/stretchr/testify/assert"
)

func TestClassifyTrafficStatus(t *testing.T) {
	tests := []struct {
		name           string
		input          cmd.AppTrafficReport
		expectedStatus string
		checkReport    func(t *testing.T, r *cmd.AppTrafficReport)
	}{
		{
			name: "Zero traffic is Idle/Unused",
			input: cmd.AppTrafficReport{
				Name: "app1", TotalRequests: 0, BytesReceived: 0, BytesSent: 0,
			},
			expectedStatus: "Idle/Unused",
		},
		{
			name: "Less than 100 requests is Low Traffic",
			input: cmd.AppTrafficReport{
				Name: "app1", TotalRequests: 50,
			},
			expectedStatus: "Low Traffic",
		},
		{
			name: "Between 100 and 1000 requests is Low Traffic",
			input: cmd.AppTrafficReport{
				Name: "app1", TotalRequests: 500,
			},
			expectedStatus: "Low Traffic",
		},
		{
			name: "1000 or more requests is Active",
			input: cmd.AppTrafficReport{
				Name: "app1", TotalRequests: 5000,
			},
			expectedStatus: "Active",
		},
		{
			name: "High 5xx error rate appends warning to recommendation",
			input: cmd.AppTrafficReport{
				Name: "app1", TotalRequests: 100, HTTP5xx: 15,
			},
			checkReport: func(t *testing.T, r *cmd.AppTrafficReport) {
				assert.Contains(t, r.Recommendation, "5xx error rate")
			},
		},
		{
			name: "Low 5xx error rate does not append warning",
			input: cmd.AppTrafficReport{
				Name: "app1", TotalRequests: 1000, HTTP5xx: 5,
			},
			checkReport: func(t *testing.T, r *cmd.AppTrafficReport) {
				assert.NotContains(t, r.Recommendation, "5xx error rate")
				assert.Equal(t, "Active", r.Status)
			},
		},
		{
			name: "Recommendation is non-empty for all statuses",
			input: cmd.AppTrafficReport{
				Name: "app1", TotalRequests: 0,
			},
			checkReport: func(t *testing.T, r *cmd.AppTrafficReport) {
				assert.NotEmpty(t, r.Recommendation)
				assert.NotEmpty(t, r.Status)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := tt.input
			cmd.ClassifyTrafficStatus(&r)
			if tt.expectedStatus != "" {
				assert.Equal(t, tt.expectedStatus, r.Status)
			}
			if tt.checkReport != nil {
				tt.checkReport(t, &r)
			}
		})
	}
}

func TestClassifyTrafficStatus_MultipleApps(t *testing.T) {
	apps := []*cmd.AppTrafficReport{
		{Name: "idle-app", TotalRequests: 0},
		{Name: "low-app", TotalRequests: 200},
		{Name: "active-app", TotalRequests: 5000},
	}

	for _, r := range apps {
		cmd.ClassifyTrafficStatus(r)
	}

	assert.Equal(t, "Idle/Unused", apps[0].Status)
	assert.Equal(t, "Low Traffic", apps[1].Status)
	assert.Equal(t, "Active", apps[2].Status)
}
