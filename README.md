# Alternate Mining Drones for EveJS 0.12.8

EveJS 0.12.8 mod for both supported deployments - native (Windows) and Docker - that gives mining
drones the auto-targeting every other drone in the game already has. Launch a mining drone and it
finds the closest ore or ice inside your ship's drone control range, flies to it and starts mining.
When the hold can no longer take another unit, or when one of those drones takes fire, the whole
squadron recalls itself.

It is server-side only. No vendor file is modified on disk, and **there is nothing to distribute to
players** - the client already renders whatever the server tells it a drone is doing, and this mod
issues exactly the call a player's own mining order issues.

Players steer it from ordinary chat (`!atm ...`), which reaches the server for every character
whatever rights it has; what they choose is saved per character in
`config/alternateMiningDrones.players.json`. The slash form works wherever the client forwards it,
and both run one handler.

See [HOW-IT-WORKS.md](HOW-IT-WORKS.md) for the mechanism, the exact seams, the compatibility
contract with the other server-side mods, and the invariants to preserve if you modify it.
[MANUAL.md](MANUAL.md) is the handbook: install options, every setting, the in-game commands, the
per-character file, when the drones come home, and troubleshooting. [CHANGELOG.md](CHANGELOG.md)
lists what each version changed.

## At a glance

Launch your mining or ice drones and they go to work on their own:

- 🎯 the closest compatible rock inside your ship's drone control range - ore, ice and moon ore all work,
- 🧊 ice harvesting drones take ice and leave your ore alone: each drone type only takes what it can actually mine,
- 🪨 `spread` puts one drone per rock, and the closest rock still takes the leftovers once every other rock has a drone on it; `/atm focus` stacks them all on one rock instead,
- 📦 hold full? the whole squadron recalls itself to the drone bay,
- 🛡️ drone taking fire? the whole squadron comes home and stays home for two minutes,
- 🖱️ ordered a drone somewhere by hand? it is left completely alone - only idle drones are ever touched.

`/atm filter` turns that into a queue, one per kind of rock: an entry is a rock name or a type ID, the
order typed is the order mined, `move` / `del` / `clear` edit it, and `grade on` takes the richest grade
of a rock in range before the plainer ones. Every reply prints the queue as one numbered list per kind
of rock, always by name, and a change reaches drones that are already mining within a second.

The defaults are sensible: on, spread, follow the ship, recall on full hold, recall when shot, grade
off, and nothing queued - the closest rock still gets mined. Settings live in
`config/alternateMiningDrones.json` (every key is documented in `config.example.json`), and every
environment variable is in `.env.example`.

Everything in this repository - `README.md`, `MANUAL.md`, `HOW-IT-WORKS.md` and `CHANGELOG.md` - is
written to be read by a person or fed to an AI, so the mod can be understood and changed.

## Why the server has to do it

In EVE the *client* decides which rock a mining drone mines. It sends
`Handle_CmdMineRepeatedly([droneID], rockID)` (`server/src/services/drone/entityService.js`) and the server mines exactly that rock -
`commandMineRepeatedly` even errors with "That target cannot be mined or salvaged by drones." when
the target is not mineable. Nothing in `droneRuntime.tickScene` ever picks a rock for an idle
mining drone: combat drones get a `droneAssist` assignment, mining drones do not.

A launched mining drone therefore sits at `activityState = STATE_IDLE` with `droneCommand = null`
until a player clicks something. That is the whole gap this mod fills, and it is why the fix belongs
on the server: the client cannot be made to target a rock it does not know the server will accept,
but the server can issue the order itself.

## What it does

