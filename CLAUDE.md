# taildefense

Co-op wave defense over a tailnet: a Go binary `td` (host, client, launcher) and a TypeScript
three.js browser client embedded from `internal/web/dist`.

- Build, test and run Go and Node only through `./build.sh` (containers); never a Go or Node on
  the PATH. `./build.sh check` before committing.
- A change to how the game plays fails the golden game; rewrite it with `./build.sh golden` only
  when the change is meant, so the diff shows it.
- Where things are written down:
  - `README.md`: what td is, setup, dependencies, commands, keys, the architecture picture. Keep
    it short; longer text goes in `docs/`.
  - `docs/playing.md`: the player's guide. `docs/settings.md`: settings, network, updates.
  - `docs/architecture.md`: one tick end to end, and why it's built this way.
  - `docs/development.md`: playtests, the golden game, the demo and the animation lab.
  - `docs/game-design.md`: design decisions and their reasons; update it with the code.
  - `web/PROTOCOL.md`: the contract between `td` and the page; update it with the codec.
