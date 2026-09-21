# Changelog

Advanced Utility Drones for EveJS 0.12.8. Newest release first.

Every release is a drop-in replacement for the one before it: run `update.bat` over an existing
install, or copy the `AdvancedUtilityDrones/` folder over the one in `mods/`. Nothing outside that
folder is edited, no player installs anything, and every value you have set stays exactly as it is: the installer
only adds the keys a later release introduced, and stamps the file with the release it was brought up
to. A server keeps its settings and every player keeps their saved choices.

---

## 1.0.0 - 2026-09-22

**The mod is `AdvancedUtilityDrones` now, and it flies salvage drones as well as mining drones.**
The command is `/aud`, the kind of drone comes first, and the version line restarts at 1.0.0
because the rename makes this a different mod from the `/atm` 1.3.0 line - not a step along it.

### Fixed

- **The installer no longer prunes the folder it is run from.** Installing from inside a folder that is
  already named `mods/AdvancedUtilityDrones` - the README's own instruction - made the payload copy a
  directory onto itself, and the pass that strips `installer/` out of an installed folder then deleted
  the installer the operator was holding: `update.bat` and `uninstall.bat` were gone after the first
  run. A self-install is now recognised by real path and skipped whole, and the run reports
  `already in place` instead of claiming an update it did not make.
- **An update rewrites the `configVersion` stamp instead of adding a second one.** A file written by the
  `/atm` 1.3.0 line already names the release it was brought up to, and the migration put its own stamp
  on a new line below that one rather than replacing it, so the file came out holding
  `"configVersion"` twice - the superseded value first, the new one last. Parsers take the last, so
  nothing behaved differently, but the raw text said two things and every upgrade from the old name
  took that path. The line the file already has is now the line that is rewritten, the key order the
  operator typed is left exactly as it was, and a file with no stamp at all still has one added.

### Added

- **Salvage-drone automation.** An idle salvage drone launched from a player ship now picks its own
  wreck inside the ship's drone control range, works it, and moves to the next one when it is empty -
  the same gap the mining half fills, for the same reason: `droneRuntime.commandSalvage` can pick a
  wreck for a drone, but only ever an *owned* one and only from a player's own order.
- **A wreck is a target, whoever it belonged to.** Nothing in the salvage path asks who owns a wreck,
  because there is nothing for the answer to change: the game's loot-entitlement check guards the
  transfer of items, and in this game it is taking the loot that carries a suspect flag, not stripping
  the hull. The drones issue the same `commandSalvage` a player's own order would.
- **`/aud` answers with the two menus.** One line for the mining drones and one for the salvage drones,
  and nothing else: the kind of drone is the only thing that level has to say, and every menu opens one
  word further in with `/aud mi help` or `/aud sa help`. `/aud help`, the same word as `h`, is those two
  lines plus the whole-character commands - `copy` and `clear` - because neither belongs to one kind.
- **Every command has exactly two spellings: its word, and one short form of two letters.** `mi` and
  `sa` are the two kinds; inside a menu `tg` is `target`, `rg` is `range`, `th` is `threshold`, `fl` is
  `filter`, `ls` is `list`, `ct` is `control`, `rs` is `resume`, `cl` is `clear` and `st` is `status`,
  `ds` is `distance` on the salvage menu, and a filter verb is two letters too (`ad`, `mv`, `dl`, `cl`,
  `gd`, `fb`). `help` is the one word that also answers to a single letter, `h`. What a command *takes*
  is always typed in full - `spread`, `focus`, `ore`, `nearest`, `hold`, a number, a name.
- **`/aud salvage distance nearest|farthest`** - which end of the field the squadron starts at. `nearest`
  is the default; `farthest` is for a long run through a field, so the drones do not crawl back over
  ground they have already covered. **`/aud salvage target spread|focus`**, or `/aud sa tg spread`,
  behaves as it does for miners.
- **`/aud salvage list`** - the wrecks around the ship, in the order the drones will work them, each
  with the character it belonged to.
- **`/aud salvage status`** - drones out, wrecks in range, assignments and recalls with the last
  reason, and the hold the material goes into.
- **Drones are classified by their effects, not by their names.** A type that resolves a salvage or a
  mining snapshot is flown; the name is only the fallback, and only it splits ore from ice. A
  third-party hull that launches fifty drones under its own type names puts every one of them to work
  - the mining half included.
- **The claims map is per controller.** Two hulls sharing a field, or one pilot flying two of them, no
  longer count a wreck against each other. On a fifty-drone hull that is the difference between a
  whole squadron working and a handful working.
- **Coverage for the salvage half**: the nearest wreck first whatever it used to belong to,
  `distance farthest`, a full cargo hold stopping the squadron even with a mining bay standing empty,
  per-controller claims, the fifty-drone case for both kinds, effect-based classification, and the
  salvage menu's own switches.

### Changed

