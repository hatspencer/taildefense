#!/usr/bin/env sh
# Build, test or install taildefense in a container, so Go need not be installed here.
#
#   ./build.sh build      static binary for this machine at ./td, browser client included
#   ./build.sh install    build, then run ./td install -f
#   ./build.sh dist       cross-compile dist/td-<os>-<arch> for macOS and Linux
#   ./build.sh check      gofmt verification, go vet, go test, and the client's type check
#   ./build.sh test       go test only, extra arguments go to go test
#   ./build.sh web        the browser client only, into internal/web/dist
#   ./build.sh go <args>  one off go command, e.g. go test ./internal/ui
#   ./build.sh npm <args> one off npm command in web/, e.g. npm install three@0.170.0
#   ./build.sh fmt        gofmt -w every source file
#   ./build.sh tidy       go mod tidy
#   ./build.sh shell      a shell inside the build container (interactive only)
#
# The toolchains always run in the golang and node images as your own user, never a Go or
# Node on PATH, so every install of a commit is the same build. Docker and Podman both work,
# Docker first. Override the images with TAILDEFENSE_GO_IMAGE and TAILDEFENSE_NODE_IMAGE and
# the engines with TAILDEFENSE_CONTAINER_ENGINE.
#
# This is also the build half of `taildefense update`: it clones the repository and runs the
# clone's build.sh, then the new binary's install. The host module cache is mounted, so a
# warm machine builds with no network beyond the git fetch.
set -eu

cd "$(dirname "$0")"

# The same image mf, slip and hive build with, so one pull serves all four. Qualified with
# its registry because Podman enforcing short names would otherwise ask which registry
# "golang" means, and `taildefense update` runs this with no terminal to answer on.
IMAGE=${TAILDEFENSE_GO_IMAGE:-docker.io/library/golang:1.27-alpine}
NODE_IMAGE=${TAILDEFENSE_NODE_IMAGE:-docker.io/library/node:22-alpine}
BINARY=td
PLATFORMS="darwin/arm64 darwin/amd64 linux/amd64 linux/arm64"

usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

ENGINE=

engine() {
  [ -n "$ENGINE" ] && return 0
  for candidate in ${TAILDEFENSE_CONTAINER_ENGINE:-docker podman}; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    "$candidate" info >/dev/null 2>&1 || continue
    ENGINE=$candidate
    return 0
  done
  return 1
}

need_engine() {
  if engine; then
    return 0
  fi
  {
    echo "error: no usable container engine."
    echo "  Tried: ${TAILDEFENSE_CONTAINER_ENGINE:-docker podman}, none installed with a reachable daemon."
    echo "  Install Docker or Podman and try again. A local Go toolchain is not used."
  } >&2
  exit 1
}

# Rootless Podman already maps this user to root in the container, so --user there would
# pick a subuid the host user does not own; keep-id is its equivalent.
engine_id_flags() {
  if [ "$ENGINE" = podman ] &&
    [ "$(podman info --format '{{.Host.Security.Rootless}}' 2>/dev/null)" = true ]; then
    echo "--userns=keep-id"
  else
    echo "--user $(id -u):$(id -g)"
  fi
}

# :z relabels a Podman bind mount for SELinux; without it every read inside is denied.
engine_mount_suffix() {
  if [ "$ENGINE" = podman ]; then
    echo ":z"
  fi
}

# Commit and dirty flag are read on the host: the container has no git. Untracked files do
# not make a build dirty, the same rule mf follows.
commit() {
  if [ -n "${TAILDEFENSE_COMMIT:-}" ]; then
    echo "$TAILDEFENSE_COMMIT"
  else
    git rev-parse --short HEAD 2>/dev/null || echo unknown
  fi
}

dirty() {
  if [ -n "${TAILDEFENSE_COMMIT:-}" ]; then
    echo false
  elif [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    echo true
  else
    echo false
  fi
}

ldflags() {
  echo "-s -w -X taildefense/internal/version.Commit=$(commit) -X taildefense/internal/version.Dirty=$(dirty)"
}

host_target() {
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  case "$os" in
    linux | darwin) ;;
    *)
      echo "error: unsupported OS $os (linux and darwin only)" >&2
      exit 1
      ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=amd64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *)
      echo "error: unsupported architecture $(uname -m)" >&2
      exit 1
      ;;
  esac
  echo "$os/$arch"
}

# The host's module cache, so a warm machine builds with no network. The fallback lives
# outside the tree because Go writes the cache read-only, and an update deletes its clone.
modcache() {
  if [ -d "${GOMODCACHE:-$HOME/go/pkg/mod}" ]; then
    echo "${GOMODCACHE:-$HOME/go/pkg/mod}"
  else
    mkdir -p "${TAILDEFENSE_MODCACHE:-$HOME/.cache/taildefense-modcache}"
    echo "${TAILDEFENSE_MODCACHE:-$HOME/.cache/taildefense-modcache}"
  fi
}

