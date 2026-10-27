package web

import (
	"bufio"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// gpuEnv puts a browser td starts on the discrete GPU of a Linux laptop with two, the way the
// desktop's "Launch using Discrete Graphics" does. The page asks for the fast GPU too, and
// macOS and Windows honour that (with --force_high_performance_gpu), but on Linux the
// browser takes whichever GPU its environment names. A player who set any of these already
// made their own choice, and env is left alone. It reports whether it chose the GPU.
func gpuEnv(env []string) ([]string, bool) {
	if runtime.GOOS != "linux" {
		return env, false
	}
	for _, kv := range env {
		k, _, _ := strings.Cut(kv, "=")
		switch k {
		case "DRI_PRIME", "__NV_PRIME_RENDER_OFFLOAD", "__GLX_VENDOR_LIBRARY_NAME", "__VK_LAYER_NV_optimus", "VK_LOADER_DRIVERS_SELECT":
			return env, false
		}
	}
	kv := discreteEnv()
	return append(env, kv...), len(kv) > 0
}

// chromiumGPUArgs are the flags a Chromium browser needs for gpuEnv to take. On Wayland it
// draws on the GPU the compositor names, whatever its environment says, so it runs under
// XWayland, where the offload settings work as for any X program. Naming the render node
// instead (--render-node-override) does put it on the discrete GPU, but the compositor,
// on the integrated one, cannot import its frames: Hyprland crashed on them.
func chromiumGPUArgs(env []string) []string {
	if getenv(env, "WAYLAND_DISPLAY") != "" && getenv(env, "DISPLAY") != "" {
		return []string{"--ozone-platform=x11"}
	}
	return nil
}

// getenv is k's value in env; the last one counts, as for exec.
func getenv(env []string, k string) string {
	v := ""
	for _, kv := range env {
		if key, val, _ := strings.Cut(kv, "="); key == k {
			v = val
		}
	}
	return v
}

// discreteEnv is what selects the discrete GPU: switcheroo-control's answer where it runs,
// else NVIDIA's offload settings when its driver is loaded, else Mesa's when there are two
// GPUs. Nothing on a machine with one.
func discreteEnv() []string {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, "switcherooctl", "list").Output(); err == nil {
		if kv := switcherooDiscrete(string(out)); kv != nil {
			return kv
		}
	}
	if _, err := os.Stat("/proc/driver/nvidia/version"); err == nil {
		return []string{"__NV_PRIME_RENDER_OFFLOAD=1", "__GLX_VENDOR_LIBRARY_NAME=nvidia", "__VK_LAYER_NV_optimus=NVIDIA_only"}
	}
	if cards, _ := filepath.Glob("/sys/class/drm/card[0-9]"); len(cards) > 1 {
		return []string{"DRI_PRIME=1"}
	}
	return nil
}

// switcherooDiscrete reads `switcherooctl list` for the environment of the first discrete
// GPU that is not the default already.
func switcherooDiscrete(out string) []string {
	var env []string
	discrete, isDefault := false, false
	flush := func() []string {
		if discrete && !isDefault && len(env) > 0 {
			return env
		}
		return nil
	}
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		k, v, _ := strings.Cut(line, ":")
		v = strings.TrimSpace(v)
		switch k {
		case "Device":
			if got := flush(); got != nil {
				return got
			}
			env, discrete, isDefault = nil, false, false
		case "Discrete":
			discrete = v == "yes"
		case "Default":
			isDefault = v == "yes"
		case "Environment":
			for _, kv := range strings.Fields(v) {
				if strings.Contains(kv, "=") {
					env = append(env, kv)
				}
			}
		}
	}
	return flush()
}
