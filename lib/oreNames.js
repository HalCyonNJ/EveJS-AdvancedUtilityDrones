"use strict";

// What kind of rock a filter entry means.
//
// The queue is one flat list and an entry is a name, so a reply that reads
// "ore : 1. veldspar   ice : 2. clear icicle" has to know which kind a bare
// name mines. The game's own static data answers that: every rock is an
// "Asteroid" (item category 25), and the group it sits in says whether it is
// ordinary ore, ice, or one of the five moon-asteroid families the server's own
// services/structure/autoMoonMiningService.js recognises - the same rule
// lib/runtime.js uses when it routes a rock into the ore, ice or moon bucket.
//
// Two things keep this honest. Nothing in the targeting path reads it: the
// drones mine from the live mining state, and the catalogue only ever reads a
// queue back to the player. And a rock the mod has actually seen is remembered
// with the kind the mining runtime gave it (remember), so where the static
// table and the running server disagree, a reply follows the server from the
// moment that rock is in range.
//
// Everything is built on first use, from the same itemTypes table the server's
// item registry reads. A server whose static data cannot be read degrades to
// "no kind known" instead of failing: the filter keeps working, and the reply
// says it cannot group.

const {
  MOON_ORE_GROUP_IDS,
  ORE_FILTER_SCOPES,
} = require("../config.js");
const { nearestNames, normalizeName, typoBudget } = require("./nameMatch.js");

// Every rock in the game is an item type in this category.
const ITEM_CATEGORY_ASTEROID = 25;
// The group the ice types live in ("Ice": Blue Ice, Glacial Mass, Glare Crust,
// Krystallos, ... together with their compressed forms).
const GROUP_ICE = 465;
// Decorative asteroids. The game never puts one of these in a belt a drone can
// mine, so a name that only matches one of them is a name nothing mines.
const IGNORED_GROUP_IDS = Object.freeze([4094, 4714]);
const MAX_SUGGESTIONS = 3;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// "Compressed Veldspar", "Veldspar IV-Grade": the same rock under a name that
// adds nothing for a player checking a spelling.
function baseName(name) {
  return String(name || "")
    .replace(/^(?:ancient |batch )?compressed /iu, "")
    .replace(/ (?:ii|iii|iv|x)-grade$/iu, "")
    .trim();
}

