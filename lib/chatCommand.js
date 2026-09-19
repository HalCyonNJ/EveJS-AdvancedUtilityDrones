"use strict";

const OVERLAY_MARKER = Symbol.for("evejs.alternateMiningDrones.chatOverlay");
const OVERLAY_VERSION = "1.3.0";
const {
  ORE_FILTER_MAX_PATTERNS,
  ORE_FILTER_SCOPES,
} = require("../config.js");
const copySettings = require("./copySettings.js");
const oreQueue = require("./oreQueue.js");
// The accepted spellings are exactly these two names, on both paths: "/atm" and
// "/altmining" through the client's slash handler, "!atm" and "!altmining" in
// ordinary chat. The long "/alternateminingdrones" is gone, and so is "!amd" -
// the "amd" abbreviation is claimed by other mods on a shared server, and a
// trigger this mod swallows would take their command away from them.
const COMMAND_NAMES = Object.freeze(["atm", "altmining"]);
// Ordinary chat never passes through the client's slash-command handler, which
// is the only reason a character without staff rights can drive this mod at all:
// typing "!atm ..." into the normal chat window reaches the server as a
// plain message, is consumed here, and is never broadcast to the channel.
const TRIGGER_NAMES = Object.freeze(["atm", "altmining"]);
const CONTROL_VALUES = Object.freeze(["hold", "recall", "off"]);
// "/atm help" answers with what can follow "/atm" and nothing else: the filter
// has a command list of its own, reached with "/atm filter help", which is what
// keeps this one short enough to read in one screen.
const HELP_LINES = Object.freeze([
  "/atm on|off - enable or disable automatic mining for your character",
  "/atm spread|focus - one rock per drone, or every drone on the closest rock",
  "/atm range [<meters|ship>] - show the search radius, or set it",
  "/atm threshold <m3> - come home once the chosen hold has less room than this",
  "/atm filter - show what to mine; \"/atm filter help\" lists the filter's commands",
  "/atm list [ore|ice|moon] - what is mineable around your ship right now",
  "/atm copy <name|id> - copy another character's setup onto you; part of a name is",
  "    enough, and \"/atm copy list\" shows who has settings stored here",
  "/atm control hold|recall|off - what a manual drone order means for the automation",
  "/atm resume - undo a manual takeover and let the mod fly those drones again",
  "/atm reset - forget your personal settings and follow the server defaults",
  "/atm status - show the current automation state",
  "/atm help - this list",
  "\"/atm f ...\" is the same as \"/atm filter ...\"",
  "!atm <arguments> - the same thing from ordinary chat; no staff rights needed",
  "/altmining works like /atm, and !altmining like !atm - no other trigger spellings",
]);
const MIN_RANGE_METERS = 1000;
const MAX_RANGE_METERS = 10000000;
const MAX_THRESHOLD_M3 = 1000000;
const MAX_LIST_LINES = 12;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeCommandName(value) {
  return String(value || "").trim().toLowerCase();
}

function formatMeters(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "unknown";
  }
  if (numeric >= 10000) {
    return `${(numeric / 1000).toFixed(1)} km`;
  }
  return `${Math.round(numeric)} m`;
}

function formatVolume(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "unknown";
  }
  return `${Math.round(numeric * 100) / 100} m3`;
}

function playerMeta(session) {
  const name = session && (session.characterName || session.charName || session.character_name);
  if (name == null || String(name).trim() === "") {
    return null;
  }
  return { characterName: String(name).trim() };
}

function buildHelpText(config, runtime = null) {
  const header = runtime
    ? `AlternateMiningDrones v${runtime.MOD_VERSION} - the commands that follow /atm:`
    : "AlternateMiningDrones - the commands that follow /atm:";
  const lines = [header, ...HELP_LINES.map((line) => `  ${line}`)];
  if (!config.allowPlayerToggle) {
    lines.push("  (per-character control is disabled by the server configuration)");
  }
  if (!config.chatTrigger) {
    lines.push("  (the !atm chat trigger is disabled by the server configuration)");
  }
  return lines.join("\n");
}

// "/atm filter help" - what can follow "/atm filter", kept apart from "/atm
// help" so the top-level list stays a list of the top-level commands, and laid
// out the same way: one line per command, the line is what to type, and the
// detail lines sit under it indented by four spaces.
function buildFilterHelpText(config, runtime = null) {
  const header = runtime
    ? `AlternateMiningDrones v${runtime.MOD_VERSION} filter - the commands that follow /atm filter:`
    : "AlternateMiningDrones filter - the commands that follow /atm filter:";
  const lines = [
    header,
    ...FILTER_HELP_LINES.map((line) => `  ${line}`),
  ];
  if (!config.allowPlayerToggle) {
    lines.push("  (changing the queue is disabled by the server configuration; reading it is not)");
  }
  return lines.join("\n");
}

function describeBreakdown(breakdown) {
  if (!breakdown) {
    return "no ship data";
  }
  return (
    `${breakdown.mode}; base ${formatMeters(breakdown.base)} + ` +
    `skills ${formatMeters(breakdown.skills)} + modules ${formatMeters(breakdown.modules)} + ` +
    `implants ${formatMeters(breakdown.implants)}`
  );
}

