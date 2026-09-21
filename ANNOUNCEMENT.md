# Advanced Utility Drones - Discord posts

The text below is what gets pasted into Discord. Three messages, each inside the
2000-character limit, each one ready as it stands - no editing needed.

To copy one, take everything from the line **after** its marker down to the line
**before** the next marker. The markers are not part of the message, and neither
is this preamble. A single trailing newline does not matter to Discord.

=== MESSAGE 1 OF 3 - the announcement (1462 characters) ===
⚒️ EveJS v0.12.8 - Advanced Utility Drones
Automation for two squadrons, mining and salvage, from one command, with no client mod:
🎯 an idle mining drone picks the closest rock inside your ship's drone control range and starts mining,
🪨 spread gives one drone per rock, focus puts every idle drone on the closest one,
🧊 the queue takes rock names and type IDs, so ice-only or ore-only is a line you type once,
📦 the hold running out of room brings the squadron home,
🛡️ so does taking fire,
🖱️ a drone you ordered by hand is left alone until you type `resume`,
🚢 an idle salvage drone picks its own wreck the same way, works it, and moves on when it is empty,
🔗 wrecks get the same target setting, plus nearest-first or farthest-first,
⚙️ settings live in config/advancedUtilityDrones.json, and every character keeps their own choices.
The defaults are sensible: both squadrons on, spread, range follows the ship, come home when the hold is nearly full.
---
💬 Type `/aud` in game for the two menus, or `!aud` from ordinary chat. Every command has a short form of two letters, and what a command takes is always typed in full:
/aud mi on        /aud sa on
/aud mi tg focus  /aud sa tg focus
/aud mi fl ad veldspar, kernite
/aud sa ds farthest
/aud mi st        /aud sa st
`/aud mi help` and `/aud sa help` list the rest.
I also placed README.md, MANUAL.md, HOW-IT-WORKS.md and the CHANGELOG inside the package, so you can feed this to your AI and mod it.
=== MESSAGE 2 OF 3 - the commands, part one (1126 characters) ===
🎛️ Advanced Utility Drones - commands 1/2
In game `/aud`, in ordinary chat `!aud`, no staff rights needed. Every command has two spellings and the short one is two letters; what a command takes is always typed in full.

**Whole character** (no drone kind in front)
`/aud` - the two menus, mining and salvage, and nothing else.
`/aud help` / `/aud h` - those two lines plus the two below.
`/aud copy <name|id>` / `/aud cp` - take another character's whole setup onto you, both kinds. `/aud copy list` names who has settings saved here.
`/aud clear` / `/aud cl` - forget your settings for both kinds and follow the defaults.

**Mining** - `/aud mining` / `/aud mi`
```
on | off                  ->  /aud mi on
target spread|focus       ->  /aud mi tg focus
range [<meters|ship>]     ->  /aud mi rg 45000    /aud mi rg ship
threshold <m3>            ->  /aud mi th 500
list [ore|ice|moon]       ->  /aud mi ls ice
control hold|recall|off   ->  /aud mi ct recall
resume                    ->  /aud mi rs
clear                     ->  /aud mi cl
status                    ->  /aud mi st
help                      ->  /aud mi h
```
=== MESSAGE 3 OF 3 - the commands, part two (1375 characters) ===
🎛️ Advanced Utility Drones - commands 2/2

**Mining filter** (the `filter` command above) - `/aud mining filter` / `/aud mi fl`
```
add <name|id>[, <more>]   ->  /aud mi fl ad veldspar, kernite
                              /aud mi fl ad gneiss, dark ochre    (the comma makes two entries)
                              /aud mi fl ad 16268                 (a type ID works as well as a name)
move <name|id> <place>    ->  /aud mi fl mv kernite 1
del <name|id>             ->  /aud mi fl dl kernite    /aud mi fl dl 16268
clear ore|ice|moon        ->  /aud mi fl cl ore
grade on|off              ->  /aud mi fl gd on
fallback any|idle         ->  /aud mi fl fb idle
(nothing)                 ->  /aud mi fl    shows the queue, grade and fallback
help                      ->  /aud mi fl h
```

**Salvage** - `/aud salvage` / `/aud sa`
```
on | off                  ->  /aud sa on
target spread|focus       ->  /aud sa tg focus
distance nearest|farthest ->  /aud sa ds farthest
list                      ->  /aud sa ls    (wrecks in range, nearest first, and whose they are)
range [<meters|ship>]     ->  /aud sa rg ship
threshold <m3>            ->  /aud sa th 50
control hold|recall|off   ->  /aud sa ct off
resume                    ->  /aud sa rs
clear                     ->  /aud sa cl
status                    ->  /aud sa st
help                      ->  /aud sa h
```
=== END ===