- **The short forms are two letters, and prefix guessing is gone.** The earlier build accepted any
  prefix that still picked one command out, and answered a shared letter with both candidates; `s`
  meaning the spread or the status, or the status or the salvage menu, is exactly the ambiguity a server
  running several mods cannot afford, so each table now holds one word and one two-letter short form per
  command and nothing else. `f` is no longer `filter` - `fl` is - and `?` is gone, though `help` still
  answers to `h`.
- **`reset` is `clear`.** `/aud clear`, `/aud mining clear` and `/aud salvage clear` do what `/aud
  reset` used to, and `resume` keeps its `rs` short form, so the two commands can no longer be read for
  one another.
- **`copy` lives at the root only.** `/aud copy <name|id>` and `/aud copy list` are the whole of it,
  and both are reached with `/aud cp ...`; there is no per-kind copy to learn, and no menu's help text
  names it any more - `/aud help` is where it is listed.
- **`spread` and `focus` became one command: `target`, short `tg`.** The two words were commands of
  their own for one build, which read oddly beside `distance` - a switch that had already taken its
  value. `/aud mining target spread|focus`, or `/aud mi tg focus`, sets the mode and `target` on its own
  prints what is set; the values are typed in full like every other value. A line that types one where a
  command belongs is answered with `target` instead of a bare refusal.

### Retired

- **The `foreign` switch and its warning line are gone, and so is the ownership check behind them.**
  A live test settled the question the switch was built on: salvaging another pilot's wreck does not
  flag you on this server - taking the loot does. There is no suspect timer to warn about, so there is
  nothing to gate on either, and the key was taken out of the file rather than left as a switch that
  does nothing. `salvageForeign` is off the server-wide key list, `EVEJS_ADVANCED_UTILITY_DRONES_`
  `SALVAGE_FOREIGN` is no longer read, and `foreign` is off the salvage menu; an older file that
  still holds the key is read without complaint and the key simply has no effect.

### Renamed

- **`AlternateMiningDrones` is `AdvancedUtilityDrones`, and `/atm` is `/aud`.** `/altmining` went
  with it. The retired spellings - `/atm`, `/altmining`, `!atm`, `!altmining` - answer with one line
  naming the new commands instead of being ignored.
- **The kind of drone comes first.** `/aud mining ...` (short `mi`) is the mining menu, `/aud salvage ...`
  (short `sa`) is the salvage menu, and a bare `/aud` answers with one line per kind of drone and nothing
  else, so the menus open one word further in. A bare `/aud off` is refused with a pointer to the two
  spellings, because "off" on its own would be ambiguous: the two squadrons are separate switches.
- **The root commands cover a whole character and take no kind word.** `/aud copy <name|id>` (short `cp`)
  moves **both kinds** onto a character, and `/aud clear` (short `cl`) clears both at once - the per-menu
  copies are gone. `clear` replaced the old `reset` so it can no longer be mistaken for `resume`, and the
  two kinds clear their own halves with `/aud mining clear` and `/aud salvage clear`.
- The per-character file is `config/advancedUtilityDrones.players.json`, and an entry keeps the two
  kinds side by side under `mining` and `salvage`. An entry written by 1.3.0 - flat `enabled`,
  `targetMode`, `oreFilter` - is still read and means the mining kind, so nothing needs editing by hand.
- The server-wide keys for the new half are `salvageEnabled`, `salvageTargetMode` and
  `salvageDistance`, with `EVEJS_ADVANCED_UTILITY_DRONES_SALVAGE_*` as environment variables. All
  three are in `config.example.json` and `.env.example`.
- Menus, help texts, replies and log lines all print the new name and the new commands.

### Notes for operators

- **Upgrading needs nothing done by hand.** The installer carries `config/alternateMiningDrones.json`
  and `config/alternateMiningDrones.players.json` over to the new names - a file already sitting under
  the new name is the operator's and is never overwritten - and the migration then adds the four
  salvage keys to the server-wide file with a new `configVersion` stamp, changing no value that is
  already there.
- **The old environment spellings are still read.** `EVEJS_ALT_MINING_DRONES_*` works, and a value set
  under the new spelling wins when both are present, so an existing `compose.yaml` or `.env` keeps
  working while it is being renamed.
- **Drone salvage is delivered into the cargo hold on this server.** The drone path grants into
  `ITEM_FLAGS.CARGO_HOLD` and its own space check reads cargo, so no hull has a hold that receives
  drone salvage anywhere else - there is no working salvage hold to watch, and the hold rule and
  `/aud salvage threshold` are about cargo space and nothing else.
- **There is no salvage filter in this release.** Every wreck in range is worked, in the order the
  distance setting asks for: nothing in a wreck can say what it is worth the way a rock's type does.
- The test suite is 108 cases; `node test\run.js` (or `RunTests.bat`) runs them all.

---


## 1.3.0 - 2026-09-19

**Changed: one bad word no longer costs the whole line, `add` never reorders an entry, and an older
configuration file is brought up to this release's key set by the installer.**

### Changed