function buildStatusText(runtime, session) {
  const status = runtime.describeStatus(session);
  const player = status.playerState;
  const lines = [
    `AlternateMiningDrones v${runtime.MOD_VERSION}`,
    `  automation   : ${player.enabled ? "ON" : "OFF"} (${player.targetMode})`,
    `  drones       : ${status.dronesInSpace} mining-capable, ` +
      `${status.miningDrones} mining, ${status.idleMiningDrones} idle`,
    `  assigned     : ${status.stats.assignments}, recalls ${status.stats.recalls}` +
      (status.stats.lastRecallReason ? ` (last: ${status.stats.lastRecallReason})` : ""),
    `  threshold    : ${formatVolume(player.minHoldFreeVolumeM3)}`,
    `  takeover     : ${player.playerControlPolicy}`,
  ];
  if (status.filter) {
    const queue = describeFilterQueue(
      status.filter.queue, (token) => runtime.oreFilterLabel(token),
    );
    lines.push(
      `  filter       : ${queue} ` +
      `(fallback ${status.filter.fallback}${status.filter.grade ? ", grade on" : ""}, ` +
      `${status.filter.matching} of ${status.filter.scanned} rocks in range match)`,
    );
    if (status.filter.matching === 0 && status.idleMiningDrones > 0) {
      lines.push(
        status.filter.fallback === "idle"
          ? "                 nothing in range matches - those drones stay idle"
          : "                 nothing in range matches - flying at the closest rock instead",
      );
    }
  }
  if (status.hold) {
    lines.push(
      `  hold state   : flag ${status.hold.flagID} at ` +
      `${formatVolume(status.hold.free)} free of ${formatVolume(status.hold.capacity)}` +
      (status.hold.reason ? ` (${status.hold.reason})` : ""),
    );
    if (status.hold.bays.length > 1) {
      lines.push(
        `  hold bays    : ${status.hold.bays
          .map((bay) => `flag ${bay.flagID} ${formatVolume(bay.free)} free`)
          .join(", ")}`,
      );
    }
  }
  if (status.stats.parked || status.stats.stalls || status.stats.stateRefreshes) {
    lines.push(
      `  watchdog     : ${status.stats.parked} parked, ${status.stats.stalls} stalled, ` +
      `${status.stats.stateRefreshes} state replays`,
    );
  }
  lines.push(
    `  settings from: ${player.source === "player" ? "your saved choices" : "the server defaults"}`,
  );
  if (player.rangeOverrideMeters != null) {
    lines.push(`  your radius  : ${formatMeters(player.rangeOverrideMeters)} (override)`);
  }
  lines.push(
    status.range
      ? `  control range: ${formatMeters(status.range.rangeMeters)} ` +
        `(${describeBreakdown(status.range.breakdown)})`
      : "  control range: not in space",
  );
  lines.push('  use "/atm help" for the command list');
  return lines.join("\n");
}

// The queue as one line: the entries in the order the drones work through them,
// with no numbers - the reply that wants numbers prints it per kind, where the
// number means something ("filter" and the grouped lines under every change).
// labelOf is how an entry becomes what a player should read, which is what turns
// a queued type ID into the name of the rock it stands for.
function describeFilterQueue(tokens, labelOf = null) {
  const queue = oreQueue.tokenList(tokens);
  return queue.length === 0
    ? "off, every mineable rock counts"
    : queue
      .map((token) => (labelOf ? labelOf(token) : oreQueue.describeToken(token)))
      .join(", ");
}

// Said after every queue change, so nobody has to guess whether a working
// drone is going to follow the new order.
const QUEUE_APPLIES_AT_ONCE =
  " Drones already mining switch to the new queue within a second.";

// The queue read back grouped by the kind of rock each entry mines, so
// "/atm filter add gneiss, dark ochre" answers with the ore list, then the ice
// list, then the moon list. Every entry carries the number it has inside its own
// list - the number "filter move" takes - and the label a reply prints for it, so
// an entry queued as a type ID reads as the rock it stands for. A name that
// matches no rock at all gets a "warning" line of its own, with the name it may
// have meant; notes are the same line for what the command itself has to say,
// like a word it passed over instead of queueing.
function buildFilterKindLines(runtime, tokens, notes = []) {
  const queue = oreQueue.tokenList(tokens);
  const extras = (Array.isArray(notes) ? notes : [])
    .filter((note) => typeof note === "string" && note.trim() !== "");
  const view = queue.length > 0 ? runtime.describeOreFilterQueues(queue) : null;
  const width = (view && view.unknown.length > 0) || extras.length > 0 ? "warning".length : 6;
  const lines = [];
  if (view && !view.ready) {
    lines.push(
      "  by kind : this server's ore list cannot be read, so the queue stays ungrouped",
      `  queue   : ${describeFilterQueue(queue, (token) => runtime.oreFilterLabel(token))}`,
    );
  } else if (view) {
    for (const scope of ORE_FILTER_SCOPES) {
      const entries = view.groups[scope] || [];
      const body = entries.length === 0
        ? "nothing"
        : entries.map((entry) => `${entry.order}. ${entry.label}`).join(", ");
      lines.push(`  ${scope.padEnd(width)}: ${body}`);
    }
    for (const entry of view.unknown) {
      const hint = entry.suggestions.length > 0
        ? `, did you mean ${entry.suggestions.join(" or ")}?`
        : "";
      lines.push(
        `  ${"warning".padEnd(width)}: ${entry.order}. ${entry.label} ` +
        `(no rock matches that name${hint})`,
      );
    }
  }
  for (const note of extras) {
    lines.push(`  ${"warning".padEnd(width)}: ${note}`);
  }
  return lines;
}

// A command's sentence, with the queue grouped by kind underneath it and whatever
// the command passed over on a warning line under that.
function withKindLines(message, runtime, tokens, notes = []) {
  const lines = buildFilterKindLines(runtime, tokens, notes);
  return lines.length === 0 ? message : `${message}\n${lines.join("\n")}`;
}

// "/atm filter help" - the filter's own commands, in the shape of the
// top-level list. A bare number is a type ID everywhere except after a name in
// "move", where it is that entry's place.
const FILTER_HELP_LINES = Object.freeze([
  "/atm filter add <name|id>[, <name|id> ...] - queue what to mine, first entry first",
  "    the comma separates entries, so a name may hold a space",
  "    (\"gneiss, dark ochre\" is two); a bare number is a type ID, and a word that",
  "    names no rock is passed over with a warning instead of being queued",
  "/atm filter move <name|id> <place> - put one entry at a place in its own list; the",
  "    first name picks the list, and a name typed without a number goes to the end",
  "/atm filter del <name|id> - drop one entry; the name or its type ID both work",
  "/atm filter clear ore|ice|moon - empty one whole list",
  "/atm filter grade on|off - mine the richest grade of a rock in range before the",
  "    plainer ones",
  "/atm filter fallback any|idle - with nothing in range matching, mine the closest",
  "    rock anyway, or park the drones",
  "/atm filter - show the queue, and the state of grade and fallback",
  "/atm filter help - this list",
  "\"/atm f <arguments>\" is the same as \"/atm filter <arguments>\"",
]);

function formatCompactVolume(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "unknown";
  }
  if (numeric >= 1000000) {
    return `${(numeric / 1000000).toFixed(1)}M m3`;
  }
  if (numeric >= 1000) {
    return `${(numeric / 1000).toFixed(1)}k m3`;
  }
  return `${Math.round(numeric * 100) / 100} m3`;
}

