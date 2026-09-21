# How Advanced Utility Drones works

> **Who this is for.** Humans who want to know what this mod actually does before they run it, and AI
> agents that have to reason about, port, or modify it later. Every claim below is checkable against
> the source: file names, function names and the exact line numbers are quoted, so a reader can jump
> straight to the code.

**Target:** EveJS 0.12.8 (SDE build 3396210)
**Mod version:** 1.0.0-alpha · **Manifest kind:** `loader` · **Backends:** native and Docker
**Runtime requirement:** Node.js 18+ (the installer needs it on `PATH` too)

---

## 0. The short version

In EVE the **client** decides which rock a mining drone mines and which wreck a salvage drone works.
It sends `Handle_CmdMineRepeatedly([droneID], rockID)` —
`server/src/services/drone/entityService.js:90` — or `Handle_CmdSalvage([droneID], wreckID)` —
`entityService.js:95` — and the server does exactly that. Nothing on the server ever chooses a target
for an idle drone, so a launched drone parks at `activityState = STATE_IDLE` with `droneCommand =
null` until somebody clicks.

This mod wraps `droneRuntime.tickScene` **after** the vendor tick has run
(`server/src/services/drone/droneRuntime.js:7495`, called from `server/src/space/runtime.js:48466`)
and, for every ship that owns an idle drone, calls the very same
`commandMineRepeatedly(session, [droneID], targetID)` or
`commandSalvage(session, [droneID], targetID)` the client would have called. From the server's point
of view nothing unusual happened: an order came in for a drone that was idle. That is the entire
trick, and it is why the client needs no change — it already renders whatever the server says the
drone is doing.

The two kinds stop being symmetric in exactly one place: a rock belongs to nobody and a wreck belongs
to somebody. `commandSalvage` can choose a wreck on its own — `resolveAutomaticSalvageTarget`
(`droneRuntime.js:5411`, reached only from `commandSalvage` with a zero target) — but only ever an
**owned** one, and only from a player's order. The mod asks the game's own loot-entitlement check
(`server/src/services/_shared/spaceLootEntitlement.js`, `evaluateSpaceLootAccess`) about each wreck
before it issues anything, so corporation and fleet loot rights, an abandoned wreck and an NPC wreck
behave the way they behave everywhere else; what the safety light refuses is skipped with a warning.

Three further behaviours ride on the same pass: recall the ship's drones when the hold can no longer
take one more unit, recall them when one of them takes damage, and print the warning line about
somebody else's wreck once per wreck per launch.

- No file on disk is modified. No game client change. **Nothing to distribute to players.**
- No GM or staff role is needed. Everything is per-character, or per-server configuration, and the
  per-character half is reachable from ordinary chat (`!aud ...`) whatever rights the character
  has - see 2.3.
- The search radius is the ship's own drone control range by default.

---

## 1. Why an idle drone has no auto-target

`tickScene` walks `getSceneDroneEntities(scene)` and dispatches on `droneEntity.droneCommand`:

| `droneCommand` | What the tick does |
|---|---|
| `"ENGAGE"` | Combat targeting, including the `droneAssist` pilot assignment (`getDronePilotAssignment`, `droneRuntime.js:2583`). |
| `"MINE"` | Mines `droneEntity.targetID`, and only that (`droneRuntime.js:7554`). |
| `"SALVAGE"`, `"REPAIR"`, `"RETURN_HOME"`, `"RETURN_BAY"` | Their own handlers. |
| `null` | Nothing. The drone holds its orbit around the controller. |

`SALVAGE` is the one row that is never reached on its own: `tickDroneSalvage`
(`droneRuntime.js:7142`) runs the cycle for a drone that already has a `SALVAGE` task, and nothing in
`tickScene` ever assigns one. `commandSalvage` is exported from the same module
(`droneRuntime.js:7670`) and reached through `entityService.js:95`, so an order is the only way in —
which is the whole gap this mod fills for salvage.

`launchDronesForSession` (`droneRuntime.js:4502`) leaves a freshly launched drone in that last row:
`activityState = STATE_IDLE` plus `clearDroneTaskState(droneEntity)` (`droneRuntime.js:4711-4713`).
There is no acquisition step for mining the way there is for combat, so the drone is inert until a
`CmdMineRepeatedly` arrives.

### 1.1 Which drones can mine or salvage what

