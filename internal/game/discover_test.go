package game

import "testing"

// Fog cuts a survivor's sight hard, rain somewhat.
func TestFogAndRainShortenSight(t *testing.T) {
	w := New(5)
	clear := w.sightMul()
	w.Weather, w.WeatherAmt = WRain, 1
	rain := w.sightMul()
	w.Weather = WFog
	fog := w.sightMul()
	if !(clear == 1 && rain < .8 && fog < .5) {
		t.Fatalf("sight: clear %.2f, rain %.2f, fog %.2f", clear, rain, fog)
	}
}
