# Advanced Utility Drones - Manual

**Applies to** v1.0.0 on EveJS 0.12.8, both deployments (native Windows and Docker Compose).

Launch a mining drone and it goes to work: it picks the closest ore or ice rock inside your ship's
drone control range, flies over and mines it, and finds the next rock when that one runs out. Launch
a salvage squadron over a wreck field and each drone takes a wreck of its own, works it and moves on
to the next one. Both kinds come home when the hold they deliver into can no longer take a whole
unit, or when one of the drones takes fire.

Everything happens on the server. No EveJS source file is edited on disk, and **there is nothing to
install on a player's machine**.

## Contents

1. Quick start for players
2. What it does, and what it does not do
3. Requirements
4. Installing
5. Updating and uninstalling
6. Server configuration
7. In-game commands - the `/aud mining` mining menu and the `/aud salvage` salvage menu
8. Per-character settings
9. When the drones come home (the hold rule)
10. Troubleshooting
11. Further reading

## 1. Quick start for players

```text
1. Launch your mining drones anywhere in space. No order needed.
   Launch your salvage drones over a wreck field. No order needed either.
2. Miners pick their own rocks, salvagers pick their own wrecks, and both re-target when a target
   runs out.
3. !aud mining status    - what the mod is doing for your miners right now
   !aud mining focus     - every miner on one rock instead of one rock each
   !aud mining filter add veldspar, kernite      - mine Veldspar first, Kernite second
   !aud mining off       - back to fully manual mining

   !aud salvage status    - what the mod is doing for your salvagers right now
   !aud salvage list      - the wrecks around you, with the owner of each
   !aud salvage distance farthest   - work the field from the far end instead of the near one
   !aud salvage ds farthest         - every command has two spellings, so "ds" is "distance"
   !aud salvage off       - back to fully manual salvaging
```

`!aud ...` goes into ordinary chat. It works for every character, staff or not: the line is
consumed before it reaches the channel, and the answer comes back to you alone. Whatever you change
is saved for your character and survives a restart. The command word is `/aud` and nothing else, and
the kind of drone comes first - `/aud mining` for the miners, `/aud salvage` for the salvagers - because the two
squadrons are separate switches.

## 2. What it does, and what it does not do

**It does**

- Auto-targeting for **ore, ice and moon-ore mining drones** launched from a player ship: the closest
  compatible rock inside the ship's drone control range, then the next one when a rock depletes.
- Auto-targeting for **salvage drones** launched from a player ship: a wreck inside the same control
  range, worked until it is empty, then the next one.
- `spread` (one rock or wreck per drone, default) and `focus` (every idle drone on the closest target).
- For salvagers, which end of the field to start at (`/aud salvage distance nearest|farthest`). Whose wreck
  it was does not enter into it: stripping a hull moves no item, and it is taking the loot that carries
  a suspect flag in this game, so every wreck inside the control radius is a target.
- Auto-recall when the hold the material goes into cannot take one more whole unit, with a
  configurable margin (default 2 m3) so a nearly-full hold cannot turn into an idle/working flap.
- Auto-recall when one of those drones takes fire - the whole squadron comes home and is not
  re-tasked for two minutes.
- A drone you ordered by hand is left completely alone. Only idle drones are ever touched. This is
  configurable (`playerControlPolicy`).
- Works in asteroid belts, ice belts and on moon ore - to a mining drone all three are just ore or
  ice rocks - and over any wreck a drone's own salvage effect can work.
- Flies a drone by the effects its type carries, not by its name, so a hull that launches fifty
  drones puts every one of them to work.

**It does not**

- Touch any client file. Players install nothing.
- Edit any EveJS source file on disk: three module exports are wrapped in memory at startup.
- Touch combat or repair drones, or any assist assignment.
- Touch mining lasers, gas scoops or gas harvesters, loot tables, ore yields, belt composition or
  the market. A salvage drone takes exactly what a manual salvage order takes.
- Have anything to do with gas clouds: **no gas-cloud mining drone exists** in SDE build 3396210.
  All 18 mining drones in the game use the `mining` effect (11 for ore, 7 for ice); `miningClouds` is
  carried only by Gas Cloud Scoop and Gas Cloud Harvester *modules*, which are not drones.

## 3. Requirements

- EveJS 0.12.8, either deployment (native Windows install, or the Docker Compose project).
- Node.js 18 or newer on `PATH` to run the installer. The server itself needs nothing extra.

## 4. Installing

Get the mod folder into `<EveJS root>\mods\AdvancedUtilityDrones` - clone the repository, copy the
folder, or unpack `Source code (zip)` from the release you want - and run the installer from inside it.
The folder name matters: the preload points at `mods\AdvancedUtilityDrones`, so an archive that unpacks
as `EveJS-AdvancedUtilityDrones-main` has to be renamed to that.

The installer and its wrappers live in `installer\` in this checkout - `installer\install.bat`,
`installer\update.bat`, `installer\uninstall.bat`, `installer\status.bat`; the sections below use their
short names.

### 4.1 The installer (Docker and native)

```text
installer\install.bat
```

With no arguments it assumes EveJS is installed on the machine it runs on, finds the root by itself
(it asks when more than one could match) and patches whichever entry point it finds.

| Option | Meaning |
|---|---|
| `--server <path>` | Use this EveJS root instead of searching for one. |
| `--docker-only` | Only patch the Docker entry point. |
| `--native-only` | Only patch `StartServer.bat`. |
| `--dry-run` | Print what would change; write nothing. |
| `--status` | Report the current install and the loader chains (same as `status.bat`). |
| `--update` | Same run, labelled as an update - `update.bat` does this for you. |
| `--force` | Re-apply even when it already looks installed. |
| `--help` | Usage. |

### 4.2 Docker

```text
installer\install.bat
docker compose build
docker compose up -d --no-deps server
```

The installer adds one `--require .../loader.js` line as the **last** entry of the node invocation in
`docker/entrypoint.sh` (in both `run_server()` and `run_all()`), and the image build bakes the mod
folder in.

### 4.3 Native (Windows)

```text
installer\install.bat
```

then restart the server with `StartServer.bat`. The installer **appends** to `NODE_OPTIONS` rather
than overwriting it, so a preload block another loader mod wrote is left intact.

### 4.4 Linux, macOS and Docker hosts

The `.bat` wrappers only call the Node programs beside them, so on a Linux or macOS host - or on a
Docker host with no Node at all - run those programs yourself:

```text
node installer/install.js --server /path/to/EveJS
node installer/update.js --server /path/to/EveJS
node installer/uninstall.js --server /path/to/EveJS
node installer/install.js --status --server /path/to/EveJS
```

Nothing but Docker is needed for the container form, which mounts the checkout into a node:20-alpine
image and runs the installer there:

```text
docker run --rm --user "$(id -u):$(id -g)" \
  -v /path/to/EveJS:/repo -w /repo/mods/AdvancedUtilityDrones \
  node:20-alpine node installer/install.js --server /repo