// What the "list" command shows: every ore type in drone range, with the name
// to type into the queue, how much of it is there and how far the nearest rock is.
function buildOreListText(runtime, session, scope) {
  const result = runtime.describeSceneOres(session, scope || null);
  if (!result.hasShip) {
    return "AlternateMiningDrones: no active ship found.";
  }
  const what = scope ? `${scope} rocks` : "mineable rocks";
  if (result.entries.length === 0) {
    return `AlternateMiningDrones: no ${what} within ${formatMeters(result.rangeMeters)}.`;
  }
  const lines = [`AlternateMiningDrones ${what} in range (${formatMeters(result.rangeMeters)}):`];
  const shown = result.entries.slice(0, MAX_LIST_LINES);
  for (const entry of shown) {
    lines.push(
      `  ${entry.matchesFilter ? "*" : " "} ${entry.scope.padEnd(4)} ${entry.name}` +
      ` - ${entry.rocks} rock${entry.rocks === 1 ? "" : "s"}, ` +
      `${formatCompactVolume(entry.remainingM3)} left, ` +
      `nearest ${formatMeters(entry.nearest)}`,
    );
  }
  if (result.entries.length > shown.length) {
    lines.push(`  ...and ${result.entries.length - shown.length} more`);
  }
  lines.push(`  queue one with: /atm filter add <name>`);
  return lines.join("\n");
}

// "/atm filter" - the queue as the reply prints it: one line per kind of rock
// with the number that kind's "move" takes, what the drones do when nothing in
// range matches, and whether the richest grade of a rock is mined first.
function describeFilter(runtime, characterID) {
  const state = runtime.getPlayerState(characterID);
  const tokens = state && Array.isArray(state.oreFilter) ? state.oreFilter : [];
  const lines = ["AlternateMiningDrones filter - the drones work down each list, first entry first:"];
  if (tokens.length === 0) {
    lines.push("  nothing is queued, so every mineable rock counts");
  } else {
    lines.push(...buildFilterKindLines(runtime, tokens));
  }
  lines.push(
    `  fallback: ${(state && state.filterFallback) || "any"} ` +
    "(with nothing in range matching, \"any\" mines the closest rock anyway and " +
    "\"idle\" parks the drones)",
  );
  lines.push(
    `  grade   : ${state && state.filterGrade ? "on" : "off"} ` +
    (state && state.filterGrade
      ? "(the richest grade of a rock in range is mined before the plainer ones)"
      : "(every grade counts the same - \"filter grade on\" prefers the richest)"),
  );
  lines.push("  commands: \"/atm filter help\" - add, move, del, clear, grade, fallback; \"f\" works");
  return lines.join("\n");
}

function handleFilterFallback(runtime, characterID, value, meta) {
  const normalized = normalizeCommandName(value);
  if (!normalized) {
    const state = runtime.getPlayerState(characterID);
    return {
      message:
        `AlternateMiningDrones filter fallback: ${state ? state.filterFallback : "any"} ` +
        '("any" mines the closest rock anyway once nothing in range matches the queue, ' +
        '"idle" leaves the drones parked instead).',
    };
  }
  if (!["any", "idle", "default"].includes(normalized)) {
    return { message: 'AlternateMiningDrones: fallback must be "any", "idle" or "default".' };
  }
  const state = runtime.setPlayerFilterFallback(
    characterID, normalized === "default" ? null : normalized, meta,
  );
  return { message: `AlternateMiningDrones filter fallback: ${state.filterFallback}.` };
}
// "/atm filter grade on|off" - whether the richest grade of a rock in range is
// mined before the plainer ones. The game spawns the same ore at several grades
// and the type name is where that shows - Veldspar II-Grade, Blue Ice IV-Grade -
// so with this on the drones take the best rock of a family first and work down,
// and with it off every grade counts the same. Either way it is part of what the
// drones are asked to do, so switching it re-tasks the drones that are already
// mining, the same way a queue edit does.
function handleFilterGrade(runtime, characterID, value, meta) {
  const describe = (on) => (
    `AlternateMiningDrones filter grade: ${on ? "on" : "off"} ` +
    (on
      ? "(the richest grade of a rock in range is mined before the plainer ones)."
      : '(every grade counts the same - "filter grade on" prefers the richest).') +
    QUEUE_APPLIES_AT_ONCE
  );
  const normalized = normalizeCommandName(value);
  if (!normalized) {
    const state = runtime.getPlayerState(characterID);
    return { message: describe(Boolean(state && state.filterGrade)) };
  }
  if (!["on", "off", "default"].includes(normalized)) {
    return { message: 'AlternateMiningDrones: grade must be "on", "off" or "default".' };
  }
  const state = runtime.setPlayerFilterGrade(
    characterID, normalized === "default" ? null : normalized === "on", meta,
  );
  return { message: describe(Boolean(state && state.filterGrade)) };
}
const FILTER_ADD_WORDS = Object.freeze(["add", "set", "+"]);
const FILTER_DEL_WORDS = Object.freeze(["del", "delete", "remove", "rm", "-"]);
const FILTER_MOVE_WORDS = Object.freeze(["move", "mv"]);
const FILTER_CLEAR_WORDS = Object.freeze(["clear", "empty"]);

// What the queue makes of the rocks around the ship right now, so a typo shows
// up straight away instead of after a trip to the belt.
function describeQueueMatches(runtime, session, scope) {
  try {
    const result = runtime.describeSceneOres(session, scope);
    if (!result.hasShip) {
      return "";
    }
    const names = result.entries.filter((entry) => entry.matchesFilter).map((entry) => entry.name);
    if (names.length === 0) {
      return " Nothing of that kind is in range right now.";
    }
    return ` Matching in range: ${names.slice(0, 4).join(", ")}` +
      (names.length > 4 ? ` (+${names.length - 4} more)` : "") + ".";
  } catch (_error) {
    return "";
  }
}

// A word a command has to refuse outright: the "ice:glacial mass" pin 1.2.5 used
// to hang a name off one kind, and a word that cannot be an ore name or a type ID
// at all. Refusing the whole line is what keeps the reply printable back.
function describeRefusedWords(typed) {
  const messages = [];
  if (typed.pinned.length > 0) {
    messages.push(
      `"${typed.pinned[0]}" hangs a name off a kind of rock, and that spelling is gone - ` +
      "type the rock's own name, or its type ID.",
    );
  }
  if (typed.unusable.length > 0) {
    messages.push(`"${typed.unusable[0]}" is not a usable ore name.`);
  }
  return messages;
}

