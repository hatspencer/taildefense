package game

import "testing"

// TestWeatherOdds pins the weather weights: they sum to 103, and fog, the heaviest weather for
// play, comes no more often than heavy rain.
func TestWeatherOdds(t *testing.T) {
	total := 0
	for _, d := range Weathers {
		total += d.Weight
	}
	if total != 103 {
		t.Errorf("weather weights sum to %d, want 103", total)
	}
	if Weathers[WFog].Weight > Weathers[WRain].Weight {
		t.Errorf("fog weight %d is above heavy rain's %d", Weathers[WFog].Weight, Weathers[WRain].Weight)
	}
}