```

`--server` accepts any path, spaces included, and the mod is installed to
`<EveJS root>/mods/AdvancedUtilityDrones` on every platform. Running the installer from inside an
already-installed `mods/AdvancedUtilityDrones` is supported: the folder it is run from is never pruned,
so `update.js` and `uninstall.js` survive it and the next upgrade is one command.

### 4.5 EveJS Launcher

The launcher wants the mod folder itself, with `evejs-launcher.mod.json` inside it: zip this folder with `AdvancedUtilityDrones\` as the archive root and hand that to the launcher.

### 4.6 Checking it worked

A healthy boot prints five lines. Search the server log for `advancedUtilityDrones`:

```text
[advancedUtilityDrones] v1.0.0 loader ready - control range follows the ship by default; ...
[advancedUtilityDrones] per-character choices live in ...config/advancedUtilityDrones.players.json (loaded: 0 character(s)); the /aud command and the plain-chat !aud trigger work for every character (/aud mining for the mining drones, /aud salvage for the salvage drones)
[advancedUtilityDrones] plain-chat trigger installed - !aud works for every character, staff or not, and the line is never broadcast
[advancedUtilityDrones] chat command overlay installed - /aud works for every character and needs no staff rights
[advancedUtilityDrones] drone tick hook installed - idle drones are re-tasked every 500 ms (mining spread, salvage spread)
```

No lines at all means the preload line is missing - re-run `install.bat` (on Docker, rebuild the
image). A line reading `invalid-config` means the mod refused to start because a setting is wrong; see
section 6.

`status.bat` prints the loader chains the server will really get, read back out of the entry points,
and names both a mod whose block would be dropped and a folder in `mods/` that carries a `loader.js`
but appears in no chain. It also compares the installed folder with the package it is run from: a
hand-edited file, a folder left by an older release, or the copy inside a Docker image (where
`.dockerignore` drops `**/.env`) all differ, and the line says so without blocking anything.

### 4.7 What the installer changed

- Copied the mod folder to `<EveJS root>/mods/AdvancedUtilityDrones`.
- Added exactly one preload line (native: `NODE_OPTIONS` in `StartServer.bat`; Docker: the last
  `--require` entry in `docker/entrypoint.sh`).
- Seeded `config/advancedUtilityDrones.json` and `config/advancedUtilityDrones.players.json`, and
  only if they were missing. On a run over an existing tree the server-wide file is also brought up to
  this release's key set: the keys that are missing are added and stamped with
  `"configVersion": "1.0.0"`, no value in the file is edited, and the file is archived under
  `_advancedutilitydrones-backup/` first. `--dry-run` prints what would be added, `--status` reports
  the shape it found.

Nothing else. No vendor file is patched, so removing the mod is: delete the preload line, delete the
folder.

## 5. Updating and uninstalling

```text
installer\update.bat
```

`update.bat` is `install.bat` with an update label. It archives the folder it is about to replace
under `_advancedutilitydrones-backup/`, re-applies the preload line (and repairs its position if
another mod moved it), reports the version it moved from and to, and leaves every choice you and
your players have made alone. The one write it makes in `config/` is to `advancedUtilityDrones.json`,
where the keys a later release introduced are added (with a `configVersion` stamp) and no value that is
already there is edited. There is no need to uninstall first.

```text
installer\uninstall.bat [--keep-files] [--keep-config] [--dry-run] [--docker-only | --native-only] [--server <path>]
```

It removes the preload line and the mod folder, and archives the configuration files unless
`--keep-config` / `--keep-files` says otherwise. On Docker follow it with
`docker compose build && docker compose up -d --no-deps server`.

## 6. Server configuration

Precedence, highest first:

1. a real environment variable (what `docker run -e` and the compose `environment:` block set), then
2. `<EveJS root>/config/advancedUtilityDrones.json`, then
3. the mod's own `.env` file beside `loader.js`, then
4. the built-in default.

Every environment variable is `<the JSON key in SHOUTY_SNAKE_CASE>` with the prefix
`EVEJS_ADVANCED_UTILITY_DRONES_`; the master switch is the bare prefix `EVEJS_ADVANCED_UTILITY_DRONES`.
`config.example.json` and `.env.example` list every setting you can change, with the shipped default.

Under Docker, `./config` is bind-mounted, so:

```text
edit config/advancedUtilityDrones.json
docker compose restart server
```

That is a restart, not a rebuild - and `docker compose up -d` on its own will not pick up a
file-only change.

| Key | Env var (prefix `EVEJS_ADVANCED_UTILITY_DRONES_`) | Default | Meaning |
|---|---|---|---|
| `enabled` | *(the bare prefix)* | `true` | Master switch for the mining drones. `false` leaves them fully manual. |
| `enabledByDefault` | `ENABLED_BY_DEFAULT` | `true` | Whether a character starts with the automation on. |
| `allowPlayerToggle` | `ALLOW_PLAYER_TOGGLE` | `true` | Allow players to change their own settings in game. |
| `chatTrigger` | `CHAT_TRIGGER` | `true` | Allow the `!aud` ordinary-chat form. |
| `targetMode` | `TARGET_MODE` | `spread` | The mining drones: `spread` = one rock per drone; `focus` = every idle drone on the closest rock. |
| `salvageEnabled` | `SALVAGE_ENABLED` | `true` | Master switch for the salvage drones. `false` leaves them fully manual. |
| `salvageTargetMode` | `SALVAGE_TARGET_MODE` | `spread` | The salvage drones: `spread` = one wreck per drone; `focus` = the whole squadron on one wreck. |
| `salvageDistance` | `SALVAGE_DISTANCE` | `nearest` | Which end of the wreck field the squadron starts at: `nearest` or `farthest`. |
| `claimPenaltyMeters` | `CLAIM_PENALTY_METERS` | `15000` | Distance penalty for a rock another drone of yours already has. |
| `maxCandidates` | `MAX_CANDIDATES` | `48` | How many rocks a single scan scores. |
| `filterScanLimit` | `FILTER_SCAN_LIMIT` | `512` | How many rocks a scan looks at while a "what to mine" filter is set. |
| `filterFallback` | `FILTER_FALLBACK` | `any` | When nothing in range matches a filter: `any` mines the closest rock anyway, `idle` leaves the drones parked. |
| `filterGrade` | `FILTER_GRADE` | `false` | Mine the richest grade of a rock in range before the plainer ones. A grade is part of the type name (`Veldspar II-Grade`, `Blue Ice IV-Grade`); with this off every grade counts the same. |
| `retargetOnFilterChange` | `RETARGET_ON_FILTER_CHANGE` | `true` | Apply a queue change to the drones that are already mining (one re-target on the next scan) instead of waiting for their rock to run out. |
| `scanIntervalMs` | `SCAN_INTERVAL_MS` | `500` | How often a scene is scanned for idle mining drones. |
| `rangeMode` | `RANGE_MODE` | `ship` | `ship` = follow the hull, skills, modules and implants; `fixed` = use `rangeMeters` for everyone. |
| `rangeMeters` | `RANGE_METERS` | *(unset)* | Distance in metres. Setting it **alone** selects `fixed`. |
| `rangeMinMeters` / `rangeMaxMeters` | `RANGE_MIN_METERS` / `RANGE_MAX_METERS` | `1000` / `1000000` | Clamp applied to the resolved range. |
| `baseRangeMeters` | `BASE_RANGE_METERS` | `20000` | The floor that every skill, module and implant bonus is added to. |
| `recallOnFullHold` | `RECALL_ON_FULL_HOLD` | `true` | Recall the squadron when the destination bay cannot take one whole unit. |
| `minHoldFreeVolumeM3` | `MIN_HOLD_FREE_VOLUME_M3` | `2` | Come home once the destination bay has less room than this. `0` disables the margin. |
| `recallOnDamage` | `RECALL_ON_DAMAGE` | `true` | Recall the squadron when one of the drones takes damage. |
| `damageThreshold` | `DAMAGE_THRESHOLD` | `0` | Fraction of HP lost that counts as "took fire". |
| `playerControlPolicy` | `PLAYER_CONTROL_POLICY` | `hold` | What a manual drone order means: `hold`, `recall` or `off`. |
| `postLaunchDelayMs` | `POST_LAUNCH_DELAY_MS` | `2000` | Wait this long after a drone appears before naming it a rock. |
| `stateRefreshMs` | `STATE_REFRESH_MS` | `0,1000,2500,5000` | Re-send the drone's own state at these offsets after an order. |
| `stateKeepAliveMs` | `STATE_KEEP_ALIVE_MS` | `5000` | Keep re-sending a mining drone's state this often. `0` disables it. |
| `maxStalledReassignments` | `MAX_STALLED_REASSIGNMENTS` | `4` | Give up on a drone re-tasked this many times inside 15 s without the bay gaining anything. `0` disables the guard. |
| `refreshStaleSceneCache` | `REFRESH_STALE_SCENE_CACHE` | `true` | Rebuild a system's mining cache when it predates a rock that is now there (moon ore dropped into an already-mined system). |
| `verbose` | `VERBOSE` | `false` | Log every order and every hold verdict with the per-bay figures. |
| `playersFile` | `PLAYERS_FILE` | *(unset)* | Where the per-character settings file lives. |

A value outside its range, or an unknown choice, is reported in the log and makes the loader stay
inert (`invalid-config`) rather than run half-configured. `rangeMode: fixed` without `rangeMeters` is
one of those errors.

`verbose: true` is the setting to turn on when something has to be diagnosed. It prints, for example:

```text
[advancedUtilityDrones] assigned drone 9988400004288 to ore target 5020561034242 at 18855 m, flag 134 2100.25/900000 m3 free
[advancedUtilityDrones] hold stop for controller 9988400004249 (hold nearly full): flag 134 0.25/900000 m3 free, threshold 2 m3
[advancedUtilityDrones] recalled 5 mining drone(s): hold nearly full
```

Leave it off in normal operation; a quiet log is the normal state.

## 7. In-game commands

The command word is **`/aud`** and nothing else, and the **kind of drone comes first**: `/aud mining ...` is
the mining menu and `/aud salvage ...` is the salvage menu. The two squadrons are switched, tasked and
tuned separately, so a bare `/aud off` is refused with a pointer to the two spelled-out forms, and a
bare `/aud` prints both menus. `!aud ...` is the same thing from ordinary chat. With no command at all
after the kind - `/aud mining` or `/aud salvage` - `status` is assumed.

Every command has exactly two spellings - its word and one short form of two letters - and there is no
prefix guessing, because a letter that means one thing here and another thing in the mod next door is
worse than a word that means nothing at all. The two kinds are `mining` / `mi` and `salvage` / `sa`, and
`help` is the one command that also answers to a single letter, `h`. What a command *takes* is always
typed in full, never shortened: `spread`, `focus`, `ore`, `nearest`, `hold`, a number, a name. `copy`
and `clear` take no kind at all - they cover a character rather than a squadron - and are listed by
`/aud help`.

**The mining menu (`/aud mining`, short `/aud mi`)** - inside it `filter` is `fl`, `target` is `tg`, and
so on down the list; `/aud mi fl add veldspar` is `/aud mining filter add veldspar`.

| Command | What it does |
|---|---|
| `status` | Automation state, the drones you have out (mining / idle), assignment and recall counters with the last recall reason, the hold state, your control range with its breakdown, and where your settings come from. |
| `on` / `off` | Turn automatic mining on or off **for your character only**. |
| `target spread` / `focus` | Your targeting mode: one rock per drone, or every idle drone on the closest rock. `target` on its own prints what is set. |
| `filter` | The queue: what is mined, in which order - one numbered list per kind of rock, then the fallback rule and the grade preference. |
| `fl` | The short spelling of `filter`: `/aud mi fl add veldspar, kernite` queues those rocks, `/aud mi fl` prints the queue, and `/aud mi fl help` the filter's command list. |
| `filter add veldspar, kernite, blue ice` | Queue those rocks; the order typed is the order mined. One entry per comma, and a name that holds a space stays one name (`filter add gneiss, dark ochre`). An entry is a rock name, part of one, or a type ID (`1231`); `add` takes no position, and a word that fits nothing - a number no rock has, or a name that is already queued - is passed over with a `warning` line while the rest of the line still goes in. An entry that is already queued keeps the place it has: `add` never reorders, `move` does. |
| `filter move veldspar 2 kernite 1` | Reorder with the numbers the reply printed. The first name picks the kind of rock whose list is edited, and an entry of another kind is passed over with a warning. A name with no number goes to the end of its own list, and the reply carries a `warning` line saying so; a name that is not queued is reported instead of added. |
| `filter del kernite` | Drop an entry by name or type ID - `del 16268` drops Gelidus, and either spelling is printed back as the name. |
| `filter clear ore` / `ice` / `moon` | Empty one kind's list. It is the only filter command that takes a kind word. |
| `filter grade on` / `off` / `default` | Mine the richest grade of a rock in range before the plainer ones, or count every grade the same (default). `default` goes back to the server setting. |
| `fallback any` / `idle` / `default` | What to do when nothing in range matches the queue; `default` goes back to the server setting. |
| `list [ore, ice or moon]` | Every ore type within drone range with the name to queue, the volume left and the nearest distance. |
| `range` | Show the control range and where each part of it comes from. |
| `range <meters>` | Search-radius override for your character, in metres (1000 - 10000000). |
| `range ship` | Drop the override and follow your ship again. |
| `threshold <m3>` | Come home once the destination bay has less room than this (default 2 m3; `0` disables the margin). |
| `control hold` | (default) A drone you order by hand is left alone until it is launched again. |
| `control recall` | Only a manual recall parks drones; anything else keeps being automated. |
| `control off` | Keep automating drones even after you have flown them by hand. |
| `resume` | Hand your drones back to the automation after a manual takeover. |
| `clear` | Forget the mining settings and follow the server defaults again. The salvage switches stay. |
| `help` | The mining commands above, one line each. The filter's own commands are behind `/aud mining filter help` (or `/aud mining fl help`), laid out the same way. |

**Outside the two menus** - these cover a character rather than one kind of drone, so they take no
kind word:

| Command | What it does |
|---|---|
| `/aud` / `/aud help` | The two menus, plus the two commands below. |
| `/aud copy` | How to search, and where the roster of stored characters is. |
| `/aud copy list [name]` | Every character whose settings are stored here - id, name, mode and queue - narrowed by part of a name: `/aud copy list`, `/aud copy list exampel`. The caller is marked `(you)`. |
| `/aud copy <name\|id>` | Copy that character's whole setup, **both kinds of drone**, onto you: `/aud copy exampel`, `/aud copy Example Miner`, `/aud copy User:140000005`. Part of a name is enough, a misspelling is tolerated, and the words may be typed in any order. |
| `/aud clear` | Delete your saved settings and follow the server defaults again, both kinds at once. |

The old spellings - `/atm`, `/altmining`, `!atm`, `!altmining` - answer with a single line naming
the new commands instead of doing anything.

Notes:

- No staff rights are needed: the `!` form is consumed from ordinary chat before it is broadcast, and
  the reply is sent to the sender alone. Nothing of it appears in the channel.
- `copy` needs a character who has used an `/aud` command at least once, so their name is stored here -
  `copy list` lists everybody who has, with what each one has set - and
  `allowPlayerCopy: false` removes the command.
- Everything except `status`, `list` and `help` is refused when the operator sets
  `allowPlayerToggle: false`; `chatTrigger: false` disables the `!` form entirely.
- `/aud ...` only works where the client forwards a slash line to the server, which depends on
  the client build and the character's rights. When in doubt use `!aud ...`.

### 7.1 Choosing what to mine (the queue)

By default every rock inside the control range is fair game. `/aud mining filter` turns that into a queue,
and the drones work down it: they mine the first entry until nothing in range matches it any more,
then the second, and so on.

!aud mining list                                  every rock in range, with the names to queue
!aud mining filter add veldspar, kernite, blue ice Veldspar first, then Kernite, then Blue Ice
!aud mining filter add gneiss, dark ochre         one entry per comma; a name may hold a space
!aud mining filter                                show the queue, one numbered list per kind of rock
!aud mining filter add 1231                       a single type ID
!aud mining filter move kernite 2 veldspar        Kernite second in the ore list, Veldspar to the end
!aud mining filter del kernite                    drop it by name or type ID
!aud mining filter clear ice                      empty the ice list
!aud mining fl add gneiss, dark ochre             the same command - "fl" is the filter's short spelling
!aud mining filter grade on                       the richest grade of a rock in range goes first
!aud copy                                  how to search
!aud copy list [name]                      who has settings stored here
!aud copy exampel                           take that character's whole setup onto you

Rules worth knowing:

- **The order typed is the order mined.** `add veldspar, kernite, blue ice` mines Veldspar first,
  Kernite once no Veldspar is in range, and Blue Ice after that. Adding an entry that is already
  queued changes nothing but the reply: it keeps its place, and says so.
- **The comma is the separator, and one name may hold a space.** `filter add gneiss, dark ochre`
  queues two rocks - Dark Ochre is one rock, not "dark" plus "ochre" - and the space after a comma is
  decoration. A line typed without commas is still read at the spaces, and a run of words that names
  a rock of the game is put back together first, so `filter add gneiss dark ochre` queues the same
  two entries. A comma is never crossed: `filter add dark, ochre` is two patterns on purpose.
- **An entry is a rock name or a type ID, and nothing else.** `filter add veldspar`, `filter add
  gneiss` and `filter add 1231` are the whole grammar. A number on its own is a type ID, and a type
  ID that names no rock is dropped on its own - `filter add kernite 1` queues Kernite and answers
  `warning: "1" is not a rock's type ID ... "/aud mining filter move <name> 1" sets an entry's place` - because
  an entry that can never match a rock would otherwise sit in the queue warning at you in every reply.
  One bad word never costs the rest of the line. Every reply prints a queued
  type ID back as the rock it stands for (`16268` reads as `Gelidus`), because a player standing at a
  belt sees names, not numbers.
- **A name matches any kind.** `veldspar` covers Veldspar, Dense Veldspar, Concentrated Veldspar and
  the rest of the family, and it does not matter whether the rock counts as ore, ice or moon ore.
  Names are matched as substrings, case-insensitively, against the English type name the client shows.
- **A word that stands for a whole kind is not an entry.** `ore`, `ice`, `moon` and `any`/`*` are
  passed over with a warning and the rest of the line is read as usual, because a filter holds rocks
  and `ice` is part of real rock names (Blue Ice, Azure Ice). `/aud mining filter clear ice` is how a whole
  list goes away.
- **Only what you queue is mined.** A kind the queue never mentions is skipped entirely, and a rock no
  entry matches is passed over even when it is the closest rock in range.
- **The fallback still applies.** When nothing in range matches the queue at all, the shipped
  setting is `any`, so the drones mine the closest rock anyway rather than sit idle. Use
  `!aud mining filter fallback idle` for a hard queue that parks them instead.
- **The numbers in a reply are the numbers `move` takes.** Every `filter` reply prints the queue as
  one numbered list per kind of rock - `ore   : 1. veldspar, 2. pyroxeres` - and the numbers restart in
  each list, because each list is mined on its own. `filter move pyroxeres 1` moves the entry that
  list shows as "1.".
- **`move` is the only command that takes a number, and the first name picks the list.** `filter move
  kernite 2 veldspar` counts inside the ore list because Kernite is an ore rock. Name an ice rock
  first and the ice list is the one edited, and a name of another kind on that line is passed over
  with a warning rather than landing in the wrong list. A name typed without a number goes to the end
  of its own list, and the reply carries `warning: <name> without a number, so it was placed at the
  end of the list` instead of doing it silently. A number past the end of a list lands at the end of
  it, and a name that is not queued is reported, because `move` reorders the queue rather than
  growing it.
- **A name that matches no rock is called out.** It is printed on a `warning` line with the name it
  probably meant - `warning: 1. veldsparx (no rock matches that name, did you mean Veldspar?)` - and
  it is still stored as typed: the mod never corrects you on its own. That is also how a rock name
  from another server, or a new ore a mod adds, stays visible instead of disappearing. A *number* is
  the other way round: one that names no rock is refused instead of stored, because it could never
  match anything.
- **`grade on` prefers the richest rock of a family.** The game spawns the same ore at several grades
  and the type name is where that shows - `Veldspar II-Grade`, `Blue Ice IV-Grade` - so with this on
  the drones take the best grade of a rock in range first and work down; with it off every grade
  counts the same. It is per character, and `filter grade default` goes back to the server setting.
- **`clear` is the one command that takes a kind.** `/aud mining filter clear ore`, `clear ice` and
  `clear moon` empty one list, and `/aud mining filter del <name|id>` drops a single entry. The older
  spellings (`filter del ice`, `filter del *`, `filter list`) now answer with the command that
  replaced them, and so does the 1.2.2 per-kind form.
- **A drone that is already mining follows a change at once.** Changing the queue re-targets the
  drones this mod is flying onto the best rock under the new queue on the next scan, about half a
  second later; a drone already on the top-ranked rock is left alone, and a queue that leaves it
  nothing to mine brings it home. A drone you ordered by hand is never touched. Set
  `retargetOnFilterChange: false` to go back to "finish the rock first".
- Whatever is set here is saved for the character, shown by `!aud mining status` on its `filter` line and
  by `!aud mining filter`.

### 7.2 What the replies look like (worked example)

Every `filter` reply prints the queue back, so what you read is what the next command takes. A session
on a fresh character, in order:

```text
> !aud mining filter add veldspar, kernite, blue ice, zeolites
AdvancedUtilityDrones added veldspar, kernite, blue ice, zeolites. Drones already mining switch to the new queue within a second.
  ore   : 1. veldspar, 2. kernite
  ice   : 1. blue ice
  moon  : 1. zeolites

