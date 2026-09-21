"use strict";

// Per-character settings for AdvancedUtilityDrones.
//
// The server-wide defaults live in config/advancedUtilityDrones.json. Anything a
// player changes in game (or that the server owner writes here by hand) is
// persisted per character in this file, so it survives restarts and is easy to
// hand out: copy the file, keep the entries you want.
//
// The installer creates the file and the uninstaller removes it, exactly like
// the mod's other configuration file.
const fs = require("node:fs");
const path = require("node:path");

const oreQueue = require("./oreQueue.js");

const FILE_COMMENT =
  "Per-character settings for AdvancedUtilityDrones. The key is the character ID " +
  "and every key inside an entry is optional: anything a character does not set " +
  "falls back to config/advancedUtilityDrones.json. Values set in game through " +
  "/aud (or the plain-chat trigger) are written here automatically. Character-wide " +
  "keys sit at the top level; what belongs to one kind of drone sits under \"mining\" " +
  "or under \"salvage\".";
const FILE_HELP =
  "Character-wide: " +
  "rangeOverrideMeters: number|null - search radius, null follows the ship. " +
  "minHoldFreeVolumeM3: number - come home once the bay the drones deliver into has less " +
  "than this much room left (the mining hold for mining drones, the cargo hold for salvage " +
  "drones). " +
  "playerControlPolicy: hold|recall|off - what happens after the player takes manual " +
  "control of drones. " +
  "\"mining\" is what the mining drones do: " +
  "enabled: true|false. " +
  "targetMode: spread|focus - one rock per drone, or every drone on one rock. " +
  "oreFilter: [tokens] - the queue of rocks to mine, first token first: \"veldspar\" matches " +
  "any rock whose name contains it, and 1231 is a type ID. Names are separated by commas, so " +
  "one name may hold a space - \"/aud mining filter add gneiss, dark ochre\" is two " +
  "entries. A kind the queue never mentions is not mined at all. The 1.2.2 " +
  "{\"ore\": [names], \"ice\": [names], \"moon\": [names]} form is still read, and so are the " +
  "kind words, \"*\" and \"ice:glacial mass\" a release before 1.2.9 wrote. " +
  "filterGrade: true|false - take the richest grade of a rock in range before the plainer " +
  "ones, so Veldspar IV-Grade is mined before Veldspar. " +
  "filterFallback: any|idle - mine the closest rock anyway when nothing in range matches " +
  "the filter, or stay parked instead. " +
  "\"salvage\" is what the salvage drones do: " +
  "enabled: true|false. " +
  "targetMode: spread|focus - one wreck per drone, or every drone on one wreck. " +
  "distance: nearest|farthest - start at the near end of the field or at the far one. " +
null
  "An entry written the 1.3.0 way - enabled, targetMode, oreFilter and the rest at the top " +
  "level - is still read, and means the mining kind.";
const RELOAD_CHECK_INTERVAL_MS = 5000;
const META_FIELDS = Object.freeze(["updatedAt", "characterName", "_comment"]);
// Character-wide: the keys that are not about one kind of drone.
const SHARED_CHOICE_FIELDS = Object.freeze({
  playerControlPolicy: Object.freeze(["hold", "recall", "off"]),
});
const SHARED_NUMBER_FIELDS = Object.freeze({
  minHoldFreeVolumeM3: Object.freeze({ minimum: 0, maximum: 1000000 }),
  rangeOverrideMeters: Object.freeze({ minimum: 1000, maximum: 10000000 }),
});
// Per kind of drone. A kind lives under its own key, so /aud mining off and /aud salvage off
// are two different switches rather than one shared one.
const MINING_FIELDS = Object.freeze({
  booleans: Object.freeze(["enabled", "filterGrade"]),
  choices: Object.freeze({
    targetMode: Object.freeze(["spread", "focus"]),
    filterFallback: Object.freeze(["any", "idle"]),
  }),
});
const SALVAGE_FIELDS = Object.freeze({
  booleans: Object.freeze(["enabled"]),
  choices: Object.freeze({
    targetMode: Object.freeze(["spread", "focus"]),
    distance: Object.freeze(["nearest", "farthest"]),
  }),
});
const KIND_KEYS = Object.freeze({ mining: MINING_FIELDS, salvage: SALVAGE_FIELDS });

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function readBooleanValue(value) {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value == null ? "" : value).trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) {
    return false;
  }
  return null;
}

