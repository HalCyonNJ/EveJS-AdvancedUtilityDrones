"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PREFIX = "EVEJS_ADVANCED_UTILITY_DRONES";
const CONFIG_FILENAME = "advancedUtilityDrones.json";
const PLAYERS_FILENAME = "advancedUtilityDrones.players.json";

// Every knob has three spellings: an environment variable, a key in
// <server root>/config/advancedUtilityDrones.json, and a key in the mod's own
// .env file beside loader.js. Precedence is environment > config JSON > .env,
// so a Docker deployment (where .env is excluded from the image and ./config is
// bind-mounted) is driven by the JSON file, while a native checkout can use
// either. A real environment variable always wins, which is what compose.yaml
// and `docker run -e` expect.
const KEYS = Object.freeze({
  enabled: PREFIX,
  verbose: `${PREFIX}_VERBOSE`,
  scanIntervalMs: `${PREFIX}_SCAN_INTERVAL_MS`,
  rangeMode: `${PREFIX}_RANGE_MODE`,
  rangeMeters: `${PREFIX}_RANGE_METERS`,
  rangeMinMeters: `${PREFIX}_RANGE_MIN_METERS`,
  rangeMaxMeters: `${PREFIX}_RANGE_MAX_METERS`,
  baseRangeMeters: `${PREFIX}_BASE_RANGE_METERS`,
  targetMode: `${PREFIX}_TARGET_MODE`,
  claimPenaltyMeters: `${PREFIX}_CLAIM_PENALTY_METERS`,
  refreshStaleSceneCache: `${PREFIX}_REFRESH_STALE_SCENE_CACHE`,
  recallOnFullHold: `${PREFIX}_RECALL_ON_FULL_HOLD`,
  recallOnDamage: `${PREFIX}_RECALL_ON_DAMAGE`,
  damageThreshold: `${PREFIX}_DAMAGE_THRESHOLD`,
  maxCandidates: `${PREFIX}_MAX_CANDIDATES`,
  filterScanLimit: `${PREFIX}_FILTER_SCAN_LIMIT`,
  filterFallback: `${PREFIX}_FILTER_FALLBACK`,
  filterGrade: `${PREFIX}_FILTER_GRADE`,
  retargetOnFilterChange: `${PREFIX}_RETARGET_ON_FILTER_CHANGE`,
  allowPlayerToggle: `${PREFIX}_ALLOW_PLAYER_TOGGLE`,
  allowPlayerCopy: `${PREFIX}_ALLOW_PLAYER_COPY`,
  enabledByDefault: `${PREFIX}_ENABLED_BY_DEFAULT`,
  minHoldFreeVolumeM3: `${PREFIX}_MIN_HOLD_FREE_VOLUME_M3`,
  playerControlPolicy: `${PREFIX}_PLAYER_CONTROL_POLICY`,
  postLaunchDelayMs: `${PREFIX}_POST_LAUNCH_DELAY_MS`,
  stateRefreshMs: `${PREFIX}_STATE_REFRESH_MS`,
  stateKeepAliveMs: `${PREFIX}_STATE_KEEP_ALIVE_MS`,
  maxStalledReassignments: `${PREFIX}_MAX_STALLED_REASSIGNMENTS`,
  playersFile: `${PREFIX}_PLAYERS_FILE`,
  chatTrigger: `${PREFIX}_CHAT_TRIGGER`,
  salvageEnabled: `${PREFIX}_SALVAGE_ENABLED`,
  salvageTargetMode: `${PREFIX}_SALVAGE_TARGET_MODE`,
  salvageDistance: `${PREFIX}_SALVAGE_DISTANCE`,
  salvageForeign: `${PREFIX}_SALVAGE_FOREIGN`,
});