> !aud mining filter add dark ochre, ice
AdvancedUtilityDrones added dark ochre. Drones already mining switch to the new queue within a second.
  ore    : 1. veldspar, 2. kernite, 3. dark ochre
  ice    : 1. blue ice
  moon   : 1. zeolites
  warning: "ice" names a whole kind of rock, so it is not an entry - /aud mining filter clear ice empties the ice list

> !aud mining filter move kernite 1 veldspar
AdvancedUtilityDrones moved kernite, veldspar. Drones already mining switch to the new queue within a second.
  ore   : 1. kernite, 2. dark ochre, 3. veldspar
  ice   : 1. blue ice
  moon  : 1. zeolites

> !aud mining filter add veldsparx
AdvancedUtilityDrones added veldsparx. Drones already mining switch to the new queue within a second.
  ore    : 1. kernite, 2. dark ochre, 3. veldspar
  ice    : 1. blue ice
  moon   : 1. zeolites
  warning: 1. veldsparx (no rock matches that name, did you mean Veldspar?)

> !aud mining filter move blue ice 1 kernite 2
AdvancedUtilityDrones moved blue ice. Drones already mining switch to the new queue within a second.
  ore    : 1. kernite, 2. dark ochre, 3. veldspar
  ice    : 1. blue ice
  moon   : 1. zeolites
  warning: 1. veldsparx (no rock matches that name, did you mean Veldspar?)
  warning: kernite is not ice rock, and the first name picked the ice list - so it was left alone