// The queue is a list of tokens in priority order; lib/oreQueue.js owns the
// grammar and also knows how to read the three-bucket shape 1.2.2 wrote, so an
// entry kept from the older release still means what it meant.
// Returns the normalized tokens, or null when there is nothing left to store
// (which is how a cleared filter disappears from the players file).
function readOreFilter(rawValue) {
  const entries = oreQueue.readQueue(rawValue);
  return entries ? oreQueue.serializeQueue(entries) : null;
}

// One kind of drone's keys out of a stored entry, or null when the entry says
// nothing about that kind. Unknown keys and values of the wrong type are
// dropped rather than stored, so a hand-edited file can only ever say something
// the mod understands.
function readKindSettings(rawValue, spec) {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    return null;
  }
  const entry = {};
  for (const field of spec.booleans || []) {
    if (rawValue[field] === undefined) {
      continue;
    }
    const parsed = readBooleanValue(rawValue[field]);
    if (parsed !== null) {
      entry[field] = parsed;
    }
  }
  for (const [field, accepted] of Object.entries(spec.choices || {})) {
    if (rawValue[field] === undefined || rawValue[field] === null) {
      continue;
    }
    const normalized = String(rawValue[field]).trim().toLowerCase();
    if (accepted.includes(normalized)) {
      entry[field] = normalized;
    }
  }
  return Object.keys(entry).length > 0 ? entry : null;
}

// A stored entry, in the shape 1.0.0 writes: shared keys at the top level, then
// one object per kind of drone.
//
// The flat shape 1.3.0 wrote (enabled, targetMode, oreFilter, ... straight on
// the character) is still read and means the mining kind, so a players file
// that predates the split keeps working without being rewritten by hand. A key
// under "mining" wins over the same key at the top level, because that is the
// one somebody typed on purpose.
function normalizeEntry(rawEntry) {
  if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
    return null;
  }
  const entry = {};
  for (const [field, accepted] of Object.entries(SHARED_CHOICE_FIELDS)) {
    if (rawEntry[field] === undefined || rawEntry[field] === null) {
      continue;
    }
    const normalized = String(rawEntry[field]).trim().toLowerCase();
    if (accepted.includes(normalized)) {
      entry[field] = normalized;
    }
  }
  for (const [field, limits] of Object.entries(SHARED_NUMBER_FIELDS)) {
    if (rawEntry[field] === undefined) {
      continue;
    }
    if (rawEntry[field] === null) {
      if (field === "rangeOverrideMeters") {
        entry[field] = null;
      }
      continue;
    }
    const numeric = Number(String(rawEntry[field]).trim());
    if (Number.isFinite(numeric) && numeric >= limits.minimum && numeric <= limits.maximum) {
      entry[field] = field === "rangeOverrideMeters" ? Math.round(numeric) : numeric;
    }
  }
  for (const field of META_FIELDS) {
    if (rawEntry[field] !== undefined && typeof rawEntry[field] !== "object") {
      entry[field] = String(rawEntry[field]);
    }
  }

  const mining = readKindSettings(rawEntry.mining, MINING_FIELDS) || {};
  for (const field of [...MINING_FIELDS.booleans, ...Object.keys(MINING_FIELDS.choices)]) {
    if (mining[field] !== undefined || rawEntry[field] === undefined) {
      continue;
    }
    const folded = readKindSettings({ [field]: rawEntry[field] }, MINING_FIELDS);
    if (folded) {
      mining[field] = folded[field];
    }
  }
  // The queue is a list of tokens in priority order; lib/oreQueue.js owns the
  // grammar and also knows how to read the three-bucket shape 1.2.2 wrote, so an
  // entry kept from an older release still means what it meant.
  //
  // The queue is written under "mining" and was written at the top level before
  // the split; the nested one wins, because that is the one this release wrote.
  const nestedMining =
    rawEntry.mining && typeof rawEntry.mining === "object" && !Array.isArray(rawEntry.mining)
      ? rawEntry.mining
      : null;
  if (nestedMining && nestedMining.oreFilter !== undefined) {
    const filter = readOreFilter(nestedMining.oreFilter);
    if (filter) {
      mining.oreFilter = filter;
    }
  }
  if (rawEntry.oreFilter !== undefined && mining.oreFilter === undefined) {
    const filter = readOreFilter(rawEntry.oreFilter);
    if (filter) {
      mining.oreFilter = filter;
    }
  }
  if (Object.keys(mining).length > 0) {
    entry.mining = Object.freeze(mining);
  }
  const salvage = readKindSettings(rawEntry.salvage, SALVAGE_FIELDS);
  if (salvage) {
    entry.salvage = Object.freeze(salvage);
  }
  return Object.keys(entry).length > 0 ? Object.freeze(entry) : null;
}