- **`filter add` drops the word that fits nothing and queues the rest.** `/atm filter add veldspar, 1,
  pyroxeres` queues Veldspar and Pyroxeres and answers with `warning: "1" is not a rock's type ID ...`
  - the "drop it and report it" that `del` has always used. 1.2.10 turned the whole line away, which
  cost an operator the entries they had typed correctly.
- **`filter add` never reorders.** A name that is already queued keeps the place it has and the reply
  says so; `/atm filter move <name> <place>` is the command for moving an entry. Before this, topping
  up a queue with a rock that was already in it moved that rock to the end of its list.
- **`/atm filter help` is laid out like `/atm help`.** One line per command - the line being what
  to type - with the detail lines under it, instead of paragraphs; the two lists are the same shape
  and the same width.

### Added

- **The installer brings an older `config/advancedUtilityDrones.json` up to this release's key set.**
  A file written by 1.2.1 is missing `filterGrade`, `allowPlayerCopy`, `chatTrigger`,
  `filterFallback` and `retargetOnFilterChange`; every install and update now adds the keys that are
  missing, stamps `"configVersion": "1.3.0"`, and never rewrites a value that is already in the file.
  The file is archived under `_advancedutilitydrones-backup/` first, `--dry-run` prints what would be
  added, and `--status` reports the shape it found. New module: `installer/lib/configMigration.js`.
- **`f` is the short spelling of `filter`.** `/atm f add veldspar` is `/atm filter add veldspar`,
  `/atm f` prints the queue, `/atm f help` prints the list, and `!atm f ...` works from ordinary chat
  too. The top-level list and the queue read-back both name it; nothing else grew a short form.

---

## 1.2.10 - 2026-09-19

**Fixed: the grade preference now reaches the drones that are already mining, `move` says when it put a
name at the end, and `add` refuses a number no rock has. `/atm help` split in two.**

### Fixed

- **`filter grade on|off` re-tasks working drones.** The switch was stored and read by the targeting
  loop, but it was not part of the change the mod watches for, so a drone already sitting on a plain
  rock finished that rock first: the reply said `on` while the drone kept mining ungraded ore. It is
  part of that check now, and the reply says the working drones switch within a second, the way a
  queue edit does.
- **`filter move` reports a name typed without a number.** `/atm filter move dark ochre 1, veldspar`
  places Veldspar at the end of its list, and now prints `warning: veldspar without a number, so it
  was placed at the end of the list` instead of doing it silently.

### Changed

- **`filter add` refuses a number that names no rock.** A bare number is a type ID, so `filter add
  kernite 1` is refused whole - `"1" is not a rock's type ID, so it cannot be queued ... "/atm filter
  move kernite 1" sets an entry's place` - instead of queueing `1` and warning about it in every
  later reply. `add 1231` is unchanged: `1231` names a rock, so it is queued and read back as
  Veldspar.
- **`/atm help` is the top-level list only.** It lists what can follow `/atm` and points at
  `/atm filter help`, which carries the filter's own commands (add, move, del, clear, grade,
  fallback) with their examples. `/atm filter` on its own still prints the queue, with that pointer
  as its last line. Reading either works even when `allowPlayerToggle: false`.

## 1.2.9 - 2026-09-19

**Changed: a filter entry is a rock, and the drones can be told to take the richest grade of one
first.** The queue used to take whole kinds, `*` and a `kind:name` pin, which made a two-word rock
name and a word like `ice` fight over the same word. A typed entry is now a rock name or a type ID
and nothing else, `clear` is the one command that names a kind, and a new preference sends the
drones to the best grade of a rock in range before the plainer ones.

### Changed

- **`filter add` takes rock names and type IDs, and no positions.** `/atm filter add veldspar,
  kernite, 16268` is the whole grammar of an entry, one per comma, and a number after a name is no
  longer a place in a list. `move` is the only command that takes a number.
- **A kind word, `*` and `any` are passed over with a warning.** `filter add veldspar, ice` queues
  Veldspar and answers `"ice" names a whole kind of rock, so it is not an entry - /atm filter clear
  ice empties the ice list`. The rest of the line is still read: one bad word does not throw the
  good ones away, and `move` and `del` behave the same way.
- **`ice:glacial mass` is refused.** The 1.2.5 pin is gone; type the rock's own name or its type ID.
- **`filter clear ore|ice|moon` is the only command that takes a kind.** It empties that list, so
  `del ice` and `del *` - which used to empty one list and the whole queue - now answer with the
  command that replaced them.
- **`filter move` picks the list from its first name.** `/atm filter move glacial mass 1 kernite 2`
  edits the ice list because Glacial Mass is ice rock, and Kernite - which is not - is passed over
  with a warning instead of landing in the wrong list.
- **`filter del` works from either spelling.** A name drops the entries stored as that name and the
  type IDs it covers; a type ID also resolves to the name a reply prints for it, so `del 16268`
  reaches an entry queued as `gelidus`.
- **Every reply prints rocks, never numbers.** A queued type ID reads back as the rock it stands for
  (`16268` is `Gelidus`), because a player at a belt sees names and has no table to look a number up
  in.