> !aud mining filter grade on
AdvancedUtilityDrones filter grade: on (the richest grade of a rock in range is mined before the plainer ones). Drones already mining switch to the new queue within a second.

> !aud mining filter clear ice
AdvancedUtilityDrones dropped blue ice from the ice list. Drones already mining switch to the new queue within a second.
  ore    : 1. kernite, 2. dark ochre, 3. veldspar
  ice    : nothing
  moon   : 1. zeolites
  warning: 1. veldsparx (no rock matches that name, did you mean Veldspar?)

> !aud mining filter del veldsparx
AdvancedUtilityDrones dropped veldsparx. Drones already mining switch to the new queue within a second.
  ore   : 1. kernite, 2. dark ochre, 3. veldspar
  ice   : nothing
  moon  : 1. zeolites

> !aud mining filter
AdvancedUtilityDrones filter - the drones work down each list, first entry first:
  ore   : 1. kernite, 2. dark ochre, 3. veldspar
  ice   : nothing
  moon  : 1. zeolites
  fallback: any (with nothing in range matching, "any" mines the closest rock anyway and "idle" parks the drones)
  grade   : on (the richest grade of a rock in range is mined before the plainer ones)
  commands: "/aud mining filter help" - add, move, del, clear, grade, fallback
```

`/aud mining fl help` is the same list as `/aud mining filter help`. Every help list is laid out the same way -
one line per command, the line being what to type, with the detail lines indented under it. A bare
`/aud` prints the two menus, and `/aud help` is those two lines plus the whole-character commands:

```text
> !aud
AdvancedUtilityDrones v1.0.0 - pick the drones to control:
  /aud mining|mi [command] - the mining drones; "/aud mi help" lists the rest
  /aud salvage|sa [command] - the salvage drones; "/aud sa help" lists the rest