// A patch from the command layer names one key at a time ("mining.enabled"), so
// the two per-kind objects are merged one level deep instead of being replaced
// wholesale - otherwise setting the salvage mode would drop the salvage switch.
function mergeEntries(base, patch) {
  const merged = { ...(base || {}) };
  for (const [key, value] of Object.entries(patch || {})) {
    if (
      Object.prototype.hasOwnProperty.call(KIND_KEYS, key) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      merged[key] = { ...(merged[key] || {}), ...value };
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function createPlayerStore(options = {}) {
  const file = options.file ? path.resolve(String(options.file)) : "";
  const log = typeof options.log === "function" ? options.log : () => {};
  const logError = typeof options.logError === "function" ? options.logError : () => {};
  const characters = new Map();
  let lastMtimeMs = 0;
  let lastError = null;
  let lastCheckAtMs = 0;
  let writes = 0;

  function emptyDocument() {
    return {
      _comment: FILE_COMMENT,
      _help: FILE_HELP,
      characters: {},
    };
  }

  function applyDocument(document) {
    characters.clear();
    const rawCharacters =
      document && typeof document === "object" && !Array.isArray(document)
        ? document.characters
        : null;
    if (rawCharacters && typeof rawCharacters === "object" && !Array.isArray(rawCharacters)) {
      for (const [key, value] of Object.entries(rawCharacters)) {
        const characterID = toInt(key, 0);
        const entry = normalizeEntry(value);
        if (characterID > 0 && entry) {
          characters.set(characterID, entry);
        }
      }
    }
  }

  function readFile(force) {
    if (!file) {
      return false;
    }
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch (_error) {
      if (force) {
        lastMtimeMs = 0;
        lastError = null;
        applyDocument(null);
      }
      return false;
    }
    if (!force && stat.mtimeMs === lastMtimeMs) {
      return false;
    }
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      lastError = error;
      logError(`could not read ${file}: ${error && error.message}`);
      return false;
    }
    lastMtimeMs = stat.mtimeMs;
    if (!text.trim()) {
      applyDocument(null);
      return true;
    }
    try {
      applyDocument(JSON.parse(text));
      lastError = null;
      return true;
    } catch (error) {
      lastError = error;
      logError(`${file} is not valid JSON: ${error && error.message}`);
      return false;
    }
  }

  function writeFile() {
    if (!file) {
      return false;
    }
    const document = emptyDocument();
    const ids = [...characters.keys()].sort((left, right) => left - right);
    for (const characterID of ids) {
      document.characters[String(characterID)] = { ...characters.get(characterID) };
    }
    const serialized = `${JSON.stringify(document, null, 2)}\n`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.tmp`;
      fs.writeFileSync(temporary, serialized, "utf8");
      fs.renameSync(temporary, file);
      lastMtimeMs = fs.statSync(file).mtimeMs;
      writes += 1;
      return true;
    } catch (error) {
      logError(`could not write ${file}: ${error && error.message}`);
      return false;
    }
  }

  function ensureFile() {
    if (!file) {
      return false;
    }
    try {
      if (fs.existsSync(file)) {
        return false;
      }
    } catch (_error) {
      return false;
    }
    // Never invent a configuration directory: the file belongs beside the
    // server's own config/, and a path that does not exist yet is a mistake
    // (a stray runtime root, a test) rather than a request to create one.
    try {
      if (!fs.existsSync(path.dirname(file))) {
        return false;
      }
    } catch (_error) {
      return false;
    }
    const created = writeFile();
    if (created) {
      log(`created ${file}`);
    }
    return created;
  }

  ensureFile();
  readFile(true);

  return Object.freeze({
    file: () => file,
    has: (characterID) => characters.has(toInt(characterID, 0)),
    get: (characterID) => characters.get(toInt(characterID, 0)) || null,
    all: () => {
      const result = {};
      for (const [characterID, entry] of characters) {
        result[String(characterID)] = { ...entry };
      }
      return result;
    },
    set(characterID, patch, meta = null) {
      const id = toInt(characterID, 0);
      if (id <= 0 || !patch || typeof patch !== "object") {
        return null;
      }
      const merged = mergeEntries(characters.get(id) || null, patch);
      if (meta && typeof meta === "object") {
        Object.assign(merged, meta);
      }
      merged.updatedAt = new Date().toISOString();
      const normalized = normalizeEntry(merged);
      if (!normalized) {
        return null;
      }
      characters.set(id, normalized);
      writeFile();
      return { ...normalized };
    },
    // /aud copy: the target ends up with exactly the source's entry, instead
    // of the merge a normal set() does. Everything the source never set
    // disappears from the target, which is what "copy the whole setup" has
    // to mean - a leftover threshold or queue would otherwise survive a copy
    // that was supposed to make two characters identical.
    replace(characterID, entry, meta = null) {
      const id = toInt(characterID, 0);
      if (id <= 0) {
        return null;
      }
      const merged = { ...(entry && typeof entry === "object" ? entry : {}) };
      for (const field of META_FIELDS) {
        delete merged[field];
      }
      if (meta && typeof meta === "object") {
        Object.assign(merged, meta);
      }
      merged.updatedAt = new Date().toISOString();
      const normalized = normalizeEntry(merged);
      if (!normalized) {
        // Nothing left to store: this character follows the server defaults.
        if (!characters.delete(id)) {
          return null;
        }
        writeFile();
        return {};
      }
      characters.set(id, normalized);
      writeFile();
      return { ...normalized };
    },
    clear(characterID) {
      const id = toInt(characterID, 0);
      if (!characters.delete(id)) {
        return false;
      }
      writeFile();
      return true;
    },
    // A hand-edited file takes effect within a few seconds without a restart.
    maybeReload(nowMs = Date.now()) {
      const now = toInt(nowMs, 0) || Date.now();
      if (now - lastCheckAtMs < RELOAD_CHECK_INTERVAL_MS) {
        return false;
      }
      lastCheckAtMs = now;
      return readFile(false);
    },
    reload: () => readFile(true),
    ensureFile: () => ensureFile(),
    stats: () => ({
      file,
      characters: characters.size,
      writes,
      lastError: lastError ? String(lastError.message || lastError) : null,
    }),
  });
}

module.exports = {
  FILE_COMMENT,
  FILE_HELP,
  KIND_KEYS,
  createPlayerStore,
  mergeEntries,
  normalizeEntry,
};