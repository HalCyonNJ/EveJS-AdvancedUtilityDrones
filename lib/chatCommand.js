"use strict";

const OVERLAY_MARKER = Symbol.for("evejs.betaAdvancedUtilityDrones.chatOverlay");
const OVERLAY_VERSION = "1.0.3-beta.1";
const {
  ORE_FILTER_MAX_PATTERNS,
  ORE_FILTER_SCOPES,
} = require("../config.js");
const copySettings = require("./copySettings.js");
const oreQueue = require("./oreQueue.js");
// The accepted spelling is exactly one name, on both paths: "/aud" through the
// client's slash handler and "!aud" in ordinary chat. The 1.3.0 spellings -
// "/atm", "/altmining" and their "!" forms - are answered with a single line
// saying the mod was renamed, because a player with either of them in their
// fingers deserves an answer rather than silence. "!amd" stays out of the set
// for good: another mod may claim that abbreviation.
const COMMAND_NAMES = Object.freeze(["aud"]);
// Ordinary chat never passes through the client's slash-command handler, which
// is the only reason a character without staff rights can drive this mod at all:
// typing "!aud ..." into the normal chat window reaches the server as a
// plain message, is consumed here, and is never broadcast to the channel.
const TRIGGER_NAMES = Object.freeze(["aud"]);
// The names this mod used to answer to, kept for one release so a player whose
// fingers still type them is told about the rename instead of being ignored.
const LEGACY_NAMES = Object.freeze(["atm", "altmining"]);
const RENAME_NOTICE =
  "The /atm command set was renamed: use \"/aud mining\" (short \"/aud mi\") for the " +
  "mining drones, or \"/aud salvage\" (short \"/aud sa\") for the salvage drones. " +
  "The old \"/atm\" and \"/altmining\" spellings are gone.";
