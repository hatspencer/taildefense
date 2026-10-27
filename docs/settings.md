# Settings, networking and updates

What the settings do, how the game uses the network, and how td keeps itself up to date. The
README lists the commands; `td config` shows each setting and where its value came from.

## Settings

`DIFFICULTY` is `easy`, `normal` (the default), `hard` or `brutal`, for the games you host. It
scales creep health and wave size, gold, the time between waves, how tough the loot guards are
and how long a downed player can be revived (20 s on normal). Hard and brutal are played at night:
out past the base you see only a few steps round you (twice as far with a rifle), the map is
black until someone on the team has been there, the dead come out of the dark, and nobody tells
you how many guards a site has left. Brutal's night is darker still: you see a small pool round
you and down your flashlight's beam, only what you, a teammate, the generator or a turret
lights right now shows, and ground found before goes back to black. On brutal you start with only a crowbar and no gold. A restart keeps the game's difficulty. The host can also change it
mid-game by clicking the difficulty chip at the top left.

`WAVES` is how long the games you host are: `20`, `30` or `40` (the default) waves, after which
the evac Huey comes for the survivors and the game ends, or `endless`, which goes on until the
generator falls. `--waves` sets it for one run, and the launcher's `w` on Host a game cycles
through them. A restart keeps it.

`FOG` is `off` by default. On, the games you host hide whatever the team cannot see, on any
difficulty; at night (hard and brutal) that is always so.

`BROWSER` is `auto` by default: td finds the browsers installed (Chrome, Chromium, Brave, Edge,
Vivaldi, Firefox, and Safari on macOS) and starts the best one full screen, as an app window with
a profile of its own that keeps the GPU busy even unfocused, and closes it when the game ends. It
also prints a clickable link per browser it found, so the game can be started in another one, plus
a plain link for any browser. A browser's name (`chrome`, `firefox`…) always uses that one,
`default` opens an ordinary tab in the system's browser, `none` only prints the links, and anything
else is a command run with the URL. In any browser the page keeps the browser's own shortcuts
(save, print, find, zoom, reload, DevTools) out of the game and asks before a running game's page
is closed. `--no-browser` does the same as `none` for one run, which is
handy over SSH.

On a Linux laptop with two GPUs td starts the browser on the discrete one, as the desktop's
"Launch using Discrete Graphics" does, unless `DRI_PRIME` or NVIDIA's offload variables are set
already. Under Wayland a Chromium browser draws on whatever GPU the compositor uses, so td starts it
under XWayland (`--ozone-platform=x11`) when there is one; with a scaled display that window may
look softer.

## Network

The host listens on its tailnet address and on loopback, port 7787, and never on any other
interface. Players are identified by their tailnet login (`tailscale whois`), so someone who drops
and rejoins keeps their gold and weapons.

The game page is served only on `127.0.0.1`, on a random port. Its URL carries a random token, and
the page's WebSocket refuses a wrong token or a page from another origin. One tab plays at a time;
opening the URL again takes over from the old tab.

## Updates

The version is the git commit. With `AUTOUPDATE` on (the default), the launcher checks
the repo's main at most once an hour and updates in the background, then offers a restart.
`td host`, `td join` and `td serve` say when td is out of date and how to update, in the
terminal and in the game page. A host and its players must run the same td: a host refuses a player whose version differs from
its own, and the refusal names both versions and says to run `td update` on both machines. The
launcher's join list and `td ls` mark such games with ✗.

After installing, `td update` lists the commits it brought in, newest first, read from its own
clone deepened by 200 commits with blobs left out, about a second. An installed commit it cannot
find there (a dirty local build, a branch switch, an install over 200 commits old) gets the latest
15 instead, labelled as such, rather than a guess. It is best-effort: a fetch that fails never
fails the update. A background update writes the list to its log.
