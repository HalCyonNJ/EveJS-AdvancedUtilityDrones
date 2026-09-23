# Advanced Utility Drones - Manual

Applies to **v1.0.3-beta.1** on EveJS 0.12.9.

The command is `/aud`; `!aud` is the same command from ordinary chat. The kind of drone comes
first: `mining` (`mi`) or `salvage` (`sa`). In game, the help lists use the short forms. The
examples in this manual use the full spellings.

## Root Commands

| Command | Purpose | Full-spelling example |
|---|---|---|
| `/aud` | Show the two drone kinds. | `/aud` |
| `/aud help` | Show the root commands. | `/aud help` |
| `/aud copy <name\|id>` | Copy another character's complete setup onto you. | `/aud copy Example Alt` |
| `/aud copy list [name]` | List stored character setups, optionally filtered by name. | `/aud copy list fleet` |
| `/aud clear` | Clear your saved settings for both drone kinds. | `/aud clear` |

`copy` is exact: the target receives the source character's complete saved setup for both kinds.
`copy list` is read-only. A character appears there after using an `/aud` command once.

## Mining Commands

`/aud mining` opens the mining command set. With no command after it, `status` is used.

| Command | Purpose | Full-spelling example |
|---|---|---|
| `/aud mining status` | Show mining state, drones, range, hold and counters. | `/aud mining status` |
| `/aud mining on` | Enable automatic mining for your character. | `/aud mining on` |
| `/aud mining off` | Disable automatic mining for your character. | `/aud mining off` |
| `/aud mining target spread` | Give each mining drone its own rock. | `/aud mining target spread` |
| `/aud mining target focus` | Put the mining drones on the same rock. | `/aud mining target focus` |
| `/aud mining range` | Show the current search radius. | `/aud mining range` |
| `/aud mining range <meters>` | Set a fixed search radius in metres. | `/aud mining range 60000` |
| `/aud mining range ship` | Follow the ship's resolved drone-control range. | `/aud mining range ship` |
| `/aud mining threshold <m3>` | Set the free-space margin that stops the squadron. | `/aud mining threshold 2` |
| `/aud mining filter` | Show the mining queue, fallback and grade setting. | `/aud mining filter` |
| `/aud mining filter add <name\|id>[, ...]` | Add one or more rocks to the ordered queue. | `/aud mining filter add veldspar, kernite` |
| `/aud mining filter move <name\|id> [place]` | Move a queued rock to a place in its list. | `/aud mining filter move kernite 1` |
| `/aud mining filter del <name\|id>` | Remove a queued rock. | `/aud mining filter del kernite` |
| `/aud mining filter clear ore\|ice\|moon` | Clear one complete rock list. | `/aud mining filter clear ice` |
| `/aud mining filter grade on\|off` | Prefer the richest grade in range, or treat grades equally. | `/aud mining filter grade on` |
| `/aud mining filter fallback any\|idle` | Mine the closest rock when the queue matches nothing, or stay idle. | `/aud mining filter fallback idle` |
| `/aud mining list [ore\|ice\|moon]` | List mineable rocks in range. | `/aud mining list ore` |
| `/aud mining control hold\|recall\|off` | Choose how a manual drone order affects automation. | `/aud mining control hold` |
| `/aud mining resume` | Return manually controlled drones to automation. | `/aud mining resume` |
| `/aud mining clear` | Clear only the mining settings. | `/aud mining clear` |
| `/aud mining help` | Show the mining command list. | `/aud mining help` |

Accepted values:

- `target`: `spread` or `focus`.
- `range`: a number of metres, or `ship`.
- `filter`: rock names or type IDs; list names are `ore`, `ice` and `moon`.
- `grade`: `on` or `off`.
- `fallback`: `any` or `idle`.
- `control`: `hold`, `recall` or `off`.

## Salvage Commands

`/aud salvage` opens the salvage command set. With no command after it, `status` is used.

| Command | Purpose | Full-spelling example |
|---|---|---|
| `/aud salvage status` | Show salvage state, drones, wrecks, cargo and counters. | `/aud salvage status` |
| `/aud salvage on` | Enable automatic salvage for your character. | `/aud salvage on` |
| `/aud salvage off` | Disable automatic salvage for your character. | `/aud salvage off` |
| `/aud salvage target spread` | Give each salvage drone its own wreck. | `/aud salvage target spread` |
| `/aud salvage target focus` | Put the salvage drones on the same wreck. | `/aud salvage target focus` |
| `/aud salvage distance nearest` | Choose the nearest wreck first. | `/aud salvage distance nearest` |
| `/aud salvage distance farthest` | Choose the farthest wreck first. | `/aud salvage distance farthest` |
| `/aud salvage list` | List wrecks in range with distance and former owner. | `/aud salvage list` |
| `/aud salvage range` | Show the current search radius. | `/aud salvage range` |
| `/aud salvage range <meters>` | Set a fixed search radius in metres. | `/aud salvage range 60000` |
| `/aud salvage range ship` | Follow the ship's resolved drone-control range. | `/aud salvage range ship` |
| `/aud salvage threshold <m3>` | Set the cargo free-space margin that stops the squadron. | `/aud salvage threshold 2` |
| `/aud salvage control hold\|recall\|off` | Choose how a manual drone order affects automation. | `/aud salvage control recall` |
| `/aud salvage resume` | Return manually controlled drones to automation. | `/aud salvage resume` |
| `/aud salvage clear` | Clear only the salvage settings. | `/aud salvage clear` |
| `/aud salvage help` | Show the salvage command list. | `/aud salvage help` |

`list` is informational. It reports what is around the ship and does not change the targeting
order; `distance` is the command that chooses `nearest` or `farthest`.

Accepted values:

- `target`: `spread` or `focus`.
- `distance`: `nearest` or `farthest`.
- `range`: a number of metres, or `ship`.
- `control`: `hold`, `recall` or `off`.

## Shared Values

- `threshold` is per character and applies to the destination hold for each drone kind.
- `range` and `control` are also per character and shared by both drone kinds.
- `hold` leaves a manually ordered drone under your control until it is relaunched or resumed.
- `recall` leaves the automation running unless you issue a manual recall.
- `off` lets the automation continue to manage drones after a manual order.
