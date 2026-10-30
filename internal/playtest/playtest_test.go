package playtest

import (
	"bufio"
	"errors"
	"fmt"
	"math/rand/v2"
	"os"
	"strconv"
	"strings"
	"testing"

	"taildefense/internal/game"
)

// soak is how many extra games TD_SOAK asks for; 0 plays only the short set.
func soak() int {
	n, _ := strconv.Atoi(os.Getenv("TD_SOAK"))
	return n
}

type setup struct {
	seed    uint64
	diff    game.Difficulty
	players int
	waves   int
}

func (g setup) String() string {
	return fmt.Sprintf("seed %d, %s, %d players", g.seed, g.diff, g.players)
}

func play(t *testing.T, g setup) Result {
	t.Helper()
	s := New(g.seed, g.diff, g.players)
	s.Hold = true
	bots := make([]*Bot, g.players)
	for i := range bots {
		bots[i] = NewBot(uint8(i), g.seed)
	}
	res, err := Play(s, bots, g.waves, g.waves*8*60*game.TickRate)
	if err != nil {
		var stuck *StuckError
		if errors.As(err, &stuck) {
			t.Fatalf("%v: %v", g, err)
		}
		t.Fatalf("%v: %v\n  replay: TD_SOAK_ONE=%d,%d,%d,%d go test ./internal/playtest -run Soak -v", g, err, g.seed, g.diff, g.players, g.waves)
	}
	return res
}

// Bots play whole games on a spread of maps, difficulties and team sizes, and nothing they
// do breaks the world, the wire or the wave clock. TD_SOAK=n plays n more games, longer;
// TD_SOAK_ONE=seed,diff,players,waves plays one again.
func TestSoak(t *testing.T) {
	games := []setup{
		{1, game.DiffNormal, 1, 4},
		{2, game.DiffEasy, 4, 4},
		{3, game.DiffHard, 2, 4},
		{4, game.DiffBrutal, 3, 3},
	}
	if testing.Short() {
		games = games[:1]
	}
	r := rand.New(rand.NewPCG(uint64(soak()), 99))
	for i := 0; i < soak(); i++ {
		games = append(games, setup{r.Uint64() >> 16, game.Difficulty(r.IntN(int(game.NumDifficulties))), 1 + r.IntN(game.MaxPlayers), 10 + r.IntN(15)})
	}
	if one := os.Getenv("TD_SOAK_ONE"); one != "" {
		var g setup
		if _, err := fmt.Sscanf(one, "%d,%d,%d,%d", &g.seed, &g.diff, &g.players, &g.waves); err != nil {
			t.Fatalf("TD_SOAK_ONE=%q: %v", one, err)
		}
		games = []setup{g}
	}
	for _, g := range games {
		t.Run(g.String(), func(t *testing.T) {
			t.Parallel()
			res := play(t, g)
			t.Logf("%d waves in %ds, %d kills", res.Waves, res.Ticks/game.TickRate, res.Kills)
			if res.Waves < g.waves && res.Over && res.Out == 0 {
				t.Errorf("the generator fell in wave %d of %d: the bots lost, every check held, so look at the balance\n  replay: TD_SOAK_ONE=%d,%d,%d,%d go test ./internal/playtest -run Soak -v", res.Waves+1, g.waves, g.seed, g.diff, g.players, g.waves)
			} else if res.Waves < g.waves {
				t.Errorf("only %d of %d waves were played through in time", res.Waves, g.waves)
			}
		})
	}
}

// A game is its seed and its commands: played again from the log it comes out the same,
// tick for tick.
func TestAGameReplaysFromItsLog(t *testing.T) {
	const seed, players, ticks = 17, 3, 2 * 60 * game.TickRate
	s := New(seed, game.DiffNormal, players)
	bots := []*Bot{NewBot(0, seed), NewBot(1, seed), NewBot(2, seed)}
	res, err := Play(s, bots, 99, ticks)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Log) < 50 {
		t.Fatalf("the bots gave only %d commands", len(s.Log))
	}
	again, err := Replay(seed, game.DiffNormal, players, false, s.Log, len(res.Hashes))
	if err != nil {
		t.Fatal(err)
	}
	for i := range res.Hashes {
		if again[i] != res.Hashes[i] {
			t.Fatalf("the replay parts from the game at tick %d", i+1)
		}
	}
}