// A word that stands for a whole kind of rock, passed over instead of queued.
// 1.2.9 is where "ice" became a word inside real rock names - Blue Ice, Azure
// Ice - so it cannot mean a kind as well, and a filter that names a whole kind is
// what "filter clear" is for.
function describeSkippedWords(typed) {
  return typed.reserved.map((word) => (
    oreQueue.isKindWord(word)
      ? `"${word}" names a whole kind of rock, so it is not an entry - ` +
        `/atm filter clear ${word} empties the ${word} list`
      : `"${word}" stands for every rock, so it is not an entry - ` +
        "the queue takes ore names and type IDs"
  ));
}

// A bare number typed into "add" is a type ID and nothing else, so one the game's
// asteroid table does not know can never match a rock. It is dropped on its own -
// the way "del" drops a word that matches nothing - and the rest of the line is
// still queued, because one bad word never costs the good ones. A catalogue that
// could not be read cannot check anything, so then nothing is dropped.
const TYPE_ID_SHAPE = /^\d+$/u;

function isOrphanTypeID(runtime, word) {
  const text = String(word || "").trim();
  if (!TYPE_ID_SHAPE.test(text) || !runtime.isOreCatalogReady()) {
    return false;
  }
  return runtime.oreTypeIDsFor(text).length === 0;
}

// "/atm filter add ..." - the queue grows by the names typed. An entry that is
// already queued keeps the place it has, because "add" is not "move"; a word that
// names a whole kind of rock, and a number no rock has, are passed over with a
// warning line while everything else on the line still goes in.
function applyQueueAdd(runtime, session, characterID, words, meta) {
  const typed = oreQueue.classifyTypedWords(words);
  const refused = describeRefusedWords(typed);
  if (refused.length > 0) {
    return { message: `AlternateMiningDrones: ${refused[0]}` };
  }
  const state = runtime.getPlayerState(characterID);
  const current = state && Array.isArray(state.oreFilter) ? state.oreFilter : [];
  const notes = describeSkippedWords(typed);
  const usable = typed.usable.filter((word) => {
    if (!isOrphanTypeID(runtime, word)) {
      return true;
    }
    notes.push(
      `"${word}" is not a rock's type ID, so it was not queued - a bare number is a ` +
      "type ID, and only one that names a rock works; \"/atm filter move <name> " +
      `${word}" sets an entry's place`,
    );
    return false;
  });
  if (usable.length === 0) {
    return {
      message: withKindLines(
        'AlternateMiningDrones: add needs a name - ' +
        '"/atm filter add veldspar, kernite, blue ice".',
        runtime, current, notes,
      ),
    };
  }
  const edits = oreQueue.parseEdits(usable);
  const result = oreQueue.placeTokens(current, edits, runtime.oreEntryKinds, {
    skipExisting: true,
  });
  if (result.tokens.length > ORE_FILTER_MAX_PATTERNS) {
    return {
      message: `AlternateMiningDrones: the queue holds at most ${ORE_FILTER_MAX_PATTERNS} ` +
        `entries (this one would hold ${result.tokens.length}). Delete one first.`,
    };
  }
  const label = (token) => runtime.oreFilterLabel(token);
  if (result.skipped.length > 0) {
    const already = result.skipped.map(label).join(", ");
    const one = result.skipped.length === 1;
    notes.push(
      `${already} ${one ? "is" : "are"} already in the queue and ${one ? "keeps" : "keep"} ` +
      `the place ${one ? "it has" : "they have"} - "add" never reorders an entry, ` +
      '"/atm filter move <name> <place>" does',
    );
  }
  if (result.placed.length === 0) {
    return {
      message: withKindLines(
        "AlternateMiningDrones: nothing new to add " +
        `(the queue is ${describeFilterQueue(result.tokens, label)}).`,
        runtime, result.tokens, notes,
      ),
    };
  }
  const added = result.placed.map(label).join(", ");
  runtime.setPlayerOreFilter(characterID, result.tokens, meta);
  return {
    message: withKindLines(
      `AlternateMiningDrones added ${added}.` +
        describeQueueMatches(runtime, session, null) + QUEUE_APPLIES_AT_ONCE,
      runtime,
      result.tokens,
      notes,
    ),
  };
}

// "/atm filter move veldspar 2 kernite 1" - the queue is reordered with the
// numbers the reply prints, which count inside the list of the kind of rock the
// entry mines. The first name typed picks which list is edited: name an ice rock
// and the numbers count in the ice list, and a name of another kind is passed
// over with a warning rather than moved somewhere it does not belong. A name that
// is not queued yet is reported instead of added - this reorders the queue, it
// does not grow it.
function applyQueueMove(runtime, characterID, words, meta) {
  const state = runtime.getPlayerState(characterID);
  const current = state && Array.isArray(state.oreFilter) ? state.oreFilter : [];
  if (current.length === 0) {
    return { message: "AlternateMiningDrones: the queue is empty, there is nothing to move." };
  }
  const typed = oreQueue.classifyTypedWords(words);
  const refused = describeRefusedWords(typed);
  if (refused.length > 0) {
    return { message: `AlternateMiningDrones: ${refused[0]}` };
  }
  const label = (token) => runtime.oreFilterLabel(token);
  const notes = describeSkippedWords(typed);
  if (typed.usable.length === 0) {
    return {
      message: withKindLines(
        'AlternateMiningDrones: move needs a name - "/atm filter move veldspar 2".',
        runtime, current, notes,
      ),
    };
  }
  const edits = oreQueue.parseEdits(typed.usable, { positions: true });
  const kindsOfFirst = oreQueue.kindsOfEntry(edits[0].entry, runtime.oreEntryKinds);
  if (kindsOfFirst.length > 1) {
    return {
      message: `AlternateMiningDrones: "${edits[0].token}" mines more than one kind of rock ` +
        `(${kindsOfFirst.join(", ")}) - the queue keeps one list per kind, so name a rock ` +
        "that belongs to one of them.",
    };
  }
  const kind = kindsOfFirst.length === 1 ? kindsOfFirst[0] : null;
  const result = oreQueue.placeTokens(current, edits, runtime.oreEntryKinds, {
    groupEnd: true,
    onlyExisting: true,
    onlyKind: kind,
  });
  if (result.discarded.length > 0 && kind) {
    notes.push(
      `${result.discarded.map(label).join(", ")} is not ${kind} rock, and the first name ` +
      `picked the ${kind} list - so ${result.discarded.length === 1 ? "it was" : "they were"} ` +
      "left alone",
    );
  }
  // A name typed without a number is placed at the end of its own list rather than
  // refused, and the reply says which ones went there: "move dark ochre 1,
  // veldspar" would otherwise read as if veldspar had been given a place of its own.
  const placedTokens = new Set(result.placed);
  const numberless = edits
    .filter((edit) => edit.position === null && placedTokens.has(edit.token))
    .map((edit) => label(edit.token));
  if (numberless.length > 0) {
    notes.push(
      `${numberless.join(", ")} without a number, so ` +
      `${numberless.length === 1 ? "it was" : "they were"} placed at the end of the list`,
    );
  }
  if (result.placed.length === 0) {
    const why = result.missed.length > 0
      ? `nothing in the queue matches ${result.missed.map(label).join(", ")}`
      : "nothing on that line could be moved";
    return {
      message: withKindLines(
        `AlternateMiningDrones: ${why} (the queue is ${describeFilterQueue(current, label)}).`,
        runtime, current, notes,
      ),
    };
  }
  const moved = result.placed.map(label).join(", ");
  const tail = result.missed.length > 0
    ? ` (not in the queue: ${result.missed.map(label).join(", ")})`
    : "";
  runtime.setPlayerOreFilter(characterID, result.tokens, meta);
  return {
    message: withKindLines(
      `AlternateMiningDrones moved ${moved}${tail}.` + QUEUE_APPLIES_AT_ONCE,
      runtime,
      result.tokens,
      notes,
    ),
  };
}

