⚒️ EveJS v0.12.8 - Alternate Mining Drones v1.3.0

Alternate Mining Drones Launch your mining or ice drones and they go to work on their own:

🎯 find the closest compatible rock inside your ship's drone control range and start mining - ore, ice and moon ore all work,
🧊 ice harvesting drones take ice and leave your ore alone - each drone type only takes what it can actually mine,
🪨 default spread puts one drone per rock; the closest rock takes the leftovers once every other rock
has a drone on it, and /atm focus stacks them all on one rock instead,
📦 hold full? the whole squadron recalls itself to the drone bay,
🛡️ drone taking fire? the whole squadron comes home and stays home for two minutes,
🖱️ ordered a drone somewhere by hand? it is left completely alone - only idle drones are ever touched.

🎯 What to mine is a queue, and the order you type is the order mined

/atm filter add veldspar, kernite, 16268 queues three rocks, and the drones only move on to the next
one once nothing in range matches the entry above it. An entry is a rock name or a type ID, one per
comma, and a name matches any rock whose own name holds it, so "dark ochre" stays one rock. add only
grows the queue, move, del and clear edit it, and grade on sends the drones to the richest grade in
range first - Veldspar II-Grade before plain Veldspar. A word that names no rock costs only itself:
it is passed over with a warning, and the rest of the line is still queued.

⚙️ Settings live in config/alternateMiningDrones.json

Copy the shipped config.example.json to the server's config folder and edit it. On Docker that
folder is already bind-mounted, so a change costs a container restart, never an image rebuild. An
environment variable in the server service overrides it, and every key is documented in
.env.example.

The defaults are sensible: on, spread, follow the ship, recall on full hold, recall when shot,
grade off, and nothing queued - the closest rock still gets mined.

---
💬 Players can tune it themselves

Everything is done from ordinary chat: !atm ... reaches the server for every character whatever
rights it has, /atm ... works wherever the client forwards it, and /altmining answers to both as
well. What a player changes is saved per character and survives a restart.

!atm status - what the automation is doing for you
!atm on | off - automate this character, or give me vanilla mining back
!atm spread | focus - one rock per drone, or every idle drone on one rock
!atm range [meters | ship] - show the search radius, or set it
!atm threshold 4 - come home once the hold has less than 4 m3 free
!atm filter - the queue, plus the fallback and grade state
!atm filter add <name|id>, ... - queue these rocks, in the order typed
!atm filter move <name|id> <place> - put one entry at a place in its own list
!atm filter del <name|id> - drop one entry
!atm filter clear ore|ice|moon - empty one kind's list
!atm filter grade on | off - mine the richest grade of a rock in range first
!atm filter fallback any | idle - nothing matches: mine the closest anyway, or park
!atm list [ore | ice | moon] - what is mineable around you, with the names to queue
!atm copy <name|id> - copy another character's whole setup onto you
!atm control hold | recall | off - what a manual drone order means for the automation
!atm resume - hand the drones back to the automation
!atm reset - forget your personal settings
!atm help - this list; /atm filter help is the filter's own, and f means filter

Anyone who prefers to click rocks by hand types !atm off and gets exactly the vanilla behaviour
back; with allowPlayerToggle: false that whole surface disappears and the server defaults rule.

Updating is drop-in: run update.bat, or drop the mod folder over mods/ - config/ is never
overwritten and nobody loses settings.

---
I also placed README.md, MANUAL.md, HOW-IT-WORKS.md and the CHANGELOG inside the package, so you
can feed this to your AI and mod it.
