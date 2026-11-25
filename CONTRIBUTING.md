# Contributing

taildefense is MIT licensed ([LICENSE](LICENSE)): play it, change it, fork it, ship your own.

## What gets merged

A pull request is merged into `main` when it fits the spirit of the game and the maintainer
likes it. That is a matter of taste, not a checklist, and a "no" says nothing about the quality
of the work: `main` is one person's idea of the game. `docs/game-design.md` records the
decisions made so far and why, which is the best guide to what fits. For anything large, open
an issue first and ask before you build it.

## Your own flavour

A change doesn't have to be merged to be played. Keep it on a branch and install that branch:

```
td update -b your-branch      # build and install that branch
td update                     # later: pick up the branch's new commits
td update -f                  # back to main
```

- `td update` builds from the repository the install came from. For a branch in your fork, name
  the fork once: `TAILDEFENSE_REPO=https://github.com/you/taildefense.git td update -b your-branch`.
  A fresh machine can install straight from it with `install.sh`, which takes `TAILDEFENSE_REPO`
  and `TAILDEFENSE_INSTALL_BRANCH`.
- Everyone in a game runs the same build: a host refuses a player whose version differs. To play
  a flavour together, each player runs the same `td update -b`.
- An install that follows a branch is never autoupdated. td says when the branch has moved on,
  and `td update` brings it in.

Flavours are welcome to stay flavours for good: rebase on `main` when you want what is new there.

## Sending a pull request

- Build and test only through `./build.sh` (containers; no Go or Node on the PATH needed). Run
  `./build.sh check` before you push.
- A change to how the game plays fails the golden game. Rewrite it with `./build.sh golden` only
  when the change is meant, so the diff shows it.
- Update what describes your change: `docs/game-design.md` for a design decision,
  `docs/weapons.md` with `internal/game/defs.go`, `web/PROTOCOL.md` with the codec,
  `docs/playing.md` for what a player sees.
- One change per pull request, against `main`.

## Claude Code

taildefense is developed and maintained with [Claude Code](https://claude.com/claude-code), and
the repo carries its setup: `CLAUDE.md` (the project's rules), `.claude/agents/` (an implementer,
a checker and a browser checker) and `.claude/settings.json` (the `./build.sh` commands allowed
without asking, and no attribution lines on commits). You don't need it to contribute, and
contributions written with any tool or none are judged the same way. If you do use it, it picks
all of this up by itself; put what is particular to your machine in `CLAUDE.local.md` and
`.claude/settings.local.json`, which git ignores.

## Licence of contributions

What you contribute is licensed under the MIT licence, like the rest of the project, and you
confirm it is yours to give. Sounds, music and other assets must be CC0 or as permissive, with a
row in the `CREDITS` file beside them (`web/src/sound/*/`); those files keep the licences listed
there.