- **The label column widens to `warning` when a warning line is printed**, so the numbers stay the
  numbers `move` takes.

### Added

- **`/atm filter grade on|off|default`** - the grade preference, per character, off by default. The
  game spawns the same ore at several grades and the type name is where that shows (`Veldspar
  II-Grade`, `Blue Ice IV-Grade`), so with it on the drones take the richest grade of a family in
  range first and work down; with it off every grade counts the same. The ladder is real - 100 units
  of Veldspar refine to 200/400/420/440/460 at 0/I/II/III/IV-Grade - and `lib/oreGrades.js` reads it
  off the type name, `Compressed` and `Ancient Compressed` prefixes included.
- **The queue read-back says so too** - `/atm filter` prints a `grade` line, `status` prints
  `grade on` inside its `filter` line, and a copied setup carries the preference with it.
- **Server-wide default** `filterGrade` (`EVEJS_ADVANCED_UTILITY_DRONES_FILTER_GRADE`, default `false`),
  documented in `.env.example` and `config.example.json`.

```text
> /atm filter add veldspar, dark ochre, 16268, ice
AdvancedUtilityDrones added veldspar, dark ochre, Gelidus. Drones already mining switch to the new queue within a second.
  ore    : 1. veldspar, 2. dark ochre
  ice    : 1. Gelidus
  moon   : nothing
  warning: "ice" names a whole kind of rock, so it is not an entry - /atm filter clear ice empties the ice list

> /atm filter move 16268 1 dark ochre 2
AdvancedUtilityDrones moved Gelidus. Drones already mining switch to the new queue within a second.
  ore    : 1. dark ochre
  ice    : 1. Gelidus
  moon   : nothing
  warning: dark ochre is not ice rock, and the first name picked the ice list - so it was left alone

> /atm filter grade on
AdvancedUtilityDrones filter grade: on (the richest grade of a rock in range is mined before the plainer ones).
```

---

## 1.2.8 - 2026-09-19

**Changed: the command has exactly four spellings.** `/advancedutilitydrones` was long enough that
nobody typed it, and `!amd` is an abbreviation another mod on a shared server may want for itself.
Both were removed. `/atm` and `/altmining` are the slash forms, `!atm` and `!altmining` the
plain-chat ones, and a line that spells anything else is left alone.

### Changed

- **`/advancedutilitydrones` is gone.** It was a registered alias of `/atm`; the client or the
  server answers it the way it answers any unknown command.
- **`!amd` is gone.** The plain-chat hook hands the line back instead of consuming it, so another mod
  is free to claim the abbreviation. Nothing else about the trigger changed: `chatTrigger`, the
  per-character gate and the "never broadcast" behaviour are all as they were.
- **`/atm`, `/altmining`, `!atm`, `!altmining` are the whole list.** No other spelling reaches
  the mod, and `/atm help` says so on its last line.

---
## 1.2.7 - 2026-09-19

**Changed: a rock whose name is two words no longer splits into two entries.** `/atm filter add Gneiss
Dark Ochre` queued `gneiss`, `dark` and `ochre` - three patterns. `dark` and `ochre` each match Dark
Ochre on their own, so nothing landed on the `warning` line and the reply looked right while the
queue was not what was typed. The separator is the comma now, and a line without commas is read at
the spaces with any run of words that names a rock put back together first.

### Changed

- **Names are separated by commas.** `/atm filter add gneiss, dark ochre` is two entries, and the
  space after a comma is decoration. The comma is never crossed, so `/atm filter add dark, ochre` is
  two patterns on purpose.
- **A line typed without commas still works.** The words are separated at the spaces, and a run of
  words the game knows as one rock is joined back up: `filter add gneiss dark ochre` queues the same
  two entries. `filter add veldspar kernite blue ice` and every other existing line read the same as
  before.
- **A word that stands for a whole kind is never swallowed into a name.** `ore`, `ice`, `moon`,
  `any` and `*` are always entries of their own, and so is a number - a place in a list or a type
  ID. For a rock whose own name holds one of those words, queue the distinctive part
  (`filter add azure` for Azure Ice) or its type ID.
- **The reply separates entries with a comma:** `ore   : 1. veldspar, 2. dark ochre`.
- **`del` still clears a queue an older release wrote.** `filter del dark ochre` drops a stored
  `dark ochre` entry; where the queue holds `dark` and `ochre` as two entries, those are dropped
  instead, because either way the words typed are what was asked for.
- **`/atm copy` is unchanged** and still carries the whole queue onto the target, a name of several
  words included.

```text
> /atm filter add Gneiss Dark Ochre
AdvancedUtilityDrones added gneiss, dark ochre.
  ore   : 1. gneiss, 2. dark ochre

> /atm filter add dark, ochre
AdvancedUtilityDrones added dark, ochre.
  ore   : 1. gneiss, 2. dark ochre, 3. dark, 4. ochre
```

## 1.2.6 - 2026-09-19