// The names this mod answered to before it was renamed from Alternate Mining
// Drones. An existing .env, a Docker service env or a compose.yaml keeps working
// unchanged: the new spelling wins when both are present, and nothing else about
// the two differs.
const LEGACY_PREFIX = "EVEJS_ALT_MINING_DRONES";
const LEGACY_KEY_BY_ENV = Object.freeze(
  Object.fromEntries(
    Object.entries(KEYS).map(([_field, name]) => [
      name,
      `${LEGACY_PREFIX}${name.slice(PREFIX.length)}`,
    ]),
  ),
);

// Per-character overrides persisted in config/advancedUtilityDrones.players.json;
// the /aud command and the chat trigger write these.
const PLAYER_KEYS = Object.freeze({
  enabled: "enabled",
  targetMode: "targetMode",
  rangeOverrideMeters: "rangeOverrideMeters",
  minHoldFreeVolumeM3: "minHoldFreeVolumeM3",
  playerControlPolicy: "playerControlPolicy",
});

// A hand-written file may spell a key the long way (exactly like the
// environment variable) or the short way used by config.example.json. Both
// resolve to the same setting, so a config never silently falls back to the
// built-in defaults.
const JSON_KEY_BY_ENV = Object.freeze({
  [KEYS.enabled]: "enabled",
  [KEYS.enabledByDefault]: "enabledByDefault",
  [KEYS.allowPlayerToggle]: "allowPlayerToggle",
  [KEYS.allowPlayerCopy]: "allowPlayerCopy",
  [KEYS.verbose]: "verbose",
  [KEYS.scanIntervalMs]: "scanIntervalMs",
  [KEYS.rangeMode]: "rangeMode",
  [KEYS.rangeMeters]: "rangeMeters",
  [KEYS.rangeMinMeters]: "rangeMinMeters",
  [KEYS.rangeMaxMeters]: "rangeMaxMeters",
  [KEYS.baseRangeMeters]: "baseRangeMeters",
  [KEYS.targetMode]: "targetMode",
  [KEYS.claimPenaltyMeters]: "claimPenaltyMeters",
  [KEYS.refreshStaleSceneCache]: "refreshStaleSceneCache",
  [KEYS.recallOnFullHold]: "recallOnFullHold",
  [KEYS.recallOnDamage]: "recallOnDamage",
  [KEYS.damageThreshold]: "damageThreshold",
  [KEYS.maxCandidates]: "maxCandidates",
  [KEYS.filterScanLimit]: "filterScanLimit",
  [KEYS.filterFallback]: "filterFallback",
  [KEYS.filterGrade]: "filterGrade",
  [KEYS.retargetOnFilterChange]: "retargetOnFilterChange",
  [KEYS.minHoldFreeVolumeM3]: "minHoldFreeVolumeM3",
  [KEYS.playerControlPolicy]: "playerControlPolicy",
  [KEYS.postLaunchDelayMs]: "postLaunchDelayMs",
  [KEYS.stateRefreshMs]: "stateRefreshMs",
  [KEYS.stateKeepAliveMs]: "stateKeepAliveMs",
  [KEYS.maxStalledReassignments]: "maxStalledReassignments",
  [KEYS.playersFile]: "playersFile",
  [KEYS.chatTrigger]: "chatTrigger",
  [KEYS.salvageEnabled]: "salvageEnabled",
  [KEYS.salvageTargetMode]: "salvageTargetMode",
  [KEYS.salvageDistance]: "salvageDistance",
  [KEYS.salvageForeign]: "salvageForeign",
});

// What the mod does once the player has touched drones by hand: "hold" parks
// them until they are scooped and relaunched, "recall" only parks on a manual
// recall, "off" keeps the pre-1.0.1 behaviour.
const PLAYER_CONTROL_HOLD = "hold";
const PLAYER_CONTROL_RECALL = "recall";
const PLAYER_CONTROL_OFF = "off";