// The two kinds of drone are two menus, and the kind is the first word after
// "/aud": mining drones and salvage drones are switched, tasked and tuned
// separately, so a bare "/aud off" - which kind did that mean? - is deliberately
// not a command. "/aud" on its own answers with the two menus rather than
// guessing, which is also why nothing here defaults to a kind.
const MINING_SCOPES = Object.freeze(["mi"]);
const SALVAGE_SCOPES = Object.freeze(["sa"]);
// What can follow "/aud" itself: the two kinds of drone, and the two commands
// that cover a whole character. Every command in this mod has exactly two
// spellings - its word and one short form - and these tables are where that is
// written down. Nothing else is accepted, and nothing is guessed at.
const ROOT_WORDS = Object.freeze({
  mining: MINING_SCOPES,
  salvage: SALVAGE_SCOPES,
  copy: Object.freeze(["cp"]),
  clear: Object.freeze(["cl"]),
  help: Object.freeze(["h"]),
});
// What can follow "/aud mining", or "/aud mi". "h" is the one single letter
// left in the mod, because a command line has spelt help that way forever.
const MINING_ACTIONS = Object.freeze({
  on: Object.freeze([]),
  off: Object.freeze([]),
  target: Object.freeze(["tg"]),
  range: Object.freeze(["rg"]),
  threshold: Object.freeze(["th"]),
  filter: Object.freeze(["fl"]),
  list: Object.freeze(["ls"]),
  control: Object.freeze(["ct"]),
  resume: Object.freeze(["rs"]),
  clear: Object.freeze(["cl"]),
  status: Object.freeze(["st"]),
  help: Object.freeze(["h"]),
});
// What can follow "/aud salvage", or "/aud sa". The two menus share a short
// form wherever they share a command, so one word means one thing on both.
const SALVAGE_ACTIONS = Object.freeze({
  on: Object.freeze([]),
  off: Object.freeze([]),
  target: Object.freeze(["tg"]),
  distance: Object.freeze(["ds"]),
  range: Object.freeze(["rg"]),
  threshold: Object.freeze(["th"]),
  list: Object.freeze(["ls"]),
  control: Object.freeze(["ct"]),
  resume: Object.freeze(["rs"]),
  clear: Object.freeze(["cl"]),
  status: Object.freeze(["st"]),
  help: Object.freeze(["h"]),
});
// What can follow "/aud mining filter", or "/aud mi fl". The value each verb
// takes is always spelt out in full.
const FILTER_VERBS = Object.freeze({
  add: Object.freeze(["ad"]),
  move: Object.freeze(["mv"]),
  del: Object.freeze(["dl"]),
  clear: Object.freeze(["cl"]),
  grade: Object.freeze(["gd"]),
  fallback: Object.freeze(["fb"]),
  help: Object.freeze(["h"]),
});
// The values a switch takes, and the kinds of rock a list or a clear can name.
const CONTROL_WORDS = Object.freeze({
  hold: Object.freeze([]),
  recall: Object.freeze([]),
  off: Object.freeze([]),
});
const DISTANCE_WORDS = Object.freeze({ nearest: Object.freeze([]), farthest: Object.freeze([]) });
const FALLBACK_WORDS = Object.freeze({
  any: Object.freeze([]),
  idle: Object.freeze([]),
  default: Object.freeze([]),
});
const GRADE_WORDS = Object.freeze({
  on: Object.freeze([]),
  off: Object.freeze([]),
  default: Object.freeze([]),
});
const RANGE_WORDS = Object.freeze({
  ship: Object.freeze([]),
});
// What "target" takes. These two were commands of their own for one build; they
// are values now, and a value is always typed in full.
const TARGET_MODE_WORDS = Object.freeze({
  spread: Object.freeze([]),
  focus: Object.freeze([]),
});
const ROCK_KIND_WORDS = Object.freeze({
  ore: Object.freeze([]),
  ice: Object.freeze([]),
  moon: Object.freeze([]),
});
// "/aud" on its own: one line per kind of drone and nothing else. The kind is
// the only thing this level has to say, because the two squadrons are switched
// separately and a bare "/aud off" could not say which one was meant; everything
// else waits one word further in, behind the "help" of the kind that wants it.
const ROOT_HELP_LINES = Object.freeze([
  "/aud mi [command]",
  "/aud sa [command]",
]);
// "/aud help" - the same two lines, plus the two commands that cover a whole
// character rather than one kind. They live here and nowhere else: a kind's own
// help lists that kind's commands, and copy/clear are not one of them. A bare
// "/aud" stays at the two menus.
const ROOT_EXTRA_HELP_LINES = Object.freeze([
  "/aud cp <name|id>",
  "/aud cp list [name]",
  "/aud cl",
  "/aud h",
]);
// "/aud mining help", or "/aud mi help" - what can follow the mining kind and
// nothing else: the filter has a command list of its own, reached with
// "/aud mining filter help", which is what keeps this one short enough to read
// in one screen. Every line is the long spelling; the short ones are listed at
// the bottom, because the point of them is to be learnt once.
const HELP_LINES = Object.freeze([
  "/aud mi on|off",
  "/aud mi tg spread|focus",
  "/aud mi rg [<meters|ship>]",
  "/aud mi th <m3>",
  "/aud mi fl [command]",
  "/aud mi ls [ore|ice|moon]",
  "/aud mi ct hold|recall|off",
  "/aud mi rs",
  "/aud mi cl",
  "/aud mi st",
  "/aud mi h",
]);
// "/aud salvage help", or "/aud sa help" - what can follow the salvage kind and
// nothing else. There is no salvage filter: every wreck in range is worked, in
// the order the distance setting asks for.
const SALVAGE_HELP_LINES = Object.freeze([
  "/aud sa on|off",
  "/aud sa tg spread|focus",
  "/aud sa ds nearest|farthest",
  "/aud sa ls",
  "/aud sa rg [<meters|ship>]",
  "/aud sa th <m3>",
  "/aud sa ct hold|recall|off",
  "/aud sa rs",
  "/aud sa cl",
  "/aud sa st",
  "/aud sa h",
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

// One slot of a command line, spelt out. Every table maps the name a command
// answers to onto the single short spelling that also means it, and those two
// are the only things accepted - there is no prefix guessing. A word that is
// half of two commands ("co" is copy and control) has no way of knowing which
// was meant, and this mod can run beside other mods, so a letter
// that means one thing here and another thing there is worse than a word that
// means nothing at all.
function resolveWord(word, words) {
  const token = normalizeCommandName(word);
  if (!token) {
    return null;
  }
  for (const name of Object.keys(words)) {
    if (name === token || words[name].includes(token)) {
      return name;
    }
  }
  return null;
}

// The answer to a word that named no command of this menu.
function describeUnknownWord(menu, typed) {
  return `beta-AdvancedUtilityDrones: unknown option "${typed}". ` +
    `Use "/aud ${menu === "mining" ? "mi" : "sa"} h" for the list.`;
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
  const header = "beta-AdvancedUtilityDrones - /aud mi";
  const lines = [header, ...HELP_LINES.map((line) => `  ${line}`)];
  if (!config.allowPlayerToggle) {
    lines.push("  (server: player control disabled)");
  }
  if (!config.chatTrigger) {
    lines.push("  (server: !aud disabled)");
  }
  return lines.join("\n");
}

// "/aud" on its own: the two menus and the two whole-character commands. Every
// line is a menu entry, so a player who typed the wrong thing is one line away
// from the right one.
function buildRootHelpText(config, runtime = null, withCommands = false) {
  const header = "beta-AdvancedUtilityDrones - /aud";
  const body = withCommands
    ? [...ROOT_HELP_LINES, ...ROOT_EXTRA_HELP_LINES]
    : ROOT_HELP_LINES;
  const lines = [header, ...body.map((line) => `  ${line}`)];
  if (!config.allowPlayerToggle) {
    lines.push("  (server: player control disabled)");
  }
  if (!config.chatTrigger) {
    lines.push("  (server: !aud disabled)");
  }
  return lines.join("\n");
}

// "/aud salvage help" - the salvage menu. Built like the mining one, so the two read
// the same way: one line per command, and the line is what to type.
function buildSalvageHelpText(config, runtime = null) {
  const header = "beta-AdvancedUtilityDrones - /aud sa";
  const lines = [header, ...SALVAGE_HELP_LINES.map((line) => `  ${line}`)];
  if (!config.allowPlayerToggle) {
    lines.push("  (server: player control disabled)");
  }
  return lines.join("\n");
}

// "/aud mining filter help" - what can follow "/aud mining filter", kept apart from "/aud mining
// help" so the top-level list stays a list of the top-level commands, and laid
// out the same way: one line per command, the line is what to type, and the
// detail lines sit under it indented by four spaces.
function buildFilterHelpText(config, runtime = null) {
  const header = "beta-AdvancedUtilityDrones - /aud mi fl";
  const lines = [
    header,
    ...FILTER_HELP_LINES.map((line) => `  ${line}`),
  ];
  if (!config.allowPlayerToggle) {
    lines.push("  (server: queue editing disabled; reading still allowed)");
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
    `beta-AdvancedUtilityDrones v${runtime.MOD_VERSION}`,
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
  lines.push('  use "/aud mi h" for commands');
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
// "/aud mining filter add gneiss, dark ochre" answers with the ore list, then the ice
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

// "/aud mining filter help" - the filter's own commands, in the shape of the
// top-level list. A bare number is a type ID everywhere except after a name in
// "move", where it is that entry's place.
const FILTER_HELP_LINES = Object.freeze([
  "/aud mi fl ad <name|id>[, ...]",
  "/aud mi fl mv <name|id> [place]",
  "/aud mi fl dl <name|id>",
  "/aud mi fl cl ore|ice|moon",
  "/aud mi fl gd on|off",
  "/aud mi fl fb any|idle",
  "/aud mi fl",
  "/aud mi fl h",
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
    return "beta-AdvancedUtilityDrones: no active ship found.";
  }
  const what = scope ? `${scope} rocks` : "mineable rocks";
  if (result.entries.length === 0) {
    return `beta-AdvancedUtilityDrones: no ${what} within ${formatMeters(result.rangeMeters)}.`;
  }
  const lines = [`beta-AdvancedUtilityDrones ${what} in range (${formatMeters(result.rangeMeters)}):`];
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
  lines.push(`  queue one with: /aud mining filter add <name>`);
  return lines.join("\n");
}

// "/aud mining filter" - the queue as the reply prints it: one line per kind of rock
// with the number that kind's "move" takes, what the drones do when nothing in
// range matches, and whether the richest grade of a rock is mined first.
function describeFilter(runtime, characterID) {
  const state = runtime.getPlayerState(characterID);
  const tokens = state && Array.isArray(state.oreFilter) ? state.oreFilter : [];
  const lines = ["beta-AdvancedUtilityDrones filter - the drones work down each list, first entry first:"];
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
  lines.push("  commands: \"/aud mi fl h\"");
  return lines.join("\n");
}

function handleFilterFallback(runtime, characterID, value, meta) {
  const normalized = normalizeCommandName(value);
  if (!normalized) {
    const state = runtime.getPlayerState(characterID);
    return {
      message:
        `beta-AdvancedUtilityDrones filter fallback: ${state ? state.filterFallback : "any"} ` +
        '("any" mines the closest rock anyway once nothing in range matches the queue, ' +
        '"idle" leaves the drones parked instead).',
    };
  }
  const asked = resolveWord(normalized, FALLBACK_WORDS);
  if (!asked) {
    return { message: 'beta-AdvancedUtilityDrones: fallback must be "any", "idle" or "default".' };
  }
  const state = runtime.setPlayerFilterFallback(
    characterID, asked === "default" ? null : asked, meta,
  );
  return { message: `beta-AdvancedUtilityDrones filter fallback: ${state.filterFallback}.` };
}
// "/aud mining filter grade on|off" - whether the richest grade of a rock in range is
// mined before the plainer ones. The game spawns the same ore at several grades
// and the type name is where that shows - Veldspar II-Grade, Blue Ice IV-Grade -
// so with this on the drones take the best rock of a family first and work down,
// and with it off every grade counts the same. Either way it is part of what the
// drones are asked to do, so switching it re-tasks the drones that are already
// mining, the same way a queue edit does.
function handleFilterGrade(runtime, characterID, value, meta) {
  const describe = (on) => (
    `beta-AdvancedUtilityDrones filter grade: ${on ? "on" : "off"} ` +
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
  const asked = resolveWord(normalized, GRADE_WORDS);
  if (!asked) {
    return { message: 'beta-AdvancedUtilityDrones: grade must be "on", "off" or "default".' };
  }
  const state = runtime.setPlayerFilterGrade(
    characterID, asked === "default" ? null : asked === "on", meta,
  );
  return { message: describe(Boolean(state && state.filterGrade)) };
}

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
        `/aud mining filter clear ${word} empties the ${word} list`
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

// "/aud mining filter add ..." - the queue grows by the names typed. An entry that is
// already queued keeps the place it has, because "add" is not "move"; a word that
// names a whole kind of rock, and a number no rock has, are passed over with a
// warning line while everything else on the line still goes in.
function applyQueueAdd(runtime, session, characterID, words, meta) {
  const typed = oreQueue.classifyTypedWords(words);
  const refused = describeRefusedWords(typed);
  if (refused.length > 0) {
    return { message: `beta-AdvancedUtilityDrones: ${refused[0]}` };
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
      "type ID, and only one that names a rock works; \"/aud mining filter move <name> " +
      `${word}" sets an entry's place`,
    );
    return false;
  });
  if (usable.length === 0) {
    return {
      message: withKindLines(
        'beta-AdvancedUtilityDrones: add needs a name - ' +
        '"/aud mining filter add veldspar, kernite, blue ice".',
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
      message: `beta-AdvancedUtilityDrones: the queue holds at most ${ORE_FILTER_MAX_PATTERNS} ` +
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
      '"/aud mining filter move <name> <place>" does',
    );
  }
  if (result.placed.length === 0) {
    return {
      message: withKindLines(
        "beta-AdvancedUtilityDrones: nothing new to add " +
        `(the queue is ${describeFilterQueue(result.tokens, label)}).`,
        runtime, result.tokens, notes,
      ),
    };
  }
  const added = result.placed.map(label).join(", ");
  runtime.setPlayerOreFilter(characterID, result.tokens, meta);
  return {
    message: withKindLines(
      `beta-AdvancedUtilityDrones added ${added}.` +
        describeQueueMatches(runtime, session, null) + QUEUE_APPLIES_AT_ONCE,
      runtime,
      result.tokens,
      notes,
    ),
  };
}

// "/aud mining filter move veldspar 2 kernite 1" - the queue is reordered with the
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
    return { message: "beta-AdvancedUtilityDrones: the queue is empty, there is nothing to move." };
  }
  const typed = oreQueue.classifyTypedWords(words);
  const refused = describeRefusedWords(typed);
  if (refused.length > 0) {
    return { message: `beta-AdvancedUtilityDrones: ${refused[0]}` };
  }
  const label = (token) => runtime.oreFilterLabel(token);
  const notes = describeSkippedWords(typed);
  if (typed.usable.length === 0) {
    return {
      message: withKindLines(
        'beta-AdvancedUtilityDrones: move needs a name - "/aud mining filter move veldspar 2".',
        runtime, current, notes,
      ),
    };
  }
  const edits = oreQueue.parseEdits(typed.usable, { positions: true });
  const kindsOfFirst = oreQueue.kindsOfEntry(edits[0].entry, runtime.oreEntryKinds);
  if (kindsOfFirst.length > 1) {
    return {
      message: `beta-AdvancedUtilityDrones: "${edits[0].token}" mines more than one kind of rock ` +
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
        `beta-AdvancedUtilityDrones: ${why} (the queue is ${describeFilterQueue(current, label)}).`,
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
      `beta-AdvancedUtilityDrones moved ${moved}${tail}.` + QUEUE_APPLIES_AT_ONCE,
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

// "/aud mining filter del kernite" - everything the typed names resolve to leaves the
// queue. The words that name a whole kind of rock used to empty that list and now
// get a warning instead: "clear" is the command for a whole kind.
function applyQueueDel(runtime, characterID, words, meta) {
  const typed = oreQueue.classifyTypedWords(words);
  const refused = describeRefusedWords(typed);
  if (refused.length > 0) {
    return { message: `beta-AdvancedUtilityDrones: ${refused[0]}` };
  }
  const state = runtime.getPlayerState(characterID);
  const current = state && Array.isArray(state.oreFilter) ? state.oreFilter : [];
  const label = (token) => runtime.oreFilterLabel(token);
  const notes = describeSkippedWords(typed);
  if (typed.usable.length === 0) {
    return {
      message: withKindLines(
        'beta-AdvancedUtilityDrones: del needs a name - "/aud mining filter del kernite". ' +
        '"/aud mining filter clear ice" empties one kind of rock.',
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
        `beta-AdvancedUtilityDrones: nothing in the queue matches ${missed.join(", ")} ` +
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
      `beta-AdvancedUtilityDrones dropped ${dropped}${tail}.` +
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

// "/aud mining filter clear ice" - one kind's list is emptied. This is the only command
// that takes a kind word, because it is the one thing a kind word can usefully
// say: the queue itself holds rocks, not kinds.
function applyQueueClear(runtime, characterID, words, meta) {
  const typed = words.length === 1 ? normalizeCommandName(words[0]) : "";
  const kind = resolveWord(typed, ROCK_KIND_WORDS) || typed;
  if (!oreQueue.isKindWord(kind)) {
    return {
      message: 'beta-AdvancedUtilityDrones: clear takes one kind of rock - ' +
        '"/aud mining filter clear ore", "clear ice" or "clear moon".',
    };
  }
  const state = runtime.getPlayerState(characterID);
  const current = state && Array.isArray(state.oreFilter) ? state.oreFilter : [];
  const label = (token) => runtime.oreFilterLabel(token);
  const result = oreQueue.removeMatching(current, [kind], runtime.oreEntryKinds);
  if (result.removed.length === 0) {
    return {
      message: `beta-AdvancedUtilityDrones: the ${kind} list is already empty.`,
    };
  }
  const dropped = result.removed.map(label).join(", ");
  runtime.setPlayerOreFilter(characterID, result.tokens, meta);
  return {
    message: withKindLines(
      `beta-AdvancedUtilityDrones dropped ${dropped} from the ${kind} list.` +
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
    return `beta-AdvancedUtilityDrones: "${head}" is a kind of rock, not a command - ` +
      `"/aud mining filter clear ${head}" empties that list, and ` +
      `"/aud mining list ${head}" shows what is around you.`;
  }
  if (head === "list") {
    return 'beta-AdvancedUtilityDrones: "/aud mining list" shows the rocks in range, ' +
      '"/aud mining list ice" just one kind.';
  }
  return "beta-AdvancedUtilityDrones: filter takes add, move, del, clear, grade or fallback - " +
    'ad, mv, dl, cl, gd or fb. For example "/aud mi fl ad veldspar, kernite", ' +
    'and "/aud mi fl" on its own shows the queue.';
}

function readScopeArgument(word) {
  if (!word) {
    return { scope: null, error: null };
  }
  const scope = resolveWord(word, ROCK_KIND_WORDS);
  if (!scope) {
    return { scope: null, error: 'beta-AdvancedUtilityDrones: list takes "ore", "ice" or "moon".' };
  }
  return { scope, error: null };
}

// Every command needs a character, and every reply wants the character's name
// written next to whatever it stored. One place decides both, so a session-less
// call reads the same from either menu.
function sessionContext(session) {
  const characterID = toInt(session && (session.characterID || session.charid), 0);
  if (characterID <= 0) {
    return {
      characterID: 0,
      meta: null,
      error: "beta-AdvancedUtilityDrones needs a character session.",
    };
  }
  return { characterID, meta: playerMeta(session), error: null };
}

// ─── /aud salvage: the salvage drones ─────────────────────────────────────────────

// The bay a salvage drone delivers into is the cargo hold: the server's own
// salvager cycle grants the material there, and no hull in this game data has a
// hold that receives salvage anywhere else. The line says so rather than leaving
// an expectation, because the threshold is what the hold is measured against.
function describeSalvageHoldLine(hold) {
  if (!hold) {
    return null;
  }
  return (
    `  hold state   : flag ${hold.flagID} at ${formatVolume(hold.free)} free of ` +
    `${formatVolume(hold.capacity)} (cargo hold` +
    (hold.reason ? `, ${hold.reason}` : "") + ")"
  );
}

function buildSalvageStatusText(runtime, session) {
  const status = runtime.describeSalvageStatus(session);
  const player = status.playerState;
  const lines = [
    `beta-AdvancedUtilityDrones v${runtime.MOD_VERSION} salvage`,
    `  automation   : ${player.enabled ? "ON" : "OFF"} ` +
      `(${player.targetMode}, ${player.distance} first)`,
    `  drones       : ${status.dronesInSpace} salvage-capable, ` +
      `${status.workingDrones} working, ${status.idleDrones} idle`,
    `  wrecks       : ${status.wrecks.total} in range`,
    `  assigned     : ${status.stats.salvageAssignments}, ` +
      `recalls ${status.stats.salvageRecalls}` +
      (status.stats.lastRecallReason ? ` (last: ${status.stats.lastRecallReason})` : ""),
    `  threshold    : ${formatVolume(player.minHoldFreeVolumeM3)}`,
    `  takeover     : ${player.playerControlPolicy}`,
  ];
  const holdLine = describeSalvageHoldLine(status.hold);
  if (holdLine) {
    lines.push(holdLine);
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
  lines.push('  use "/aud sa h" for commands');
  return lines.join("\n");
}

// "/aud salvage list" - every wreck in range, with its distance and former
// owner. The listing is informational; it does not change targeting.
function buildSalvageListText(runtime, session) {
  const result = runtime.describeSalvageWrecks(session);
  if (!result.hasShip) {
    return "beta-AdvancedUtilityDrones: no active ship found.";
  }
  if (result.entries.length === 0) {
    return "beta-AdvancedUtilityDrones: no salvageable wreck within " +
      `${formatMeters(result.rangeMeters)}.`;
  }
  const lines = [
    `beta-AdvancedUtilityDrones wrecks in range (${formatMeters(result.rangeMeters)}):`,
  ];
  result.entries.forEach((entry, index) => {
    lines.push(
      `  ${index + 1}. ${entry.name} (${entry.targetID}) ${formatMeters(entry.distance)} - ` +
      `${entry.owner}'s`,
    );
  });
  if (result.scanned > result.entries.length) {
    lines.push(`  ...and ${result.scanned - result.entries.length} more in range`);
  }
  lines.push('  work them with: "/aud sa on"');
  return lines.join("\n");
}

// "/aud salvage ..." - the salvage menu. There is no "whose wreck" switch: salvaging
// the hull is not what carries a flag in this game, so every wreck in range is a
// target and the switches here are about how the field is worked, not about who
// owns it.
function handleSalvageCommand(runtime, config, session, argumentText) {
  const context = sessionContext(session);
  if (context.error) {
    return { message: context.error };
  }
  const { characterID, meta } = context;
  const parts = String(argumentText || "").trim().split(/\s+/u).filter(Boolean);
  const typed = normalizeCommandName(parts[0] || "status");
  const value = parts.slice(1).join(" ").trim();
  const action = resolveWord(typed, SALVAGE_ACTIONS) || typed;

  if (action === "help") {
    return { message: buildSalvageHelpText(config, runtime) };
  }
  if (action === "status") {
    return { message: buildSalvageStatusText(runtime, session) };
  }
  // Reading what is around the ship changes nothing, so it answers even where
  // players may not change their own settings.
  if (action === "list") {
    return { message: buildSalvageListText(runtime, session) };
  }
  if (!config.allowPlayerToggle) {
    return { message: "beta-AdvancedUtilityDrones: per-character control is disabled by the server." };
  }

  if (action === "on" || action === "off") {
    const state = runtime.setPlayerSalvageEnabled(characterID, action === "on", meta);
    return {
      message:
        `beta-AdvancedUtilityDrones salvage ${action.toUpperCase()} for you ` +
        `(${state.targetMode}, ${state.distance} first). Salvage drones launched from ` +
        "your ship " +
        (action === "on"
          ? "will pick their own wrecks."
          : "will stay idle until you order them."),
    };
  }

  if (action === "target") {
    return handleTargetMode(runtime, characterID, "salvage", value, meta);
  }

  if (action === "distance") {
    if (!value) {
      const current = runtime.getSalvageState(characterID);
      return {
        message:
          `beta-AdvancedUtilityDrones salvage distance: ${current.distance} first ` +
          '("nearest" works the field from the near end, "farthest" from the far end).',
      };
    }
    const direction = resolveWord(value, DISTANCE_WORDS);
    if (!direction) {
      return { message: 'beta-AdvancedUtilityDrones: distance must be "nearest" or "farthest".' };
    }
    const state = runtime.setPlayerSalvageDistance(characterID, direction, meta);
    return { message: `beta-AdvancedUtilityDrones salvage distance: ${state.distance} first.` };
  }

  if (action === "range") {
    return handleRange(runtime, session, characterID, value, meta);
  }
  if (action === "threshold") {
    return handleThreshold(runtime, characterID, value, meta);
  }
  if (action === "control") {
    return handleControl(runtime, characterID, value, meta);
  }
  if (action === "resume") {
    return handleResume(runtime, session, "salvage");
  }
  if (action === "clear") {
    return handleKindReset(runtime, characterID, "salvage", meta);
  }

  const targetWord = resolveWord(typed, TARGET_MODE_WORDS);
  if (targetWord) {
    return {
      message: `beta-AdvancedUtilityDrones: "${targetWord}" is a targeting mode, not a command - ` +
        `"/aud salvage target ${targetWord}" sets it, and "/aud salvage target" prints it.`,
    };
  }

  return { message: describeUnknownWord("salvage", typed) };
}

// ─── the commands that sit above a kind of drone ────────────────────────────

// "/aud clear": the whole entry, both kinds and the shared keys with it.
function handleResetAll(runtime, characterID) {
  runtime.clearPlayerSettings(characterID);
  return {
    message:
      "beta-AdvancedUtilityDrones: all your personal settings were cleared - both kinds of " +
      "drone, and the shared radius, threshold and takeover setting with them; the " +
      'server defaults apply again. "/aud mining clear" and "/aud salvage clear" clear one kind ' +
      "on its own.",
  };
}

// "/aud mining clear" and "/aud salvage clear": one kind's keys, and nothing else.
// The shared keys are not one kind's to throw away, so they stay until "/aud clear".
function handleKindReset(runtime, characterID, kind, meta) {
  const state = runtime.clearPlayerKindSettings(characterID, kind, meta);
  const what = kind === "salvage" ? "salvage" : "mining";
  return {
    message:
      `beta-AdvancedUtilityDrones: the ${what} settings were cleared; the server defaults ` +
      `apply again (automation ${state && state.enabled ? "ON" : "OFF"}, ` +
      `mode ${state ? state.targetMode : "spread"}). The shared radius, threshold and ` +
      'takeover setting are untouched - "/aud clear" clears everything.',
  };
}

function handleResume(runtime, session, asked) {
  const what = asked === "salvage" ? "salvage drone(s)" : "mining drone(s)";
  const resumed = runtime.resumeDrones(session, asked);
  return {
    message: resumed > 0
      ? `beta-AdvancedUtilityDrones: ${resumed} ${what} handed back to the automation.`
      : `beta-AdvancedUtilityDrones: no ${what} of yours is under manual control.`,
  };
}

// The radius and the threshold belong to the character rather than to one kind
// of drone, so both menus answer them and neither menu owns them.
function handleThreshold(runtime, characterID, value, meta) {
  if (!value) {
    const current = runtime.getPlayerState(characterID);
    return {
      message:
        `beta-AdvancedUtilityDrones threshold: ${formatVolume(current.minHoldFreeVolumeM3)} ` +
        "of spare room before the drones come home.",
    };
  }
  const numeric = Number(value.replace(/[,_\s]/gu, ""));
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > MAX_THRESHOLD_M3) {
    return {
      message:
        "beta-AdvancedUtilityDrones threshold must be a number of cubic metres between " +
        `0 and ${MAX_THRESHOLD_M3}.`,
    };
  }
  const state = runtime.setPlayerMinHoldFreeVolume(characterID, numeric, meta);
  return {
    message:
      `beta-AdvancedUtilityDrones threshold: ${formatVolume(state.minHoldFreeVolumeM3)}. ` +
      "The drones head home once the hold they deliver into has less room than that.",
  };
}

function handleControl(runtime, characterID, value, meta) {
  if (!value) {
    const current = runtime.getPlayerState(characterID);
    return {
      message:
        `beta-AdvancedUtilityDrones manual takeover: ${current.playerControlPolicy} ` +
        '("hold" stops automating a drone you ordered by hand until it is relaunched, ' +
        '"recall" only reacts to a manual recall, "off" keeps automating it).',
    };
  }
  const asked = resolveWord(value, CONTROL_WORDS);
  if (!asked) {
    return { message: 'beta-AdvancedUtilityDrones control must be "hold", "recall" or "off".' };
  }
  const state = runtime.setPlayerControlPolicy(characterID, asked, meta);
  return {
    message: `beta-AdvancedUtilityDrones manual takeover: ${state.playerControlPolicy.toUpperCase()}.`,
  };
}

// ─── the router ─────────────────────────────────────────────────────────────

// "/aud ..." - the kind comes first. An empty line, "help", or a bare "/aud"
// answers with the two menus; a word that is not one of the two kinds is
// answered with the spelling that would have worked, because the word is
// usually right and only the kind is missing.
function handleCommand(runtime, config, session, argumentText) {
  const parts = String(argumentText || "").trim().split(/\s+/u).filter(Boolean);
  const head = normalizeCommandName(parts[0] || "");
  const rest = parts.slice(1).join(" ").trim();
  const asked = resolveWord(head, ROOT_WORDS);
  if (!head) {
    return { message: buildRootHelpText(config, runtime) };
  }
  if (asked === "help") {
    return { message: buildRootHelpText(config, runtime, true) };
  }
  if (LEGACY_NAMES.includes(head)) {
    return { message: RENAME_NOTICE };
  }
  if (asked === "mining") {
    return handleMiningCommand(runtime, config, session, rest);
  }
  if (asked === "salvage") {
    return handleSalvageCommand(runtime, config, session, rest);
  }
  const context = sessionContext(session);
  if (context.error) {
    return { message: context.error };
  }
  if (asked === "copy") {
    return handleCopy(runtime, config, context.characterID, rest, context.meta);
  }
  if (asked === "clear") {
    if (!config.allowPlayerToggle) {
      return { message: "beta-AdvancedUtilityDrones: per-character control is disabled by the server." };
    }
    return handleResetAll(runtime, context.characterID);
  }
  return {
    message:
      `beta-AdvancedUtilityDrones: start with a kind of drone - "/aud mi ${head}" or ` +
      `"/aud sa ${head}". "/aud h" lists the commands.`,
  };
}
// "/aud mining ..." - the mining menu, unchanged from 1.3.0 apart from the name
// that reaches it and the two commands that now cover a kind on their own.
function handleMiningCommand(runtime, config, session, argumentText) {
  const context = sessionContext(session);
  if (context.error) {
    return { message: context.error };
  }
  const { characterID, meta } = context;
  const parts = String(argumentText || "").trim().split(/\s+/u).filter(Boolean);
  const typed = normalizeCommandName(parts[0] || "status");
  const value = parts.slice(1).join(" ").trim();
  const action = resolveWord(typed, MINING_ACTIONS) || typed;

  if (action === "help") {
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
  if (action === "filter") {
    const words = oreQueue.splitTypedWords(value, runtime.oreEntryKinds);
    const typedVerb = normalizeCommandName(words[0] || "");
    const verb = resolveWord(typedVerb, FILTER_VERBS);
    // Reading the queue changes nothing, so it works even where players may not
    // change their own settings - and so does the list of what is around you.
    if (!typedVerb) {
      return { message: describeFilter(runtime, characterID) };
    }
    if (verb === "help") {
      return { message: buildFilterHelpText(config, runtime) };
    }
    if (!config.allowPlayerToggle) {
      return { message: "beta-AdvancedUtilityDrones: per-character control is disabled by the server." };
    }
    if (verb === "fallback") {
      return handleFilterFallback(runtime, characterID, words.slice(1).join(" "), meta);
    }
    if (verb === "grade") {
      return handleFilterGrade(runtime, characterID, words.slice(1).join(" "), meta);
    }
    if (verb === "add") {
      return applyQueueAdd(runtime, session, characterID, words.slice(1), meta);
    }
    if (verb === "move") {
      return applyQueueMove(runtime, characterID, words.slice(1), meta);
    }
    if (verb === "del") {
      return applyQueueDel(runtime, characterID, words.slice(1), meta);
    }
    if (verb === "clear") {
      return applyQueueClear(runtime, characterID, words.slice(1), meta);
    }
    return { message: describeFilterUsage(typedVerb) };
  }
  if (!config.allowPlayerToggle) {
    return { message: "beta-AdvancedUtilityDrones: per-character control is disabled by the server." };
  }

  const rockKind = resolveWord(typed, ROCK_KIND_WORDS);
  if (rockKind) {
    return {
      message: `beta-AdvancedUtilityDrones: "${rockKind}" is a kind of rock, not a command - ` +
        `"/aud mi fl clear ${rockKind}" empties that list, and ` +
        `"/aud mi ls ${rockKind}" shows what is around you.`,
    };
  }

  if (action === "on" || action === "off") {
    const state = runtime.setPlayerEnabled(characterID, action === "on", meta);
    return {
      message:
        `beta-AdvancedUtilityDrones ${action.toUpperCase()} for you ` +
        `(mode ${state.targetMode}). Mining drones launched from your ship ` +
        (action === "on" ? "will pick their own rocks." : "will stay idle until you order them."),
    };
  }

  if (action === "target") {
    return handleTargetMode(runtime, characterID, "mining", value, meta);
  }

  if (action === "range") {
    return handleRange(runtime, session, characterID, value, meta);
  }

  if (action === "threshold") {
    return handleThreshold(runtime, characterID, value, meta);
  }

  if (action === "control") {
    return handleControl(runtime, characterID, value, meta);
  }

  if (action === "resume") {
    return handleResume(runtime, session, "mining");
  }

  if (action === "clear") {
    return handleKindReset(runtime, characterID, "mining", meta);
  }

  // A targeting mode is a value now, so a line that types one where a command
  // belongs is answered with the command that takes it.
  const targetWord = resolveWord(typed, TARGET_MODE_WORDS);
  if (targetWord) {
    return {
      message: `beta-AdvancedUtilityDrones: "${targetWord}" is a targeting mode, not a command - ` +
        `"/aud mining target ${targetWord}" sets it, and "/aud mining target" prints it.`,
    };
  }

  return { message: describeUnknownWord("mining", typed) };
}

// /aud copy - hand another character's whole setup to the caller. The players
// file is the only place a setup can come from, so every identifier is looked
// up there; lib/copySettings.js owns the grammar (id, User:<id> or a name).
function describeCopiedSettings(state, salvage, runtime) {
  const label = (token) => runtime.oreFilterLabel(token);
  const filter = state.oreFilter
    ? describeFilterQueue(state.oreFilter, label)
    : "off, every rock counts";
  const lines = [
    `  automation : ${state.enabled ? "ON" : "OFF"} (${state.targetMode})`,
    `  threshold  : ${formatVolume(state.minHoldFreeVolumeM3)}`,
    `  takeover   : ${state.playerControlPolicy}`,
    `  range      : ${state.rangeOverrideMeters != null
      ? `${formatMeters(state.rangeOverrideMeters)} (your own setting)`
      : "follows your ship"}`,
    `  filter     : ${filter} (fallback ${state.filterFallback})`,
    `  grade      : ${state.filterGrade ? "on (the richest grade of a rock first)" : "off"}`,
  ];
  if (salvage) {
    lines.push(
      `  salvage    : ${salvage.enabled ? "ON" : "OFF"} ` +
      `(${salvage.targetMode}, ${salvage.distance} first)`,
    );
  }
  return lines;
}

// "/aud copy" on its own: the shape of the command. The list of sources is a
// form of its own ("copy list"), so a bare copy answers with what to type
// instead of printing another character's saved settings to whoever wanted the syntax.
const COPY_USAGE_LINES = Object.freeze([
  "beta-AdvancedUtilityDrones copy - take another character's whole setup onto yours:",
  "  /aud copy exampel         - part of a name is enough, and a typo is tolerated",
  "  /aud copy User:140000005 - or the character ID under the name in the client",
  "  /aud copy list [name]    - who has settings stored here",
]);
// The word that turns "copy" into the listing instead of a copy.
const COPY_LIST_WORDS = Object.freeze(["list"]);

// "/aud copy list [name]" - who is in the players file, narrowed by whatever is
// typed after "list".
//
// A character becomes findable the first time they run any /aud mining command,
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
      message: "beta-AdvancedUtilityDrones copy list - nobody is stored here yet: set one " +
        "character up, then copy it onto the rest.",
    };
  }
  const matching = asked ? copySettings.matchStoredCharacters(entries, asked) : all;
  if (asked && matching.length === 0) {
    return {
      message: `beta-AdvancedUtilityDrones: nobody stored here matches "${asked}". ` +
        '"/aud copy list" shows everyone.',
    };
  }
  const lines = [
    asked
      ? `beta-AdvancedUtilityDrones copy list "${asked}" - ${matching.length} of ${all.length} ` +
        "character(s) match:"
      : `beta-AdvancedUtilityDrones copy list - ${all.length} character(s) stored here:`,
  ];
  for (const id of matching.slice(0, copySettings.MAX_COPY_LIST_LINES)) {
    const entry = entries[String(id)] || {};
    const state = runtime.getPlayerState(id);
    const salvage = runtime.getSalvageState(id);
    const name = String(entry.characterName || "").trim() || "(no name stored)";
    const filter = state.oreFilter ? describeFilterQueue(state.oreFilter, (token) => runtime.oreFilterLabel(token)) : "no filter";
    lines.push(
      `  ${String(id).padEnd(11)} ${name}${id === characterID ? " (you)" : ""}` +
      ` - mining ${state.enabled ? "on" : "off"} ${state.targetMode}, ${filter}` +
      `; salvage ${salvage && salvage.enabled ? "on" : "off"}`,
    );
  }
  if (matching.length > copySettings.MAX_COPY_LIST_LINES) {
    lines.push(`  ...and ${matching.length - copySettings.MAX_COPY_LIST_LINES} more`);
  }
  lines.push('  "/aud copy <name|id>" takes one of their setups onto you.');
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
      message: "beta-AdvancedUtilityDrones: copying another character's settings is disabled " +
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
    return { message: "beta-AdvancedUtilityDrones: per-character control is disabled by the server." };
  }
  const entries = runtime.allStoredPlayerSettings();
  const found = copySettings.matchCopySource(entries, asked.raw);
  if (!found.entry) {
    if (found.error === "ambiguous") {
      return {
        message: `beta-AdvancedUtilityDrones: "${asked.raw}" fits more than one character - ` +
          `${describeCopySource(entries, found.candidates)}. Type more of the name, or ` +
          "the character ID.",
      };
    }
    return {
      message: `beta-AdvancedUtilityDrones: no character matching "${asked.raw}" has settings ` +
        'stored here. "/aud copy list" shows everyone who does.',
    };
  }
  if (found.characterID === characterID) {
    return {
      message: "beta-AdvancedUtilityDrones: that is you, so there is nothing to copy. " +
        "Name another character of yours.",
    };
  }
  const sourceName = String(found.entry.characterName || "").trim();
  const label = sourceName ? `${sourceName} (${found.characterID})` : String(found.characterID);
  if (!copySettings.hasCopyableSettings(found.entry)) {
    runtime.copyPlayerSettings(found.characterID, characterID, meta);
    return {
      message: `beta-AdvancedUtilityDrones: ${label} has nothing set, so your settings were ` +
        "cleared and the server defaults apply again.",
    };
  }
  const state = runtime.copyPlayerSettings(found.characterID, characterID, meta);
  if (!state) {
    return {
      message: "beta-AdvancedUtilityDrones: the copy could not be stored - check the server log.",
    };
  }
  return {
    message: `beta-AdvancedUtilityDrones: copied ${label} onto you.\n` +
      describeCopiedSettings(state, runtime.getSalvageState(characterID), runtime).join("\n") +
      `\n  ${QUEUE_APPLIES_AT_ONCE.trim()}`,
  };
}

// "/aud mining target spread|focus", or the salvage menu's own pair - which rock
// (or wreck) a freshly launched drone takes. The two words were commands of their
// own for one build; they are values now, always typed in full, and the word on
// its own answers with what is set the way "distance" and "range" do.
function handleTargetMode(runtime, characterID, kind, value, meta) {
  const salvage = kind === "salvage";
  const read = salvage
    ? () => runtime.getSalvageState(characterID)
    : () => runtime.getPlayerState(characterID);
  const what = salvage
    ? "one wreck per drone, or every drone on one wreck"
    : "one rock per drone, or every drone on the closest rock";
  if (!value) {
    return {
      message:
        `beta-AdvancedUtilityDrones ${kind} target: ${(read() || {}).targetMode || "spread"} ` +
        `(${what}).`,
    };
  }
  const asked = resolveWord(value, TARGET_MODE_WORDS);
  if (!asked) {
    return { message: 'beta-AdvancedUtilityDrones: target must be "spread" or "focus".' };
  }
  const state = salvage
    ? runtime.setPlayerSalvageTargetMode(characterID, asked, meta)
    : runtime.setPlayerTargetMode(characterID, asked, meta);
  return {
    message: salvage
      ? `beta-AdvancedUtilityDrones salvage targeting mode: ${String(state.targetMode).toUpperCase()}.`
      : `beta-AdvancedUtilityDrones targeting mode: ${String(state.targetMode).toUpperCase()}.`,
  };
}

function handleRange(runtime, session, characterID, value, meta) {
  if (!value) {
    const status = runtime.describeStatus(session);
    const range = status.range;
    return {
      message: range
        ? `beta-AdvancedUtilityDrones search radius: ${formatMeters(range.rangeMeters)} ` +
          `(${describeBreakdown(range.breakdown)})`
        : "beta-AdvancedUtilityDrones search radius: no active ship found.",
    };
  }
  if (resolveWord(value, RANGE_WORDS) === "ship") {
    runtime.setPlayerRangeOverride(characterID, null, meta);
    const status = runtime.describeStatus(session);
    return {
      message: "beta-AdvancedUtilityDrones search radius now follows your ship: " +
        `${status.range ? formatMeters(status.range.rangeMeters) : "unknown"}.`,
    };
  }
  const numeric = Number(value.replace(/[,_\s]/gu, ""));
  if (!Number.isFinite(numeric) || numeric < MIN_RANGE_METERS || numeric > MAX_RANGE_METERS) {
    return {
      message:
        "beta-AdvancedUtilityDrones range must be a number between " +
        `${MIN_RANGE_METERS} and ${MAX_RANGE_METERS} meters, or "ship".`,
    };
  }
  runtime.setPlayerRangeOverride(characterID, Math.round(numeric), meta);
  return {
    message: `beta-AdvancedUtilityDrones search radius set to ${formatMeters(numeric)} ` +
      '(use "/aud mining range ship" to follow the ship again).',
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
  // The retired names are matched too, so the rename notice can be printed
  // instead of the line being broadcast to the channel as ordinary chat. The
  // name is left in front of the reply for those, which is how the router knows
  // which one was typed.
  const name = normalizeCommandName(match[1]);
  const rest = match[2] || "";
  if (TRIGGER_NAMES.includes(name)) {
    return rest;
  }
  return LEGACY_NAMES.includes(name) ? (rest ? `${name} ${rest}` : name) : null;
}

// Returns the argument text when the line is addressed to this mod, or null when
// the line belongs to somebody else and must be passed straight through.
function matchCommand(trimmed, config) {
  if (trimmed.startsWith("/") || trimmed.startsWith(".")) {
    const match = trimmed.slice(1).match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s+([\s\S]*))?$/u);
    if (!match) {
      return null;
    }
    const name = normalizeCommandName(match[1]);
    const rest = match[2] || "";
    if (COMMAND_NAMES.includes(name)) {
      return rest;
    }
    // A retired name is answered with the rename notice rather than passed on
    // to the vendor handler, so the name is kept in front of the reply.
    return LEGACY_NAMES.includes(name) ? (rest ? `${name} ${rest}` : name) : null;
  }
  return matchTrigger(trimmed, config);
}

function install(upstream, options) {
  if (!upstream || typeof upstream.executeChatCommand !== "function") {
    throw new Error("AUD_CHAT_EXPORT_INVALID");
  }
  if (upstream[OVERLAY_MARKER]) {
    return upstream;
  }
  const runtime = options.runtime;
  const config = options.config;
  if (!runtime || typeof runtime.describeStatus !== "function") {
    throw new Error("AUD_CHAT_RUNTIME_INVALID");
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
    upstream.COMMANDS_HELP_TEXT = `${help}\n` +
      `${ROOT_HELP_LINES.join("\n")}\n${ROOT_EXTRA_HELP_LINES.join("\n")}`;
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
  HELP_LINES,
  LEGACY_NAMES,
  MINING_SCOPES,
  OVERLAY_MARKER,
  OVERLAY_VERSION,
  RENAME_NOTICE,
  ROOT_HELP_LINES,
  SALVAGE_HELP_LINES,
  SALVAGE_SCOPES,
  TRIGGER_NAMES,
  buildFilterHelpText,
  buildHelpText,
  buildOreListText,
  buildRootHelpText,
  buildSalvageHelpText,
  buildSalvageListText,
  buildSalvageStatusText,
  buildStatusText,
  formatMeters,
  handleCommand,
  install,
  matchCommand,
  matchTrigger,
};