**Changed: `/atm copy` answers with the shape of the command, and the roster of stored characters is
now `/atm copy list [name]`.** A bare `copy` printed the search examples *and* everybody stored on the
server, so the one reply a player types to remember the syntax also pushed other people's settings in
front of them. The roster is a form of its own now - and it takes part of a name, so a fleet is searched
the same way a copy is.

### Changed

- **`/atm copy`** - the examples only: `<name|id>`, the `User:<id>` label the client shows, and
  `copy list [name]`.
- **`/atm copy list [name]`** - every character whose settings are stored here (id, name, mode and
  queue), with the caller marked `(you)`. Part of a name narrows it (`copy list exampel`), and the
  `User:<id>` label works as a filter too. The listing keeps *every* match instead of refusing an
  ambiguous one, so `copy list fleet` shows both `Fleet Lead` and `Fleet Wing` where `copy fleet`
  still asks for more of the name.
- A filter that matches nobody says so and points back at `copy list`; `/atm help` lists both forms.

  ```text
  > /atm copy
  AdvancedUtilityDrones copy - take another character's whole setup onto yours:
    /atm copy exampel         - part of a name is enough, and a typo is tolerated
    /atm copy User:140000005 - or the character ID under the name in the client
  > /atm copy list exampel
  AdvancedUtilityDrones copy list "exampel" - 2 of 3 character(s) match:
    140000005   Example Miner (you) - on spread, veldspar, kernite
    140000006   Example Alt - on focus, no filter
  ```

### Notes

- The queue, the players file and the copy itself are unchanged: this is the two shapes of one command
  and the matcher they share. `lib/copySettings.js` grew `matchStoredCharacters` (every match, in the
  same prefix / substring / any-order / typo tiers), and `matchCopySource` is now the "exactly one
  answer" wrapper around it - so `copy` and `copy list` can never disagree about who is meant.
- `allowPlayerCopy: false` still removes the whole command, the roster included.
- 1.2.5's grammar is untouched: `filter` is still `add` / `move` / `del`.

---
## 1.2.5 - 2026-09-19

**New: `/atm filter` is three commands and one reply.** `add`, `move` and `del` are the whole
grammar, every reply prints the queue as one numbered list per kind of rock, and the number in front
of an entry is the number those commands take. The queue itself is unchanged - the same tokens in the
same order, stored and read back exactly as before - and nothing in the mining path reads the new
data: this is about what the reply tells the player.

### Added

- **The queue comes back as one numbered list per kind of rock.** The numbers restart in every list,
  because each list is mined on its own, and the label of a list is the kind word that stands for it.

  ```text
  > /atm filter add veldspar kernite blue ice zeolites
  AdvancedUtilityDrones added veldspar, kernite, blue, ice (any ice rock), zeolites.
    ore   : 1. veldspar   2. kernite
    ice   : 1. blue   2. ice (any ice rock)
    moon  : 1. zeolites
  ```

- **A name that matches no rock gets its own `warning` line**, with the name it probably meant:
  `warning: 1. veldsparx (no rock matches that name, did you mean Veldspar?)`. The entry is kept as
  typed - the mod never corrects a player on its own - but a typo no longer sits in the queue
  matching nothing in silence.
- **A number right after a name is that name's place in its own list**, in `add` as well as in
  `move`: `/atm filter add kernite 1` puts Kernite at the top of the ore list even when it is the
  fifth name typed. A number past the end of a list lands at the end of it, and a number on its own
  is still a type ID.
- **`/atm filter move <name> [number] ...`** reorders the queue with the same grammar: a name with no
  number goes to the end of its own list, and a move that asks for the place an entry already has
  changes nothing. A name that is not queued yet is reported, not added - this reorders the queue, it
  does not grow it.
- **`/atm filter del <name|ore|ice|moon|*>`** drops everything the words resolve to: a name, a type
  ID, a name pinned to one kind (`del ice:glacial mass`), a kind word (`del ice` drops every ice
  entry) or `*` for the whole queue.

### Changed

- **`clear` is gone.** `del ice` drops that list and `del *` empties the queue, and typing the old
  words answers with the command that replaced them.
- **The per-kind forms are gone too.** `/atm filter ore`, `/atm filter ore del 1` and
  `/atm filter list` each answer with the line that does what they meant (`/atm filter add ore`,
  `/atm filter del ...`, `/atm list`).
- **Entries are dropped by name, not by position.** The numbers now count inside one list, so a bare
  number after `del` is a type ID again: `del 1231` drops the type ID 1231.
- **`/atm status` and `/atm copy` print the queue as one line of names** (`pyroxeres, veldspar`)
  instead of a numbered list, so the numbered lists in a `filter` reply are never confused with them.
- **`/atm help` and the footer of `/atm filter` list the three commands** with the shape of each one.

### Notes

- **Where the kind of a rock comes from.** The server's own item types: every rock is an `Asteroid`
  (item category 25) and the group it sits in says ordinary ore, ice (group 465) or one of the five
  moon-asteroid families `services/structure/autoMoonMiningService.js` names. Nothing in the targeting
  path reads it - the drones still mine from the live mining state - and a rock the mod has actually
  seen is remembered with the kind the mining runtime gave it, so a reply cannot disagree with what
  the drones do. The catalogue is built on first use and cached.