const RANGE_MODE_SHIP = "ship";
const RANGE_MODE_FIXED = "fixed";
const TARGET_MODE_SPREAD = "spread";
const TARGET_MODE_FOCUS = "focus";
// Which wreck a salvage drone takes first: the closest one, or the furthest
// one, so a pilot clearing a belt from the far end can say so.
const SALVAGE_DISTANCE_NEAREST = "nearest";
const SALVAGE_DISTANCE_FARTHEST = "farthest";
// Whose wrecks the salvage drones may work. "off" is own wrecks only, which is
// what the game's own auto-salvage does; "warn" also works another player's
// wreck but says so in chat first; "allow" does it silently. The safety light is
// a separate question and is warned about whatever this is set to.
const SALVAGE_FOREIGN_OFF = "off";
const SALVAGE_FOREIGN_WARN = "warn";
const SALVAGE_FOREIGN_ALLOW = "allow";

// What the mod does when the player's "what to mine" filter matches nothing in range:
// "any" mines the closest rock anyway, "idle" leaves the drones parked.
const FILTER_FALLBACK_ANY = "any";
const FILTER_FALLBACK_IDLE = "idle";
// The three buckets a rock can be filtered into. Moon ore is kept apart from
// ordinary ore on purpose: /aud m filter ore never matches a moon rock.
const ORE_FILTER_SCOPES = Object.freeze(["ore", "ice", "moon"]);
// A queue entry is a substring of the ore's type name ("veldspar" matches
// Veldspar, Dense Veldspar and Concentrated Veldspar alike), a type ID, or one
// of ORE_FILTER_ANY_ENTRIES, which stands for every rock of that kind. Entries
// are mined in the order they are stored, so the list is the priority order and
// the caps below are what the validator enforces on a hand-written file.
const ORE_FILTER_MAX_PATTERNS = 16;
const ORE_FILTER_MAX_PATTERN_LENGTH = 24;
const ORE_FILTER_ANY_ENTRIES = Object.freeze(["any", "*", "all"]);
// The five moon-asteroid families of SDE build 3396210: 1884 Ubiquitous,
// 1920 Common, 1921 Uncommon, 1922 Rare, 1923 Exceptional. Same list the
// server keeps in server/src/services/structure/autoMoonMiningService.js.
const MOON_ORE_GROUP_IDS = Object.freeze([1884, 1920, 1921, 1922, 1923]);