| Situation | Behaviour |
|---|---|
| Mining drone launched, no order given | Auto-targets the closest compatible rock in the ship's drone control range and starts mining. |
| Ore drone | Mines ore asteroids (Veldspar, Arkonor, moon ore, ...). |
| Ice harvesting drone | Mines ice only. `miningClouds` exists **only** on gas scoop and gas harvester modules in SDE 3396210, so no gas-cloud drone exists to automate. |
| Several idle drones, default `spread` | One rock each; the closest rock still collects the remainder when every other rock in range already has a drone on it. |
| `focus` mode | Every idle drone on the closest compatible rock. |
| **What to mine, in order** | `/atm filter add veldspar, kernite, blue ice` queues the rocks to mine, and the order typed is the order mined: the drones only move on to the next entry once nothing in range matches the one above it. Every entry is a rock name or a type ID (`1231`), one per comma, and a name matches any rock whose own name contains it - so `dark ochre` is one rock, not two. A bare number has to name a rock: `add 1231` is queued, while a word that fits nothing - a number no rock has, or a name that is already in the list - is passed over with a `warning` line and the rest of the line still goes in. `add` never reorders an entry that is already queued; `move` is the command that moves one. `/atm filter move` reorders an entry with the number the reply printed - a name typed without one goes to the end of its list, and the reply says so - `del` drops one, `clear ore\|ice\|moon` empties a whole kind, and `grade on` sends the drones to the richest grade of a rock in range first and re-tasks the drones that are already mining. Every reply prints the queue as one numbered list per kind of rock, always by name - a queued type ID reads back as the rock it stands for. A name that matches no rock is reported on a `warning` line with the name it probably meant, `/atm list` prints the names to queue, and `/atm filter help` (or `/atm f help`, the filter's short spelling) lists the filter's own commands. A change reaches the drones that are already mining within a second. |
| **Multibox fleet** | `/atm copy <name\|id>` hands another character's whole setup - mode, threshold, takeover rule, range and the full queue - to the character who types it. Part of a name is enough and a misspelling is tolerated, because a player without staff rights never gets to see another account's ID. `/atm copy` on its own shows how to search; `/atm copy list [name]` shows who is stored here. |
| Rock depleted | The drone goes idle again and is re-targeted on the next scan. |
| Hold cannot take one more unit | Every mining drone of that ship recalls to the drone bay. The deciding bay is the one the server delivers into: the hull's own mining bay when it has one, its cargo hold otherwise. |
| Cargo hold still has room | Ignored on a hull that has a mining bay: the server takes the mining bay first and never spills into cargo, so the squadron comes home instead of working a rock nothing can be delivered from. |
| Bay nearly full | Recall before the last sliver, so a bay that cannot take a whole unit never turns into an idle/mining flap (`minHoldFreeVolumeM3`, default 2 m3). |
| One of those drones takes damage | Every mining drone of that ship recalls to the drone bay, then stays put for 120 s. |
| Player ordered a drone by hand | That drone is left alone until it is launched again; the rest of the squadron keeps working. Configurable with `playerControlPolicy`. |
| Ship is warping | Nothing is assigned. |
| `/atm off`, or `!atm off` from chat | That character's mining drones go back to being fully manual. |

## Install

Get this folder into `<EveJS root>\mods\AlternateMiningDrones` - clone the repository, copy the
folder, or take `Source code (zip)` from the release you want - and run the installer from inside it.
The folder name matters: the preload points at `mods\AlternateMiningDrones`, so a GitHub archive that
unpacks as `EveJS-AlternateMiningDrones-main` has to be renamed to that.

```text
installer\install.bat
```

What it does is register the preload for the deployment you actually run - Docker or native - and
nothing else. It is idempotent, it backs up every file it rewrites to
`<EveJS root>\_alternateminingdrones-backup\<timestamp>\` first, and `installer\uninstall.bat` removes
its own line and leaves the rest alone.

### Installer (native and Docker)

Run the installer with no arguments and it assumes EveJS is installed on this computer,
finds the root itself - beside this folder, above it, and as a last resort on the local
drives - and stops to ask if the machine holds more than one checkout. Use
`--server "C:\path\to\EveJS"` only to override that search.

It copies this folder to `<EveJS root>\mods\AlternateMiningDrones` and registers the preload in every
deployment it finds:

| Deployment | Registered in | Entry added |
|---|---|---|
| Docker | `docker/entrypoint.sh`, in both `run_server()` and `run_all()` | `--require /app/mods/AlternateMiningDrones/loader.js` |
| Native | `StartServer.bat`, whose `NODE_OPTIONS` both `npm start` branches inherit | `NODE_OPTIONS=--require "...\mods\AlternateMiningDrones\loader.js"` |

The entry is appended **last** in the continuation list on purpose: require order is
`Module._load` hook order, and only the last-installed hook sees the exports object the final
transform produced. Every file the installer rewrites is copied to
`<EveJS root>\_alternateminingdrones-backup\<timestamp>\` first.

Afterwards rebuild a Docker deployment, or restart a native one:

```text
Docker : docker compose build && docker compose up -d --no-deps server
Native : restart the server with StartServer.bat
```

A healthy boot logs five lines:

```text
[alternateMiningDrones] v1.3.0 loader ready - control range follows the ship by default; ...
[alternateMiningDrones] per-character choices live in ...config/alternateMiningDrones.players.json (loaded: 0 character(s)); both /atm (alias /altmining) and the plain-chat !atm trigger work for every character
[alternateMiningDrones] plain-chat trigger installed - !atm works for every character, staff or not, and the line is never broadcast
[alternateMiningDrones] chat command overlay installed - /atm works for every character and needs no staff rights
[alternateMiningDrones] drone tick hook installed - idle mining drones are re-tasked every 500 ms (spread mode)
```

### Updating

```text
installer\update.bat
```

A reinstall is already an upgrade: `copyPayload` never overwrites a local `.env`, and the two
configuration files are written only when they are missing. `update.bat` is therefore the same
program as `install.bat` with a different label - it archives the folder it replaces, prints the
version it moved from and to, and touches `config/` in one way only: the keys a later release
introduced are added to `config/alternateMiningDrones.json`, with a `configVersion` stamp, and not one
value that is already in there is changed. Use `install.bat` if you prefer; both work.

### Manually

1. Copy this folder to `<EveJS root>/mods/AlternateMiningDrones`.
2. Add `--require /app/mods/AlternateMiningDrones/loader.js \` as the **last** `--require` line
   inside the `node` invocation of both `run_server()` and `run_all()` in `docker/entrypoint.sh`.
3. `docker compose build && docker compose up -d --no-deps server`.

No vendor file is patched, so uninstalling is: remove the two `--require` lines, delete the folder,
rebuild. `installer\uninstall.bat` does exactly that.

## Configuration

Precedence, highest first:

1. a real environment variable (what `docker run -e` and `compose.yaml` `environment:` set),
2. `<EveJS root>/config/alternateMiningDrones.json`,
3. the mod's own `.env` beside `loader.js`,
4. the built-in default.

Under Docker `./config` is bind-mounted, so editing the JSON needs a container restart and never an
image rebuild - that is the recommended place for a Docker deployment. `.env` is excluded from the
image by `.dockerignore` (`**/.env`), which is why the JSON exists.

[`config.example.json`](config.example.json) is a ready-to-copy template, and the installer writes
exactly that file for you when it is missing; from then on the file is yours, and an update only
adds a key a later release introduced. Nothing has to be set: the defaults already do the right thing, including following the ship's drone control range.

### Per-character settings

`<EveJS root>/config/alternateMiningDrones.players.json` holds one entry per character. This is what
`/atm` and `!atm` write, and what the mod reads back on every restart:

```json
{
  "_comment": "Per-character settings for AlternateMiningDrones. ...",
  "_help": "enabled: true|false ...",
  "characters": {
    "140000005": {
      "targetMode": "focus",
      "minHoldFreeVolumeM3": 1,
      "playerControlPolicy": "hold",
      "updatedAt": "2026-09-18T04:12:03.118Z"
    },
    "140000011": {
      "targetMode": "spread",
      "minHoldFreeVolumeM3": 4
    },
    "140000017": { "enabled": false }
  }
}
```

Every key inside an entry is optional, and anything a character does not set falls back to
`config/alternateMiningDrones.json` - so an owner sets the house rules once and each player overrides
only what they care about. The file is created by the installer and by the first boot, it is re-read
within 5 s of a hand edit, it travels with the mod, and `installer\uninstall.bat` removes it after archiving it
under `_alternateminingdrones-backup/`. `playersFile` puts it somewhere else.

`/atm reset` deletes a character's entry and puts them back on the server defaults.

`/atm copy <name|id>` goes the other way round: it reads another character's entry out of this file
and writes it onto yours, complete and exact - a key the source never set is dropped from your entry
instead of being left behind, so two characters really do end up identical. The name to search for is
the `characterName` above, so a character becomes findable the first time they run any `/atm` command;
`/atm copy` with no argument shows the examples. `/atm copy list` names everybody who is
stored here, `/atm copy list exampel` narrows that to the ones whose name matches.

### The settings that matter

| JSON key | Env var | Default | Meaning |
|---|---|---|---|
| `enabled` | `EVEJS_ALT_MINING_DRONES` | `true` | Master switch. `false` leaves mining drones manual. |
| `targetMode` | `..._TARGET_MODE` | `spread` | `spread` = one rock per drone, `focus` = all drones on the closest rock. |
| `rangeMode` | `..._RANGE_MODE` | `ship` | `ship` = follow the hull/skills/modules/implants, `fixed` = use `rangeMeters`. |
| `rangeMeters` | `..._RANGE_METERS` | *(unset)* | Distance in meters. Setting it **alone** selects `fixed` mode. |
| `recallOnFullHold` | `..._RECALL_ON_FULL_HOLD` | `true` | Recall when no bay can accept one more unit. |
| `recallOnDamage` | `..._RECALL_ON_DAMAGE` | `true` | Recall when one of the drones takes damage. |
| `filterScanLimit` | `..._FILTER_SCAN_LIMIT` | `512` | How many rocks one scan looks at while a queue is set, instead of `maxCandidates`. |
| `filterFallback` | `..._FILTER_FALLBACK` | `any` | When nothing in range matches the queue: `any` mines the closest rock anyway, `idle` leaves the drones parked. |
| `filterGrade` | `..._FILTER_GRADE` | `false` | Mine the richest grade of a rock in range before the plainer ones. A grade is part of the type name (`Veldspar II-Grade`, `Blue Ice IV-Grade`), and with this off every grade counts the same. |
| `retargetOnFilterChange` | `..._RETARGET_ON_FILTER_CHANGE` | `true` | Apply a queue change to the drones that are already mining, with one re-target on the next scan, instead of waiting for their rock to run out. |
| `scanIntervalMs` | `..._SCAN_INTERVAL_MS` | `500` | How often a scene is scanned for idle mining drones. |
| `minHoldFreeVolumeM3` | `..._MIN_HOLD_FREE_VOLUME_M3` | `2` | Recall once the destination bay has less room than this. `0` disables the margin. |
| `playerControlPolicy` | `..._PLAYER_CONTROL_POLICY` | `hold` | What a manual drone order means to the automation: `hold`, `recall` or `off`. |
| `chatTrigger` | `..._CHAT_TRIGGER` | `true` | Allow `!atm ...` from ordinary chat, the only channel a character without staff rights can use. |
| `allowPlayerToggle` | `..._ALLOW_PLAYER_TOGGLE` | `true` | Allow `/atm` per-character control. |
| `allowPlayerCopy` | `..._ALLOW_PLAYER_COPY` | `true` | Allow `/atm copy`, which hands one character's saved setup to another. |
| `postLaunchDelayMs` | `..._POST_LAUNCH_DELAY_MS` | `2000` | Wait this long after a drone appears before naming its first rock. |
| `stateRefreshMs` | `..._STATE_REFRESH_MS` | `0,1000,2500,5000` | Re-send the drone's own state at these offsets after an order, until the server reports it mining. |
| `stateKeepAliveMs` | `..._STATE_KEEP_ALIVE_MS` | `5000` | Keep re-sending a mining drone's state this often. `0` disables it. |
| `maxStalledReassignments` | `..._MAX_STALLED_REASSIGNMENTS` | `4` | Park a drone re-tasked this many times inside a 15 s window without the bay gaining anything. `0` disables the guard. |

[`.env.example`](.env.example) documents every key, including `claimPenaltyMeters`,
`rangeMinMeters`, `rangeMaxMeters`, `baseRangeMeters`, `damageThreshold`, `maxCandidates`,
`enabledByDefault`, `refreshStaleSceneCache` and `verbose`.

### Drone control range

With `rangeMode: "ship"` (the default) the search radius is the same number the client shows for the
ship, computed the way the client computes it:

```text
20 km base (character attribute 458 droneControlDistance)
+ 5 km per Drone Avionics level        (attribute 459, Drone Avionics)
+ 3 km per Advanced Drone Avionics level (attribute 459, Advanced Drone Avionics)
+ 20 km per fitted Drone Link Augmentor  (attribute 459, +24 km for the II)
+ any implant/booster bonus              (Halcyon Y-1..Y-5: 4..20 km)
```

Every one of those modifiers is an additive `ItemModifier` onto attribute 458, so the sum is what the
client displays. A Rorqual with both drone skills at V and three Drone Link Augmentor I resolves to
**120 km**; add a Halcyon Y-5 implant and it is 140 km. The roster is resolved live from the fitted
hull, so swapping a module or training a level changes the radius without a restart. The value is
clamped by `rangeMinMeters`/`rangeMaxMeters`.

## Chat commands

No GM or staff role is required - these are per-character, exactly like `/motd` or `/where`.

| Command | Effect |
|---|---|
| `/atm status` | Automation state, drones in space/mining/idle, assignment and recall counters, and the resolved control range with its breakdown. |
| `/atm on` / `off` | Turn automatic mining on or off for **your character only**. |
| `/atm spread` / `focus` | Your targeting mode. |
| `/atm range` | Show the control range and where each part of it comes from. |
| `/atm range 120000` | Search radius override for your character, in meters. |
| `/atm range ship` | Drop the override and follow your ship again. |
| `/atm threshold 4` | Recall once the destination bay has less than 4 m3 free. |
| `/atm filter` | The queue: what is mined, in which order - one numbered list per kind of rock, then the fallback and whether the grade preference is on. |
| `/atm f ...` | The short spelling of `filter`: `/atm f add veldspar` is `/atm filter add veldspar`, `/atm f` prints the queue, and `/atm f help` the list. |
| `/atm filter add veldspar, kernite, blue ice` | Queue those rocks - the order typed is the order mined. One entry per comma, and a name that holds a space stays one name (`add gneiss, dark ochre`). An entry is a rock name, part of one, or a type ID (`1231`); `add` takes no position, and a word that fits nothing - or a name that is already queued - is passed over with a `warning` line while the rest of the line still goes in. |
| `/atm filter move veldspar 2 kernite 1` | Reorder with the numbers the reply printed. The **first name picks the kind of rock** whose list is edited, and an entry of another kind is passed over with a warning. A name with no number goes to the end of its list; a name that is not queued is reported instead of added. |
| `/atm filter del kernite` | Drop an entry by name or type ID - `del 16268` drops Gelidus, and either spelling is printed back as the name. |
| `/atm filter clear ore` / `ice` / `moon` | Empty one kind's list. It is the only filter command that takes a kind word. |
| `/atm filter grade on` / `off` | Mine the richest grade of a rock in range before the plainer ones, or count every grade the same (default). Per character; `default` goes back to the server setting. |
| `/atm list` | Every ore type in drone range with the name to queue, the volume left and the nearest distance. |
| `/atm control hold` | A drone you order by hand is left alone until it is launched again (default). `recall` only reacts to a manual recall; `off` keeps automating it. |
| `/atm resume` | Hand your drones back to the automation after a manual takeover. |
| `/atm copy` | How to search, and where the roster of stored characters is. |
| `/atm copy list [name]` | Every character whose settings are stored here - id, name, mode and queue - narrowed by part of a name. The caller is marked `(you)`. |
| `/atm copy exampel` / `copy User:140000005` | Copy that character's whole setup onto you - part of a name is enough, and a name typed in the wrong order or one letter off still finds them. |
| `/atm reset` | Delete your saved settings and follow the server defaults again. |
| `/atm help` | The list above. The filter's own commands are behind `/atm filter help` (or `/atm f help`), in the same one-line-per-command shape. |

`/altmining` is the one long form and `!altmining` works in chat; the command word takes no other spelling. `filter` is the exception with a short form, `f`.
Setting `allowPlayerToggle: false` removes the per-character commands and leaves only the server
defaults.

**The plain-chat form is the one that always works.** A line beginning with `/` is sent by the client
as a `slash.SlashCmd` call, and EveJS applies no role gate to it - `slashService.js` runs the same
`executeChatCommand` for everybody. Whether a *client* forwards an unrecognised `/` command is
another matter, and on a character without staff rights it may not. Everything else is an ordinary chat
message, which the server broadcasts without ever looking at it, so the mod consumes the line where it
would be broadcast:

```text
!atm status
!atm focus
!atm control hold
```

`chatTrigger: false` switches the plain-chat channel off, and the line is consumed before anything is
stored or delivered: it is never broadcast. The reply comes back to the sender alone, as a system
message. `/`, `.` and `!` all run the same handler.

## Scope

Affects:

- idle mining drones launched from a player ship - ore, ice and moon ore.
- the ship's mining drones as a group, for the recall triggers.

Does not touch:

- any game client file - nothing to distribute to players.
- any EveJS source file on disk - three exports are wrapped in memory at startup.
- combat, salvage or repair drones, or an assist assignment.
- a drone you ordered by hand: only `droneCommand`-less, `STATE_IDLE` drones are candidates.
- mining lasers, gas scoops and gas harvesters.
- loot, ore yields, belt composition, rock volume or the market.

## Compatibility

This mod adds no source transform and pins no file hash, so it cannot conflict with a mod that
rewrites the same files. It wraps exactly two exports after everything else has loaded:
`droneRuntime.tickScene` and `chatCommands.executeChatCommand`. It additionally *chains* the nine
player-facing drone order functions (`commandMineRepeatedly`, `commandEngage`, ...) purely to observe
them: each wrapper calls the original and returns its result unchanged, so another mod that wraps or
replaces them still sees the same behaviour.

Verified against the other server-side mods on this server - `fourModeAsteroidBelts`,
`soloProgressionBalance`, `moonOreAnomalies` and `autopilotJumpZero`. None of them touches
`tickScene`, and each composes with the others' `executeChatCommand` overlay by chaining.
`fourModeAsteroidBelts` rewrites `droneRuntime.js` by compiling transformed source, which is exactly
why this loader must be preloaded **last**: a mod that replaces the whole exports object would
discard a patch applied to the previous one.

## Limitations

- **Gas clouds** cannot be mined by any drone in this SDE. `miningClouds` appears only on Gas Cloud
  Scoop and Gas Cloud Harvester *modules*. There is nothing to automate.
- **Moon-ore chunks** are spawned into a system's static entity list after the fact, while the
  server caches the mineable state of a system once (`ensureSceneMiningState`). A chunk that appears
  in a system somebody is already mining is invisible to *every* mining path, including a manual
  laser, until the cache is dropped. With `refreshStaleSceneCache` (default on) this mod drops it
  the moment such a rock appears and then mines normally.
- Recall uses `commandReturnBay`, so recalled drones dock and must be relaunched. That is the
  "come home" the auto-recall is for; there is no return-to-orbit-and-wait mode.
- Drones are re-targeted at most once per `scanIntervalMs` (default twice a second), and only from
  `tickScene`, so a scene with no drone activity costs nothing.

## Tests

```text
RunTests.bat
```

`test/run.js` covers the control-range arithmetic, target selection, spread/focus, hold-full and
damage recall, recall suppression, the scan throttle, the per-player switch, configuration parsing
(including the short-key JSON form), the per-character settings file and its restart behaviour, the
hold policies and the near-full threshold, the stalled-drone guard, the plain-chat trigger and its
off switch, the manual-takeover parking and resume, the state-replay schedule, the `Module._load`
seam with a real round trip through the wrapped drone commands, the queue grammar and its reading of
the 1.2.2 per-kind shape, what each verb does with a word that names nothing (`add` dropping it and
queueing the rest, `move` warning about a name typed without a place, `del` reaching an entry from
either spelling), the two help lists and the filter's short spelling `f`, the grade preference and
its place in the signature that re-tasks a working drone, the ore-name catalogue that groups a reply
by kind (including the live mining state outranking the static table), the grouped lines and the
`move` command that read it, the `/atm copy` finder (id, `User:` label, partial, reordered and
misspelt names), the `copy list` roster that narrows itself with the same matcher and keeps every
match, and the copy's exact, non-merging replacement of a character's entry, the installer's
registration transforms including an end-to-end install/reinstall/uninstall against a throwaway
EveJS tree, and the configuration migration that brings an older `config/alternateMiningDrones.json`
up to the installed release's key set.