- **A server whose item types cannot be read** shows the queue ungrouped, as one comma-separated
  line, with a note saying so. The filter keeps working either way.
- No new setting, no new file to configure, and no change to the players file: an existing queue,
  hand-written or not, is read exactly as before, and a queue written by 1.2.5 is a plain list of
  tokens like any other.
- **This release supersedes 1.2.4, which was never deployed.** The 1.2.4 packages are gone from
  `dist/`; everything they carried is here, with the reply re-cut as described above.

---
## 1.2.3 - 2026-09-19

**New: one queue instead of three, and `/atm copy` became a finder.** The what-to-mine list is a
single ordered queue that reads the way a player types it, and the copy command looks an alt up by the
name the client shows instead of a numeric ID nobody without staff rights ever sees.

### Changed

- **One flat queue.** `/atm filter add veldspar kernite ice` appends those rocks in that order, and
  that order is the priority order: Veldspar first, Kernite once no Veldspar is in range, any ice after
  that. The three per-kind lists are gone, so a rock no longer has to be assigned to a kind before it
  can be queued - the kind split is what made the old `filter ore add 1 ...` form so wordy.
- **A bare kind word means that whole kind.** `ore`, `ice` and `moon` stand for every rock of that
  kind, so "any ore, then any ice" is `add ore ice`. `*` (or `any`) is any rock, `1231` is a type
  ID, and `ice:glacial mass` pins a name to one kind for the rare name two kinds share.
- **A name matches any kind.** `veldspar` is matched against the English type name the client shows,
  case-insensitively, so it covers Veldspar, Dense Veldspar, Concentrated Veldspar and the rest of the
  family - no kind prefix needed.
- **`del`, `clear` and the reply keep their shape.** `/atm filter del 2` drops the entry the queue
  printed as "2.", `/atm filter del ice` drops the whole ice kind, `/atm filter clear ice` empties
  one kind and `/atm filter clear` empties everything. The numbers in a reply are positions in the
  queue, so what is printed can be typed straight back.
- **The 1.2.2 per-kind form still works.** `/atm filter ore add 1 veldspar 2 kernite` pins those names
  to ore, reads and drops the priority numbers - the queue itself is the order now - and
  `/atm filter ore del 2` counts that kind's entries, exactly as it did.
- **`/atm copy` searches.** `/atm copy exampel` finds `Example Miner`: a name is matched exactly
  first, then as a prefix, then as a substring, then with every word of the query in any order, and
  last with one or two typo edits against a word of the name.
- **`/atm copy` with no argument is a finder, not just a list.** It prints both ways to search
  (`/atm copy <part of a name>` and `/atm copy User:<id>`) next to every stored character, marks the
  caller as `(you)` and says that a character shows up once they have used an `/atm` command.
- The queue a reply prints and the queue the file stores are the same tokens, so
  `config/advancedUtilityDrones.players.json` holds what the player read in game:
  `"oreFilter": ["veldspar", "ice"]`. An entry written by 1.2.2 - three per-kind buckets - is read as
  the queue it describes, so an upgrade keeps every setting.

### Notes for operators

- No configuration change is needed: existing settings, including 1.2.2-shaped `oreFilter` entries,
  keep working and the queue still holds at most 16 entries.

---

## 1.2.2 - 2026-09-18

**New: `/atm copy` - one command to make a multibox fleet uniform.** The whole per-character
setup - targeting mode, threshold, takeover rule, range and the full what-to-mine queue - can be
handed from one character to another.

### Added

- **`/atm copy <id|name>`** (plain chat: `!atm copy ...`). The identifier is the character ID, the
  client's `User:<id>` label, or the character name the mod stored when that player last changed
  something: `/atm copy User:140000005`, `/atm copy 140000005` and `/atm copy Example Miner` all
  work, and a unique part of a name is enough. A name that fits more than one character is refused
  with the candidates instead of guessed.
- **`/atm copy` on its own** lists the characters whose settings are stored on the server, with what
  each one has set - the pick list for the next account of the fleet.
- **The copy is exact, not a merge.** The target's entry becomes the source's entry: a threshold or
  a queue the source never set is dropped from the target as well, so the two characters really are
  identical afterwards. A source with nothing saved is refused, so a mistyped ID cannot wipe a
  character's settings - `/atm reset` is still how you deliberately go back to the defaults.
- `allowPlayerCopy` (env `EVEJS_ADVANCED_UTILITY_DRONES_ALLOW_PLAYER_COPY`, default `true`). `false`
  removes the command; it is refused as well when `allowPlayerToggle` is `false`, while the
  read-only listing still answers.
- The copy goes through the same write path as every other setting, so it survives a restart and the
  "a queue change reaches working drones within a second" rule applies to it too.

### Notes for operators