// "del" on one typed word: everything it resolves to leaves the queue, whichever
// way the entry went in. A type ID covers the entries stored as that ID; a name
// covers the entries stored as the name and the type IDs that name resolves to,
// so "del gelidus" reaches an entry queued as 16268; and a type ID is also
// resolved to the name a reply prints for it, so "del 16268" reaches an entry
// queued as "gelidus" - a reply only ever shows the name. A name of several words
// that matches nothing is tried word by word as well, because a queue set before
// 1.2.7 can hold "dark" and "ochre" as two entries.
function removeOneName(tokens, word, runtime) {
  const kindsOf = runtime.oreEntryKinds;
  const aliases = [word, ...runtime.oreTypeIDsFor(word)];
  const label = runtime.oreFilterLabel(word);
  if (label && label.toLowerCase() !== String(word).toLowerCase()) {
    aliases.push(label);
  }
  const whole = oreQueue.removeMatching(tokens, aliases, kindsOf);
  if (whole.removed.length > 0 || !word.includes(" ")) {
    return whole;
  }
  const parts = oreQueue.removeMatching(tokens, word.split(" "), kindsOf);
  return parts.removed.length > 0 ? parts : whole;
}

// "/atm filter del kernite" - everything the typed names resolve to leaves the
// queue. The words that name a whole kind of rock used to empty that list and now
// get a warning instead: "clear" is the command for a whole kind.
function applyQueueDel(runtime, characterID, words, meta) {
  const typed = oreQueue.classifyTypedWords(words);
  const refused = describeRefusedWords(typed);
  if (refused.length > 0) {
    return { message: `AlternateMiningDrones: ${refused[0]}` };
  }
  const state = runtime.getPlayerState(characterID);
  const current = state && Array.isArray(state.oreFilter) ? state.oreFilter : [];
  const label = (token) => runtime.oreFilterLabel(token);
  const notes = describeSkippedWords(typed);
  if (typed.usable.length === 0) {
    return {
      message: withKindLines(
        'AlternateMiningDrones: del needs a name - "/atm filter del kernite". ' +
        '"/atm filter clear ice" empties one kind of rock.',
        runtime, current, notes,
      ),
    };
  }
  let tokens = current;
  const removed = [];
  const missed = [];
  for (const word of typed.usable) {
    const step = removeOneName(tokens, word, runtime);
    tokens = step.tokens;
    removed.push(...step.removed);
    if (step.removed.length === 0) {
      missed.push(word);
    }
  }
  if (removed.length === 0) {
    return {
      message: withKindLines(
        `AlternateMiningDrones: nothing in the queue matches ${missed.join(", ")} ` +
        `(the queue is ${describeFilterQueue(current, label)}).`,
        runtime, current, notes,
      ),
    };
  }
  const dropped = removed.map(label).join(", ");
  const tail = missed.length > 0 ? ` (not there: ${missed.join(", ")})` : "";
  runtime.setPlayerOreFilter(characterID, tokens, meta);
  return {
    message: withKindLines(
      `AlternateMiningDrones dropped ${dropped}${tail}.` +
        (tokens.length === 0
          ? " The queue is now empty, so every mineable rock counts again."
          : "") +
        QUEUE_APPLIES_AT_ONCE,
      runtime,
      tokens,
      notes,
    ),
  };
}

// "/atm filter clear ice" - one kind's list is emptied. This is the only command
// that takes a kind word, because it is the one thing a kind word can usefully
// say: the queue itself holds rocks, not kinds.
function applyQueueClear(runtime, characterID, words, meta) {
  const kind = words.length === 1 ? normalizeCommandName(words[0]) : "";
  if (!oreQueue.isKindWord(kind)) {
    return {
      message: 'AlternateMiningDrones: clear takes one kind of rock - ' +
        '"/atm filter clear ore", "clear ice" or "clear moon".',
    };
  }
  const state = runtime.getPlayerState(characterID);
  const current = state && Array.isArray(state.oreFilter) ? state.oreFilter : [];
  const label = (token) => runtime.oreFilterLabel(token);
  const result = oreQueue.removeMatching(current, [kind], runtime.oreEntryKinds);
  if (result.removed.length === 0) {
    return {
      message: `AlternateMiningDrones: the ${kind} list is already empty.`,
    };
  }
  const dropped = result.removed.map(label).join(", ");
  runtime.setPlayerOreFilter(characterID, result.tokens, meta);
  return {
    message: withKindLines(
      `AlternateMiningDrones dropped ${dropped} from the ${kind} list.` +
        (result.tokens.length === 0
          ? " The queue is now empty, so every mineable rock counts again."
          : "") +
        QUEUE_APPLIES_AT_ONCE,
      runtime,
      result.tokens,
    ),
  };
}

