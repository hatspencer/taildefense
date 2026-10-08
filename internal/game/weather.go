package game

// WeatherKind is the sky over the whole map; the host picks it and everyone sees the same.
type WeatherKind uint8

const (
	WClear WeatherKind = iota
	WFog
	WRain
	WStorm
	WSnow
	NumWeathers
)

// WeatherDef names a weather and says what it does.
type WeatherDef struct {
	Name   string
	Info   string
	Weight int // how often it comes up between waves
}

// Weathers is indexed by WeatherKind.
var Weathers = [NumWeathers]WeatherDef{
	WClear: {Name: "Clear", Weight: 40},
	WFog:   {Name: "Fog", Info: "you and your turrets reach 25% less far; creeps notice you later", Weight: 18},
	WRain:  {Name: "Rain", Info: "fire burns half as hot; creeps 8% slower", Weight: 18},
	WStorm: {Name: "Storm", Info: "rain, and lightning strikes creeps out in the open", Weight: 12},
	WSnow:  {Name: "Snow", Info: "creeps 15% slower, survivors 8% slower", Weight: 12},
}

// weatherFade is how many seconds a weather takes to come in or clear.
const weatherFade = 6

// stepWeather eases the current weather out when another is due and the next one in, and
// throws a storm's lightning.
func (w *World) stepWeather() {
	switch {
	case w.weatherNext != w.Weather:
		w.WeatherAmt -= Dt / weatherFade
		if w.WeatherAmt <= 0 {
			w.WeatherAmt = 0
			w.Weather = w.weatherNext
		}
	case w.Weather == WClear:
		w.WeatherAmt = 0
	default:
		w.WeatherAmt = min(w.WeatherAmt+Dt/weatherFade, 1)
	}
	if w.Weather != WStorm || w.WeatherAmt < .5 || len(w.Creeps) == 0 {
		return
	}
	w.lightning -= Dt
	if w.lightning > 0 {
		return
	}
	w.lightning = 1.5 + w.rng.Float32()*3
	// Strike a creep out in the open: never inside the walls, where it would look like the
	// sky is defending the base for you.
	for try := 0; try < 6; try++ {
		c := &w.Creeps[w.rng.IntN(len(w.Creeps))]
		dx, dy := c.X-w.CoreX, c.Y-w.CoreY
		if dx*dx+dy*dy < BuildRadius*BuildRadius {
			continue
		}
		w.explode(c.X, c.Y, 2, 60*HPScale(max(w.Wave, 1)), -1, 8)
		return
	}
}

// rollWeather picks the weather for the coming wave.
func (w *World) rollWeather() {
	total := 0
	for _, d := range Weathers {
		total += d.Weight
	}
	r := w.rng.IntN(total)
	for k, d := range Weathers {
		if r < d.Weight {
			w.weatherNext = WeatherKind(k)
			return
		}
		r -= d.Weight
	}
}

// amt is how strongly weather k holds right now, 0 when another weather is up.
func (w *World) amt(k WeatherKind) float32 {
	if w.Weather == k {
		return w.WeatherAmt
	}
	return 0
}

func (w *World) wet() float32 { return w.amt(WRain) + w.amt(WStorm) }

// rangeMul scales survivors' and turrets' reach: fog shortens it.
func (w *World) rangeMul() float32 { return 1 - .25*w.amt(WFog) }

// aggroMul scales how far creeps notice survivors: fog hides them.
func (w *World) aggroMul() float32 { return 1 - .4*w.amt(WFog) }

// creepSpeedMul is rain and snow slowing creeps.
func (w *World) creepSpeedMul() float32 { return 1 - .08*w.wet() - .15*w.amt(WSnow) }

// playerSpeedMul is snow slowing survivors.
func (w *World) playerSpeedMul() float32 { return 1 - .08*w.amt(WSnow) }

// burnMul is rain putting fires out.
func (w *World) burnMul() float32 { return 1 - .5*w.wet() }
