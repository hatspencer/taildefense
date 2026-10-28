package playtest

import "testing"

//go:noinline
func mulSub(a, b, c float64) float64 { return a*b - c }

// The game must round every product on its own, as amd64 does: on arm64 the compiler may fuse
// a*b+c into one rounding, the world drifts a bit off the amd64 one and the golden game
// recorded on either fails on the other. ./build.sh turns the fusing off; a test run without
// it says so here rather than as a golden game that plays differently.
func TestProductsAreRoundedOnTheirOwn(t *testing.T) {
	a := 1 + 0x1p-30
	p := a * a // 1 + 2^-29, the 2^-60 rounded away
	if r := mulSub(a, a, p); r != 0 {
		t.Fatalf("a*a-p is %g, not 0: a*b+c is fused, so the game plays differently here than on amd64; build and test through ./build.sh, which passes -gcflags=all=-d=fmahash=qn", r)
	}
}
