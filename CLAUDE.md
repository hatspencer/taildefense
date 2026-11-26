# taildefense

Co-op wave defense over a tailnet: a Go binary `td` (host, client, launcher) and a TypeScript
three.js browser client embedded from `internal/web/dist`.

- Build, test and run Go and Node only through `./build.sh` (containers); never a Go or Node on
  the PATH. `./build.sh check` before committing.
- A change to how the game plays fails the golden game; rewrite it with `./build.sh golden` only
  when the change is meant, so the diff shows it.
- Commits and pull requests carry no attribution lines: no `Co-Authored-By`, no
  `Claude-Session`, no "Generated with" footer or session link.
- `main` takes changes only through pull requests: the remote refuses a direct push. Push a
  branch and open a pull request from it.
- In a worktree, `./build.sh` uses the main checkout's `.gocache` by itself, so run it without
  an environment prefix: the allow rules match only the bare `./build.sh <target>` form.
- Subagents in `.claude/agents/`, each on the cheapest model that does the job:
  - `implementer` (Opus, medium effort): one scoped change from a written brief, checked and
    committed on a branch. Give it its own worktree.
  - `checker` (Haiku): runs `./build.sh check` or a long run and returns only what failed.
  - `browser-check` (Sonnet): looks at the client through the Playwright MCP, keeps the
    screenshots in `screenshots/` and returns what it saw.
  - `model-builder` (Opus): builds or reworks one family of models in `web/src/scene` and
    iterates on its renders against `docs/artdirection.png`. One family and one worktree each;
    several in parallel.
  - `animator` (Opus): how one family of figures moves, judged on frame strips.
  - `art-critic` (Sonnet): holds screenshots beside the picture and lists the differences; a
    read that is not the author's. Edits nothing.
  - `docs-sync` (Sonnet): updates the docs after a verified change.
- `tools/shot.py '<hash>' screenshots/<name>.png` screenshots the built client from a headless
  Chrome of its own, so agents can each look at their work at once (`&webgl` in the hash:
  WebGPU loses its device headless).
- Where things are written down:
  - `README.md`: what td is, setup, dependencies, commands, keys, the architecture picture. Keep
    it short; longer text goes in `docs/`.
  - `docs/playing.md`: the player's guide. `docs/settings.md`: settings, network, updates.
  - `CONTRIBUTING.md`: what gets merged, playing a branch with `td update -b`, the licence (MIT, in `LICENSE`).
  - `docs/architecture.md`: one tick end to end, and why it's built this way.
  - `docs/development.md`: playtests, the golden game, the demo and the animation lab.
  - `docs/art-direction.md`: the look, after `docs/artdirection.png`: what to take from the
    picture, the palette, the sizes agreed.
  - `docs/game-design.md`: design decisions and their reasons; update it with the code.
  - `docs/weapons.md`: the armory's weapons, their stats, upgrade tracks and costs; update it
    with `internal/game/defs.go`.
  - `web/PROTOCOL.md`: the contract between `td` and the page; update it with the codec.
