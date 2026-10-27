package web

import (
	"slices"
	"testing"
)

func TestTheDiscreteGPUIsReadFromSwitcheroo(t *testing.T) {
	out := `Device: 0
  Name:        Intel Corporation Meteor Lake-P [Intel Arc Graphics]
  Default:     yes
  Discrete:    no
  Environment: DRI_PRIME=pci-0000_00_02_0 VK_LOADER_DRIVERS_SELECT=*intel*

Device: 1
  Name:        NVIDIA Corporation AD107GLM [RTX 500 Ada Generation Laptop GPU]
  Default:     no
  Discrete:    yes
  Environment: __GLX_VENDOR_LIBRARY_NAME=nvidia __NV_PRIME_RENDER_OFFLOAD=1 __VK_LAYER_NV_optimus=NVIDIA_only VK_LOADER_DRIVERS_SELECT=*nvidia*
`
	want := []string{"__GLX_VENDOR_LIBRARY_NAME=nvidia", "__NV_PRIME_RENDER_OFFLOAD=1", "__VK_LAYER_NV_optimus=NVIDIA_only", "VK_LOADER_DRIVERS_SELECT=*nvidia*"}
	if got := switcherooDiscrete(out); !slices.Equal(got, want) {
		t.Errorf("got %q", got)
	}
	one := "Device: 0\n  Name: Intel\n  Default: yes\n  Discrete: no\n  Environment: DRI_PRIME=pci-0000_00_02_0\n"
	if got := switcherooDiscrete(one); got != nil {
		t.Errorf("one GPU, got %q", got)
	}
}

func TestAPlayersOwnGPUChoiceStands(t *testing.T) {
	env := []string{"PATH=/bin", "DRI_PRIME=0"}
	if got, chose := gpuEnv(env); !slices.Equal(got, env) || chose {
		t.Errorf("got %q, chose %v", got, chose)
	}
}

func TestChromiumRunsUnderXWaylandForTheDiscreteGPU(t *testing.T) {
	both := []string{"WAYLAND_DISPLAY=wayland-1", "DISPLAY=:0"}
	if got := chromiumGPUArgs(both); !slices.Equal(got, []string{"--ozone-platform=x11"}) {
		t.Errorf("Wayland with XWayland, got %q", got)
	}
	for _, env := range [][]string{
		{"DISPLAY=:0"},                            // X11 already
		{"WAYLAND_DISPLAY=wayland-1"},             // no XWayland to run under
		{"WAYLAND_DISPLAY=wayland-1", "DISPLAY="}, // nor here
	} {
		if got := chromiumGPUArgs(env); got != nil {
			t.Errorf("%q, got %q", env, got)
		}
	}
}