# Per-tree compiler cache; overridable because Go locks it and parallel builds serialise.
GOCACHE_DIR="${TAILDEFENSE_GOCACHE:-$PWD/.gocache}"

# run executes a command in the golang image as the calling user. HOME is a mounted
# directory, not /tmp, so tests that shorten $HOME to ~ see a realistic home.
run() {
  mkdir -p "$GOCACHE_DIR/build" "$GOCACHE_DIR/home"
  need_engine
  z=$(engine_mount_suffix)
  # shellcheck disable=SC2086
  "$ENGINE" run --rm \
    $(engine_id_flags) \
    -e HOME=/gohome \
    -e CGO_ENABLED=0 \
    -e GOFLAGS=-mod=readonly \
    -e GOCACHE=/gobuild \
    -e GOMODCACHE=/gomodcache \
    -v "$PWD:/src$z" \
    -v "$GOCACHE_DIR/build:/gobuild$z" \
    -v "$GOCACHE_DIR/home:/gohome$z" \
    -v "$(modcache):/gomodcache$z" \
    -w /src \
    ${TTY_FLAGS:-} \
    "$@"
}

build_one() {
  os=${1%/*}
  arch=${1#*/}
  out=$2
  echo "  $os/$arch -> $out"
  run -e "GOOS=$os" -e "GOARCH=$arch" "$IMAGE" \
    go build -mod=readonly -trimpath -ldflags "$(ldflags)" -o "$out" .
}

# web_build bundles the browser client into internal/web/dist, which the binary embeds. npm's
# cache lives in the mounted home, so a warm machine installs with no network.
web_build() {
  echo "  client -> internal/web/dist"
  run -w /src/web "$NODE_IMAGE" sh -c 'npm ci --no-audit --no-fund --loglevel=error && npm run --silent build'
}

GO_FILES='find . -name "*.go" -not -path "./.gocache/*" -not -path "./dist/*" -not -path "./web/*"'

cmd=${1:-build}
[ $# -gt 0 ] && shift

case "$cmd" in
  -h | --help | help)
    usage 0
    ;;
  build)
    need_engine
    web_build
    build_one "$(host_target)" "./$BINARY"
    echo "built ./$BINARY ($(commit))"
    ;;
  install)
    need_engine
    web_build
    build_one "$(host_target)" "./$BINARY"
    "./$BINARY" install -f
    ;;
  dist)
    need_engine
    rm -rf dist && mkdir -p dist
    web_build
    for p in $PLATFORMS; do
      build_one "$p" "dist/$BINARY-${p%/*}-${p#*/}"
    done
    # Bare names: the glob expands before the redirect creates SHA256SUMS.
    (cd dist && (shasum -a 256 -- * >SHA256SUMS 2>/dev/null || sha256sum -- * >SHA256SUMS))
    ls -l dist
    ;;
  check)
    need_engine
    run "$IMAGE" sh -c '
      out=$(gofmt -l $('"$GO_FILES"'));
      if [ -n "$out" ]; then echo "gofmt needed:"; echo "$out"; exit 1; fi
      go vet -mod=readonly ./... && go test -mod=readonly ./...'
    run -w /src/web "$NODE_IMAGE" sh -c 'npm ci --no-audit --no-fund --loglevel=error && npm run --silent check'
    ;;
  web)
    need_engine
    web_build
    ;;
  npm)
    need_engine
    run -w /src/web "$NODE_IMAGE" npm "$@"
    ;;
  test)
    need_engine
    run "$IMAGE" go test -mod=readonly "$@" ./...
    ;;
  go)
    need_engine
    run "$IMAGE" go "$@"
    ;;
  fmt)
    need_engine
    run "$IMAGE" sh -c 'gofmt -l -w $('"$GO_FILES"')'
    ;;
  tidy)
    need_engine
    run -e GOFLAGS= "$IMAGE" go mod tidy
    ;;
  shell)
    need_engine
    # A shell with no terminal starts, reads nothing and hangs silently.
    if [ ! -t 0 ] || [ ! -t 1 ]; then
      echo "build.sh shell needs a terminal: stdin or stdout is not a tty." >&2
      echo "Run one command instead: ./build.sh check, or ./build.sh go test ./internal/ui" >&2
      exit 2
    fi
    TTY_FLAGS="-it" run "$IMAGE" sh
    ;;
  *)
    echo "unknown command: $cmd" >&2
    usage 1
    ;;
esac