// A word that is not a filter command. The forms players have in their fingers get
// the line that does what they meant, so nobody has to go looking for the command
// that replaced it.
function describeFilterUsage(head) {
  if (ORE_FILTER_SCOPES.includes(head)) {
    return `AlternateMiningDrones: "${head}" is a kind of rock, not a command - ` +
      `"/atm filter clear ${head}" empties that list, and ` +
      `"/atm list ${head}" shows what is around you.`;
  }
  if (head === "list") {
    return 'AlternateMiningDrones: "/atm list" shows the rocks in range, ' +
      '"/atm list ice" just one kind.';
  }
  return "AlternateMiningDrones: filter takes add, move, del, clear, grade or fallback - " +
    'for example "/atm filter add veldspar, kernite"; "/atm filter" shows the queue, ' +
    'and "/atm f" is the same command.';
}

function readScopeArgument(word) {
  const scope = word ? normalizeCommandName(word) : null;
  if (scope && !ORE_FILTER_SCOPES.includes(scope)) {
    return { scope: null, error: 'AlternateMiningDrones: list takes "ore", "ice" or "moon".' };
  }
  return { scope, error: null };
}

function handleCommand(runtime, config, session, argumentText) {
  const characterID = toInt(session && (session.characterID || session.charid), 0);
  if (characterID <= 0) {
    return { message: "AlternateMiningDrones needs a character session." };
  }
  const parts = String(argumentText || "").trim().split(/\s+/u).filter(Boolean);
  const action = normalizeCommandName(parts[0] || "status");
  const value = parts.slice(1).join(" ").trim();
  const meta = playerMeta(session);

  if (action === "help" || action === "?") {
    return { message: buildHelpText(config, runtime) };
  }
  if (action === "status") {
    return { message: buildStatusText(runtime, session) };
  }
  // Reading the filter and asking what is around you changes nothing, so both
  // work even where players may not change their own settings.
  if (action === "list") {
    const asked = readScopeArgument(value);
    if (asked.error) {
      return { message: asked.error };
    }
    return { message: buildOreListText(runtime, session, asked.scope) };
  }
  if (action === "filter" || action === "f") {
    const words = oreQueue.splitTypedWords(value, runtime.oreEntryKinds);
    const head = normalizeCommandName(words[0] || "");
    // Reading the queue changes nothing, so it works even where players may not
    // change their own settings - and so does the list of what is around you.
    if (!head) {
      return { message: describeFilter(runtime, characterID) };
    }
    if (head === "help" || head === "?") {
      return { message: buildFilterHelpText(config, runtime) };
    }
    if (!config.allowPlayerToggle) {
      return { message: "AlternateMiningDrones: per-character control is disabled by the server." };
    }
    if (head === "fallback") {
      return handleFilterFallback(runtime, characterID, words.slice(1).join(" "), meta);
    }
    if (head === "grade") {
      return handleFilterGrade(runtime, characterID, words.slice(1).join(" "), meta);
    }
    if (FILTER_ADD_WORDS.includes(head)) {
      return applyQueueAdd(runtime, session, characterID, words.slice(1), meta);
    }
    if (FILTER_MOVE_WORDS.includes(head)) {
      return applyQueueMove(runtime, characterID, words.slice(1), meta);
    }
    if (FILTER_DEL_WORDS.includes(head)) {
      return applyQueueDel(runtime, characterID, words.slice(1), meta);
    }
    if (FILTER_CLEAR_WORDS.includes(head)) {
      return applyQueueClear(runtime, characterID, words.slice(1), meta);
    }
    return { message: describeFilterUsage(head) };
  }
  if (action === "copy") {
    return handleCopy(runtime, config, characterID, value, meta);
  }

  if (!config.allowPlayerToggle) {
    return { message: "AlternateMiningDrones: per-character control is disabled by the server." };
  }

  if (ORE_FILTER_SCOPES.includes(action)) {
    return {
      message: `AlternateMiningDrones: "${action}" is a kind of rock, not a command - ` +
        `"/atm filter clear ${action}" empties that list, and ` +
        `"/atm list ${action}" shows what is around you.`,
    };
  }

  if (action === "fallback") {
    return handleFilterFallback(runtime, characterID, value, meta);
  }

  if (action === "on" || action === "off") {
    const state = runtime.setPlayerEnabled(characterID, action === "on", meta);
    return {
      message:
        `AlternateMiningDrones ${action.toUpperCase()} for you ` +
        `(mode ${state.targetMode}). Mining drones launched from your ship ` +
        (action === "on" ? "will pick their own rocks." : "will stay idle until you order them."),
    };
  }

  if (action === "spread" || action === "focus") {
    const state = runtime.setPlayerTargetMode(characterID, action, meta);
    return {
      message: `AlternateMiningDrones targeting mode: ${state.targetMode.toUpperCase()}.`,
    };
  }

  if (action === "range") {
    return handleRange(runtime, session, characterID, value, meta);
  }

  if (action === "threshold") {
    const current = runtime.getPlayerState(characterID);
    if (!value) {
      return {
        message:
          `AlternateMiningDrones threshold: ${formatVolume(current.minHoldFreeVolumeM3)} ` +
          "of spare room before the drones come home.",
      };
    }
    const numeric = Number(value.replace(/[,_\s]/gu, ""));
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > MAX_THRESHOLD_M3) {
      return {
        message:
          "AlternateMiningDrones threshold must be a number of cubic metres between " +
          `0 and ${MAX_THRESHOLD_M3}.`,
      };
    }
    const state = runtime.setPlayerMinHoldFreeVolume(characterID, numeric, meta);
    return {
      message:
        `AlternateMiningDrones threshold: ${formatVolume(state.minHoldFreeVolumeM3)}. ` +
        "The drones head home once the hold they deliver into has less room than that.",
    };
  }

  if (action === "control") {
    const current = runtime.getPlayerState(characterID);
    if (!value) {
      return {
        message:
          `AlternateMiningDrones manual takeover: ${current.playerControlPolicy} ` +
          '("hold" stops automating a drone you ordered by hand until it is relaunched, ' +
          '"recall" only reacts to a manual recall, "off" keeps automating it).',
      };
    }
    const normalized = normalizeCommandName(value);
    if (!CONTROL_VALUES.includes(normalized)) {
      return { message: 'AlternateMiningDrones control must be "hold", "recall" or "off".' };
    }
    const state = runtime.setPlayerControlPolicy(characterID, normalized, meta);
    return {
      message: `AlternateMiningDrones manual takeover: ${state.playerControlPolicy.toUpperCase()}.`,
    };
  }

  if (action === "resume") {
    const resumed = runtime.resumeDrones(session);
    return {
      message: resumed > 0
        ? `AlternateMiningDrones: ${resumed} drone(s) handed back to the automation.`
        : "AlternateMiningDrones: no drone of yours is under manual control.",
    };
  }

  if (action === "reset" || action === "default") {
    const state = runtime.clearPlayerSettings(characterID);
    return {
      message:
        "AlternateMiningDrones: your personal settings were cleared; the server defaults " +
        `apply again (mode ${state.targetMode}).`,
    };
  }

  return {
    message:
      `AlternateMiningDrones: unknown option "${action}". ` +
      'Use "/atm help" for the list.',
  };
}