const DEFAULTS = Object.freeze({
  enabled: true,
  verbose: false,
  scanIntervalMs: 500,
  // "ship" tracks the hull, the skills and the fitted Drone Link Augmentors;
  // "fixed" uses rangeMeters for everyone. Setting rangeMeters on its own
  // selects "fixed", which is what a config file that only names a distance
  // expects to happen.
  rangeMode: RANGE_MODE_SHIP,
  rangeMeters: null,
  rangeMinMeters: 1000,
  rangeMaxMeters: 1000000,
  // SDE build 3396210 declares droneControlDistance (attribute 458) on
  // CharacterType as 20000 m. Every skill, module and implant bonus is an ADD
  // onto that base, so this is the floor of the control range.
  baseRangeMeters: 20000,
  targetMode: TARGET_MODE_SPREAD,
  claimPenaltyMeters: 15000,
  // Rebuild a scene's mining cache when it predates a mineable rock that is now
  // present (a moon-ore chunk spawned into a system that was already mined).
  refreshStaleSceneCache: true,
  recallOnFullHold: true,
  recallOnDamage: true,
  damageThreshold: 0,
  maxCandidates: 48,
  // How many rocks a single scan may look at once a filter is set. A filter has
  // to see past the nearest rocks to find the ones the player asked for, so the
  // scan is wider than the plain maxCandidates window.
  filterScanLimit: 512,
  filterFallback: FILTER_FALLBACK_ANY,
  // Off unless the player asks for it: with it on the drones take the richest
  // grade of a rock in range before the plainer ones.
  filterGrade: false,
  // Apply a queue change to the drones that are already mining instead of
  // waiting for their rock to run out: one re-target pass on the next scan.
  retargetOnFilterChange: true,
  allowPlayerToggle: true,
  // 1 = "/aud copy" may hand one character's whole setup to another one.
  // Players only ever copy settings, never anything account-bound, so this is
  // on by default; 0 removes the command.
  allowPlayerCopy: true,
  enabledByDefault: true,
  // Stop mining once the destination bay has less than this much room left.
  // Two cubic metres covers the sliver a near-full hold leaves behind (and
  // compressed ore, whose units are a fraction of a cubic metre) instead of
  // letting the drones restart a cycle that can never deliver anything.
  minHoldFreeVolumeM3: 2,
  playerControlPolicy: PLAYER_CONTROL_HOLD,
  // Wait this long after a drone appears before giving it a rock, so the
  // client has the drone in hand before the first state notification lands.
  postLaunchDelayMs: 2000,
  // Re-send the drone’s own state this many ms after a task (only until the
  // drone reports mining), and keep re-sending it every stateKeepAliveMs while
  // it mines, so the drone window and the target icon cannot go stale.
  stateRefreshMs: "0,1000,2500,5000",
  stateRefreshScheduleMs: Object.freeze([0, 1000, 2500, 5000]),
  stateKeepAliveMs: 5000,
  // Give up on a drone that keeps being re-tasked without the hold gaining
  // anything (0 disables the guard).
  maxStalledReassignments: 4,
  playersFile: "",
  chatTrigger: true,
  // Salvage drones off a launched hull pick their own wrecks, the same way the
  // mining ones pick rocks. On by default, because with salvageForeign=off they
  // only ever touch wrecks their own pilot owns.
  salvageEnabled: true,
  salvageTargetMode: TARGET_MODE_SPREAD,
  salvageDistance: SALVAGE_DISTANCE_NEAREST,
  salvageForeign: SALVAGE_FOREIGN_OFF,
});

const LIMITS = Object.freeze({
  scanIntervalMs: { minimum: 100, maximum: 60000 },
  rangeMeters: { minimum: 1000, maximum: 10000000 },
  rangeMinMeters: { minimum: 0, maximum: 10000000 },
  rangeMaxMeters: { minimum: 1000, maximum: 10000000 },
  baseRangeMeters: { minimum: 0, maximum: 1000000 },
  claimPenaltyMeters: { minimum: 0, maximum: 1000000 },
  damageThreshold: { minimum: 0, maximum: 1 },
  maxCandidates: { minimum: 1, maximum: 4096 },
  filterScanLimit: { minimum: 1, maximum: 4096 },
  minHoldFreeVolumeM3: { minimum: 0, maximum: 1000000 },
  postLaunchDelayMs: { minimum: 0, maximum: 60000 },
  stateRefreshMs: { minimum: 0, maximum: 600000 },
  stateKeepAliveMs: { minimum: 0, maximum: 600000 },
  maxStalledReassignments: { minimum: 0, maximum: 1000 },
});

function readEnvFile(file) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (_error) {
    return {};
  }
  const result = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value.length >= 2 && ["\"", "'"].includes(value[0]) && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

function readJsonFile(file, problems) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (_error) {
    return {};
  }
  if (!text.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      problems.push(`${CONFIG_FILENAME} must contain a JSON object`);
      return {};
    }
    return parsed;
  } catch (error) {
    problems.push(`${CONFIG_FILENAME} is not valid JSON: ${error && error.message}`);
    return {};
  }
}

function readBoolean(value, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return fallback;
}

function readNumber(value, fallback, limits, label, problems) {
  if (value == null || String(value).trim() === "") return fallback;
  const numeric = Number(String(value).trim());
  if (!Number.isFinite(numeric)) {
    problems.push(`${label} must be a finite number`);
    return fallback;
  }
  if (limits && (numeric < limits.minimum || numeric > limits.maximum)) {
    problems.push(`${label} must be between ${limits.minimum} and ${limits.maximum}`);
    return fallback;
  }
  return numeric;
}