// The golden game: a fixed game of bots whose world hash is kept every ten seconds in
// testdata/golden.txt. It fails when anything changes how the game plays, which a change to
// the rules is meant to do: then look at the summary line's diff to see it is the change
// intended, and rewrite the file with ./build.sh golden.
func TestTheGoldenGamePlaysAsRecorded(t *testing.T) {
	const seed, players = 7, 2
	const path = "testdata/golden.txt"
	s := New(seed, game.DiffNormal, players)
	s.Hold = true
	res, err := Play(s, []*Bot{NewBot(0, seed), NewBot(1, seed)}, 5, 20*60*game.TickRate)
	if err != nil {
		t.Fatal(err)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "# seed %d, %s, %d bots; regenerate with ./build.sh golden\n", seed, game.DiffNormal, players)
	fmt.Fprintf(&b, "summary waves %d ticks %d kills %d over %v commands %d\n", res.Waves, res.Ticks, res.Kills, res.Over, len(s.Log))
	for i := 10*game.TickRate - 1; i < len(res.Hashes); i += 10 * game.TickRate {
		fmt.Fprintf(&b, "%d %016x\n", i+1, res.Hashes[i])
	}
	got := b.String()
	if os.Getenv("TD_GOLDEN") == "update" {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v; create it with ./build.sh golden", err)
	}
	want := string(raw)
	if got == want {
		return
	}
	gl, wl := lines(got), lines(want)
	for i := 0; i < len(gl) || i < len(wl); i++ {
		var g, w string
		if i < len(gl) {
			g = gl[i]
		}
		if i < len(wl) {
			w = wl[i]
		}
		if g != w {
			t.Fatalf("the golden game plays differently: if the rules changed on purpose, rewrite %s with ./build.sh golden\n"+
				"  was: %s\n  now: %s\n  first difference: line %d\n  recorded: %s\n  now:      %s",
				path, wl[1], gl[1], i+1, w, g)
		}
	}
}

func lines(s string) []string {
	var out []string
	sc := bufio.NewScanner(strings.NewReader(s))
	for sc.Scan() {
		out = append(out, sc.Text())
	}
	for len(out) < 2 {
		out = append(out, "")
	}
	return out
}

// A short game is played to its end over the wire: the last wave cleared, the evac Huey in,
// the bots aboard and away, with every check holding on the way.
func TestBotsGetToTheChoppa(t *testing.T) {
	for _, g := range []setup{{21, game.DiffEasy, 2, 3}, {3, game.DiffHard, 2, 3}} {
		t.Run(g.String(), func(t *testing.T) {
			t.Parallel()
			s := New(g.seed, g.diff, g.players)
			s.Hold = true
			s.W.LastWave = g.waves
			bots := make([]*Bot, g.players)
			for i := range bots {
				bots[i] = NewBot(uint8(i), g.seed)
			}
			res, err := Play(s, bots, 99, (g.waves+4)*8*60*game.TickRate)
			if err != nil {
				t.Fatal(err)
			}
			if !res.Over || res.Waves != g.waves || res.Out == 0 {
				t.Fatalf("over %v after %d waves with %d aboard, evac stage %d", res.Over, res.Waves, res.Out, s.W.Evac.Stage)
			}
			if s.W.Evac.Stage != game.EvacGone {
				t.Errorf("the game ended with the Huey at stage %d", s.W.Evac.Stage)
			}
		})
	}
}

// Bots defend with frost and rockets on the creeps' way in, never walls, raise what they
// built rather than sell it, and go exploring with their free time.
func TestBotsBuildFrostAndRocketsAndExplore(t *testing.T) {
	const seed, players, waves = 5, 2, 4
	s := New(seed, game.DiffNormal, players)
	s.Hold = true
	bots := []*Bot{NewBot(0, seed), NewBot(1, seed)}
	if _, err := Play(s, bots, waves, waves*8*60*game.TickRate); err != nil {
		t.Fatal(err)
	}
	w := s.W
	kinds := map[game.StructKind]int{}
	raised := 0
	for i := range w.Structs {
		st := &w.Structs[i]
		if !st.Alive || st.Owner < 0 {
			continue
		}
		kinds[st.Kind]++
		if game.TrackSum(st) > 0 {
			raised++
		}
	}
	searched := 0
	for _, st := range w.Sites {
		if st.Searched && st.Kind.Lootable() {
			searched++
		}
	}
	t.Logf("frost %d, missile %d, gun %d, wall %d, gate %d, raised %d, sites searched %d", kinds[game.STurretFrost], kinds[game.STurretMissile], kinds[game.STurretGun], kinds[game.SWall], kinds[game.SGate], raised, searched)
	if kinds[game.SWall]+kinds[game.SGate] > 0 {
		t.Errorf("the bots built %d walls and %d gates", kinds[game.SWall], kinds[game.SGate])
	}
	if kinds[game.STurretFrost] == 0 || kinds[game.STurretMissile] == 0 {
		t.Errorf("frost %d, missile %d: the bots should build both", kinds[game.STurretFrost], kinds[game.STurretMissile])
	}
	for k, n := range kinds {
		if k != game.STurretFrost && k != game.STurretMissile && k != game.STurretGun && n > 0 {
			t.Errorf("the bots built %d %s", n, game.Structs[k].Name)
		}
	}
	if raised == 0 {
		t.Error("no tower was upgraded")
	}
	if searched == 0 {
		t.Error("nobody went exploring: no loot site searched")
	}
}