// options.readRows() returns the game's item types and options.moonGroupIDs is
// the moon-ore group list, which lib/runtime.js owns and passes in.
function createOreCatalog(options = {}) {
  const readRows = typeof options.readRows === "function" ? options.readRows : null;
  const logError = typeof options.logError === "function" ? options.logError : () => {};
  const moonGroupIDs = new Set(
    (Array.isArray(options.moonGroupIDs) ? options.moonGroupIDs : MOON_ORE_GROUP_IDS)
      .map((value) => toInt(value, 0))
      .filter((value) => value > 0),
  );
  // typeID -> kind, for rocks the mining runtime itself classified.
  const seen = new Map();
  const cachedKinds = new Map();
  let state = null;

  // Ice is the one kind the game keeps in a group of its own; moon ore is the
  // five families the server names; everything else in the category is ore.
  function kindOfRow(row) {
    const groupID = toInt(row && row.groupID, 0);
    if (IGNORED_GROUP_IDS.includes(groupID)) {
      return null;
    }
    if (groupID === GROUP_ICE || /ice/iu.test(String((row && row.groupName) || ""))) {
      return "ice";
    }
    return moonGroupIDs.has(groupID) ? "moon" : "ore";
  }

  function build() {
    const result = { ready: false, entries: [], byTypeID: new Map(), suggestable: [] };
    state = result;
    if (!readRows) {
      logError("the server's reference data is not reachable, so filter entries cannot be grouped");
      return state;
    }
    let rows = [];
    try {
      rows = readRows();
    } catch (error) {
      logError(`the game's item types cannot be read: ${error && error.message}`);
      return state;
    }
    const bases = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const typeID = toInt(row && row.typeID, 0);
      const name = String((row && row.name) || "").trim();
      if (typeID <= 0 || !name || toInt(row && row.categoryID, 0) !== ITEM_CATEGORY_ASTEROID) {
        continue;
      }
      const kind = kindOfRow(row);
      if (!kind) {
        continue;
      }
      result.entries.push({ typeID, name, lowerName: name.toLowerCase(), kind });
      const base = baseName(name);
      const key = normalizeName(base);
      if (key && !bases.has(key)) {
        bases.set(key, base);
      }
    }
    result.byTypeID = new Map(result.entries.map((entry) => [entry.typeID, entry]));
    result.suggestable = [...bases.values()].sort((left, right) => left.localeCompare(right));
    result.ready = result.entries.length > 0;
    if (!result.ready) {
      logError("the game's item types held no asteroid rows, so filter entries cannot be grouped");
    }
    return state;
  }

  function ensure() {
    return state || build();
  }

  // What the live mining runtime called this rock, which outranks the table.
  function kindOf(entry) {
    return seen.get(entry.typeID) || entry.kind;
  }

  return Object.freeze({
    // false when the catalogue could not be read. A caller then shows the queue
    // ungrouped rather than guessing a kind for every entry.
    isReady() {
      return ensure().ready;
    },
    // The kinds one queue entry can mine, [] for a name no rock in the game
    // has. A pattern matches the way lib/oreQueue.js matches rocks: it is
    // looked for inside the type name, which is why "veldspar" covers every
    // grade of veldspar and "IV-Grade" covers four ice types.
    kindsFor(value) {
      const text = normalizeName(value);
      const data = ensure();
      if (!text || !data.ready) {
        return [];
      }
      const cached = cachedKinds.get(text);
      if (cached) {
        return cached;
      }
      const found = new Set();
      if (/^\d+$/u.test(text)) {
        const entry = data.byTypeID.get(Number(text));
        if (entry) {
          found.add(kindOf(entry));
        }
      } else {
        for (const entry of data.entries) {
          if (entry.lowerName.includes(text)) {
            found.add(kindOf(entry));
          }
        }
      }
      const kinds = ORE_FILTER_SCOPES.filter((scope) => found.has(scope));
      cachedKinds.set(text, kinds);
      return kinds;
    },
    // The rock a bare type ID names, so a reply can print "Gelidus" rather than
    // "16268": the player is looking at the name on the asteroid in front of
    // them, and a number would send them looking for a table.
    nameOfTypeID(value) {
      const text = normalizeName(value);
      const data = ensure();
      if (!data.ready || !/^\d+$/u.test(text)) {
        return null;
      }
      const entry = data.byTypeID.get(Number(text));
      return entry ? entry.name : null;
    },
    // Every type ID a name pattern covers, which is how "del gelidus" reaches an
    // entry the player queued as 16268, and "del 16268" one they queued by name.
    typeIDsFor(value) {
      const text = normalizeName(value);
      const data = ensure();
      if (!text || !data.ready) {
        return [];
      }
      if (/^\d+$/u.test(text)) {
        return data.byTypeID.has(Number(text)) ? [text] : [];
      }
      return data.entries
        .filter((entry) => entry.lowerName.includes(text))
        .map((entry) => String(entry.typeID));
    },
    // "did you mean veldspar?" in a reply.
    suggestionsFor(value) {
      const data = ensure();
      if (!data.ready || typoBudget(value) <= 0) {
        return [];
      }
      return nearestNames(value, data.suggestable, MAX_SUGGESTIONS).map((entry) => entry.name);
    },
    // A rock the mod has seen, with the kind the mining runtime gave it. This
    // is what keeps a reply in step with a server whose static table says
    // something else.
    remember(typeID, kind) {
      const key = toInt(typeID, 0);
      if (key <= 0 || !ORE_FILTER_SCOPES.includes(kind) || seen.get(key) === kind) {
        return;
      }
      seen.set(key, kind);
      cachedKinds.clear();
    },
  });
}

module.exports = {
  ITEM_CATEGORY_ASTEROID,
  MAX_SUGGESTIONS,
  baseName,
  createOreCatalog,
};