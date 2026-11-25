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
lights right now shows, and ground found before goes back to black. On brutal you start with only a crowbar and no gold, and the base has no walls or gates until you build them. A restart keeps the game's difficulty. The host can also change it
mid-game by clicking the difficulty chip at the top left.

`WAVES` is how long the games you host are: `20`, `30` or `40` (the default) waves, after which
the evac Huey comes for the survivors and the game ends, or `endless`, which goes on until the
generator falls. `--waves` sets it for one run, and the launcher's `w` on Host a game cycles
through them. A restart keeps it.

`MODE` is the kind of game you host: `standard` (the default), or `blades`, a game with no guns.
In a blades game everyone picks a crowbar, a katana or a greatsword when they join (and again
after a restart); the armory sells no gun, and nothing out past the walls hands one over: the
gas station gives a legendary blade instead. Turrets, traps and abilities are as ever. `--mode`
sets it for one run, and the launcher's `m` on Host a game flips it. A restart keeps it.

`FOG` is `off` by default. On, the games you host hide whatever the team cannot see, on any
difficulty; at night (hard and brutal) that is always so.

`VOLUME` is the game's sound, `0` to `100`, `70` by default; `0` (or `off`) turns sound off
altogether. It is this machine's own: everyone in a game sets their own. The slider in the
game's menu (F10) changes it as you drag and saves it when you let go, so the next game starts
where you left it.

`MUSIC` is the game's music, `0` to `100` of the volume, `50` by default; `0` (or `off`) turns
the music off and leaves the sound. It is this machine's own too, with its own slider under
the volume's in the menu.

`RETICLE` is `on` by default: a small reticle lies on the ground under the cursor, so you can see
where a dash, a weapon art, an airstrike or an ultimate aimed at the cursor will go. Even on, it
appears only once you have one of those: the dash or the airstrike bought, the crowbar or a
legendary blade in hand, or a weapon whose ultimate is aimed at a point (the rocket launcher). `off`
never draws it. It is this machine's
own, like the volume, with a switch under the music's slider in the menu (F10) that takes effect
and is saved the moment it flips.

`RETICLE_SIZE` is that reticle's size, `50` to `300` percent, `100` by default. The reticle
already grows as the camera pulls back so that it stays about the same size on screen; this is
a multiplier on top of that. It has its own slider in the menu, under the reticle's switch,
which resizes it as you drag and saves it when you let go.

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

`SLACK_TOKEN` is the Slack bot token, `xoxb-…`, that announces the games you host in a Slack
channel. It is empty by default, which is off; `td config slack_token ""` or `td config
slack_token --reset` clears it again. A token is a secret, so td keeps it in the prefs file,
which td writes readable only by you, and never shows it in clear: `td config` and the
launcher's settings show `xoxb-…` and its last four characters, and the launcher edits it from
an empty field, where leaving the field empty changes nothing.

`SLACK_CHANNEL` is the channel the games you host are announced in: a name, with or without its
`#` (kept as `#name`), or a channel ID such as `C0123ABCD`. It is empty by default, and games are
announced only with both it and the token set. With `td serve` on a machine of its own,
`TAILDEFENSE_SLACK_TOKEN` and `TAILDEFENSE_SLACK_CHANNEL` set them without a prefs file. What
gets posted, and how to set it up, is under [Slack](#slack).

On a Linux laptop with two GPUs the browser draws on the one that drives the screen, usually the
integrated one. The discrete GPU of such a laptop often has no outputs of its own, and every frame
drawn there has to be copied across, which at 5K made the game slower, not faster.

## Slack

With `SLACK_TOKEN` and `SLACK_CHANNEL` both set, a game you host (`td`, `td host` or `td serve`)
is announced in the channel once it is listening:

> **Ada** is hosting taildefense on **box**
> Join with `td join box` · needs td 4f1c2ab
> Hard · 30 waves · blades · fog of war · 2 bots

It always carries the join command and the td version the host runs, since a player on another
version is refused; the mode, fog of war and bots are there only when they are not the default.
When a game ends, its final scoreboard, the picture the host's page draws and keeps in the
screenshots folder, is posted as a reply in the announcement's thread, and every game of the same
hosting (a restart too) replies in that one thread. `td serve` has no page, so it replies with a
line of text instead: the waves held, the kills, who played, and whether the Huey got out or the
generator fell. A game only this machine can reach (tailscale down) is not announced at all, and
td says so when it starts.

Slack never holds up a game: the posts go one after another off to the side, a post waits at most
10 s and the picture 30 s, and a failure is said once in the terminal with what to do about it.
Leaving right at the end still gives the scoreboard a few seconds to go out.

To set it up:

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps) ("From scratch", in your
   workspace).
2. Under OAuth & Permissions, give it the bot token scopes `chat:write` and `files:write`.
3. Install it to the workspace, and copy the Bot User OAuth Token (`xoxb-…`).
4. Invite the bot to the channel: `/invite @name` in the channel.
5. `td config slack_token xoxb-…` and `td config slack_channel C0123ABCD`.
6. `td doctor` checks the token and says which workspace and bot it is and the channel it
   announces in.