- The settings are not account-bound and not private - every entry sits in one server-side file - so
  copying from another player is allowed by default. `allowPlayerCopy: false` in
  `config/advancedUtilityDrones.json` (or the environment variable) turns it off.
- Nothing else changed: same commands, same files, drop-in over 1.2.1.

---

## 1.2.1 - 2026-09-18

**A queue change now reaches the drones that are already mining.** Until this release a new queue
only applied to drones that happened to be idle: a working drone finished the rock it was on first,
which made the command look as if it had not been understood.

### Added

- **Immediate re-target.** When the queue changes - `add`, `del`, `clear`, `/atm fallback`, `reset`,
  or a hand edit of the players file - the next scan (half a second later) re-targets that
  character's mining drones onto the best rock under the new queue. A drone already on the
  top-ranked rock is left alone rather than restarted, and a queue that leaves a working drone
  nothing to mine brings it home with the recall reason `queue changed`.
- `retargetOnFilterChange` (env `EVEJS_ADVANCED_UTILITY_DRONES_RETARGET_ON_FILTER_CHANGE`, default `true`).
  `false` restores the 1.2.0 behaviour, where only idle drones follow a new queue.
- The replies to the queue commands say so, and `status` counts the re-targets.

### Notes for operators

- Only drones this mod is flying are re-targeted. A drone the player ordered by hand stays parked,
  and combat, salvage and repair drones are never touched.
- Nothing else changed: same commands, same settings files, drop-in over 1.2.0.

---

## 1.2.0 - 2026-09-18

**New: `/atm`, and a priority queue instead of a filter.** The command got a short name, and what
to mine became an ordered list per kind of rock instead of an unordered set.

### Changed

- **The command is `/atm` now** (plain chat: `!atm`). `/altmining`, `/advancedutilitydrones` and
  `!amd` still work, so nobody has to relearn anything.
- **`ore` / `ice` / `moon` moved under `filter`** and take `add`, `del`, `clear` and `list`:
  `/atm filter ore add 1 veldspar 2 kernite` queues Veldspar ahead of Kernite, `/atm filter ore del 2`
  drops an entry by position, `/atm filter ore del kernite` drops it by name, `/atm filter ore clear`
  empties one kind and `/atm filter clear` empties all three.
- **The list is a priority order, not a whitelist.** An idle drone is sent to the first entry that
  matches anything in range; a rock matching a lower entry is passed over even when it is closer.
  The entry `any` (or `*`, or `all`) stands for that whole kind, which is how the old "any ice"
  is written now.
- **`/atm filter` prints the queue**, one numbered line per kind, and `status` shows it on its
  `filter` line: `ore 1.veldspar 2.kernite . ice skipped . moon skipped`.
- **`/atm list` reads in queue order** while a queue is set - the rocks the player asked for first,
  everything else by distance - and only the queued ones are marked.
- The per-kind cap went from 8 entries to 16.
- A bare name is still a shortcut for `add`, and the old `ore veldspar` spelling now answers with
  the new one instead of doing nothing.

### Notes for operators

- The players file keeps its `oreFilter` key and its shape: an ordered array of names per kind. A
  queue written by 1.1.0 loads unchanged and is simply read as a priority order, in the order it was
  already stored.
- Nothing else moved: same single preload line, same `config/` files, drop-in over 1.0.x and 1.1.0.

---

## 1.1.0 - 2026-09-18

**New: tell the drones what to mine.** A player can now name the ore the automation is allowed to
touch - per character, from the same chat command, with no configuration file to hand out.

### Added

- `/altmining ore|ice|moon [names]` - mine only rocks of that kind whose type name contains one of
  the names. No name at all means "any rock of that kind". Moon ore is a kind of its own, so an
  `ore` filter never picks a moon rock. Names are matched case-insensitively as substrings, which
  is what makes `veldspar` cover Veldspar, Dense Veldspar, Concentrated Veldspar and the rest of
  the family. A number is read as a type ID. At most 8 names of 24 characters per kind.
- `/altmining ore|ice|moon off` - drop that kind from the filter; `/altmining filter all` clears it
  completely and `/altmining filter` shows it.
- `/altmining fallback any|idle|default` - what happens when a filter matches nothing in range.
  `any` (the shipped default) mines the closest rock anyway, `idle` parks those drones, `default`
  goes back to the server setting.
- `/altmining list [ore|ice|moon]` - every ore type within drone range, with the name to type, the
  rock count, the volume left and the distance to the nearest rock of it. The type the filter
  already matches is marked with an asterisk.
- Two server settings: `filterScanLimit` (default 512) widens the scan while a filter is set,
  because the nearest 48 rocks may all be ones the player does not want; `filterFallback`
  (default `any`) is the server-wide default for the per-character fallback above.
- `status` prints a `filter` line while a filter is set, including how many rocks in range match.

### Notes for operators

- Nothing to configure: with no filter set, the mod behaves exactly as it did in 1.0.2.
- `oreFilter` and `filterFallback` live in `config/advancedUtilityDrones.players.json` next to the
  other per-character choices, so they travel with that file and are removed with the mod.
