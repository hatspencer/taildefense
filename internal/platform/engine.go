package platform

import (
	"os"
	"os/exec"
	"strings"
)

// EnvContainerEngine overrides which container engines are tried, as a space-separated list.
// The same variable build.sh reads, so one machine cannot have the script and the binary
// disagreeing about which engine it has.
const EnvContainerEngine = "TAILDEFENSE_CONTAINER_ENGINE"

// ContainerEngine names the engine to use: Docker when its daemon answers, otherwise Podman.
// Both are first-class on macOS and Linux, and the search order matches build.sh.
//
// The daemon is probed rather than only the executable, because an installed Docker with a
// stopped daemon is the ordinary case on a laptop, and noticing it here is what makes the fall
// through to a working Podman happen. `info` is the cheapest command that needs the daemon.
//
// Shared rather than duplicated: `td update` builds in a container and the Atlassian MCP
// server runs in one, and two copies of this would drift into disagreeing about the same
// machine. That is the whole reason it moved here.
func ContainerEngine() (string, bool) {
	for _, name := range containerEngineCandidates() {
		if _, ok := LookPath(name); !ok {
			continue
		}
		if exec.Command(name, "info").Run() == nil {
			return name, true
		}
	}
	return "", false
}

// ContainerEngineName resolves an engine without probing its daemon, for the cases that only
// need the name to write down: rendering a configuration file that will launch it later.
//
// Deliberately separate from ContainerEngine. A daemon that is not running right now is no
// reason to write the wrong engine into a file that outlives this moment, and a probe that
// takes a second is no reason to slow down a render.
func ContainerEngineName() (string, bool) {
	for _, name := range containerEngineCandidates() {
		if _, ok := LookPath(name); ok {
			return name, true
		}
	}
	return "", false
}

// containerEngineCandidates is the one place the order and the override live.
func containerEngineCandidates() []string {
	if v := strings.TrimSpace(os.Getenv(EnvContainerEngine)); v != "" {
		return strings.Fields(v)
	}
	return []string{"docker", "podman"}
}