Candidates are the ship's own drones: category `18` (`DRONE_CATEGORY_ID`), driven by a ship
(`controllerID` = the controller ship's `itemID`).

**The kind is decided by the drone's own effects, not by its name.** A type that resolves a salvage
snapshot (`droneDogma.resolveDroneSalvageSnapshot`) is a salvage drone; one that resolves a mining
snapshot (`resolveDroneMiningSnapshot`) is a mining drone. That is the same resolution the vendor's own
`assignDroneSalvageTask` and `commandMineRepeatedly` perform — both reject an incompatible pairing
themselves — so a third-party hull that launches fifty drones under its own type names puts every one
of them to work instead of the handful a name list would recognise. `classifyDroneKind`
(`lib/runtime.js`) probes the drone against its controller and caches the answer per type ID, and it
caches **only** effect-derived answers: a name-derived one is a guess, and the same type asked again
with a controller in hand deserves the real answer.

The name is still consulted, in two roles:

```text
name contains "salvage"                             -> salvage drone
name contains "ice"                                 -> ice drone -> ice rocks only
name contains "mining" / "excavator" / "harvester" -> ore drone -> ore rocks only
```

1. it is the fallback when the effects cannot be read at all — no controller at hand, an unreadable
   type record — and
2. it is what splits ore from ice, because the game's own records do not: all 18 mining drones resolve
   the same `mining` effect, ice harvesters included.

Matching on the name is safe because EveJS resolves every type name through `localName`
(`server/src/services/_shared/referenceData.js:81`), which prefers the `en` string.

In SDE build 3396210 there are **18 mining drones** — 11 ore (Civilian Mining Drone, Harvester Mining
Drone, Mining Drone I, Mining Drone - Improved, Mining Drone II, Mining Drone - Elite, both
'Excavator' Mining Drones, 'Augmented' Mining Drone, Mutated Mining Drone, Prototype 'Pluto' Mining
Drone) and 7 ice (every Ice Harvesting Drone, plus its 'Excavator', 'Augmented', Mutated and
Prototype 'Pluto' variants). All 18 use the `mining` effect.

**There is no gas-cloud mining drone.** `miningClouds` (effect 2726) is carried only by Gas Cloud
Scoop and Gas Cloud Harvester *modules*. Gas clouds are therefore out of scope for a drone mod — not
because this mod ignores them, but because nothing in the game can mine them with a drone.

---

## 2. The seam

`droneRuntime.tickScene` is called as a property access —
`droneRuntime.tickScene(this, now)` (`server/src/space/runtime.js:48466`) — so replacing that one
property on the module exports is enough to intercept every scene tick without touching any file:

```js
const original = exported.tickScene;
exported.tickScene = function advancedUtilityDronesTickScene(scene, now) {
  const result = original.call(this, scene, now);   // vendor tick first
  runtime.onSceneTick(scene, now);                  // then this mod
  return result;
};
```

Two consequences of running **after** the vendor tick, both intentional:

- A drone launched during this tick is already in the scene with `STATE_IDLE`, so it is picked up by
  the very next pass instead of a tick later.
- `getControllerDogmaContext` is called outside `beginDogmaTick`/`endDogmaTick`
  (`droneDogma.js:443-450`). That is supported — it simply falls back to the normal fingerprint cache
  (`droneDogma.js:452-505`) instead of the per-tick memo. The mod caches the resolved range on the ship
  entity keyed by that fingerprint, so the cost is one resolve per refit, not one per scan.

The mod installs itself through `Module._load` chaining and **requires no server module at load
time**: `createServerDeps` hands back lazy closures, so preloading it cannot force a transform target
into the module cache before the mods that rewrite those files have installed their hooks.

### 2.1 Require order matters (the one hard rule)

`--require` order is `Module._load` hook order. The last loader required owns the outermost hook, and
only that hook sees the exports object the final transform produced. A mod that compiles transformed
source — `fourModeAsteroidBelts` does exactly that for `droneRuntime.js` — returns a **new** exports
object, so a patch applied to an earlier one is silently discarded.

The installer therefore appends the preload **last** in the continuation list
(`installer/lib/register.js`, `applyEntrypointPreload`):

```text
exec node \
  --require /app/mods/fourModeAsteroidBelts/loader.js \
  ...                                              \
  --require /app/mods/AdvancedUtilityDrones/loader.js \
  .
```

Keep it last in both `run_server()` and `run_all()` if you edit `docker/entrypoint.sh` by hand.

The same rule decides where the **Windows launcher's** block goes. `StartServer.bat` preloads loader
mods by appending `--require` to `NODE_OPTIONS`, and another mod may already own that variable - the
live one does. Three consequences:

- The block **appends** instead of assigning, and only assigns outright when `NODE_OPTIONS` is unset.
  `if not defined NODE_OPTIONS` (first writer wins) silently drops whichever mod registers second; a
  plain assignment drops every mod that came before. Appending is the only shape that cannot lose.
- It is inserted **after** every block already registered below the anchor, so it is evaluated last and
  observes the value they produced - which is also what keeps this mod outermost.
- Re-running the installer **repairs the position**: an earlier copy of the block is removed before the
  new one is inserted, so a launcher an older installer mis-ordered heals on the next run.

```text
set "EVEJS_PROXY_LOCAL_INTERCEPT=1"
if exist "...\autopilotJumpZero\loader.js" (
  if defined NODE_OPTIONS (
    set "NODE_OPTIONS=%NODE_OPTIONS% --require=".../autopilotJumpZero/loader.js""
  ) else (
    set "NODE_OPTIONS=--require=".../autopilotJumpZero/loader.js""
  )
)
rem --- AdvancedUtilityDrones: preload the server-side loader ---
if exist "...\AdvancedUtilityDrones\loader.js" (
  if defined NODE_OPTIONS (
    set "NODE_OPTIONS=%NODE_OPTIONS% --require=".../AdvancedUtilityDrones/loader.js""
  ) else (
    set "NODE_OPTIONS=--require=".../AdvancedUtilityDrones/loader.js""
  )
)
rem --- AdvancedUtilityDrones: end AdvancedUtilityDrones preload ---
```

A neighbouring block is treated as **one unit** however many lines it spans: a marker-delimited block,
an unmarked `if exist ( ... )` group that mentions `NODE_OPTIONS`, or a one-line writer. Measuring by
lines instead of by blocks is what drops a naive installer *inside* its neighbour's `if/else`, where
the neighbour's `set` gets the last word.

#### The loader contract, and the audit that enforces it

Two rules for every mod that preloads into the server, on either deployment:

1. **Append, never claim.** In `StartServer.bat`, do not use `if not defined NODE_OPTIONS` - it is
   first-come-first-served and quietly drops the second mod - and never assign `NODE_OPTIONS` outright
   once it may already be set. In `docker/entrypoint.sh` there is no variable to claim: the list is
   just lines, so add an entry instead of rewriting the invocation.
2. **Order by kind.** A *replacement* hook (one that compiles a target into new exports) belongs
   **innermost** = first in the list. A *wrapping* hook (one that patches the exports it is handed)
   belongs **outermost** = last. `soloProgressionBalance` compiles `droneRuntime.js` into fresh
   exports, so it has to sit in front of this mod; `autopilotJumpZero` compiles `beyonceService.js`,
   so it has to sit in front of anything that wraps that file. The two ends of the list are claimed
   by different mods on purpose, not by accident.

Neither deployment reports a violation. `cmd.exe` simply ends up with fewer `--require` entries than
were written, and a container launch silently hands a wrapper the wrong exports object.
`installer/lib/loaderAudit.js` replays both files and prints the chains the server will really get:

```text
Docker launch chain (--require order; the last entry owns the outermost hook)
  run_server : fourModeAsteroidBelts -> soloProgressionBalance -> moonOreAnomalies -> autopilotJumpZero -> AdvancedUtilityDrones
  run_all    : fourModeAsteroidBelts -> soloProgressionBalance -> moonOreAnomalies -> autopilotJumpZero -> AdvancedUtilityDrones
Native loader chain : autopilotJumpZero -> AdvancedUtilityDrones
                      (AdvancedUtilityDrones is required last, so it owns the outermost hook)
                      no loader block is dropped
```

Every server launch is listed separately, because patching one branch of the entrypoint by hand and
forgetting the other is a real way to end up with two different servers. A block a later writer
erases is named with its line number, and a mod required *after* this one gets a note rather than a
warning: that is only a problem if it replaces a file this mod wraps.

The status command also compares each chain against `mods/`. A folder that carries a `loader.js` and
appears in no chain is installed and completely inert - it loads nothing, logs nothing and does
nothing, and no EveJS surface says so. It is a note rather than a warning, because a checkout ships
both entry points while its owner runs only one of them, and because the mods it names belong to
other authors:

```text
  [note] Native: in mods/ but not preloaded by this launcher: fourModeAsteroidBelts, moonOreAnomalies, soloProgressionBalance
```

Only the chain for the deployment you actually run matters. `install.bat --docker-only` or
`--native-only` restrains the installer to one of them, and a tree that has only one entry point is
patched in only one place.

Re-run `installer/status.bat` after installing anything else that preloads a loader.

**What cannot be defended:** a block that sits *after* this one and assigns `NODE_OPTIONS` outright
still wins, because there is nothing left for this mod to append to. That is a bug in the later mod;
the audit reports its line number so it can be moved above this block or switched to appending.

### 2.2 The chat overlay

`/aud` is an overlay on `chatCommands.executeChatCommand`, installed the same way
`fourModeAsteroidBelts` installs `/beltmode` and `/beltvolume`: the previous function is captured, a
new one replaces the exported property, and anything that is not an `/aud` message is handed
`COMMANDS_HELP_TEXT` (a joined string, not an array — see `chatCommands.js:512-658`), so `/help`
lists them — what is appended is the root list (the two menus), the commands that follow `/aud m`, and
the filter's own list behind `/aud m filter help`, which keeps `/aud m help` to one screen. Every list
is built the same way (one line per command, the line being what to type), and the filter answers to
`f` as well as to its own name.

`handleCommand` is a router and nothing else. The first word after `/aud` picks the menu — `m`/`mining`
for the miners, `s`/`salvage` for the salvagers — and a bare `/aud` prints the root list rather than
guessing a kind, because a bare `off` would be ambiguous: `/aud m off` and `/aud s off` are two
different switches. `copy` and `reset` sit outside the menus because they cover a whole character
rather than one kind of drone. `lib/chatCommand.js` holds the whole grammar; the two menus share the
helpers for the settings that belong to a character (radius, threshold, takeover), so neither menu
owns them.

Consumers destructure that export at load time (`slashService.js:15`, `lscService.js:11`,
`xmppStubServer.js:27`), which is fine **because the overlay is installed when `chatCommands` is first
required** — before any of those destructurings receive the function.

Every overlay chains instead of replacing, so all of them keep working regardless of install order,
and each marks itself with its own `Symbol.for(...)` to stay idempotent.

### 2.3 The ordinary-chat trigger (no staff rights)

A line the player types without a leading `/` never reaches `executeChatCommand`. The client sends
`/`-prefixed input as a `slash.SlashCmd` call (`slashService.js:211`; `slash-debug.log` records the raw
line arriving as `command="/aud m focus"`), while anything else is an XMPP `groupchat` message.
`xmppStubServer.handleGroupMessage` (`xmppStubServer.js:2727`) reads the body, and for a plain line it
goes straight to `chatRuntime.broadcastLocalMessage(session, body)` (`chatRuntime.js:1702`) and then to
`deliverRoomMessage(...)` - unconditionally, and without asking anything. So `!aud` cannot be
handled in `chatCommands`; it has to be consumed at the broadcaster.

`broadcastLocalMessage` is therefore the third wrapped export
(`server/src/_secondary/chat/chatRuntime.js`, plus `sendChannelMessage` so the trigger behaves the same
in a non-local channel). The wrapper leaves a message that is not addressed to this mod completely
alone. For one that is, it runs the same `handleCommand` the slash overlay runs and then **throws** an
`Error` whose message is the reply:

```js
sendResult = chatRuntime.broadcastLocalMessage(session, body);
//   catch (error) { sendSystemMessageToClient(client, roomJid,
//                     formatChannelAccessError(error, "speak")); return; }
```

That catch is the whole mechanism. `formatChannelAccessError` (`xmppStubServer.js:992`) ends with
`return error.message` for any error whose `code` it does not recognise, so an unrecognised throw is
rendered as its own text, sent to the sender alone, and the `return` skips the broadcast, the backlog
entry and every other member. One throw therefore does four things at once: it replies, it suppresses
the line, it keeps the channel quiet, and it leaves the rest of the chat path untouched. The mod still
edits no file on disk - the seam is an exported function, not a source transform.

Two consequences are worth knowing:

- The reply arrives as a system message in the channel, exactly as the `/aud` output does, so a
  client renders both the same way. The **salvage warning** cannot use this path: a warning is printed
  from a scene tick, not from a command, so `lib/runtime.js` sends it through
  `chatRuntime.broadcastLocalMessage` directly - local chat, where a public suspect flag belongs.
- Leave the error's `code` unset. `password_required`, `invite_required`, `banned`, `muted` and the
  `*_mismatch` / `not_allowed` / `denied` codes are translated into their own text first, which would
  replace the reply.

---

## 3. Choosing a target

`onSceneTick(scene, now)` (`lib/runtime.js`) throttles to one pass per `scanIntervalMs` per scene,
buckets the scene's drones by `controllerID`, and for each ship:

1. **Keeps only mining drones** (`classifyMiningDroneKind`, see 1.1). A ship with none costs one
   `filter`.
2. **Checks for damage first** (section 5). A recall beats any assignment.
3. **Honours the player switch of that kind.** `/aud m off` stops the mining pass, `/aud s off` the
   salvage one; each pass reads its own switch.
4. **Skips a warping ship** (`controllerEntity.mode === "WARP" || warpState`).
5. **Keeps only idle drones**: no `droneCommand`, no `droneAssist`,
   `activityState === STATE_IDLE`, and not inside the 120 s post-recall suppression window.
6. **Collects candidates**: every entity in `ensureSceneMiningState(scene).byEntityID`
   (`miningRuntimeState.js:885`) with `remainingQuantity > 0` and a `yieldKind` matching one of the
   idle drones' kinds, sorted by surface distance and cut to `maxCandidates`. `yieldKind` is
   `ore` / `ice` / `gas` (`miningRuntimeState.js:148`).
7. **Culls by range**: `surfaceDistance(ship, rock)` is the *surface* distance (centre distance minus
   both radii), the same measure the client uses, compared against the resolved control range
   (section 4).
8. **Scores and assigns**:

```text
spread : score = distance + (drones already sent to that rock * claimPenaltyMeters)
focus  : score = distance
```

   The penalty is what spreads a flight out without giving up: with the default 15 km a free rock
   20 km away beats a claimed one 5 km away, but when only one rock is left every drone stacks on it.
9. **Re-uses the vendor's own visibility gate** before each assignment:
   `droneRuntime._testing.canPlayerCompanionActOnTarget(scene, session, drone, ship, rock)` — the same
   check `commandMineRepeatedly` performs (`droneRuntime.js:932`, called at `droneRuntime.js:5508`).
   A rock the drone could not be ordered onto is never ordered onto.
10. **Issues the order**: `droneRuntime.commandMineRepeatedly(session, [droneID], targetID)`
    (`droneRuntime.js:5470`). The vendor then sets `droneCommand = "MINE"`, computes the pursuit or
    orbit behaviour and starts the cycle — identical to a player's click in every respect.

Because the vendor function is used verbatim, the drone behaves like a manually ordered one on every
later tick, including the depleted-rock path that returns it to `STATE_IDLE`
(`miningRuntimeState.js:1016`), at which point this mod re-targets it.

### 3.1 The "what to mine" queue

A player can narrow the pool further with `/aud m filter ...`; the choice is kept per character in the
players file, under `mining.oreFilter`. It is one more predicate on the candidate list, applied after
the kind match and the range test, so nothing else in this chapter changes - a rock the queue does not
want is simply never scored. **Salvage has no such queue**: there is no ore in a wreck to name, so the
only choices a salvager has are which end of the field to start at and whose wrecks may be worked.

- The queue is an ordered array of tokens in priority order, and `lib/oreQueue.js` owns the grammar:
  every reader, writer and printer of the queue goes through it. Since 1.2.9 a token a command may
  read is either a name (`veldspar` matches any rock whose type name contains it, case-insensitively,
  which is why it covers every Veldspar variant) or a type ID (`1231`). Since 1.3.0 a number the
  catalogue cannot place is dropped by `add` on its own - the rest of the line is still queued and the
  reply carries a `warning` naming it - so a token that could never match a rock never reaches the
  queue and one bad word costs only itself; a name the catalogue cannot place is still stored and
  warned about, which is how a rock from another server or a new ore a mod adds stays visible.
  `placeTokens` also takes `skipExisting` for `add`: an entry that is already queued keeps the place it
  has, because `add` grows the queue and `move` reorders it. A word that stands
  for a whole kind (`ore`, `ice`, `moon`) or for every rock (`any`, `all`, `*`) is a *reserved* word:
  `filter clear` is the one command that takes a kind, and everywhere else those words are passed
  over with a warning and the rest of the line is read as usual. That is deliberate - `ice` is part
  of real rock names (Blue Ice, Azure Ice), and a filter holds rocks, not kinds. The pinned
  `kind:name` spelling 1.2.5 accepted is refused outright: `parseTypedToken` no longer reads it,
  while `parseStoredToken` still does, so a queue an older release wrote is read back unchanged.
- **A typed line is cut into entries by `oreQueue.splitTypedWords`**, and the comma is the hard
  separator: `filter add gneiss, dark ochre` is two entries because the second name holds a space,
  and `filter add dark, ochre` is two patterns on purpose. A line with no comma is still read at the
  spaces, but a run of words the catalogue knows as one rock is joined back up first
  (`gneiss dark ochre` -> `gneiss` + `dark ochre`). A reserved word and a number are never joined to
  a neighbour, and a catalogue that cannot be read joins nothing - which leaves the pre-1.2.7
  reading in place. Without this, a two-word rock name silently became two patterns that each match
  something, so the `warning` line never fired.
- **A token that names no kind matches every kind.** Nobody has to know which bucket a rock sits in,
  and one queue can mix ore, ice and moon ore in the order the player typed them.
- Every rock is still sorted into one of three buckets (`ore`, `ice`, `moon`), because that is what
  decides which tokens can match it. The bucket starts from the mining cache's `yieldKind`; moon ore
  is recognised by the rock's `generatedMoonOreChunk` flag or by the yield type's `groupID` being one
  of the five moon-asteroid families (`MOON_ORE_GROUP_IDS` in config.js - the same list
  `autoMoonMiningService` keeps server-side).
- **The queue is a priority order, not a set.** `oreQueue.rank` returns the index of the first token
  a rock matches, and the assignment sort below is `rank` first, the grade preference next and the
  score last, so a rock the player queued first is mined before a closer one that matches a lower
  entry. A kind no token mentions comes back as `-1` - not mined at all. The queue decides which rock
  an *idle* drone flies to; a drone that is already mining is left alone exactly as in step 5.
- **The grade preference is `filterGrade`** (per character, off unless asked for). `lib/oreGrades.js`
  reads the grade out of a rock's own type name - the bare name is I and `II-Grade` through
  `X-Grade` sit above it, with `0-Grade` below, and a `Compressed` / `Ancient Compressed` prefix is
  taken off first. The candidate sort builds that grade per rock entity and orders by grade
  descending between the rank test and the score, so the drones take the richest grade of a family
  in range first and work down; with it off every grade scores the same. The ladder is real: 100
  units of Veldspar refine to 200/400/420/440/460 at 0/I/II/III/IV-Grade, and Blue Ice gives 69
  against 104 at IV-Grade.
- The rank travels from the candidate filter into the drone loop in one map keyed by entity ID, so
  the sort needs no second classification pass.
- When no rock in range matches the queue at all, `filterFallback` decides: `any` (default) mines the
  closest rock anyway, `idle` leaves those drones parked for that scan.
- **The file stores the tokens a reply prints**, so `"oreFilter": ["veldspar", "blue ice"]` is what
  the player read in game - `oreFilterLabel` turns a type ID into the name of the rock it stands for,
  so a line copied out of a reply pastes straight back into a command. `oreQueue.readQueue` also
  reads the three per-kind buckets 1.2.2 wrote (`{"ore": [...], "ice": [...], "moon": [...]}`, an
  empty bucket meaning that whole kind), which is how an upgrade keeps a queue that was set before
  1.2.3; `setPlayerOreFilter` normalizes through the same reader, so a hand-written or half-typed
  queue never reaches the file.
- `/aud m filter` (short spelling `/aud m f`) takes four verbs - `add`, `move`, `del` and `clear` - plus the `grade` and `fallback`
  switches. `parseEdits(words, {positions})` pairs each name with the number that follows it, and
  only `move` reads positions; `add` ignores a number and joins the end of the queue.
  `oreQueue.placeTokens` puts each entry at that place inside the list of the kind it mines, lifting
  it out of the queue first so whatever was there shifts along: a place past the end of a list lands
  at its end, an edit with no place joins the end of its own list (`move`) or the end of the queue
  (`add`), and `move` refuses a name that is not queued (`onlyExisting`) instead of growing the
  queue. `move` also takes the kind of its *first* name (`onlyKind`) and returns everything else in
  `discarded`, which is how an entry of another kind is reported instead of landing in the wrong
  list. `oreQueue.removeMatching` is `del` and `clear`: `clear` passes one kind word and drops that
  whole list, while a name or type ID drops whatever it matches, both ways round - a typed name is
  expanded to the type IDs it covers and a typed ID to the name a reply prints for it, so either
  spelling reaches an entry the other one stored.
- **A changed queue reaches the drones that are already mining.** `noteQueueSignature` keeps the
  last `oreFilter`/`filterFallback` per character and flags a change on the next pass, so a command
  in game and a hand edit of the players file behave the same. That pass adds the character's
  automated mining drones (`isAutomatedMiningDrone`: a mining order, not player-parked) to the
  assignment pool with the rock each one is on. The candidate loop skips a drone whose current rock
  is still the top-ranked one - no cycle is restarted for nothing - and a drone the new queue leaves
  nothing to mine is recalled with the reason `queue changed`. Set `retargetOnFilterChange: false`
  for the pre-1.2.1 behaviour, where only idle drones follow the queue.
- A queue widens the scan (`filterScanLimit`, default 512 rather than `maxCandidates`), because the
  nearest 48 rocks may all be ones the player does not want.
- `describeSceneOres` backs `/aud m list`: it groups the candidates per type, sorts the queued types by
  rank and the rest by distance, and prints the names a player can queue.
- **Every reply that shows or changes the queue prints it as one numbered list per kind, and the
  kind comes from the game's own item types.** `lib/oreNames.js` builds a catalogue on first use out
  of `itemTypes` (item category 25 asteroids) and assigns each rock to ore, ice or moon by the group
  it sits in: group 465 and the `Ice` group name are ice, the five families
  `services/structure/autoMoonMiningService.js` names are moon ore, everything else is ore. It is
  display only - the assignment loop still mines from the live mining state - and a rock seen in
  space is remembered with the kind `classifyTargetScope` gave it, so where the table and the
  running server disagree the reply follows the server. Built lazily through
  `createServerDeps().getReferenceData`; an unreadable table degrades to one comma-separated line and
  a note, rather than to a wrong kind.
- `runtime.oreEntryKinds(token)` is the single answer to "what does this entry mine" - `null` for the
  one case where it cannot tell - and the reply (`oreQueue.groupByKind`), the placement
  (`oreQueue.placeTokens`) and `del` (`oreQueue.removeMatching`) all read it. `groupByKind` numbers
  each list on its own, which is the number `add`, `move` and `del` take; an entry that matches no
  rock at all lands on the `warning` line, with suggestions from `lib/nameMatch.js` - the same
  edit-distance rule `/aud copy` uses to tolerate a misspelling.

### 3.2 Copying a setup between characters

A mining fleet is usually several accounts flown by one person, and retyping a queue on every alt is
how a fleet ends up mining four different rocks. `/aud copy <who>` reads one character's entry out
of the players file and writes it onto the caller - mode, threshold, takeover rule, range and the
whole queue, token for token - so the two are identical afterwards.

- **The identifier** is parsed by `lib/copySettings.js`: a character ID (`140000005`), the client's
  `User:<id>` label (`user:`, `id:`, `char:`, `character:`, `pilot:` and `name:` are all accepted in
  front of it), or a character name. A name is matched exactly first, then as a prefix, then as a
  substring, then with every word of the query somewhere in the name - so `/aud copy miner example`
  finds `Example Miner` - and last with one or two typo edits per word of the name (`/aud copy
  exampel`), which is the only lever a player has: the client prints `User:<id>` without ever saying
  what the number means. A query that fits more than one entry is refused with the candidates instead
  of guessed.
- **`/aud copy` on its own is the finder**, not just a listing: it prints both search forms next to
  every stored character, marks the caller as `(you)` and says that a character appears here once
  they have used any `/aud` command - which is what writes `characterName` into the entry.
- **Only the players file can be a source**, so a character who never changed anything has nothing to
  copy and the command says so - `/aud reset` is the deliberate way back to the server defaults.
- **The write is a replace, not a merge.** `playerSettings.replace()` (`lib/playerSettings.js`) drops
  the `updatedAt` / `characterName` / `_comment` metadata and stores what the source has as the
  target's whole entry, deleting the target's entry when nothing is left. That is the opposite of
  `set()`, which merges a patch over what is already stored: without the replace, a threshold or a
  queue the source never set would survive on the target and the two would *not* be identical.
- **The runtime surface is two methods**: `allStoredPlayerSettings()` (the raw entries, not the
  values already merged with the server defaults) and `copyPlayerSettings(sourceID, targetID,
  meta)`. The command layer formats the reply; the store and the runtime do the lookup and the write.
- **Two readers, one matcher.** `lib/copySettings.js` answers "which stored characters does this
  text name" once (`matchStoredCharacters`) and both forms of the command read it: `/aud copy
  <who>` wants exactly one answer and refuses an ambiguous one, `/aud copy list [who]` wants them
  all so the roster can be narrowed by the same prefix / substring / any-order / typo tiers. The
  trim to `MAX_COPY_LIST_LINES` happens in the reply, never in the matcher, so a narrowed list can
  never hide a match behind a truncation that counted other people's entries.
- **Drones already mining follow the copy** for free: a copy is just another write to the players
  file, so `noteQueueSignature` (3.1) sees the new queue on the next pass and re-targets exactly as
  it does after a `/aud m filter` command.
- **Who may copy from whom.** The settings are not account-bound and not private - every entry lives
  in one server-side file - so copying from another player is allowed. `allowPlayerCopy: false` (env
  `EVEJS_ADVANCED_UTILITY_DRONES_ALLOW_PLAYER_COPY`) removes the command, and `allowPlayerToggle: false`
  refuses the write while the read-only listing still answers.
- The command needs the caller's own character ID and nothing else, so a character without staff
  rights can use it through the plain-chat trigger: `!aud copy User:140000005`.

### 3.3 The salvage pass

`runSalvageShipPass` (`lib/runtime.js`) runs after the mining pass for the same controller, on the
same throttled tick, and it is deliberately the same shape: the idle gate, the damage recall, the
warping check and the hold rule are the mining ones, reused. What differs is what a candidate is.

1. **Keeps only salvage drones** - `classifyDroneKind(...) === "salvage"`, the effect probe of 1.1.
2. **Lists the wrecks** with `listSceneWrecks`: every entity the vendor's own
   `salvagerRuntime.isSalvageableTarget` accepts inside the resolved control range, sorted by surface
   distance.
3. **Asks the game about each wreck once per pass** - `evaluateWreckAccess(session, scene, entity)`
   wraps `spaceLootEntitlement.evaluateSpaceLootAccess` and answers `{ entitled, blocked,
   requiresSuspectTimer }`. It is one call per *wreck*, not per drone: on a hull that launches fifty
   drones the answer would be the same fifty times, and the check reaches into character, fleet and
   crimewatch state.
4. **Drops what this pilot may not have.** `blocked` - what the safety light refuses - is skipped and
   warned about; a wreck that is not `entitled` is skipped as well, unless `salvageForeign` is
   `allow`. Under `warn` that skip is the one the pilot is told about, once per wreck per launch.
   Every rung of the ladder ends in the same place - no drone is sent to a wreck that is not this
   pilot's - and `allow` is the only one that is different: it works the wreck and leaves the flag
   to the game.
5. **Scores what is left**:

```text
spread : score = (+/-)distance + (drones already sent to that wreck * claimPenaltyMeters)
focus  : score = (+/-)distance
```

   The sign is `/aud s distance`: `nearest` is the mining rule unchanged, `farthest` flips it so the
   field is worked from the far end. The penalty is the mechanism that spreads a mining flight out,
   reused - and the claims map is **per controller**, so two hulls sharing a field, or one pilot
   running two of them, cannot count a wreck against each other. A wreck the pilot is *entitled* to
   always beats one that would flag them, whatever the distance rule says.
6. **Checks the hold** before each order, against the cargo hold, and recalls the whole squadron when
   it is full (section 5).
7. **Issues the order**: `droneRuntime.commandSalvage(session, [droneID], targetID)` with the target
   named explicitly, so the vendor's owned-only automatic picker is not what decides; the entitlement
   question above is the only one that was asked.

**The warning is once per wreck per launch.** `salvageWarnedWrecks` is a per-character set, and
`resumeDrones` clears a character's salvage warnings whenever salvage drones are launched again - the
operator's own loop is fly in, launch, salvage, scoop, move on, launch again. A wreck goes into the
set only *after* the line has been sent, so a warning that could not reach anybody yet is still
printed the first time it can.

**What a drone takes is the game's business.** The mod grants nothing: `salvagerRuntime.
executeSalvagerCycle` decides what a cycle yields and where it lands, so loot rights, the salvage
skill and the wreck's contents behave exactly as they do for a manual order. This server grants drone
salvage into `ITEM_FLAGS.CARGO_HOLD` (`server/src/space/modules/salvagerRuntime.js`, and its own space
check reads cargo), while the SDE's `specialSalvageHoldCapacity` (attribute 1559, flag 137) plays no
part in the drone path - which is why section 5 judges a salvage squadron on cargo space.

---

## 4. The control range

`lib/controlRange.js` computes the number the client shows for the ship, from live data:

| Source | Attribute | Value |
|---|---|---|
| Base | 458 `droneControlDistance` on `CharacterType` (1373) | 20000 m |
| Drone Avionics | 459 `droneRangeBonus` | 5000 per level |
| Advanced Drone Avionics | 459 | 3000 per level |
| Drone Link Augmentor I / II | 459 | 20000 / 24000 |
| Drone Control Range Augmentor rigs | 459 | 15000 / 20000 |
| Implants and boosters | 459 | Halcyon Y-1..Y-5: 4000..20000 |

Every one of those modifiers is an additive `ItemModifier` onto attribute 458, so a plain sum is
correct — there is no stacking penalty to model. The parts come from
`droneDogma._testing.getControllerDogmaContext(ship)` (`droneDogma.js:452`), which returns the ship's
`skillMap`, `fittedItems` and a `fingerprint`; fitted modules are filtered through
`isEffectivelyOnlineModule` (`liveFittingState.js:202`) and implants/boosters through
`getActiveImplants` / `getActiveBoosters` (`activeImplantModifiers.js:712`, `:788`). A Rorqual with
both drone skills at V and three Drone Link Augmentor I is 20000 + 40000 + 60000 = **120 km**.

Attribute ids are looked up by name at runtime (`getAttributeIDByNames`, `liveFittingState.js:312`)
with the SDE ids as a fallback, so a future SDE rename degrades instead of breaking.

The result is cached on the ship entity as `advancedUtilityDronesRange` and invalidated by the dogma
fingerprint, so a refit or a trained level takes effect on the next scan without a restart. It is then
clamped to `rangeMinMeters..rangeMaxMeters`, and a per-character `/aud m range <meters>` override
takes precedence over it.

`rangeMode: "fixed"` — or simply setting `rangeMeters` — skips all of the above and uses one number
for every ship. That is the escape hatch for a server that wants a flat radius.

---

## 5. Recall

### 5.1 Hold full

The trigger mirrors the vendor exactly. `resolveDroneMiningDestination` (`droneRuntime.js:2373`) walks
the bays in one fixed order:

```text
preferred bay (specialised ore / ice / gas hold, or the general mining hold)
  -> general mining hold (flag 134)
    -> cargo hold (flag 5)
```

and takes the **first** bay with any room at all. The delivery itself then needs one whole unit of the
yield to fit (`droneRuntime.js:6991-7000`; the comment there records why an `availableVolume <= 0` test
alone was wrong), and when it does not fit the cycle is abandoned - the server never continues to the
next bay. A mining hull therefore stops on its own mining bay: while that bay holds a sub-unit sliver
the cargo hold behind it is unreachable, and the drone would otherwise mine forever without delivering
anything.

This mod reproduces the same order over `buildShipResourceState` + `listContainerItems`
(`liveFittingState.js:3397`, `simulationInventoryProjection.js:176`), with the used-volume arithmetic
copied from `miningRuntime.computeUsedVolume` (`miningRuntime.js:525`), including its singleton rule.
It judges the one bay the server would deliver into right now - not "some bay still has room" - and
recalls the squadron once that bay can no longer take a whole unit. A hull with no mining bay of its
own falls back to its cargo hold, which is then the bay that actually receives the ore.

### 5.2 Under attack

Drones carry the same `conditionState` as a ship — `{ damage, armorDamage, shieldCharge, ... }`
(`itemStore.js:1550`) — written by the generic damage path (`server/src/space/combat/damage.js:374`,
`:501`) against `shieldCapacity` / `armorHP` / `structureHP` (`droneRuntime.js:2793-2811`).

Each scan computes `1 - currentHP/maxHP` and stores it as `drone.advancedUtilityDronesDamageFraction`. A
drone whose fraction grows by more than `damageThreshold` (default 0, i.e. any damage at all) triggers
a recall of **every** mining drone of that ship — a partly-stripped flight is worse than no flight.
The drone entity itself is never modified beyond that one bookkeeping field, so nothing else that
reads drone state is affected.

### 5.3 How the recall is issued

`droneRuntime.commandReturnBay(session, droneIDs)` (`droneRuntime.js:4955`) — the same handler as
`Handle_CmdReturnBay`. Each recalled drone is stamped with `advancedUtilityDronesRecalledAtMs = now`, and
this mod will not re-task it for 120 s. That window matters: a returning drone is briefly still
visible in the scene, and the stamp is the backstop if its `activityState`/`droneCommand` have not yet
switched away from idle.

---

## 6. Rocks that appear after the fact

`ensureSceneMiningState` builds one cache per scene from `scene.staticEntities` and stores it on
`scene._miningRuntimeState` (`miningRuntimeState.js:885-940`). Only the dungeon and
generated-resource-site paths invalidate it. A moon-ore chunk added by
`server/src/services/structure/moonOreChunkSpawner.js` therefore does not exist as far as any mining
code is concerned until that cache is dropped — which blinds a manual mining laser and a manual drone
order just as much as it blinds this mod.

The cache is nothing but a view over `scene.staticEntities` plus the persisted per-system state, so
dropping it re-derives identical data; that is precisely what the upstream invalidation sites do
(`dungeonUniverseRuntime.js:3999`, `miningResourceSiteService.js:1640`). With
`refreshStaleSceneCache` (default on) this mod does the same, but only when it is trying to mine and
finds nothing to mine:

1. compare the scene's mineable-looking static entities against `byEntityID`,
2. remember each entity the cache does not know about in
   `scene.advancedUtilityDronesUnknownMineableIDs`,
3. rebuild **only** when that set gains a new id.

The "only on a new id" rule is what keeps this from being a timer: geometry the cache will never
accept — decorative asteroids, the deliberately non-mineable companion rock — enters the set once,
costs one rebuild, and is then remembered. A belt full of such entities cannot make it loop.

---

## 7. Configuration and failure behaviour

`config.js` reads, highest precedence first: a real environment variable, then
`<runtime root>/config/advancedUtilityDrones.json` (bind-mounted under Docker, so it can be edited
without an image rebuild), then the mod's own `.env`, then the built-in default. `.env` is a file, so
the JSON wins over it; `.dockerignore` excludes `**/.env` from the image, which is why the JSON path
exists at all.

`RANGE_MODE` has no forced default: leaving it unset selects `fixed` when `RANGE_METERS` is set and
`ship` otherwise, so "just tell me a distance" and "just follow my ship" both do what they read like.

The per-character settings fall back to the JSON above when a character has not set them, and they
live in `config/advancedUtilityDrones.players.json` - one entry per character, written by `/aud` and
by the `!` trigger, re-read within 5 s of a hand edit, archived and removed by `uninstall.bat`, and
relocatable with `playersFile`. Inside an entry the two kinds of drone sit side by side, because the
two squadrons are separately switched:

- `mining.enabled`, `mining.targetMode` (`spread` = one rock per drone), `mining.oreFilter`,
  `mining.filterFallback` and `mining.filterGrade` - what the mining drones do (3.1).
- `salvage.enabled`, `salvage.targetMode` (`spread` = one wreck per drone), `salvage.distance` and
  `salvage.foreign` - what the salvage drones do (3.3).
- `rangeOverrideMeters`, `minHoldFreeVolumeM3` and `playerControlPolicy` sit at the top level of the
  entry, because a radius, a hold margin and a takeover rule are not one kind's business -
  `minHoldFreeVolumeM3` is the room the destination hold must still keep before another unit is worth
  assigning (default 2 m3, and the reason a nearly-full hold cannot turn into an idle/working flap),
  and `playerControlPolicy` is `hold` (a hand-ordered drone is left alone until it is launched again),
  `recall` (only a manual recall parks drones) or `off` (keep automating them).

`lib/playerSettings.js` owns that shape: `KIND_KEYS` names the two kinds and the values each accepts,
and an entry written by an older release - 1.3.0's flat `enabled` / `targetMode` / `oreFilter` - is
folded into `mining` as it is read, with a key nested under `mining` winning over the same key at the
top level. `/aud copy <id|name>` reads one of those entries and writes it onto another character
(3.2); `allowPlayerCopy` (env `EVEJS_ADVANCED_UTILITY_DRONES_ALLOW_PLAYER_COPY`, default `true`) is
the switch that removes the command.

**The mod fails closed.** Any problem in the configuration — a non-numeric distance, an out-of-range
interval, an unknown `targetMode` — is logged with the offending key, and the loader installs nothing
at all:

```text
[advancedUtilityDrones] EVEJS_ADVANCED_UTILITY_DRONES_SCAN_INTERVAL_MS must be between 100 and 60000
[advancedUtilityDrones] invalid mod-owned configuration - no hooks installed
```

Mining drones then behave exactly like vanilla. Every entry point is also wrapped, so a throw inside
the pass is logged and never propagated into `tickScene`.

---

## 8. Compatibility contract

Verified against the other server-side mods installed on this server:

| Mod | What it touches | Interaction |
|---|---|---|
| `fourModeAsteroidBelts` | `Module._load` source transforms of `asteroidService.js` and `miningRuntimeState.js`; its own `executeChatCommand` overlay | None. It never rewrites `tickScene`, and the two chat overlays chain. Its transform is the reason this loader has to be preloaded last (2.1). |
| `soloProgressionBalance` | `liveFittingState.js`, `space/runtime.js` and parts of `droneRuntime.js`; fitting and dogma overlays | None. It does not touch `tickScene`, and this mod only *reads* the helpers it replaces. |
| `moonOreAnomalies` | `dungeonUniverseRuntime.js` and dungeon content packs | None. Different files entirely. |
| `autopilotJumpZero` | `beyonceService.js`, and the launcher's `NODE_OPTIONS` list | None. Different files, and both blocks append, so both load. It has to stay *first* in the preload list and this mod *last* (2.1). |
| `EveJS-MoonMining-Fix` | `moonMiningBootstrap.js`, `moonOreChunkSpawner.js` | None. Different files. Section 6 is what makes moon-ore chunks reachable. |
| Any "more drones per hull" mod | Nothing this mod knows about | None, and that is the point. The kind of a drone is read from its own effects (1.1), the drone list comes from the scene rather than a fixed roster, and the claims map is per controller and sized by nothing. A hull that launches fifty drones puts all fifty to work. |

### Invariants to preserve if you modify this mod

1. **Never require a server module at loader load time.** `createServerDeps` must keep handing back
   lazy closures. A transform target that is already in `Module._cache` when another mod installs its
   `Module._load` hook breaks that mod.
2. **Stay last in the `--require` list.** See 2.1.
3. **Only ever touch idle drones** (`droneCommand` falsy, `activityState === STATE_IDLE`). A drone the
   player ordered is a boundary you do not cross; that is what makes the mod safe to leave on.
4. **Go through the vendor commands** (`commandMineRepeatedly`, `commandReturnBay`) instead of writing
   drone state directly. Everything downstream then keeps working for free: client notifications,
   persistence, FX, and the security-scope checks.
5. **Catch everything.** A throw inside `tickScene` takes the whole scene down; the wrapper and the
   per-ship pass each have their own try/catch and log instead.
6. **Never claim `NODE_OPTIONS` in the launcher.** Append, and let the installer place the block after
   every other writer - then re-run it after installing another mod that preloads. See 2.1.
7. **Never skip the entitlement check before a salvage order.** `evaluateWreckAccess` is what keeps
   this mod from making a suspect out of a player who never asked for one, and `salvageForeign` is the
   only switch that may widen it. Issuing `commandSalvage` at a wreck the check refused is exactly the
   bug the guard exists to prevent - the vendor function does not consult entitlement at all.
8. **Never guess a drone's kind from a hard-coded type or name list.** The effect probe is what keeps
   third-party hulls working; a list would quietly leave their drones idle.
9. **Keep the claims map per controller.** One map per scene would let two hulls in one belt starve
   each other, and would get worse the more drones a hull launches.

---

## 9. Tests

```text
RunTests.bat      (or: node test/run.js)
```

107 cases over ten areas:

- **Range arithmetic** — the 120 km Rorqual case, the 140 km implant case, the 20 km base, fixed mode.
- **Target selection** — idle drones only, range culling, ore/ice separation, spread vs focus, a drone
  already ordered being left alone, the scan throttle, the player switch.
- **Recall** — hold full, the bay the server actually delivers into deciding on its own, room left in
  a bay the server never reaches, damage, the suppression window, the per-character near-full
  threshold, and the stalled-drone guard that recalls when a hold stops growing.
- **The seam** — `Module._load` wrapping of `tickScene`, the slash overlay, the plain-chat trigger and
  its off switch, the manual-takeover parking and its resume, the drone-state replay, idempotent
  install, and an invalid configuration leaving the loader inert.
- **The queue** — the token grammar (rock names and type IDs only, with a kind word, an `any` word
  and the 1.2.5 pin each answered the way 1.2.9 answers them), the comma-separated line with its
  word-joining fallback, the three per-kind buckets 1.2.2 wrote read back as the same tokens, the
  reply numbered per kind and labelled by name, the `warning` line for a name no rock has with its
  "did you mean" suggestions, a bare number that names no rock dropped by `add` on its own warning
  line while the rest of the line is queued, an entry that is already queued keeping the place it has,
  `move` placing a name by the number that follows it inside the list of its own kind with a `warning`
  line when that number is missing, `del` dropping whatever a word resolves to from either spelling,
  and `clear` emptying one kind.
- **The grade preference** — the ladder read out of a type name (`0`/bare/`II`/`III`/`IV`/`X-Grade`,
  a compressed prefix stripped), the richest rock of a family picked first with the preference on,
  the switch stored per character with `default` going back to the server setting, and the switch
  being part of the signature that re-tasks a drone that is already mining.
- **The two help lists** — `/aud m help` carrying only the top-level commands and pointing at
  `/aud m filter help`, which carries the filter's own commands in the same one-line-per-command
  shape, both readable with `allowPlayerToggle: false`, and `f` answering wherever `filter` does.
- **The ore-name catalogue** — a rock's kind from its item group (ore, ice, moon, and a decorative
  asteroid left out), a type ID resolved the same way, the live mining state outranking the table,
  and an unreadable table leaving the reply ungrouped instead of wrong.
- **Copying a setup** — the id / `User:<id>` / name grammar, a unique prefix, an ambiguous name, an
  unknown or empty source, the full-entry replacement that drops a leftover setting, and both switches.
- **The two shapes of the command** — a bare `copy` answering with the examples and nothing else, the
  `copy list` roster with the caller marked, a roster narrowed by a name or by the `User:<id>` label
  the client shows, and a filter that matches nobody answering with the way back to the full list.
- **Salvage** — only the pilot's own wreck worked and the nearest one first, `distance farthest`
  flipping the order, a foreign wreck left alone and named once per launch (`warn`) or worked in
  silence (`allow`), a wreck the safety light refuses skipped with its own warning, two hulls sharing a field
  not counting a wreck against each other, the salvage menu being its own set of switches, a 1.3.0 flat
  players entry read as the mining kind, and a hull that launches fifty drones putting every one of
  them to work - for salvage and for mining alike.
- **Drones that are not ours** — a third-party drone flown by the effect its type carries rather than
  by its name, for salvage and for ore, and a drone whose type carries neither effect left alone.
- **The installer** — the entrypoint and `StartServer.bat` transforms, idempotency, byte-exact
  removal, stepping over a neighbour's multi-line block, a neighbour that installs later landing in
  front of this one, repairing a mis-ordered block, the loader chain audits for both deployments,
  `--docker-only`/`--native-only` restraining both the install and the report, a full
  install/reinstall/uninstall against a throwaway EveJS tree, and the configuration migration that
  adds the keys an older `config/advancedUtilityDrones.json` is missing without rewriting a value.

All of it runs with dependency injection or fixture text; no server is started and no game data is
touched, which is why `RunTests.bat` is safe to run on a live box.

## 10. Packaging and distribution

**Distribution is the GitHub repository.** `HalCyonNJ/EveJS-AdvancedUtilityDrones` *is* this folder, so
the per-tag `Source code (zip)` GitHub generates is the release artifact: there is no local build step
and no archive to keep, because the installer half and the payload are the same tree the user
downloads. This replaced the old `BuildPackage.bat` / `node tools/build-package.js` step, which wrote
two zips into `dist/` - an installer package (`install.bat` + `installer/lib/` + the payload inside
`AdvancedUtilityDrones/`) and a launcher package (the payload folder alone). `dist/`, `BuildPackage.bat` and
`tools/build-package.js` were all deleted on 2026-09-20, so there is no packaging step left to run.

What still matters is the pruning contract, which serves the installer alone: `installer/`, `node_modules/` and
`.git/` are development-only and are listed in `DEV_ONLY_DIRECTORIES` in
`installer/lib/deployment.js`, which is what keeps them out of an installed `mods/AdvancedUtilityDrones`.
`DEV_ONLY_FILES` is empty now that the packaging tools are gone - if a development file ever appears at
the mod root again, that is the list to put it in.

`update.js` is the same program as `install.js` with a different label: re-running the installer already
archives the folder it is about to replace and re-applies the same idempotent registrations, and
`copyPayload` skips an existing `.env` while `seedConfig` only writes a configuration file that is
missing. The one thing an update does beyond that is `installer/lib/configMigration.js`: a server
configuration written by an older release is missing the keys the releases since added, so every run
inserts those keys and a `configVersion` stamp, and never rewrites a value that is already in the file.
So `update.bat` still adds no second code path - it reports the version it moved from and to, and what
it added to the configuration.

`README.md` documents the runtime behaviour an operator needs, and `HOW-IT-WORKS.md` rides along in the
payload because it is the contract whoever maintains a fork has to keep.

### Finding the EveJS root

`install.bat` with no arguments has to answer one question before it can write anything: which tree is
the server? It answers it with the same marker every time - a directory is an EveJS root only if it
holds `server/index.js` *and* `server/src/services/drone/droneRuntime.js` - in three passes, cheapest
first:

1. the installer's own directory, the current directory, and their immediate siblings;
2. the installer's ancestor chain, and each ancestor's children, to a depth of four;
3. a breadth-first sweep of the local drives, depth two, skipping `Windows`, `Program Files`,
   `ProgramData`, `AppData`, `node_modules` and similar, bounded by a visit budget so that a large
   drive cannot stall the installer.

Pass 3 exists for the ordinary case where the ZIP was extracted into `Downloads`. It is a last resort:
`--server`, `EVEJS_SERVER` and `EVEJS_ROOT` skip all three, and `EVEJS_ADVANCED_UTILITY_DRONES_SEARCH_BASES`
(a `";"`-separated list) replaces the drive list that pass 3 uses. The depth limit and the budget are
what keep this from becoming an unbounded filesystem walk: a candidate more than two levels below a
drive root is deliberately not found, and the operator is told to pass `--server` instead.

When the passes turn up several roots the installer lists them and reads a choice from the console; with
no console it stops rather than picking one. `uninstall.js` shares the search but never prompts: that
path deletes a preload, and an ambiguous answer there must not be guessed at.