> !aud help
AdvancedUtilityDrones v1.0.0 - pick the drones to control:
  /aud mining|mi [command] - the mining drones; "/aud mi help" lists the rest
  /aud salvage|sa [command] - the salvage drones; "/aud sa help" lists the rest
  /aud copy|cp <name|id> - take another character's whole setup onto you, both kinds
      "/aud copy list" shows who has settings stored here, and a bare
      "/aud copy" prints how to search
  /aud clear|cl - forget your personal settings and follow the server defaults

> !aud mining help
AdvancedUtilityDrones v1.0.0 - the commands that follow /aud mining:
  /aud mining on|off - enable or disable automatic mining for your character
  /aud mining target spread|focus - one rock per drone, or every drone on the closest rock
  /aud mining range [<meters|ship>] - show the search radius, or set it
  /aud mining threshold <m3> - come home once the chosen hold has less room than this
  /aud mining filter - show what to mine; "/aud mining filter help" lists the rest
  /aud mining list [ore|ice|moon] - what is mineable around your ship right now
  /aud mining control hold|recall|off - what a manual order means for the mod
  /aud mining resume - undo a manual takeover and let the mod fly those drones again
  /aud mining clear - forget the mining settings and follow the server defaults
  /aud mining status - show the current mining state
  /aud mining help - this list
  Every command has two spellings, and the short one is two letters: mining is
      mi, and then mi on, mi off, mi tg, mi rg, mi th, mi fl, mi ls, mi ct,
      mi rs, mi cl, mi st, mi h. Nothing else is accepted, and what a command
      takes is always typed in full - spread, focus, ore, ice, moon, ship, hold,
      recall or off. "/aud mi tg spread" is "/aud mining target spread".
  "/aud mining clear" clears this kind alone; "/aud clear" clears both, and
  "/aud help" lists the two commands that cover the whole character