// /atm copy - hand another character's whole setup to the caller. The players
// file is the only place a setup can come from, so every identifier is looked
// up there; lib/copySettings.js owns the grammar (id, User:<id> or a name).
function describeCopiedSettings(state, runtime) {
  const label = (token) => runtime.oreFilterLabel(token);
  const filter = state.oreFilter
    ? describeFilterQueue(state.oreFilter, label)
    : "off, every rock counts";
  return [
    `  automation : ${state.enabled ? "ON" : "OFF"} (${state.targetMode})`,
    `  threshold  : ${formatVolume(state.minHoldFreeVolumeM3)}`,
    `  takeover   : ${state.playerControlPolicy}`,
    `  range      : ${state.rangeOverrideMeters != null
      ? `${formatMeters(state.rangeOverrideMeters)} (your own setting)`
      : "follows your ship"}`,
    `  filter     : ${filter} (fallback ${state.filterFallback})`,
    `  grade      : ${state.filterGrade ? "on (the richest grade of a rock first)" : "off"}`,
  ];
}

// "/atm copy" on its own: the shape of the command. The list of sources is a
// form of its own ("copy list"), so a bare copy answers with what to type
// instead of pushing other players' settings at whoever wanted the syntax.
const COPY_USAGE_LINES = Object.freeze([
  "AlternateMiningDrones copy - take another character's whole setup onto yours:",
  "  /atm copy exampel         - part of a name is enough, and a typo is tolerated",
  "  /atm copy User:140000005 - or the character ID under the name in the client",
  "  /atm copy list [name]    - who has settings stored here",
]);
// The word that turns "copy" into the listing instead of a copy.
const COPY_LIST_WORDS = Object.freeze(["list"]);

// "/atm copy list [name]" - who is in the players file, narrowed by whatever is
// typed after "list".
//
// A character becomes findable the first time they run any /atm command,
// because that is what writes their name next to their settings - and a name is
// all a player without staff rights has: the client shows "User:<id>" without
// ever saying what the number after it means, so nobody can look an alt up by
// ID. Copying still needs the source to have settings; a character with an
// entry but nothing set is the deliberate way back to the server defaults.
function describeCopyListing(runtime, characterID, words) {
  const entries = runtime.allStoredPlayerSettings();
  const all = Object.keys(entries)
    .map((value) => toInt(value, 0))
    .filter((value) => value > 0)
    .sort((left, right) => left - right);
  // The filter reads the same identifier grammar a copy does, so the
  // "User:<id>" line the client shows can be pasted in unchanged.
  const filter = String(words == null ? "" : words).trim();
  const parsed = filter ? copySettings.parseCopyTarget(filter) : null;
  const asked = parsed ? parsed.raw : "";
  if (all.length === 0) {
    return {
      message: "AlternateMiningDrones copy list - nobody is stored here yet: set one " +
        "character up, then copy it onto the rest.",
    };
  }
  const matching = asked ? copySettings.matchStoredCharacters(entries, asked) : all;
  if (asked && matching.length === 0) {
    return {
      message: `AlternateMiningDrones: nobody stored here matches "${asked}". ` +
        '"/atm copy list" shows everyone.',
    };
  }
  const lines = [
    asked
      ? `AlternateMiningDrones copy list "${asked}" - ${matching.length} of ${all.length} ` +
        "character(s) match:"
      : `AlternateMiningDrones copy list - ${all.length} character(s) stored here:`,
  ];
  for (const id of matching.slice(0, copySettings.MAX_COPY_LIST_LINES)) {
    const entry = entries[String(id)] || {};
    const state = runtime.getPlayerState(id);
    const name = String(entry.characterName || "").trim() || "(no name stored)";
    const filter = state.oreFilter ? describeFilterQueue(state.oreFilter, (token) => runtime.oreFilterLabel(token)) : "no filter";
    lines.push(
      `  ${String(id).padEnd(11)} ${name}${id === characterID ? " (you)" : ""}` +
      ` - ${state.enabled ? "on" : "off"} ${state.targetMode}, ${filter}`,
    );
  }
  if (matching.length > copySettings.MAX_COPY_LIST_LINES) {
    lines.push(`  ...and ${matching.length - copySettings.MAX_COPY_LIST_LINES} more`);
  }
  lines.push('  "/atm copy <name|id>" takes one of their setups onto you.');
  return { message: lines.join("\n") };
}

function describeCopySource(entries, candidates) {
  return candidates
    .map((id) => {
      const name = String((entries[String(id)] || {}).characterName || "").trim();
      return name ? `${id} (${name})` : String(id);
    })
    .join(", ");
}

