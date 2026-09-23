# Advanced Utility Drones for EveJS 0.12.9

EveJS 0.12.9 mod for both supported deployments - native (Windows) and Docker - that gives mining and
salvage drones the automatic target selection they otherwise have to be given by hand. Launch a miner
and it finds the closest ore or ice inside your ship's drone control range, flies to it and starts
mining. Launch a salvage squadron over a wreck field and each drone takes a wreck of its own, works
it and moves on to the next one. When the hold can no longer take another unit, or when one of those
drones takes fire, the whole squadron recalls itself.

It is server-side only. No vendor file is modified on disk, and **there is nothing to distribute to
players** - the client already renders whatever the server tells it a drone is doing, and this mod
issues exactly the call a player's own order issues.

Players steer it from ordinary chat (`!aud mining ...` for the miners, `!aud salvage ...` for the salvagers),
which reaches the server for every character whatever rights it has; what they choose is saved per
character in `config/advancedUtilityDrones.players.json`. The slash form works wherever the client
forwards it, and both run one handler. `/aud` on its own prints the two menus and nothing else: the
kind of drone comes first, because the two squadrons are switched separately - `/aud mining off` parks the
miners and leaves the salvagers working, and `/aud salvage off` does the opposite.

See [HOW-IT-WORKS.md](HOW-IT-WORKS.md) for the mechanism, the exact seams, the compatibility
contract with the other server-side mods, and the invariants to preserve if you modify it.
[MANUAL.md](MANUAL.md) is the handbook: install options, every setting, the in-game commands, the
per-character file, when the drones come home, and troubleshooting. [CHANGELOG.md](CHANGELOG.md)
lists what each version changed.

## At a glance

Launch your mining or ice drones and they go to work on their own:

- 🎯 the closest compatible rock inside your ship's drone control range - ore, ice and moon ore all work,
- 🧊 ice harvesting drones take ice and leave your ore alone: each drone type only takes what it can actually mine,
- 🪨 `spread` puts one drone per rock, and the closest rock still takes the leftovers once every other rock has a drone on it; `/aud mining focus` stacks them all on one rock instead,
- 📦 hold full? the whole squadron recalls itself to the drone bay,
- 🛡️ drone taking fire? the whole squadron comes home and stays home for two minutes,
- 🖱️ ordered a drone somewhere by hand? it is left completely alone - only idle drones are ever touched.

`/aud mining filter` turns that into a queue, one per kind of rock: an entry is a rock name or a type ID, the
order typed is the order mined, `move` / `del` / `clear` edit it, and `grade on` takes the richest grade
of a rock in range before the plainer ones. Every reply prints the queue as one numbered list per kind
of rock, always by name, and a change reaches drones that are already mining within a second.

Launch salvage drones over a wreck field and each one picks a wreck of its own:

- 🔧 the nearest wreck first, or the far end of the field first with `/aud salvage distance farthest`,
- 🧭 `/aud salvage target spread` gives every drone its own wreck, `/aud salvage target focus` puts the whole squadron on one,
- 🔒 a wreck belongs to somebody, but stripping a hull is not what carries a flag in this game - taking the loot is - so the squadron works any wreck in range,
- 📦 salvage material goes into the cargo hold - no hull here has a hold that receives it anywhere else - so that is the hold the rule watches,
- 🖱️ a drone ordered by hand is left alone, exactly like a miner,
- 🛰️ ships in the same fleet share one claim ledger and one wreck scan per pass, while separate fleets
  and solo pilots remain independent.

Both kinds fly by what a drone *is*, not by what it is called: a hull that launches fifty drones
puts all fifty to work, not the handful whose names happened to be on a fixed list. Mining claims work
the same way: same-fleet miners see each other's active rocks before an idle drone chooses.

The defaults are sensible: mining on, spread, follow the ship, recall on full hold, recall when shot,
grade off, and nothing queued - the closest rock still gets mined. Salvage is on as well, spread and
nearest wreck first, and every wreck in range is workable. Settings live in
`config/advancedUtilityDrones.json` (every key is documented in `config.example.json`), and every
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