function readChoice(value, fallback, accepted, label, problems) {
  if (value == null || String(value).trim() === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (accepted.includes(normalized)) return normalized;
  problems.push(`${label} must be one of ${accepted.join(", ")}`);
  return fallback;
}

function readText(value, fallback) {
  if (value == null) {
    return fallback;
  }
  const trimmed = String(value).trim();
  return trimmed || fallback;
}

function readNumberList(value, fallback, limits, label, problems) {
  if (value == null || String(value).trim() === "") {
    return fallback;
  }
  const items = Array.isArray(value) ? value : String(value).split(/[,\s]+/u);
  const collected = [];
  for (const item of items) {
    if (item == null || String(item).trim() === "") {
      continue;
    }
    const numeric = readNumber(item, null, limits, label, problems);
    if (numeric != null) {
      collected.push(Math.round(numeric));
    }
  }
  if (collected.length === 0) {
    return fallback;
  }
  return Object.freeze(collected.sort((left, right) => left - right));
}

function resolvePath(value, root) {
  const text = String(value || "").trim();
  if (!text) {
    return path.join(root, "config", PLAYERS_FILENAME);
  }
  return path.isAbsolute(text) ? text : path.join(root, text);
}

function load(modDir, environment = process.env, options = {}) {
  const dir = modDir || __dirname;
  const envFilename = path.join(dir, ".env");
  const jsonFilename = options.configPath
    || path.join(
      options.runtimeRoot || path.resolve(dir, "../.."),
      "config",
      CONFIG_FILENAME,
    );
  const problems = [];
  const fileValues = readEnvFile(envFilename);
  const jsonValues = readJsonFile(jsonFilename, problems);

  // A later source is only consulted when every earlier one is absent, so an
  // explicit empty string in a higher layer means "unset" rather than "false".
  const readSource = (source, key) => {
    if (!source) {
      return undefined;
    }
    const direct = source[key];
    if (direct != null && String(direct).trim() !== "") {
      return direct;
    }
    const shortKey = JSON_KEY_BY_ENV[key];
    if (shortKey && shortKey !== key) {
      const short = source[shortKey];
      if (short != null && String(short).trim() !== "") {
        return short;
      }
    }
    // The spelling from before the rename, read last so the current one wins.
    const legacyKey = LEGACY_KEY_BY_ENV[key];
    if (legacyKey && legacyKey !== key) {
      const legacy = source[legacyKey];
      if (legacy != null && String(legacy).trim() !== "") {
        return legacy;
      }
    }
    return undefined;
  };
  const pick = (key) => {
    for (const source of [environment, jsonValues, fileValues]) {
      const value = readSource(source, key);
      if (value !== undefined) {
        return value;
      }
    }
    return undefined;
  };
  const numeric = (key, fallback, limits) => readNumber(
    pick(key), fallback, limits, KEYS[key], problems,
  );

  const rawRangeMode = pick(KEYS.rangeMode);
  const rawRangeMeters = pick(KEYS.rangeMeters);
  const rangeMeters = rawRangeMeters == null
    ? null
    : readNumber(rawRangeMeters, null, LIMITS.rangeMeters, KEYS.rangeMeters, problems);
  const rangeModeExplicit = rawRangeMode != null && String(rawRangeMode).trim() !== "";
  const rangeMode = rangeModeExplicit
    ? readChoice(
        rawRangeMode,
        DEFAULTS.rangeMode,
        [RANGE_MODE_SHIP, RANGE_MODE_FIXED],
        KEYS.rangeMode,
        problems,
      )
    : (rangeMeters != null ? RANGE_MODE_FIXED : DEFAULTS.rangeMode);
  if (rangeMode === RANGE_MODE_FIXED && rangeMeters == null) {
    problems.push(`${KEYS.rangeMeters} is required when ${KEYS.rangeMode}=${RANGE_MODE_FIXED}`);
  }

  const sources = [];
  const envNames = [...Object.values(KEYS), ...Object.values(LEGACY_KEY_BY_ENV)];
  if (Object.keys(environment || {}).some((key) => envNames.includes(key))) {
    sources.push("environment");
  }
  if (Object.keys(jsonValues).length > 0) sources.push(CONFIG_FILENAME);
  if (Object.keys(fileValues).length > 0) sources.push(".env");

  return Object.freeze({
    enabled: readBoolean(pick(KEYS.enabled), DEFAULTS.enabled),
    verbose: readBoolean(pick(KEYS.verbose), DEFAULTS.verbose),
    scanIntervalMs: numeric(KEYS.scanIntervalMs, DEFAULTS.scanIntervalMs, LIMITS.scanIntervalMs),
    rangeMode,
    rangeMeters,
    rangeMinMeters: numeric(KEYS.rangeMinMeters, DEFAULTS.rangeMinMeters, LIMITS.rangeMinMeters),
    rangeMaxMeters: numeric(KEYS.rangeMaxMeters, DEFAULTS.rangeMaxMeters, LIMITS.rangeMaxMeters),
    baseRangeMeters: numeric(KEYS.baseRangeMeters, DEFAULTS.baseRangeMeters, LIMITS.baseRangeMeters),
    targetMode: readChoice(
      pick(KEYS.targetMode),
      DEFAULTS.targetMode,
      [TARGET_MODE_SPREAD, TARGET_MODE_FOCUS],
      KEYS.targetMode,
      problems,
    ),
    claimPenaltyMeters: numeric(
      KEYS.claimPenaltyMeters, DEFAULTS.claimPenaltyMeters, LIMITS.claimPenaltyMeters,
    ),
    refreshStaleSceneCache: readBoolean(
      pick(KEYS.refreshStaleSceneCache), DEFAULTS.refreshStaleSceneCache,
    ),
    recallOnFullHold: readBoolean(pick(KEYS.recallOnFullHold), DEFAULTS.recallOnFullHold),
    recallOnDamage: readBoolean(pick(KEYS.recallOnDamage), DEFAULTS.recallOnDamage),
    damageThreshold: numeric(KEYS.damageThreshold, DEFAULTS.damageThreshold, LIMITS.damageThreshold),
    maxCandidates: numeric(KEYS.maxCandidates, DEFAULTS.maxCandidates, LIMITS.maxCandidates),
    filterScanLimit: numeric(
      KEYS.filterScanLimit, DEFAULTS.filterScanLimit, LIMITS.filterScanLimit,
    ),
    filterFallback: readChoice(
      pick(KEYS.filterFallback),
      DEFAULTS.filterFallback,
      [FILTER_FALLBACK_ANY, FILTER_FALLBACK_IDLE],
      KEYS.filterFallback,
      problems,
    ),
    filterGrade: readBoolean(pick(KEYS.filterGrade), DEFAULTS.filterGrade),
    retargetOnFilterChange: readBoolean(
      pick(KEYS.retargetOnFilterChange), DEFAULTS.retargetOnFilterChange,
    ),
    allowPlayerToggle: readBoolean(pick(KEYS.allowPlayerToggle), DEFAULTS.allowPlayerToggle),
    allowPlayerCopy: readBoolean(pick(KEYS.allowPlayerCopy), DEFAULTS.allowPlayerCopy),
    enabledByDefault: readBoolean(pick(KEYS.enabledByDefault), DEFAULTS.enabledByDefault),
    minHoldFreeVolumeM3: numeric(
      KEYS.minHoldFreeVolumeM3,
      DEFAULTS.minHoldFreeVolumeM3,
      LIMITS.minHoldFreeVolumeM3,
    ),
    playerControlPolicy: readChoice(
      pick(KEYS.playerControlPolicy),
      DEFAULTS.playerControlPolicy,
      [PLAYER_CONTROL_HOLD, PLAYER_CONTROL_RECALL, PLAYER_CONTROL_OFF],
      KEYS.playerControlPolicy,
      problems,
    ),
    postLaunchDelayMs: numeric(
      KEYS.postLaunchDelayMs,
      DEFAULTS.postLaunchDelayMs,
      LIMITS.postLaunchDelayMs,
    ),
    stateRefreshScheduleMs: readNumberList(
      pick(KEYS.stateRefreshMs),
      DEFAULTS.stateRefreshScheduleMs,
      LIMITS.stateRefreshMs,
      KEYS.stateRefreshMs,
      problems,
    ),
    stateKeepAliveMs: numeric(
      KEYS.stateKeepAliveMs,
      DEFAULTS.stateKeepAliveMs,
      LIMITS.stateKeepAliveMs,
    ),
    maxStalledReassignments: numeric(
      KEYS.maxStalledReassignments,
      DEFAULTS.maxStalledReassignments,
      LIMITS.maxStalledReassignments,
    ),
    chatTrigger: readBoolean(pick(KEYS.chatTrigger), DEFAULTS.chatTrigger),
    salvageEnabled: readBoolean(pick(KEYS.salvageEnabled), DEFAULTS.salvageEnabled),
    salvageTargetMode: readChoice(
      pick(KEYS.salvageTargetMode),
      DEFAULTS.salvageTargetMode,
      [TARGET_MODE_SPREAD, TARGET_MODE_FOCUS],
      KEYS.salvageTargetMode,
      problems,
    ),
    salvageDistance: readChoice(
      pick(KEYS.salvageDistance),
      DEFAULTS.salvageDistance,
      [SALVAGE_DISTANCE_NEAREST, SALVAGE_DISTANCE_FARTHEST],
      KEYS.salvageDistance,
      problems,
    ),
    salvageForeign: readChoice(
      pick(KEYS.salvageForeign),
      DEFAULTS.salvageForeign,
      [SALVAGE_FOREIGN_OFF, SALVAGE_FOREIGN_WARN, SALVAGE_FOREIGN_ALLOW],
      KEYS.salvageForeign,
      problems,
    ),
    playersFile: readText(pick(KEYS.playersFile), DEFAULTS.playersFile),
    playersFilename: resolvePath(
      readText(pick(KEYS.playersFile), DEFAULTS.playersFile),
      options.runtimeRoot || path.resolve(dir, "../.."),
    ),
    configFilename: jsonFilename,
    sources: Object.freeze(sources),
    problems: Object.freeze(problems),
  });
}

module.exports = {
  CONFIG_FILENAME,
  FILTER_FALLBACK_ANY,
  FILTER_FALLBACK_IDLE,
  MOON_ORE_GROUP_IDS,
  ORE_FILTER_ANY_ENTRIES,
  ORE_FILTER_MAX_PATTERN_LENGTH,
  ORE_FILTER_MAX_PATTERNS,
  ORE_FILTER_SCOPES,
  PLAYERS_FILENAME,
  PLAYER_CONTROL_HOLD,
  PLAYER_CONTROL_OFF,
  PLAYER_CONTROL_RECALL,
  PLAYER_KEYS,
  DEFAULTS,
  JSON_KEY_BY_ENV,
  KEYS,
  LIMITS,
  PREFIX,
  RANGE_MODE_FIXED,
  RANGE_MODE_SHIP,
  SALVAGE_DISTANCE_FARTHEST,
  SALVAGE_DISTANCE_NEAREST,
  SALVAGE_FOREIGN_ALLOW,
  SALVAGE_FOREIGN_OFF,
  SALVAGE_FOREIGN_WARN,
  TARGET_MODE_FOCUS,
  TARGET_MODE_SPREAD,
  load,
  readBoolean,
  readEnvFile,
  readJsonFile,
  readNumberList,
  readText,
};