function handleCopy(runtime, config, characterID, value, meta) {
  if (!config.allowPlayerCopy) {
    return {
      message: "AlternateMiningDrones: copying another character's settings is disabled " +
        "by the server.",
    };
  }
  const words = String(value == null ? "" : value).split(/[\s,]+/u).filter(Boolean);
  const head = normalizeCommandName(words[0] || "");
  if (!head) {
    return { message: COPY_USAGE_LINES.join("\n") };
  }
  if (COPY_LIST_WORDS.includes(head)) {
    return describeCopyListing(runtime, characterID, words.slice(1).join(" "));
  }
  const asked = copySettings.parseCopyTarget(value);
  if (!asked) {
    return { message: COPY_USAGE_LINES.join("\n") };
  }
  if (!config.allowPlayerToggle) {
    return { message: "AlternateMiningDrones: per-character control is disabled by the server." };
  }
  const entries = runtime.allStoredPlayerSettings();
  const found = copySettings.matchCopySource(entries, asked.raw);
  if (!found.entry) {
    if (found.error === "ambiguous") {
      return {
        message: `AlternateMiningDrones: "${asked.raw}" fits more than one character - ` +
          `${describeCopySource(entries, found.candidates)}. Type more of the name, or ` +
          "the character ID.",
      };
    }
    return {
      message: `AlternateMiningDrones: no character matching "${asked.raw}" has settings ` +
        'stored here. "/atm copy list" shows everyone who does.',
    };
  }
  if (found.characterID === characterID) {
    return {
      message: "AlternateMiningDrones: that is you, so there is nothing to copy. " +
        "Name another character of yours.",
    };
  }
  const sourceName = String(found.entry.characterName || "").trim();
  const label = sourceName ? `${sourceName} (${found.characterID})` : String(found.characterID);
  if (!copySettings.hasCopyableSettings(found.entry)) {
    runtime.copyPlayerSettings(found.characterID, characterID, meta);
    return {
      message: `AlternateMiningDrones: ${label} has nothing set, so your settings were ` +
        "cleared and the server defaults apply again.",
    };
  }
  const state = runtime.copyPlayerSettings(found.characterID, characterID, meta);
  if (!state) {
    return {
      message: "AlternateMiningDrones: the copy could not be stored - check the server log.",
    };
  }
  return {
    message: `AlternateMiningDrones: copied ${label} onto you.\n` +
      describeCopiedSettings(state, runtime).join("\n") +
      `\n  ${QUEUE_APPLIES_AT_ONCE.trim()}`,
  };
}

function handleRange(runtime, session, characterID, value, meta) {
  if (!value) {
    const status = runtime.describeStatus(session);
    const range = status.range;
    return {
      message: range
        ? `AlternateMiningDrones search radius: ${formatMeters(range.rangeMeters)} ` +
          `(${describeBreakdown(range.breakdown)})`
        : "AlternateMiningDrones search radius: no active ship found.",
    };
  }
  if (value === "ship" || value === "auto" || value === "default" || value === "reset") {
    runtime.setPlayerRangeOverride(characterID, null, meta);
    const status = runtime.describeStatus(session);
    return {
      message: "AlternateMiningDrones search radius now follows your ship: " +
        `${status.range ? formatMeters(status.range.rangeMeters) : "unknown"}.`,
    };
  }
  const numeric = Number(value.replace(/[,_\s]/gu, ""));
  if (!Number.isFinite(numeric) || numeric < MIN_RANGE_METERS || numeric > MAX_RANGE_METERS) {
    return {
      message:
        "AlternateMiningDrones range must be a number between " +
        `${MIN_RANGE_METERS} and ${MAX_RANGE_METERS} meters, or "ship".`,
    };
  }
  runtime.setPlayerRangeOverride(characterID, Math.round(numeric), meta);
  return {
    message: `AlternateMiningDrones search radius set to ${formatMeters(numeric)} ` +
      '(use "/atm range ship" to follow the ship again).',
  };
}

// The "!" form, matched on its own by lib/plainChat. A line the player types
// without a leading "/" never reaches executeChatCommand - the client sends it
// as an ordinary chat message and xmppStubServer broadcasts it - so it is
// consumed at the broadcaster instead, before it can be shown to anyone.
function matchTrigger(trimmed, config) {
  if (!config || !config.chatTrigger) {
    return null;
  }
  const match = trimmed.match(/^!\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s+([\s\S]*))?$/u);
  if (!match) {
    return null;
  }
  return TRIGGER_NAMES.includes(normalizeCommandName(match[1])) ? (match[2] || "") : null;
}

// Returns the argument text when the line is addressed to this mod, or null when
// the line belongs to somebody else and must be passed straight through.
function matchCommand(trimmed, config) {
  if (trimmed.startsWith("/") || trimmed.startsWith(".")) {
    const match = trimmed.slice(1).match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s+([\s\S]*))?$/u);
    if (!match) {
      return null;
    }
    return COMMAND_NAMES.includes(normalizeCommandName(match[1])) ? (match[2] || "") : null;
  }
  return matchTrigger(trimmed, config);
}

function install(upstream, options) {
  if (!upstream || typeof upstream.executeChatCommand !== "function") {
    throw new Error("ALT_MINING_CHAT_EXPORT_INVALID");
  }
  if (upstream[OVERLAY_MARKER]) {
    return upstream;
  }
  const runtime = options.runtime;
  const config = options.config;
  if (!runtime || typeof runtime.describeStatus !== "function") {
    throw new Error("ALT_MINING_CHAT_RUNTIME_INVALID");
  }

  const original = upstream.executeChatCommand;
  const commandList = upstream.AVAILABLE_SLASH_COMMANDS;
  if (Array.isArray(commandList) && Object.isExtensible(commandList)) {
    for (const name of COMMAND_NAMES) {
      if (!commandList.includes(name)) {
        commandList.push(name);
      }
    }
  }
  const helpDescriptor = Object.getOwnPropertyDescriptor(upstream, "COMMANDS_HELP_TEXT");
  if (helpDescriptor && helpDescriptor.writable) {
    const help = String(upstream.COMMANDS_HELP_TEXT || "");
    upstream.COMMANDS_HELP_TEXT = `${help}\n${HELP_LINES.join("\n")}`;
  }

  function feedback(session, chatHub, callOptions, message) {
    if (chatHub && session && callOptions.emitChatFeedback !== false) {
      chatHub.sendSystemMessage(
        session,
        message,
        callOptions.feedbackChannel || callOptions.channel || null,
      );
    }
    return { handled: true, message };
  }

  function wrapped(session, rawMessage, chatHub, callOptions = {}) {
    const trimmed = String(rawMessage || "").trim();
    const argument = matchCommand(trimmed, config);
    if (argument === null) {
      return original(session, rawMessage, chatHub, callOptions);
    }
    const result = handleCommand(runtime, config, session, argument);
    return feedback(session, chatHub, callOptions, result.message);
  }

  upstream.executeChatCommand = wrapped;
  Object.defineProperty(upstream, OVERLAY_MARKER, {
    value: Object.freeze({
      version: OVERLAY_VERSION,
      original,
      wrapped,
      commands: COMMAND_NAMES,
      triggers: TRIGGER_NAMES,
    }),
    enumerable: false,
  });
  return upstream;
}

module.exports = {
  COMMAND_NAMES,
  buildOreListText,
  HELP_LINES,
  OVERLAY_MARKER,
  OVERLAY_VERSION,
  TRIGGER_NAMES,
  buildHelpText,
  buildStatusText,
  formatMeters,
  handleCommand,
  install,
  matchCommand,
  matchTrigger,
};