- With the default fallback of `any`, a kind a player did not list is still mined once nothing
  matching is in range. A player who wants a hard filter sets `fallback idle` (or turns that kind
  off explicitly).

---

## 1.0.2 - 2026-09-18

**Fixed a wrong full-hold rule on hulls that have a mining bay.** Reported from a Rorqual: the ore bay
was full, the cargo hold was still empty, and the squadron went on mining a rock that could never be
delivered - the only thing that eventually brought it home was the stalled-drone watchdog.

### Changed

- The full-hold decision now follows the bay the server actually delivers into, in the server's own
  order (preferred bay -> specialized ore/ice/gas hold -> general mining hold -> cargo hold), and it
  judges only the first bay in that order that has any room left. The server abandons a mining cycle
  it cannot fit one whole unit into instead of continuing to the next bay, so the old question -
  "does any bay still have room?" - was the wrong one. On a mining hull it answered "yes" for the
  cargo hold while every cycle was being thrown away.
- A hull with a mining bay of its own is therefore judged on that bay alone and comes home on it.
  Only a hull without a mining bay is judged on its cargo hold, which is then the bay that really
  receives the ore. On a Rorqual the squadron now recalls with the cargo hold still empty, which is
  what the client shows and what the drones can actually fill.

### Removed

- `holdStopMode` - the `EVEJS_ADVANCED_UTILITY_DRONES_HOLD_STOP_MODE` environment variable, the
  `holdStopMode` JSON key, and `/altmining hold`. Its `all` value asked for the cargo hold to be
  filled after the mining bay, which no hull with a mining bay can ever do. A leftover key in a
  config file or in `config/advancedUtilityDrones.players.json` is ignored, and it disappears the
  next time that file is written. Nothing has to be edited by hand.

### Added

- `verbose: true` now logs the per-bay figures with every order and every hold verdict, so a report
  about a bay that refuses to fill can be answered straight from the log:

```text
[advancedUtilityDrones] assigned drone 9988400004288 to ore target 5020561034242 at 18855 m, flag 134 2100.25/900000 m3 free
[advancedUtilityDrones] hold stop for controller 9988400004249 (hold nearly full): flag 134 0.25/900000 m3 free, threshold 2 m3
[advancedUtilityDrones] recalled 5 mining drone(s): hold nearly full
```

- `!altmining status` prints a `hold bays` line when the hull has more than one bay the mod watches.

### Notes for operators

- Nothing to configure. The default behaviour was already the new rule (`holdStopMode: "mining"`),
  and this release simply makes it the only rule. `minHoldFreeVolumeM3` (default 2 m3) is unchanged
  and still decides how much spare room the bay keeps before the squadron comes home.

---

## 1.0.1 - 2026-09-18

- **Per-character settings.** Every choice a player makes is saved per character in
  `config/advancedUtilityDrones.players.json`, survives a restart, and falls back to the server
  defaults for anything the character has not set.
- **Ordinary-chat trigger.** `!altmining ...` is consumed from normal chat, so a character with no
  staff rights can drive the mod. The reply goes to the sender alone and the line is never broadcast.
  The `/altmining` form is unchanged and both run the same handler.
- **The control range follows the ship.** 20 km base + 5 km per Drone Avionics level + 3 km per
  Advanced Drone Avionics level + 20 km per fitted Drone Link Augmentor + implant bonuses, resolved
  live from the hull being flown. `rangeMode: "fixed"` with `rangeMeters` overrides it.
- **Recall hardening.** `minHoldFreeVolumeM3` stops the squadron before a nearly-full bay turns into
  an idle/mining flap, `maxStalledReassignments` is the watchdog for a drone that keeps being ordered
  onto a rock it never delivers from, and the drone state replay keeps the drone window and the
  target icon from going stale.
- **Installer hardening for shared `mods/` folders.** The native preload appends to `NODE_OPTIONS`
  instead of claiming it, the Docker preload goes in as the last `--require` entry, and `status.bat`
  reads the real loader chain back out of both entry points - naming any mod whose block would be
  dropped, and any folder in `mods/` that carries a `loader.js` but appears in no chain.
- **`update.bat`**, which is `install.bat` with an update label: it archives the folder it replaces
  and reports the version it moved from and to.
- **Launcher package** (`AdvancedUtilityDrones-<version>-EveJS-<evejs>-launcher.zip`) for EveJS
  Launcher, alongside the installer package.

---

## 1.0.0 - 2026-09-17

First release.

- Launched ore and ice mining drones pick their own rocks: the closest compatible rock inside the
  ship's drone control range, then the next one when a rock depletes.
- `spread` (one drone per rock, default) and `focus` (every idle drone on the closest rock).
- The squadron recalls itself when the hold can no longer take a unit, and when one of the drones
  takes fire it comes home and stays home for two minutes.
- A drone the player ordered by hand is left alone; only idle drones are ever touched.
- Server-side only: three module exports are wrapped in memory at startup, no EveJS file is edited on
  disk, and there is nothing to distribute to players.