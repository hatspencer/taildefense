#!/bin/sh
# Install taildefense on macOS or Linux in one line:
#
#   curl -fsSL https://raw.githubusercontent.com/hatspencer/taildefense/main/install.sh | sh
#
# td has no prebuilt downloads: like `td update`, this shallow-clones the repository, builds it
# with the clone's own ./build.sh in Docker or Podman, and runs the new binary's install, which
# puts it in ~/.taildefense and links ~/.local/bin/td. It needs git and a running container
# engine; Tailscale is needed to play, not to install.
#
# TAILDEFENSE_REPO clones a fork, TAILDEFENSE_INSTALL_BRANCH follows a branch other than main,
# and TAILDEFENSE_CONTAINER_ENGINE picks the engine, as they do for td itself.
#
# Everything runs from main at the end, so a download cut short runs nothing.
set -eu

REPO=${TAILDEFENSE_REPO:-https://github.com/hatspencer/taildefense.git}
BRANCH=${TAILDEFENSE_INSTALL_BRANCH:-}
TMP=

fail() {
  echo "error: $*" >&2
  exit 1
}

cleanup() {
  if [ -n "$TMP" ]; then
    # Go writes parts of its cache read-only.
    chmod -R u+w "$TMP" 2>/dev/null || true
    rm -rf "$TMP"
  fi
}

main() {
  case "$(uname -s)" in
    Linux | Darwin) ;;
    *) fail "taildefense runs on Linux and macOS only, not $(uname -s)" ;;
  esac
  command -v git >/dev/null 2>&1 || fail "git is not installed; the installer clones with it"

  engine=
  for candidate in ${TAILDEFENSE_CONTAINER_ENGINE:-docker podman}; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    "$candidate" info >/dev/null 2>&1 || continue
    engine=$candidate
    break
  done
  [ -n "$engine" ] || fail "no container engine: taildefense builds only in Docker or Podman, and neither answers (installed and running?)"

  # Under $HOME, not $TMPDIR: colima, Lima and Rancher Desktop share only $HOME with their VM,
  # and a clone outside it mounts as an empty directory.
  mkdir -p "$HOME/.cache"
  TMP=$(mktemp -d "$HOME/.cache/taildefense-install.XXXXXX")
  trap cleanup EXIT
  trap 'exit 130' INT TERM HUP

  echo "fetching $REPO${BRANCH:+ ($BRANCH)}"
  if [ -n "$BRANCH" ]; then
    GIT_TERMINAL_PROMPT=0 git clone --quiet --depth 1 --branch "$BRANCH" "$REPO" "$TMP/src"
  else
    GIT_TERMINAL_PROMPT=0 git clone --quiet --depth 1 "$REPO" "$TMP/src"
  fi

  echo "building with $engine (the first build pulls the Go and Node images)"
  # stdin is this script when it comes through a pipe; nothing below may read it.
  (cd "$TMP/src" && TAILDEFENSE_CONTAINER_ENGINE=$engine sh ./build.sh install </dev/null)

  if ! command -v tailscale >/dev/null 2>&1; then
    echo "note: tailscale is not on your PATH; install it and log in to host or join games"
  fi
}

main "$@"