> !aud mining filter help
AdvancedUtilityDrones v1.0.0 - the commands that follow /aud mining filter:
  /aud mining filter add <name|id>[, <name|id> ...] - queue what to mine, first
      entry first; the comma separates entries, so a name may hold a space
      ("gneiss, dark ochre" is two); a bare number is a type ID, and a word
      that names no rock is passed over with a warning instead of queued
  /aud mining filter move <name|id> <place> - put one entry at a place in its own
      list; the first name picks the list, and a name typed without a number
      goes to the end
  /aud mining filter del <name|id> - drop one entry; the name or its type ID
      both work
  /aud mining filter clear ore|ice|moon - empty one whole list
  /aud mining filter grade on|off - mine the richest grade of a rock in range
      before the plainer ones
  /aud mining filter fallback any|idle - with nothing in range matching, mine
      the closest rock anyway, or park the drones
  /aud mining filter - show the queue, and the state of grade and fallback
  /aud mining filter help - this list
  The short forms are two letters each: filter is fl, and then ad, mv, dl, cl,
      gd, fb and h - "/aud mi fl ad gneiss" is "/aud mining filter add gneiss".
      What a verb takes is always typed in full: ore, ice, moon, on, off, any,
      idle, a rock name or its type ID.
```

What that run shows:

- **The queue is read back in full every time**, so nothing has to be remembered between commands -
  what a reply prints is what the next command takes.
- **`add dark ochre, ice` queued one entry and warned about the other.** `ice` stands for a whole
  kind, and a filter holds rocks, so it is passed over with the line that empties that list instead.
  The command still succeeded: one bad word does not throw away the good ones.
- **`move kernite 1 veldspar` is a reorder, not two moves.** Kernite goes to the top of the ore list
  and Veldspar, which had no number, goes to the end of it - both belong to that list, so both moved,
  and the `warning` line names Veldspar as the entry that was placed by default.
- **`move blue ice 1 kernite 2` edited the ice list only.** Blue Ice is ice rock, so the first name
  picked the ice list; Kernite is not, so it was passed over with a warning and the ore list was
  left alone.
- **The label column widens when a `warning` line appears**, because "warning" is longer than "moon".
  The numbers do not move: they stay the numbers `move` takes.
- **`clear ice` and `del veldsparx` are the two ways to remove something.** `clear` empties a whole
  kind, `del` drops one entry, and both are printed back as names.
- **Every help list is the same shape, and every command has two spellings.** `/aud mining help` lists
  what follows `/aud mining`; `/aud mining fl help` (the same as `/aud mining filter help`) lists what
  follows `/aud mining filter`, one command per line. A command answers to its word and to one short form
  of two letters - `fl` for `filter`, `tg` for `target`, `st` for `status`, `ds` for `distance` - and to
  nothing else: there is no prefix guessing, and `help` is the only word that also answers to a single
  letter, `h`. `/aud salvage help` is the salvage menu's own list, and a bare `/aud` answers with one line
  per kind of drone.
- **The sentence after `added` is the belt talking.** In space a change reply carries
  `Matching in range: Veldspar, Kernite, Blue Ice.` - up to four ore types within drone range that
  the new queue matches - so it is normal for it to be shorter or longer than the queue itself, and
  it says `Nothing of that kind is in range right now.` when it is empty. The queue lines under it
  are the same either way.

### 7.3 Copying a setup onto another character

`!aud copy <name|id>` hands the **whole** saved setup of another character to the one who types it -
both kinds of drone, with their switches, modes and distance, the whole queue, the
hold threshold, the takeover rule and the range override - which is how a multibox fleet is made
uniform one alt at a time.

- **The identifier is a name, a character ID, or the `User:<id>` label** the client shows. Part of a
  name is enough and a misspelling is tolerated: names are matched exactly first, then as a prefix,
  then as a substring, then with every word of the query in any order, and last with one or two typo
  edits against a word of the name.
- **The copy is exact, not a merge.** The target's entry becomes the source's entry, so a setting the
  source never made is dropped from the target as well - the two characters really are identical
  afterwards. `/aud clear` is still how you deliberately go back to the server defaults.
- **A source with nothing saved is refused**, so a mistyped id cannot wipe a character's settings, and
  **an ambiguous name is refused with the candidates** rather than guessed at.
- **`!aud copy list [name]`** is the roster: every character whose settings are stored here, with id,
  name, mode and queue, the caller marked `(you)`. It keeps *every* match, so `copy list fleet` shows
  both `Fleet Lead` and `Fleet Wing` where `copy fleet` refuses and asks for more of the name.
- **A character becomes findable the first time they run any `/aud` command**, because that is what
  writes their name next to their settings. The `User:` line the client shows is the one to paste: a
  player without staff rights never sees another account's numeric id anywhere else.

```text
> !aud copy list exampel
AdvancedUtilityDrones copy list "exampel" - 2 of 3 character(s) match:
  140000005   Example Miner (you) - mining on spread, veldspar, kernite; salvage on
  140000006   Example Alt - mining on focus, no filter; salvage off
  "/aud copy <name|id>" takes one of their setups onto you.