Use the channel's ID, which is at the bottom of the channel's details: Slack takes a channel's
name only for a public channel, and the picture can still go to the channel by its ID when the
announcement itself failed.

What leaves the machine: the host's name, this machine's name, the game's settings and version,
and the scoreboard picture with the players' names (or, from `td serve`, their names in the text).
The token goes only to Slack.

## Network

The host listens on its tailnet address and on loopback, port 7787, TCP and UDP, and never on
any other interface. The game runs over TCP; frames, the world sent every tick, go over UDP
when it gets through both ways, so a lost packet costs one frame rather than a stall, and fall
back to TCP on their own when it does not, coming back to UDP once it gets through again, as
after a phone's hotspot drops out for a moment (F3 says which, and why, on its `arrv` line). Only the machine
on the other end of a player's TCP connection, which the tailnet vouches for, can take that
player's frames over UDP. `TAILDEFENSE_NO_UDP=1`, on the host or a player, keeps every frame on
TCP. Players are identified by their tailnet login (`tailscale whois`), so someone who drops
and rejoins keeps their gold and weapons.

The game page is served only on `127.0.0.1`, on a random port. Its URL carries a random token, and
the page's WebSocket refuses a wrong token or a page from another origin. One tab plays at a time;
opening the URL again takes over from the old tab.

Lag? Run `td doctor`. Tailscale sends game traffic straight between machines when it can and
through a DERP relay when it cannot, and a relay adds tens of milliseconds. `td ls` and the
launcher's join list show each game's path beside its ping ("23ms direct", "61ms DERP fra" in
yellow), and `td doctor` says why a path is relayed: UDP blocked (allow outbound UDP 3478 for
STUN), a hard NAT, or a router that opens no ports (enable UPnP or NAT-PMP, or forward UDP 41641
to the machine). `tailscale ping HOST` nudges a direct path and shows which one it took.

## Updates

The version is the git commit. td never updates itself: only `td update` does, run by you,
from the shell or from the launcher (`u`, or Update td now on its menu). At most once an hour the
launcher asks the repo (`git ls-remote` of main) whether main has moved past the installed
commit, without holding up its start; the answer is cached in `~/.taildefense/selfcheck`. When
main has moved on, the launcher's header says "a newer td is out: OLD → NEW · td update installs
it · or press u". Offline, or when the remote does not answer, it says nothing. `td host`, `td
join` and `td serve` say the same in the terminal and in the game page. An install following a
branch hears about its branch, never main, and a pinned one (below) hears about nothing. A host
and its players must run the same td: a host refuses a player whose version differs from its
own, and the refusal names both versions and says to run `td update` on both machines. The
launcher's join list and `td ls` mark such games with ✗.

What `td update` trusts: it clones the repository the install came from (`~/.taildefense/.repo`,
or `TAILDEFENSE_REPO`), then builds and runs what is there: main's tip, or the branch (`-b`) or
commit (`-c`) asked for. The clone's own `build.sh` runs the build, in a container, and the
binary it builds installs itself. So whoever can push to that branch decides what runs on your
machine the next time you update; nothing checks the code beyond git fetching it. Git runs with
no prompts and ssh in batch mode, so a host ssh does not already know fails the fetch rather than
being trusted on first sight.

Earlier tds had an `AUTOUPDATE` setting that updated in the background. A prefs file that still
holds it reads as if it did not; the next change to a setting drops the line.

After installing, `td update` lists the commits it brought in, newest first, read from its own
clone deepened by 200 commits with blobs left out, about a second. An installed commit it cannot
find there (a dirty local build, a branch switch, an install over 200 commits old) gets the latest
15 instead, labelled as such, rather than a guess. It is best-effort: a fetch that fails never
fails the update. Commit subjects are anybody's text, so their escapes and control characters are
stripped where git's log is read, before the list is printed, kept for the launcher, or shown in
its changelog.

`td update -c COMMIT` (or `--commit COMMIT`) builds and installs one commit of main, given as 7 to
40 hex digits: to go back to a version that worked, or to bisect a regression by playing. It
clones main's history without file contents (commits and trees only; the ordinary update stays
one commit deep), and refuses a hash that is not on main, or that is too short to name one commit,
before building anything. Going back, the list after installing is the commits it took out.

The install is then pinned: `~/.taildefense/.pin` holds the commit, and a followed branch is
forgotten. A pinned td is never told of a newer one, nor asks; the launcher, `td version` and
`td doctor` say "pinned to" the commit. A plain `td update` stays: it says so and
does nothing, or rebuilds the pinned commit if something else was put in its place. `td update
-f` returns to main, `td update -b BRANCH` to a branch, and `-c` with another commit moves the
pin. A host and its players still need the same commit, so a pinned host's players pin the same
one. A commit from before pins existed knows nothing of the record, and is also from when the
launcher updated itself: it goes back to main's tip on its own unless `td config autoupdate off`
(a setting that td still had), which `td update -c` says when it installs one.