Salvage works the same way for the same reason. `droneRuntime.commandSalvage` (reached through
`Handle_CmdSalvage` in `server/src/services/drone/entityService.js`) can pick a wreck *for* the
drone - `resolveAutomaticSalvageTarget` - but only ever an **owned** one, only from a player's own
order, and only with the player's session in hand: nothing in `tickScene` ever makes that call for an
idle drone. The salvage a player knows from the client's own auto-salvage button is that call, and it
is still a click. This mod makes the click unnecessary. It works every wreck in range, with no ownership filter of its
own: stripping a hull moves no item, and the game's own rules still decide what a salvage cycle
yields.

## What it does

### Mining drones

| Situation | Behaviour |
|---|---|
| Mining drone launched, no order given | Auto-targets the closest compatible rock in the ship's drone control range and starts mining. |
| Ore drone | Mines ore asteroids (Veldspar, Arkonor, moon ore, ...). |
| Ice harvesting drone | Mines ice only. `miningClouds` exists **only** on gas scoop and gas harvester modules in SDE 3396210, so no gas-cloud drone exists to automate. |
| Several idle drones, default `spread` | One rock each; the closest rock still collects the remainder when every other rock in range already has a drone on it. |
| `focus` mode | Every idle drone on the closest compatible rock. |
| **What to mine, in order** | `/aud mining filter add veldspar, kernite, blue ice` queues the rocks to mine, and the order typed is the order mined: the drones only move on to the next entry once nothing in range matches the one above it. Every entry is a rock name or a type ID (`1231`), one per comma, and a name matches any rock whose own name contains it - so `dark ochre` is one rock, not two. A bare number has to name a rock: `add 1231` is queued, while a word that fits nothing - a number no rock has, or a name that is already in the list - is passed over with a `warning` line and the rest of the line still goes in. `add` never reorders an entry that is already queued; `move` is the command that moves one. `/aud mining filter move` reorders an entry with the number the reply printed - a name typed without one goes to the end of its list, and the reply says so - `del` drops one, `clear ore\|ice\|moon` empties a whole kind, and `grade on` sends the drones to the richest grade of a rock in range first and re-tasks the drones that are already mining. Every reply prints the queue as one numbered list per kind of rock, always by name - a queued type ID reads back as the rock it stands for. A name that matches no rock is reported on a `warning` line with the name it probably meant, `/aud mining list` prints the names to queue, and `/aud mining filter help` (or `/aud mining fl help`, the filter's short spelling) lists the filter's own commands. A change reaches the drones that are already mining within a second. |
| **Multibox fleet** | `/aud copy <name\|id>` hands another character's whole setup - mode, threshold, takeover rule, range and the full queue - to the character who types it. Part of a name is enough and a misspelling is tolerated, because a player without staff rights never gets to see another account's ID. `/aud copy` on its own shows how to search; `/aud copy list [name]` shows who is stored here. |
| Rock depleted | The drone goes idle again and is re-targeted on the next scan. |
| Hold cannot take one more unit | Every mining drone of that ship recalls to the drone bay. The deciding bay is the one the server delivers into: the hull's own mining bay when it has one, its cargo hold otherwise. |
| Cargo hold still has room | Ignored on a hull that has a mining bay: the server takes the mining bay first and never spills into cargo, so the squadron comes home instead of working a rock nothing can be delivered from. |
| Bay nearly full | Recall before the last sliver, so a bay that cannot take a whole unit never turns into an idle/mining flap (`minHoldFreeVolumeM3`, default 2 m3). |
| One of those drones takes damage | Every mining drone of that ship recalls to the drone bay, then stays put for 120 s. |
| Player ordered a drone by hand | That drone is left alone until it is launched again; the rest of the squadron keeps working. Configurable with `playerControlPolicy`. |
| Ship is warping | Nothing is assigned. |
| `/aud mining off`, or `!aud mining off` from chat | That character's mining drones go back to being fully manual. |

### Salvage drones

| Situation | Behaviour |
|---|---|
| Salvage drone launched, no order given | Auto-targets a wreck inside the ship's drone control range and starts salvaging it. |
| Which wreck, default `nearest` | The closest wreck first. `/aud salvage distance farthest` works the field from the far end instead, which is what a long run through a belt of wrecks wants. |
| Several idle drones, default `spread` | One wreck each, the nearest still collecting the remainder; `/aud salvage focus` puts the whole squadron on one wreck. |
| Several ships in one fleet | They share one claim ledger and one scene scan per pass, so the fleet spreads across the field without rescanning it for every ship. Separate fleets and solo pilots keep independent ledgers. |
| **Whose wreck it is** | Nobody asks. Stripping a hull moves no item, and in this game it is taking the loot that carries a suspect flag and not the hull - so a wreck that belonged to another pilot is worked exactly like your own. |
| Salvage material | Goes into the cargo hold, which is where this server delivers drone salvage. The hold rule and the threshold read that hold. |
| Hold cannot take one more unit | Every salvage drone of that ship recalls to the drone bay. |
| One of those drones takes damage | Every salvage drone of that ship recalls to the drone bay, then stays put for 120 s. |
| Player ordered a drone by hand | That drone is left alone until it is launched again; the rest of the squadron keeps working. Configurable with `playerControlPolicy`. |
| Ship is warping | Nothing is assigned. |
| `/aud salvage off`, or `!aud salvage off` from chat | That character's salvage drones go back to being fully manual. |

## Install

Get this folder into `<EveJS root>\mods\beta-AdvancedUtilityDrones` - clone the repository, copy the
folder, or take `Source code (zip)` from the release you want - and run the installer from inside it.
The folder name matters: the preload points at `mods\beta-AdvancedUtilityDrones`, so a GitHub archive that
unpacks as `EveJS-AdvancedUtilityDrones-beta-0.12.9` has to be renamed to that.

```text
installer\install.bat
```

What it does is register the preload for the deployment you actually run - Docker or native - and
nothing else. It is idempotent, it backs up every file it rewrites to
`<EveJS root>\_beta-advancedutilitydrones-backup\<timestamp>\` first, and `installer\uninstall.bat` removes
its own line and leaves the rest alone.

### Installer (native and Docker)

Run the installer with no arguments and it assumes EveJS is installed on this computer,
finds the root itself - beside this folder, above it, and as a last resort on the local
drives - and stops to ask if the machine holds more than one checkout. Use
`--server "C:\path\to\EveJS"` only to override that search, and updating and uninstalling take the
same option (`installer\update.bat`, `installer\uninstall.bat`, `installer\status.bat`). Running the
installer from inside an already-installed `mods\beta-AdvancedUtilityDrones` is supported - the folder the
installer runs from is never pruned, so `update.bat` and `uninstall.bat` are still there afterwards.

It copies this folder to `<EveJS root>\mods\beta-AdvancedUtilityDrones` and registers the preload in every
deployment it finds:

| Deployment | Registered in | Entry added |
|---|---|---|
| Docker | `docker/entrypoint.sh`, in both `run_server()` and `run_all()` | `--require /app/mods/beta-AdvancedUtilityDrones/loader.js` |
| Native | `StartServer.bat`, whose `NODE_OPTIONS` both `npm start` branches inherit | `NODE_OPTIONS=--require "...\mods\beta-AdvancedUtilityDrones\loader.js"` |

The entry is appended **last** in the continuation list on purpose: require order is
`Module._load` hook order, and only the last-installed hook sees the exports object the final
transform produced. Every file the installer rewrites is copied to
`<EveJS root>\_beta-advancedutilitydrones-backup\<timestamp>\` first.

Afterwards rebuild a Docker deployment, or restart a native one:

```text
Docker : docker compose build && docker compose up -d --no-deps server
Native : restart the server with StartServer.bat
```

A healthy boot logs five lines:

```text
[beta-AdvancedUtilityDrones] v1.0.3-beta.1 loader ready - control range follows the ship by default; ...
[beta-AdvancedUtilityDrones] per-character choices live in ...config/advancedUtilityDrones.players.json (loaded: 0 character(s)); the /aud command and the plain-chat !aud trigger work for every character (/aud mining for the mining drones, /aud salvage for the salvage drones)
[beta-AdvancedUtilityDrones] plain-chat trigger installed - !aud works for every character, staff or not, and the line is never broadcast
[beta-AdvancedUtilityDrones] chat command overlay installed - /aud works for every character and needs no staff rights
[beta-AdvancedUtilityDrones] drone tick hook installed - idle drones are re-tasked every 500 ms (mining spread, salvage spread)
```

### Updating

```text
installer\update.bat
```

A reinstall is already an upgrade: `copyPayload` never overwrites a local `.env`, and the two
configuration files are written only when they are missing. `update.bat` is therefore the same
program as `install.bat` with a different label - it archives the folder it replaces, prints the
version it moved from and to, and touches `config/` in one way only: the keys a later release
introduced are added to `config/advancedUtilityDrones.json`, with a `configVersion` stamp, and not one
value that is already in there is changed. Use `install.bat` if you prefer; both work.

### Manually

1. Copy this folder to `<EveJS root>/mods/beta-AdvancedUtilityDrones`.
2. Add `--require /app/mods/beta-AdvancedUtilityDrones/loader.js \` as the **last** `--require` line
   inside the `node` invocation of both `run_server()` and `run_all()` in `docker/entrypoint.sh`.
3. `docker compose build && docker compose up -d --no-deps server`.

No vendor file is patched, so uninstalling is: remove the two `--require` lines, delete the folder,
rebuild. `installer\uninstall.bat` does exactly that.

## Configuration

Precedence, highest first:

1. a real environment variable (what `docker run -e` and `compose.yaml` `environment:` set),
2. `<EveJS root>/config/advancedUtilityDrones.json`,
3. the mod's own `.env` beside `loader.js`,
4. the built-in default.

Under Docker `./config` is bind-mounted, so editing the JSON needs a container restart and never an
image rebuild - that is the recommended place for a Docker deployment. `.env` is excluded from the
image by `.dockerignore` (`**/.env`), which is why the JSON exists.

[`config.example.json`](config.example.json) is a ready-to-copy template, and the installer writes
exactly that file for you when it is missing; from then on the file is yours, and an update only
adds a key a later release introduced. Nothing has to be set: the defaults already do the right thing, including following the ship's drone control range.

### Per-character settings

`<EveJS root>/config/advancedUtilityDrones.players.json` holds one entry per character. This is what
`/aud` writes and what the mod reads back on every restart. The two kinds of drone sit in an entry
side by side, so a character can automate one and not the other:

```json
{
  "_comment": "Per-character settings for beta-AdvancedUtilityDrones. ...",
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

Every key inside an entry is optional, and anything a character does not set falls back to
`config/advancedUtilityDrones.json` - so an owner sets the house rules once and each player overrides
only what they care about. The file is created by the installer and by the first boot, it is re-read
within 5 s of a hand edit, it travels with the mod, and `installer\uninstall.bat` removes it after archiving it
under `_beta-advancedutilitydrones-backup/`. `playersFile` puts it somewhere else. The radius, the hold
threshold and the takeover rule are not one kind's business, so they stay at the top level; the split
is one level deep and nothing else.

A players file written before the split - 1.3.0 and earlier - kept `enabled`, `targetMode`,
`oreFilter` and the rest straight on the character. That shape is still read and still means the
*mining* kind, so an upgrade does not need the file edited by hand. A key under `mining` wins over
the same key at the top level, because the nested one is the one somebody typed on purpose.

`/aud clear` deletes a character's entry and puts them back on the server defaults; `/aud mining clear`
and `/aud salvage clear` clear one kind and leave the other alone.

`/aud copy <name|id>` goes the other way round: it reads another character's entry out of this file
and writes it onto yours, complete and exact - a key the source never set is dropped from your entry
instead of being left behind, so two characters really do end up identical, both kinds of drone
together. The name to search for is the `characterName` above, so a character becomes findable the
first time they run any `/aud` command; `/aud copy` with no argument shows the examples.
`/aud copy list` names everybody who is stored here, `/aud copy list exampel` narrows that to the
ones whose name matches.

### The settings that matter

| JSON key | Env var | Default | Meaning |
|---|---|---|---|
| `enabled` | `EVEJS_ADVANCED_UTILITY_DRONES` | `true` | Master switch for the mining drones. `false` leaves mining drones manual. |
| `targetMode` | `..._TARGET_MODE` | `spread` | The mining drones: `spread` = one rock per drone, `focus` = all drones on the closest rock. |
| `rangeMode` | `..._RANGE_MODE` | `ship` | `ship` = follow the hull/skills/modules/implants, `fixed` = use `rangeMeters`. |
| `rangeMeters` | `..._RANGE_METERS` | *(unset)* | Distance in meters. Setting it **alone** selects `fixed` mode. |
| `recallOnFullHold` | `..._RECALL_ON_FULL_HOLD` | `true` | Recall when no bay can accept one more unit. |
| `salvageEnabled` | `..._SALVAGE_ENABLED` | `true` | Master switch for the salvage drones. `false` leaves them manual. |
| `salvageTargetMode` | `..._SALVAGE_TARGET_MODE` | `spread` | The salvage drones: `spread` = one wreck per drone, `focus` = the whole squadron on one wreck. |
| `salvageDistance` | `..._SALVAGE_DISTANCE` | `nearest` | Which end of the wreck field the squadron starts at: `nearest` or `farthest`. |
| `recallOnDamage` | `..._RECALL_ON_DAMAGE` | `true` | Recall when one of the drones takes damage. |
| `filterScanLimit` | `..._FILTER_SCAN_LIMIT` | `512` | How many rocks one scan looks at while a queue is set, instead of `maxCandidates`. |
| `filterFallback` | `..._FILTER_FALLBACK` | `any` | When nothing in range matches the queue: `any` mines the closest rock anyway, `idle` leaves the drones parked. |
| `filterGrade` | `..._FILTER_GRADE` | `false` | Mine the richest grade of a rock in range before the plainer ones. A grade is part of the type name (`Veldspar II-Grade`, `Blue Ice IV-Grade`), and with this off every grade counts the same. |
| `retargetOnFilterChange` | `..._RETARGET_ON_FILTER_CHANGE` | `true` | Apply a queue change to the drones that are already mining, with one re-target on the next scan, instead of waiting for their rock to run out. |
| `scanIntervalMs` | `..._SCAN_INTERVAL_MS` | `500` | How often a scene is scanned for idle mining drones. |
| `minHoldFreeVolumeM3` | `..._MIN_HOLD_FREE_VOLUME_M3` | `2` | Recall once the destination bay has less room than this. `0` disables the margin. |
| `playerControlPolicy` | `..._PLAYER_CONTROL_POLICY` | `hold` | What a manual drone order means to the automation: `hold`, `recall` or `off`. |
| `chatTrigger` | `..._CHAT_TRIGGER` | `true` | Allow `!aud ...` from ordinary chat, the only channel a character without staff rights can use. |
| `allowPlayerToggle` | `..._ALLOW_PLAYER_TOGGLE` | `true` | Allow `/aud` per-character control. |
| `allowPlayerCopy` | `..._ALLOW_PLAYER_COPY` | `true` | Allow `/aud copy`, which hands one character's saved setup to another. |
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

The command word is **`/aud`** and nothing else, and the **kind of drone comes first**: `/aud mining` is the
mining menu and `/aud salvage` is the salvage menu, because the two squadrons are switched, tasked and tuned
separately. A bare `/aud` answers with one line per kind of drone and nothing else, so the menus open
one word further in; `/aud help` is those two lines plus the whole-character commands, and a bare
`/aud off` is refused with a pointer to the two spelled-out forms. `copy` and `clear` are the only
commands that take no kind: they cover a character rather than a squadron.

Every command has exactly two spellings and nothing else: the word, and one short form of two letters.
There is no prefix guessing, because a letter that means one thing here and another thing in the mod next
door is worse than a word that means nothing at all. So `/aud mining fl cl ore` is `/aud mining filter
clear ore`, `/aud mining tg spread` is `/aud mining target spread`, and `/aud salvage ds farthest` is
`/aud salvage distance farthest`. What a command *takes* is always typed in full as well - `spread`,
`focus`, `ore`, `nearest`, `hold`, a number, a name. `help` also answers to `h`, the one single letter
left in the mod; there is no `?`.

| Command | Effect |
|---|---|
| `/aud` | One line per kind of drone, and nothing else. |
| `/aud help` | The same two lines, plus the two commands that cover a whole character: `copy` and `clear`. |
| `/aud mining help` | The mining commands in full, one line each. |
| `/aud salvage help` | The salvage commands in full, one line each. |
| `/aud mining status` | Mining state: drones in space/mining/idle, assignment and recall counters, and the resolved control range with its breakdown. |
| `/aud mining on` / `off` | Turn automatic mining on or off for **your character only**. The salvage switch is a different switch. |
| `/aud mining target spread` / `focus` | The miners' targeting mode: one rock per drone, or the whole squadron on the closest rock. The same command on the salvage menu is `/aud salvage target`, with its own setting. |
| `/aud mining range` | Show the control range and where each part of it comes from. |
| `/aud mining range 120000` | Search radius override for your character, in meters. Two hulls with different fits need two radii. |
| `/aud mining range ship` | Drop the override and follow your ship again. |
| `/aud mining threshold 4` | Recall once the destination bay has less than 4 m3 free. |
| `/aud mining filter` | The queue: what is mined, in which order - one numbered list per kind of rock, then the fallback and whether the grade preference is on. |
| `/aud mining fl ...` | The short spelling of `filter`: `/aud mining fl add veldspar` is `/aud mining filter add veldspar`, `/aud mining fl` prints the queue, and `/aud mining fl help` the list. |
| `/aud mining filter add veldspar, kernite, blue ice` | Queue those rocks - the order typed is the order mined. One entry per comma, and a name that holds a space stays one name (`add gneiss, dark ochre`). An entry is a rock name, part of one, or a type ID (`1231`); `add` takes no position, and a word that fits nothing - or a name that is already queued - is passed over with a `warning` line while the rest of the line still goes in. |
| `/aud mining filter move veldspar 2 kernite 1` | Reorder with the numbers the reply printed. The **first name picks the kind of rock** whose list is edited, and an entry of another kind is passed over with a warning. A name with no number goes to the end of its list; a name that is not queued is reported instead of added. |
| `/aud mining filter del kernite` | Drop an entry by name or type ID - `del 16268` drops Gelidus, and either spelling is printed back as the name. |
| `/aud mining filter clear ore` / `ice` / `moon` | Empty one kind's list. It is the only filter command that takes a kind word. |
| `/aud mining filter grade on` / `off` | Mine the richest grade of a rock in range before the plainer ones, or count every grade the same (default). Per character; `default` goes back to the server setting. |
| `/aud mining list` | Every ore type in drone range with the name to queue, the volume left and the nearest distance. |
| `/aud mining control hold` | A drone you order by hand is left alone until it is launched again (default). `recall` only reacts to a manual recall; `off` keeps automating it. |
| `/aud mining resume` | Hand your mining drones back to the automation after a manual takeover. |
| `/aud mining clear` | Forget the mining settings and follow the server defaults again. The salvage switches stay. |
| `/aud salvage status` | Salvage state: drones out, wrecks in range, salvage assignments and recalls with the last reason, and the hold the material goes into. |
| `/aud salvage on` / `off` | Turn automatic salvage on or off for **your character only**, separately from mining. |
| `/aud salvage target spread` / `focus` | One wreck per drone, or the whole squadron on the same wreck. The two kinds keep separate targeting settings. |
| `/aud salvage distance` | Which end of the field is worked first. |
| `/aud salvage distance nearest` / `farthest` | Start at the near end, or at the far one. |
| shorter spellings | Every command has exactly two spellings: the word and one short form of two letters - `/aud mi fl cl ore`, `/aud mi tg spread`, `/aud sa ds farthest`. Nothing else is accepted, and nothing is guessed at. `help` is the one command that also answers to a single letter, `h`. |
| `/aud salvage list` | The wrecks around your ship in the order the drones will work them, nearest first, each with the character it belonged to. |
| `/aud salvage range`, `/aud salvage threshold`, `/aud salvage control`, `/aud salvage resume`, `/aud salvage clear` | The same shared switches as the mining menu - one radius, one hold threshold, one takeover rule per character, and a `clear` that empties the salvage half alone. |
| `/aud copy` | How to search, and where the roster of stored characters is. |
| `/aud copy list [name]` | Every character whose settings are stored here - id, name, mode and queue - narrowed by part of a name. The caller is marked `(you)`. |
| `/aud copy exampel` / `copy User:140000005` | Copy that character's whole setup - **both kinds of drone** - onto you. Part of a name is enough, and a name typed in the wrong order or one letter off still finds them. |
| `/aud clear` | Delete your saved settings and follow the server defaults again, both kinds at once. |

Every command has a two-letter short form - `filter` is `fl`, `target` is `tg`, `help` is `h` - and
nothing else is accepted. `spread` and `focus` are values of `target`, not commands of their own. The old
`/atm`, `/altmining`, `!atm` and `!altmining` spellings answer with a single line naming the new
commands instead of doing anything. Setting `allowPlayerToggle: false` removes the per-character
commands and leaves only the server defaults.

**The plain-chat form is the one that always works.** A line beginning with `/` is sent by the client
as a `slash.SlashCmd` call, and EveJS applies no role gate to it - `slashService.js` runs the same
`executeChatCommand` for everybody. Whether a *client* forwards an unrecognised `/` command is
another matter, and on a character without staff rights it may not. Everything else is an ordinary chat
message, which the server broadcasts without ever looking at it, so the mod consumes the line where it
would be broadcast:

```text
!aud mining status
!aud salvage on
!aud salvage distance farthest
!aud copy astrea
```

`chatTrigger: false` switches the plain-chat channel off, and the line is consumed before anything is
stored or delivered: it is never broadcast. The reply comes back to the sender alone, as a system
message. `/`, `.` and `!` all run the same handler.

## Scope

Affects:

- idle mining drones launched from a player ship - ore, ice and moon ore.
- idle salvage drones launched from a player ship, and the wrecks they fly to.
- the ship's drones of each kind as a group, for the recall triggers.

Does not touch:

- any game client file - nothing to distribute to players.
- any EveJS source file on disk - three exports are wrapped in memory at startup.
- combat or repair drones, or an assist assignment.
- a drone you ordered by hand: only `droneCommand`-less, `STATE_IDLE` drones are candidates.
- mining lasers, gas scoops and gas harvesters.
- the loot table, ore yields, belt composition, rock volume or the market. A salvage drone takes
  exactly what a manual salvage order takes, and the wreck is emptied by the server's own cycle.
- whose wreck it was. Stripping a hull moves no item and carries no flag in this game, so the mod does
  not ask: every wreck inside the search radius is a target.

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
- **Salvage has no filter.** Every wreck in range is worked, in the order the distance setting asks
  for. A queue of wrecks would have to answer "which wreck is worth it", and nothing in the wreck
  entity can: there is no ore to name.
- **Salvage goes into the cargo hold.** This server delivers drone salvage there
  (`salvagerRuntime.executeSalvagerCycle`), and no hull in this game data has a hold that receives it
  anywhere else, so the hold rule and the threshold read cargo and nothing else. A Noctis therefore
  fills its cargo before the squadron comes home; nothing is lost, but the safety margin is cargo space.
- **A wreck is a target, whoever it belonged to.** The mod does not ask the game who owns a wreck,
  because in this game it is taking the loot that carries the suspect flag and not stripping the hull.
  It issues the same salvage call a player would, and anything that follows from that call is the
  game's own answer rather than a policy of ours.
- **Effect-less drones are left alone.** A drone whose type carries neither a mining nor a salvage
  effect is not flown, whatever it is named: the mod sits behind the game's own snapshot resolution
  (`resolveDroneMiningSnapshot` / `resolveDroneSalvageSnapshot`) rather than a list of type names, so
  third-party hulls work, and something that is neither is not guessed at.

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
either spelling), the two help lists and the filter's short spelling `fl`, the grade preference and
its place in the signature that re-tasks a working drone, the ore-name catalogue that groups a reply
by kind (including the live mining state outranking the static table), the grouped lines and the
`move` command that read it, the `/aud copy` finder (id, `User:` label, partial, reordered and
misspelt names), the `copy list` roster that narrows itself with the same matcher and keeps every
match, and the copy's exact, non-merging replacement of a character's entry.

On the salvage side it covers the whole sentence: the nearest wreck first whoever it belonged to,
`distance farthest` flips the order, a full cargo hold stops the squadron even with a mining bay
standing empty, two hulls sharing a field do not count a wreck against each other, the salvage menu is
its own set of switches, a 1.3.0 flat players entry is read as the mining kind, and a hull that
launches fifty drones puts every one of them to work - for salvage and for mining alike - while a
third-party drone is classified by the effect its type carries rather than by its name.

The installer side covers the registration transforms, an end-to-end install/reinstall/uninstall
against a throwaway EveJS tree, the configuration migration that brings an older
`config/advancedUtilityDrones.json` up to the installed release's key set, and the carry-over that
renames a `config/alternateMiningDrones.json` left by the old name into place without ever touching a
file already sitting under the new one.