> !aud copy 140000006
AdvancedUtilityDrones: copied Example Alt (140000006) onto you.
  automation : ON (focus)
  threshold  : 2 m3
  takeover   : hold
  range      : follows your ship
  filter     : veldspar, kernite (fallback any)
  grade      : off
  salvage    : ON (spread, nearest first)
  Drones already mining switch to the new queue within a second.

> !aud copy exampel
AdvancedUtilityDrones: "exampel" fits more than one character - 140000005 (Example Miner), 140000006 (Example Alt). Type more of the name, or the character ID.
```

`allowPlayerCopy: false` removes the command and its roster; it is refused as well when
`allowPlayerToggle: false`, while the read-only listing still answers. The queue a copy carries
reaches drones that are already mining within a second, like any other queue change.
### 7.4 The salvage menu (`/aud salvage`, short `/aud sa`)

Salvage drones work like miners: an idle salvager launched from your ship picks its own target among
the wrecks inside the ship's drone control range. Whose wreck it was is not a question this menu asks -
stripping a hull moves no item, and in this game it is taking the loot that carries a suspect flag, not
the hull - so the switches here are about how the field is worked rather than about who owns it.
Nothing here is shared with the mining menu except the radius, the threshold and the takeover rule,
which belong to the character.

| Command | What it does |
|---|---|
| `status` | Salvage state: drones out (working / idle), wrecks in range, salvage assignments and recalls with the last reason, the hold the material goes into, your control range, and where your settings come from. |
| `on` / `off` | Turn automatic salvage on or off **for your character only**. This is not the mining switch: `/aud mining off` leaves the salvagers working, and `/aud salvage off` leaves the miners working. |
| `target spread` / `focus` | One wreck per drone (default), or the whole squadron on the same wreck. `target` on its own prints what is set. |
| `distance` | Which end of the field is worked first, and what it is set to now. |
| `distance nearest` | (default) The closest wreck first. |
| `distance farthest` | The furthest wreck first - what a long run through a field wants, so the squadron does not crawl back over ground it has already covered. |
| shorter spellings | Every command has two spellings, its word and a two-letter short form: `target` is `tg`, `distance` is `ds`, `threshold` is `th`, `control` is `ct`, `resume` is `rs`, `status` is `st`, and `help` is `h`. Nothing else is accepted, and `spread` / `focus` are values, typed in full. |
| `list` | The wrecks around your ship, in the order the drones will work them: number, name, wreck ID, distance and whose it was. |
| `range` / `range <meters>` / `range ship` | The same control radius as the mining menu - it belongs to the character, not to one kind of drone. |
| `threshold <m3>` | The same margin, read against the cargo hold, which is where this server delivers drone salvage. |
| `control hold\|recall\|off`, `resume` | The same manual-takeover rules as the mining menu. |
| `clear` | Forget the salvage settings and follow the server defaults again. The mining switches stay. |
| `help` | The list above. |

**A wreck is a target whoever it belonged to.** The mod does not ask the game who owns a wreck before
sending a drone, because the answer would not change anything: salvaging a hull is not a criminal act
here - taking the loot is - so a wreck that belonged to another pilot is worked exactly like your own,
and nothing is printed about it. The mod issues the same salvage call a player would, and anything the
game makes of that call is the game's own answer rather than a policy of ours.

```text
> !aud salvage list
AdvancedUtilityDrones wrecks in range (120.0 km):
  1. Wreck (4001) 8500 m - Example Miner's
  2. Wreck (4002) 22.4 km - Another Pilot's
  3. Wreck (4003) 40.1 km - Another Pilot's
  work them with: "/aud salvage on"

> !aud salvage ds farthest
AdvancedUtilityDrones salvage distance: farthest first.

> !aud salvage on
AdvancedUtilityDrones salvage ON for you (spread, farthest first). Salvage drones launched from your ship will pick their own wrecks.
```

## 8. Per-character settings

`<EveJS root>/config/advancedUtilityDrones.players.json` holds one entry per character. The in-game
commands write it; the mod reads it back on every restart. **The two kinds of drone sit side by side**
under `mining` and `salvage`, so a character can automate one and not the other:

```json
{
  "_comment": "Per-character settings for AdvancedUtilityDrones. ...",
  "_help": "mining.enabled: true|false ... salvage.distance: nearest|farthest ...",
  "characters": {
    "140000005": {
      "mining": { "targetMode": "focus", "oreFilter": ["veldspar", "kernite"] },
      "salvage": { "enabled": true, "targetMode": "focus", "distance": "farthest" },
      "minHoldFreeVolumeM3": 1,
      "playerControlPolicy": "hold",
      "updatedAt": "2026-09-21T04:12:03.118Z"
    },
    "140000011": {
      "salvage": { "enabled": false }
    },
    "140000017": { "mining": { "enabled": false } }
  }
}
```

| Field | Values | Meaning |
|---|---|---|
| `mining.enabled` | `true` / `false` | Automate this character's mining drones. |
| `mining.targetMode` | `spread` / `focus` | One rock per drone, or every miner on one rock. |
| `mining.oreFilter` | array | The queue the player built, in order, e.g. `["veldspar", "kernite", "blue ice"]` - a rock name, or a type ID, and every reply prints it back as the name it stands for. 1.2.2's per-kind object is still read. |
| `mining.filterFallback` | `any` / `idle` | What happens when nothing in range matches the queue. |
| `mining.filterGrade` | `true` / `false` | Mine the richest grade of a rock in range before the plainer ones. |
| `salvage.enabled` | `true` / `false` | Automate this character's salvage drones - a separate switch from `mining.enabled`. |
| `salvage.targetMode` | `spread` / `focus` | One wreck per drone, or the whole squadron on one wreck. |
| `salvage.distance` | `nearest` / `farthest` | Which end of the wreck field the squadron starts at. |
| `rangeOverrideMeters` | number / `null` | Search radius for this character; `null` follows the ship. Shared by both kinds. |
| `minHoldFreeVolumeM3` | number | Room the destination hold must keep before the drones come home. Shared. |
| `playerControlPolicy` | `hold` / `recall` / `off` | What a manual drone order means for the automation. Shared. |
| `updatedAt`, `characterName` | written by the mod | Bookkeeping; `characterName` makes the file readable and is what `copy` searches. |

Every field is optional and anything a character does not set falls back to the server defaults, so a
server owner sets the house rules once and each player overrides only what they care about. The split
is one level deep: the radius, the threshold and the takeover rule are not one kind's business, so
they stay at the top level of the entry. The file is hand-editable and is re-read within about five
seconds of a change - no restart. `/aud clear` in game removes the entry, `/aud mining clear` and
`/aud salvage clear` clear one kind and leave the other alone, and uninstalling archives the file under
`_advancedutilitydrones-backup/`.

**A players file written by 1.3.0 or earlier is still read.** That release kept `enabled`,
`targetMode`, `oreFilter` and the rest straight on the character with no kind object; that shape is
read as the *mining* kind, so an upgrade needs no hand editing. A key under `mining` wins over the
same key at the top level, because the nested one is the one somebody typed on purpose.

## 9. When the drones come home (the hold rule)

This is the part that surprises people, because the game's own bay order decides it.

When a mining cycle finishes, the server looks for a bay to put the ore in, in this order:

```text
preferred bay (the specialized ore / ice / gas hold when the hull has one)
  -> the general mining hold (flag 134)
    -> the cargo hold (flag 5)
