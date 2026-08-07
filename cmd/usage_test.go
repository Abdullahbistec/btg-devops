package cmd

import "testing"

func TestCalcWasteScore_ZeroCost(t *testing.T) {
	score, _ := calcWasteScore(0, -1, -1)
	if score != "IDLE" {
		t.Errorf("got %q, want IDLE", score)
	}
}

func TestCalcWasteScore_ZeroUtilizationAndActivity(t *testing.T) {
	score, _ := calcWasteScore(15, 0, 0)
	if score != "IDLE" {
		t.Errorf("got %q, want IDLE", score)
	}
}

func TestCalcWasteScore_PercentBased_High(t *testing.T) {
	score, _ := calcWasteScore(50, 3, -1)
	if score != "HIGH" {
		t.Errorf("got %q, want HIGH (primaryPct=3 < 5, cost=50 > 10)", score)
	}
}

func TestCalcWasteScore_PercentBased_Medium(t *testing.T) {
	score, _ := calcWasteScore(50, 8, -1)
	if score != "MEDIUM" {
		t.Errorf("got %q, want MEDIUM (primaryPct=8 < 10, cost=50 > 10)", score)
	}
}

func TestCalcWasteScore_PercentBased_Low(t *testing.T) {
	score, _ := calcWasteScore(50, 20, -1)
	if score != "LOW" {
		t.Errorf("got %q, want LOW (primaryPct=20 < 35, cost=50 > 10)", score)
	}
}

func TestCalcWasteScore_PercentBased_Healthy(t *testing.T) {
	score, _ := calcWasteScore(50, 80, -1)
	if score != "HEALTHY" {
		t.Errorf("got %q, want HEALTHY (primaryPct=80 >= 70)", score)
	}
}

func TestCalcWasteScore_CountBased_IdleZeroActivity(t *testing.T) {
	score, _ := calcWasteScore(5, -1, 0)
	if score != "IDLE" {
		t.Errorf("got %q, want IDLE (dailyActivity=0, cost>0)", score)
	}
}

func TestCalcWasteScore_CountBased_High(t *testing.T) {
	score, _ := calcWasteScore(25, -1, 5)
	if score != "HIGH" {
		t.Errorf("got %q, want HIGH (dailyActivity=5 < 10, cost=25 > 20)", score)
	}
}

func TestCalcWasteScore_CountBased_Medium(t *testing.T) {
	score, _ := calcWasteScore(60, -1, 50)
	if score != "MEDIUM" {
		t.Errorf("got %q, want MEDIUM (dailyActivity=50 < 100, cost=60 > 50)", score)
	}
}

func TestCalcWasteScore_CountBased_Healthy(t *testing.T) {
	score, _ := calcWasteScore(60, -1, 500)
	if score != "HEALTHY" {
		t.Errorf("got %q, want HEALTHY (dailyActivity=500, well above thresholds)", score)
	}
}
