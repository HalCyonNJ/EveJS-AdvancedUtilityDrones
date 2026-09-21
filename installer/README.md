# Advanced Utility Drones v1.0.0-alpha - Installer

Gives mining drones the auto-targeting every other drone in the game has: a launched drone finds the
closest ore or ice inside the ship's drone control range and starts mining, and the squadron recalls
itself when the hold is full or one of the drones takes fire. No client update is required, and the
mod never edits EveJS source on disk - three module exports are wrapped in memory at startup.

This installer lives inside the mod folder, beside `loader.js`. The mod itself is
the folder above; its [README](../README.md) lists the settings, and
[HOW-IT-WORKS.md](../HOW-IT-WORKS.md) explains the mechanism.

The full handbook - install options, every setting, the in-game commands, the per-character file,
when the drones come home, troubleshooting - is [`MANUAL.md`](../MANUAL.md). What each version
changed is in [`CHANGELOG.md`](../CHANGELOG.md). Both files live at the mod's root, so an
installed copy keeps its own manual.

## Requirements

- EveJS 0.12.8 (native Windows install, or the Docker Compose project).
- Node.js 18 or newer on `PATH` to run the installer.

## Install

```text
install.bat
```

With no arguments the installer assumes EveJS is installed on this computer and finds it on its own,
in this order:

1. beside itself, in the current directory, and one level up;
2. up its own ancestor chain (a package unpacked inside `<EveJS root>\mods\` resolves this way);
3. only if both come up empty, a bounded sweep of the local drives - depth two, skipping `Windows`,
   `Program Files`, `AppData` and friends. That is what makes unpack-and-double-click work when the
   ZIP was extracted into `Downloads` or onto the Desktop.

A folder counts as an EveJS root only if it holds both `server/index.js` and
`server/src/services/drone/droneRuntime.js`, so the sweep recognises a real candidate instead of
guessing. When more than one is found the installer lists them and asks which to use - and if there is
no console to ask on, it stops instead of picking one. Nothing is written before the root is known.

```text
install.bat --server "C:\path\to\EveJS"
```

`--server` skips the search entirely, as do `EVEJS_SERVER` and `EVEJS_ROOT` in the environment. Use one
of them when the machine holds more than one checkout, or when the sweep finds the wrong one first. To
point the sweep at specific places instead, set `EVEJS_ADVANCED_UTILITY_DRONES_SEARCH_BASES` to a ";"-separated
list of directories; it replaces the drive list rather than adding to it.

The installer always copies the mod to `<EveJS root>\mods\AdvancedUtilityDrones`, and then registers
the preload in every deployment it finds:

| Deployment | Registered in | Entry added |
|---|---|---|
| Docker | `docker/entrypoint.sh` | `--require /app/mods/AdvancedUtilityDrones/loader.js` |
| Native | `StartServer.bat` | `NODE_OPTIONS=--require "...\mods\AdvancedUtilityDrones\loader.js"` |

The entry is appended **after** every `--require` already in the list, in both `run_server()` and
`run_all()`. That is deliberate: require order is `Module._load` hook order, and only the outermost
hook sees the exports object the last transform produced. A mod that replaces that object wholesale
would otherwise discard a patch applied to the previous one.

On the native side the entry **appends** to `NODE_OPTIONS` instead of assigning it, and goes in after
every preload block another loader mod already placed there - counting a block as one unit however many
lines it spans. A launcher that assigns outright, or that guards with `if not defined NODE_OPTIONS`,
silently disables whichever loader mod registered second, so a second mod has to append to stay
compatible. Re-running the installer removes and re-inserts this block, which is also how a launcher an
older installer mis-ordered gets repaired.

Both registrations are idempotent, so running the installer twice changes nothing the second time.
Every file it is about to rewrite is copied to
`<EveJS root>\_advancedutilitydrones-backup\<timestamp>\` first.

Options:

| Option | Effect |
|---|---|
| `--docker-only` | Register in `docker/entrypoint.sh` only. |
| `--native-only` | Register in `StartServer.bat` only. |
| `--dry-run` | Report what would change without writing anything. |
| `--force` | Reinstall even when the mod folder already looks current. |
| `--update` | Same run, labelled as an update: it reports the version it replaces. `update.bat` does this for you. |

An existing `mods\AdvancedUtilityDrones\.env` is never overwritten on reinstall, so local edits
survive an upgrade. Delete it first if the shipped defaults are wanted back.

## After installing

```text
Docker : docker compose build && docker compose up -d --no-deps server
Native : restart the server with StartServer.bat
```

Then look for these lines in the server log:

```text
[advancedUtilityDrones] v1.0.0-alpha loader ready ...
[advancedUtilityDrones] drone tick hook installed ...
[advancedUtilityDrones] plain-chat trigger installed ...
```

## Configure

Nothing has to be configured. The default follows the drone control range of whatever ship launched
the drones, which is what most people want.

To change something, edit `<EveJS root>/config/advancedUtilityDrones.json` - copy the mod's
`config.example.json` as a starting point. Under Docker that directory is already bind-mounted, so a
change costs a container restart and never an image rebuild. An environment variable on the `server`
service wins over the file, and a native install can use `mods\AdvancedUtilityDrones\.env` instead.

Precedence: environment variable > `config/advancedUtilityDrones.json` > mod `.env` > built-in default.

An invalid value is reported in the log and the mod installs nothing, leaving mining drones manual.

## Status

```text
status.bat
status.bat --server "C:\path\to\EveJS"
```

The root is located exactly as the installer locates it, so the argument is normally unnecessary.

Reports the mod folder and which deployments currently carry the preload, plus the loader chains the
two entry points will actually produce:

```text
Docker     : registered (D:\eve\docker\entrypoint.sh)
  Docker launch chain (--require order; the last entry owns the outermost hook)
    run_server : fourModeAsteroidBelts -> soloProgressionBalance -> moonOreAnomalies -> autopilotJumpZero -> AdvancedUtilityDrones
    run_all    : fourModeAsteroidBelts -> soloProgressionBalance -> moonOreAnomalies -> autopilotJumpZero -> AdvancedUtilityDrones
Native     : registered (D:\eve\StartServer.bat)
  Native loader chain : autopilotJumpZero -> AdvancedUtilityDrones
                        (AdvancedUtilityDrones is required last, so it owns the outermost hook)
                        no loader block is dropped
```

Neither line is a copy of what the installer wrote: both are read back out of the files.

The `Mod folder` line prints two digests - the folder as it is, and the folder of the package the
installer is running from. They can legitimately differ: a hand-edited file, a folder left behind by
an older release, and the copy inside a Docker image all read as one, because `.dockerignore` drops
`**/.env` before the build. The line only warns, it never blocks anything.

- `NODE_OPTIONS` is a single variable, so a mod that assigns it outright wipes out every `--require`
  already in it and says nothing about it. A block a later mod erases is named, with its line number.
- The container list cannot be erased, but its order still decides who wraps whom. Every server launch
  is listed separately, because patching one branch by hand and forgetting the other is a real way to
  end up with two different servers. A mod required *after* this one gets a note, since that is only a
  problem if it replaces a file this mod wraps.
- A folder in `mods/` that carries a `loader.js` and appears in no chain is installed and completely
  inert. Nothing in EveJS reports that, so the status command does - as a note, since a checkout ships
  both entry points while you normally run only one.

Re-run this after installing anything else that preloads a loader. In game, `/aud m status` is
the per-character view, including the resolved control range and its breakdown.

## Update

```text
update.bat
```

Run this instead of uninstalling and reinstalling when a newer package arrives. A reinstall already
does the right thing - the folder being replaced is archived under
`<EveJS root>\_advancedutilitydrones-backup\<timestamp>\`, the shipped payload is copied over it,
the same idempotent preload is applied again, and everything the operator owns is skipped because it
already exists:

| Kept untouched | Why |
|---|---|
| `config/advancedUtilityDrones.json` | Seeded only when it is missing; on a later run the keys this release added are inserted, and not one value that is there is edited. |
| `config/advancedUtilityDrones.players.json` | Every character's saved choices. |
| `mods\AdvancedUtilityDrones\.env` | `copyPayload` skips an existing `.env`. |

`update.bat` is the same program as `install.bat` with a different label, so it prints the version
it replaced and the version it installed - and it brings `config/advancedUtilityDrones.json` up to the
key set of the release it installs, adding the keys that are missing and stamping the file with
`"configVersion"`, while every value already in it is left exactly as it is (`--dry-run` prints what
would be added). It takes the same `--server`, `--dry-run`,
`--docker-only` and `--native-only` arguments. Rebuild Docker or restart the native server
afterwards.

## Uninstall

```text
uninstall.bat
```

The root is located exactly as the installer locates it. With several candidates it stops and lists
them rather than guessing: this path removes a preload, and the wrong tree must not be touched.

```text
uninstall.bat --server "C:\path\to\EveJS" --dry-run
```

Removes the preload from both deployments and archives the mod folder under
`<EveJS root>\_advancedutilitydrones-backup\<timestamp>\`. The removals are surgical rather than
restored from a whole-file backup, so uninstalling this mod never undoes another mod that registered
itself afterwards.

```text
Docker : docker compose build && docker compose up -d --no-deps server
Native : restart the server with StartServer.bat
```

Mining drones then behave exactly like vanilla: launch them and they sit idle until you order them
onto a rock.

`--keep-files` leaves the mod folder in place, `--keep-config` leaves
`config/advancedUtilityDrones.json` and the players file behind, and `--dry-run` reports without
writing. Without `--keep-config` both configuration files are archived under the backup root and
then removed.