```

It takes the **first** bay in that list with any room at all, and then it needs **one whole unit** of
the ore to fit. If it does not fit, the cycle is thrown away - the server does **not** continue to the
next bay. So while a hull's mining bay is down to its last sliver, the cargo hold behind it is
unreachable: nothing would be delivered there, and a drone ordered onto a rock anyway would mine
forever with nothing to show for it.

That is why:

- a hull **with** a mining bay (a Rorqual, a Retriever, a Hulk, ...) is judged on that bay alone and
  comes home on it, even though its ordinary cargo hold is still empty;
- a hull **without** one (a Dominix, a battleship hauling ore) is judged on its cargo hold, which is
  then the bay that really receives the ore;
- bays that can never hold ore - the fuel bay, the ship maintenance bay, the fleet hangar - are never
  consulted at all.

The mod recalls the squadron when the bay the server would deliver into cannot take one whole unit
**or** has less than `minHoldFreeVolumeM3` free (default 2 m3). The margin is what stops a nearly-full
bay from turning into an idle/mining flap - and it also covers compressed ore, whose units are a
fraction of a cubic metre.

A real pair of examples, from a Rorqual (900000 m3 mining hold) and a Dominix (750 m3 cargo hold):

```text
hold stop for controller ... (hold nearly full): flag 134 0.25/900000 m3 free, threshold 2 m3
recalled 5 mining drone(s): hold nearly full

hold stop for controller ... (hold full): flag 5 0/750 m3 free, threshold 2 m3
recalled 5 mining drone(s): hold full
```

`!aud mining status` shows the same figures under `hold state`, plus a `hold bays` line when the hull
has more than one bay in play.

**Salvage has no such list.** This server delivers drone salvage straight into the cargo hold
(`flag 5`) - `salvagerRuntime.executeSalvagerCycle` grants the salvaged material there, and its own
space check reads cargo - even on a hull whose SDE entry carries a dedicated salvage hold. The mod
follows the server rather than the SDE, so a salvage squadron is judged on cargo space alone. A
Noctis therefore fills its cargo hold before the squadron comes home; nothing is lost, but the
threshold that stops the flap is about cargo room, not about the salvage hold the hull advertises.

## 10. Troubleshooting

| Symptom | What to check |
|---|---|
| Nothing happens after launching mining drones. | `!aud mining status`: is the automation `ON`, and does the character have drones out? Then check the server-wide `enabled`, and that the drones really are mining drones (ore or ice) launched from a ship - combat, salvage and repair drones are not touched. Nothing is assigned while the ship is warping. |
| The mod never started. | The log has no `[advancedUtilityDrones]` lines: the preload line is missing - re-run `install.bat`, or rebuild the Docker image. A line with `invalid-config` means a setting was rejected; fix it and restart. |
| `!aud` gets no reply. | `chatTrigger: false` disables it; `allowPlayerToggle: false` disables everything except `status`, `list` and `help`. If the text shows up in the channel instead, the trigger is off and the line was broadcast as ordinary chat. |
| Nothing happens after launching salvage drones. | `!aud salvage status`: is the salvage automation `ON` (it is a separate switch from mining), and does the character have drones out? Then check the server-wide `salvageEnabled`. Drones that are not salvage drones are not touched, and a wreck your light refuses is left alone - `!aud salvage list` says which wrecks are which. |
| A salvage drone will not touch a wreck. | `!aud salvage list` shows what is in range and how far it is. Nothing about the wreck's owner can hold a drone back - a wreck is a target in this mod. If a wreck is listed and no drone goes, the hold is the usual reason (see below), or the wreck is outside the control radius shown by `!aud salvage status`. |
| Salvage drones sit idle. | Cargo is the deciding hold for salvage. `!aud salvage status` shows `hold state` and the hold line; if cargo is full or inside the margin they idle instead of working. |
| Drones sit idle at a rock. | That is the recall condition: the destination bay cannot take a whole unit, or is inside the margin. `!aud mining status` shows `hold state`. If `recallOnFullHold: false`, they idle instead of coming home. |
| Drones will not come home when the bay is full. | Check `recallOnFullHold`, and check that nothing else is fighting over those drones. `control hold` plus your own manual order deliberately parks a drone. `maxStalledReassignments` is the backstop for the case the hold rules cannot see. |
| They come home immediately after launch. | The bay really is (nearly) full, or the ship is warping. `!aud mining status` gives the reason of the last recall. |
| A player cannot use `/aud`. | Expected for a character without staff rights - use `!aud`, which is the form built for exactly that. The old `/atm` and `!atm` spellings answer with a rename notice. |
| One of several installed mods does nothing. | Run `status.bat`: it prints the loader chain from both entry points and names any mod whose block would be dropped, plus any folder in `mods/` with a `loader.js` that appears in no chain. |
| A config change had no effect on Docker. | The container has to be restarted: `docker compose restart server`. `docker compose up -d` alone does not pick up a bind-mounted file change. |

## 11. Further reading

- `README.md` - the project overview: what it does, support matrix, limitations.
- `CHANGELOG.md` - what changed in each release, and what to do when upgrading.
- `HOW-IT-WORKS.md` - the mechanism: the exact seams in EveJS, the compatibility contract with other
  server-side mods, and the invariants to preserve if you fork it.
- `config.example.json` / `.env.example` - every setting with its shipped default and comments.
- `RunTests.bat` - the test suite. It uses fixtures and dependency injection, starts no server and
  touches no game data, so it is safe to run on a live box.
- The salvage half of the mod is documented next to the mining half everywhere: `README.md` has the
  summary and the tables, `HOW-IT-WORKS.md` has the mechanism, including why the safety light and the
  entitlement check are the game's business rather than this mod's.