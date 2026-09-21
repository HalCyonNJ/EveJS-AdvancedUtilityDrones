"use strict";

const path = require("node:path");
const commandScope = require("./commandScope");
const { createControlRangeResolver } = require("./controlRange");
const { createOreCatalog } = require("./oreNames.js");
const { KIND_KEYS, mergeEntries } = require("./playerSettings.js");
const oreQueue = require("./oreQueue.js");
const oreGrades = require("./oreGrades.js");
const {
  FILTER_FALLBACK_ANY,
  FILTER_FALLBACK_IDLE,
  MOON_ORE_GROUP_IDS,
  ORE_FILTER_SCOPES,
  SALVAGE_DISTANCE_FARTHEST,
  TARGET_MODE_FOCUS,
} = require("../config.js");

const MOD_VERSION = "1.0.0-alpha";
const DRONE_CATEGORY_ID = 18;
const STATE_IDLE = 0;
const STATE_MINING = 2;
const DRONE_COMMAND_MINE = "MINE";
const DRONE_COMMAND_SALVAGE = "SALVAGE";
// A wreck's salvage reward is handed over in whole units, and the server stops
// the cycle when the next one will not fit. The mod never has to guess that
// figure: the recall threshold is the knob that decides when the squadron comes
// home, so the unit used to judge "room for one more" is nominal.
const SALVAGE_UNIT_VOLUME_M3 = 0.01;
const PLAYER_CONTROL_HOLD = "hold";
const PLAYER_CONTROL_RECALL = "recall";
const PLAYER_CONTROL_OFF = "off";
// Commands that mean "leave these drones alone" once the player used them by hand.
const PLAYER_RECALL_COMMANDS = Object.freeze([
  "returnHome",
  "returnBay",
  "abandon",
]);
const RECALL_SUPPRESSION_MS = 120000;
const MAX_TRACKED_UNKNOWN_MINEABLE = 4096;
// How long an order is given to put anything into the bay before it counts as
// fruitless. Four fruitless orders in a row park the drone.
const STALL_PROBE_MS = 15000;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function surfaceDistance(left, right) {
  const leftPosition = left && left.position;
  const rightPosition = right && right.position;
  if (!leftPosition || !rightPosition) {
    return Number.POSITIVE_INFINITY;
  }
  const dx = toFiniteNumber(rightPosition.x, 0) - toFiniteNumber(leftPosition.x, 0);
  const dy = toFiniteNumber(rightPosition.y, 0) - toFiniteNumber(leftPosition.y, 0);
  const dz = toFiniteNumber(rightPosition.z, 0) - toFiniteNumber(leftPosition.z, 0);
  const centerDistance = Math.sqrt((dx * dx) + (dy * dy) + (dz * dz));
  const leftRadius = Math.max(0, toFiniteNumber(left && left.radius, 0));
  const rightRadius = Math.max(0, toFiniteNumber(right && right.radius, 0));
  return Math.max(0, centerDistance - leftRadius - rightRadius);
}

// Which work drone this is, by name: "ore", "ice", "salvage" or null.
//
// The name is only the fallback half of classifyDroneKind below, and it is the
// half that keeps the ore/ice split, because the game's own effect records do
// not carry it: every mining drone - ice harvesters included - resolves the same
// mining effect, and the ore/ice answer is the name. `miningClouds` exists only
// on gas harvester MODULES, so no drone can harvest a gas cloud and none is ever
// offered as a candidate.
function classifyDroneKindByName(droneEntity, itemTypeRegistry) {
  const typeID = toInt(droneEntity && droneEntity.typeID, 0);
  const typeRecord = typeID > 0 && itemTypeRegistry
    ? itemTypeRegistry.resolveItemByTypeID(typeID) || null
    : null;
  const name = String(
    (typeRecord && typeRecord.name) || droneEntity && droneEntity.itemName || "",
  ).trim().toLowerCase();
  if (!name) {
    return null;
  }
  if (name.includes("salvage")) {
    return "salvage";
  }
  if (name.includes("ice")) {
    return "ice";
  }
  if (
    name.includes("mining") ||
    name.includes("excavator") ||
    name.includes("harvester")
  ) {
    return "ore";
  }
  return null;
}

// The mining kinds only, by name: what the idle gate and the resume path need
// when no controller is at hand. Combat, repair and unclassified drones stay out.
function classifyMiningDroneKind(droneEntity, itemTypeRegistry) {
  const kind = classifyDroneKindByName(droneEntity, itemTypeRegistry);
  return kind === "ore" || kind === "ice" ? kind : null;
}

// Which bucket a rock falls into for the "what to mine" queue. Moon ore is a
// bucket of its own: /aud m filter ore never matches a moon rock. Returns null for
// a rock no mining drone can harvest (a gas cloud, a decorative asteroid).
function classifyTargetScope(state, entity, itemTypeRegistry, moonGroupIDs) {
  const kind = String((state && state.yieldKind) || "").trim().toLowerCase();
  if (kind === "ice") {
    return "ice";
  }
  if (kind !== "ore") {
    return null;
  }
  if (entity && entity.generatedMoonOreChunk === true) {
    return "moon";
  }
  const typeID = toInt(state && state.yieldTypeID, 0);
  const typeRecord = typeID > 0 && itemTypeRegistry
    ? itemTypeRegistry.resolveItemByTypeID(typeID) || null
    : null;
  if (typeRecord && moonGroupIDs && moonGroupIDs.has(toInt(typeRecord.groupID, 0))) {
    return "moon";
  }
  return "ore";
}

// Where a rock sits in the player's queue: the index of the first entry it
// matches, so the entry at the top of the list is mined before the ones under
// it. A rock no entry matches comes back as -1 and the caller applies
// filterFallback to it. With no queue set every rock ranks 0.
function oreFilterRank(filter, scope, name, typeID) {
  if (!filter || filter.active !== true) {
    return 0;
  }
  return oreQueue.rank(filter.queue, scope, name, typeID);
}

function oreFilterAllows(filter, scope, name, typeID) {
  return oreFilterRank(filter, scope, name, typeID) >= 0;
}

// The name of the ore a rock yields, as the client would show it, plus the ID
// the filter can match numerically.
function describeRockType(state, itemTypeRegistry) {
  const typeID = toInt(state && state.yieldTypeID, 0);
  const typeRecord = typeID > 0 && itemTypeRegistry
    ? itemTypeRegistry.resolveItemByTypeID(typeID) || null
    : null;
  return {
    typeID,
    name: String((typeRecord && typeRecord.name) || "").trim(),
    groupID: toInt(typeRecord && typeRecord.groupID, 0),
  };
}

function resolveControllerCharacterID(controllerEntity) {
  return toInt(
    controllerEntity &&
      (
        controllerEntity.session && controllerEntity.session.characterID
      ) ||
      controllerEntity &&
      (
        controllerEntity.pilotCharacterID ??
        controllerEntity.characterID ??
        controllerEntity.ownerID
      ),
    0,
  );
}

// Health lives in entity.conditionState as three fractions (shieldCharge,
// armorDamage, damage) against the entity's max layers, so the damage the drone
// has taken is 1 - currentHP/maxHP.
function readDamageFraction(droneEntity) {
  const shieldCapacity = Math.max(0, toFiniteNumber(droneEntity && droneEntity.shieldCapacity, 0));
  const armorHP = Math.max(0, toFiniteNumber(droneEntity && droneEntity.armorHP, 0));
  const structureHP = Math.max(0, toFiniteNumber(droneEntity && droneEntity.structureHP, 0));
  const maxHP = shieldCapacity + armorHP + structureHP;
  if (maxHP <= 0) {
    return null;
  }
  const conditionState =
    droneEntity && droneEntity.conditionState && typeof droneEntity.conditionState === "object"
      ? droneEntity.conditionState
      : {};
  const shieldCharge = clamp(toFiniteNumber(conditionState.shieldCharge, 1), 0, 1);
  const armorDamage = clamp(toFiniteNumber(conditionState.armorDamage, 0), 0, 1);
  const structureDamage = clamp(toFiniteNumber(conditionState.damage, 0), 0, 1);
  const currentHP =
    (shieldCapacity * shieldCharge) +
    (armorHP * (1 - armorDamage)) +
    (structureHP * (1 - structureDamage));
  return clamp(1 - (currentHP / maxHP), 0, 1);
}

function createServerDeps(runtimeRoot) {
  const cache = new Map();
  const load = (relative) => {
    let loaded = cache.get(relative);
    if (!loaded) {
      loaded = require(path.join(runtimeRoot, relative));
      cache.set(relative, loaded);
    }
    return loaded;
  };
  return Object.freeze({
    getDroneRuntime: () => load("server/src/services/drone/droneRuntime.js"),
    getDroneDogma: () => load("server/src/services/drone/droneDogma.js"),
    getMiningRuntimeState: () => load("server/src/services/mining/miningRuntimeState.js"),
    getMiningInventory: () => load("server/src/services/mining/miningInventory.js"),
    getLiveFittingState: () => load("server/src/services/fitting/liveFittingState.js"),
    getItemTypeRegistry: () => load("server/src/services/inventory/itemTypeRegistry.js"),
    getReferenceData: () => load("server/src/services/_shared/referenceData.js"),
    getSessionRegistry: () => load("server/src/services/chat/sessionRegistry.js"),
    getCharacterState: () => load("server/src/services/character/characterState.js"),
    getSpaceRuntime: () => load("server/src/space/runtime.js"),
    getSimulationInventoryProjection: () => (
      load("server/src/services/inventory/simulationInventoryProjection.js")
    ),
    getItemStore: () => load("server/src/services/inventory/itemStore.js"),
    getSalvagerRuntime: () => load("server/src/space/modules/salvagerRuntime.js"),
    getChatRuntime: () => load("server/src/_secondary/chat/chatRuntime.js"),
    getActiveImplantModifiers: () => (
      load("server/src/services/dogma/implants/activeImplantModifiers.js")
    ),
    // Flat adapters consumed by the control-range resolver.
    getAttributeIDByNames: (...names) => (
      load("server/src/services/fitting/liveFittingState.js").getAttributeIDByNames(...names)
    ),
    getTypeAttributeValue: (...args) => (
      load("server/src/services/fitting/liveFittingState.js").getTypeAttributeValue(...args)
    ),
    buildEffectiveItemAttributeMap: (itemOrTypeID) => (
      load("server/src/services/fitting/liveFittingState.js")
        .buildEffectiveItemAttributeMap(itemOrTypeID)
    ),
    isEffectivelyOnlineModule: (item) => (
      load("server/src/services/fitting/liveFittingState.js")
        .isEffectivelyOnlineModule(item)
    ),
    getControllerDogmaContext: (controllerEntity) => (
      load("server/src/services/drone/droneDogma.js")
        ._testing.getControllerDogmaContext(controllerEntity)
    ),
    getActiveImplants: (characterID) => (
      load("server/src/services/dogma/implants/activeImplantModifiers.js")
        .getActiveImplants(characterID)
    ),
    getActiveBoosters: (characterID) => (
      load("server/src/services/dogma/implants/activeImplantModifiers.js")
        .getActiveBoosters(characterID)
    ),
  });
}

const PLAYER_META_FIELDS = Object.freeze(["updatedAt", "characterName", "_comment"]);

// The players file keeps a character name and the time of the last write next
// to the settings; a copy carries the settings over and nothing else.
function withoutMetaFields(entry) {
  const result = {};
  for (const [field, value] of Object.entries(entry || {})) {
    if (!PLAYER_META_FIELDS.includes(field)) {
      result[field] = value;
    }
  }
  return result;
}

function createRuntime(options) {
  const config = options.config;

  const deps = options.deps;
  const players = options.players || null;
  // Without a players file the per-character overrides still work for this
  // process; they just do not survive a restart.
  const memoryOverrides = new Map();
  const readOverride = (characterID) => (
    players ? players.get(characterID) : (memoryOverrides.get(characterID) || null)
  );
  const writeOverride = (characterID, patch, meta) => {
    if (players) {
      players.set(characterID, patch, meta);
      return;
    }
    // The same one-level-deep merge the players file does, so setting the
    // salvage mode without a players store cannot drop the salvage switch -
    // or, here, the mining queue.
    const merged = mergeEntries(memoryOverrides.get(characterID) || {}, patch);
    if (meta && typeof meta === "object") {
      Object.assign(merged, meta);
    }
    memoryOverrides.set(characterID, merged);
  };
  const log = typeof options.log === "function" ? options.log : () => {};
  const logError = typeof options.logError === "function" ? options.logError : () => {};

  // Type ID to the kind the game's own effects gave it. Only effect-derived
  // answers are cached: a name-derived one is a guess, and the same type asked
  // again with a controller in hand deserves the real answer.
  const effectKindByTypeID = new Map();

  // The game answers this itself, so ask the game: a salvage drone resolves a
  // salvage snapshot and a mining drone resolves a mining snapshot, whatever it
  // is called. A third-party mod that launches 50 drones under its own names is
  // the reason this exists - a name list would quietly leave those drones idle.
  function probeDroneKindByEffect(droneEntity, controllerEntity) {
    if (!droneEntity || !controllerEntity) {
      return null;
    }
    const typeID = toInt(droneEntity.typeID, 0);
    if (typeID <= 0) {
      return null;
    }
    if (effectKindByTypeID.has(typeID)) {
      return effectKindByTypeID.get(typeID);
    }
    let kind = null;
    try {
      const dogma = deps.getDroneDogma();
      if (typeof dogma.resolveDroneSalvageSnapshot !== "function") {
        return null;
      }
      if (dogma.resolveDroneSalvageSnapshot(droneEntity, controllerEntity)) {
        kind = "salvage";
      } else if (
        typeof dogma.resolveDroneMiningSnapshot === "function" &&
        dogma.resolveDroneMiningSnapshot(droneEntity, controllerEntity)
      ) {
        kind = "ore";
      }
    } catch (error) {
      logError("drone kind probe failed: " + (error && error.message));
      return null;
    }
    if (kind) {
      effectKindByTypeID.set(typeID, kind);
    }
    return kind;
  }

  // Which kind of work drone this is: "ore", "ice", "salvage" or null for
  // anything this mod has no business flying (combat, repair, a fighter).
  //
  // The effect decides whether a drone is salvage or mining at all; the name
  // decides ore against ice, because the effect records do not carry that split.
  // A mining drone a third-party mod named something unusual is therefore still
  // flown, as ore, instead of being dropped in silence.
  function classifyDroneKind(droneEntity, itemTypeRegistry, controllerEntity = null) {
    const byEffect = probeDroneKindByEffect(droneEntity, controllerEntity);
    if (byEffect === "salvage") {
      return "salvage";
    }
    const byName = classifyDroneKindByName(droneEntity, itemTypeRegistry);
    if (byName) {
      return byName;
    }
    return byEffect === "ore" ? "ore" : null;
  }

  const stats = {
    passes: 0,
    assignments: 0,
    recalls: 0,
    stateRefreshes: 0,
    parked: 0,
    stalls: 0,
    lastAssignAtMs: 0,
    lastRecallAtMs: 0,
    lastRecallReason: null,
    // Times the filter matched nothing: once per ship pass that fell back to the
    // closest rock anyway, and once per ship pass that left the drones parked.
    filterFallbacks: 0,
    filterBlocked: 0,
    // Drones a queue change moved off a rock they were already mining.
    retargets: 0,
    // Salvage: orders issued and recalls caused by salvage.
    salvageAssignments: 0,
    salvageRecalls: 0,
    lastSalvageAssignAtMs: 0,
  };

  const controlRange = createControlRangeResolver({ config, deps, log, logError });

  // Reading a filter entry back as "this one mines ore, that one mines ice".
  // Display only: the drones mine from the live mining state and this never
  // takes part in targeting. It is built from the game's own item types the
  // first time a reply needs it - see lib/oreNames.js.
  const oreNames = createOreCatalog({
    moonGroupIDs: MOON_ORE_GROUP_IDS,
    readRows: () => {
      const reference =
        typeof deps.getReferenceData === "function" ? deps.getReferenceData() : null;
      if (!reference || typeof reference.readStaticRows !== "function") {
        throw new Error("the server's item types are not reachable");
      }
      return reference.readStaticRows(reference.TABLE.ITEM_TYPES);
    },
    logError: (message) => logError(`ore names: ${message}`),
  });

  // Which kinds one queue entry can mine: ["ore"], ["ice", "moon"], all
  // three for a bare "*", [] for a name no rock in the game has, and null
  // when the catalogue cannot be consulted at all. A caller reading this for
  // display keeps an entry it cannot place rather than hiding it. The tokens a
  // command can create are names and type IDs, so the kind and "*" branches are
  // reachable only through a queue an older release wrote.
  function oreEntryKinds(token) {
    const entry = oreQueue.parseStoredToken(token);
    if (!entry) {
      return null;
    }
    if (entry.kind) {
      return [entry.kind];
    }
    if (entry.pattern === "*") {
      return ORE_FILTER_SCOPES.slice();
    }
    return oreNames.isReady() ? oreNames.kindsFor(entry.pattern) : null;
  }

  // How one queue entry reads in a reply. A bare type ID becomes the name of the
  // rock it stands for, because that is what the player sees on the asteroid in
  // front of them - "16268" would send them looking for a table, "Gelidus" is
  // something they can find and then delete again.
  function oreFilterLabel(token) {
    return oreNames.nameOfTypeID(token) || oreQueue.describeToken(token);
  }

  // Every type ID a typed pattern covers, so "del gelidus" reaches an entry the
  // player queued as 16268 - and "del 16268" reaches one they queued by name.
  function oreTypeIDsFor(pattern) {
    return oreNames.typeIDsFor(pattern);
  }

  // The queue as a reply reads it: the same entries sorted into the kind of
  // rock each one mines, so a chain of names typed in one line - "filter add
  // veldspar kernite blue ice" - shows its order per kind, and each kind keeps
  // the order the drones work through it in. Every entry carries the number it
  // shows inside its own list, which is the number "filter move" takes, and the
  // label a reply prints for it.
  // An entry whose name matches no rock at all is reported apart, which is what
  // turns a typo into something the player can see.
  function describeOreFilterQueues(tokens) {
    const view = oreQueue.groupByKind(tokens, (token) => (
      oreEntryKinds(token) || []
    ));
    const groups = {};
    for (const scope of ORE_FILTER_SCOPES) {
      groups[scope] = (view.groups[scope] || []).map((entry) => ({
        order: entry.order,
        token: entry.token,
        label: oreFilterLabel(entry.token),
      }));
    }
    return {
      ready: oreNames.isReady(),
      groups,
      unknown: view.unknown.map((entry) => {
        const parsed = oreQueue.parseStoredToken(entry.token);
        return {
          order: entry.order,
          token: entry.token,
          label: oreFilterLabel(entry.token),
          suggestions: oreNames.suggestionsFor(parsed ? parsed.pattern : entry.token),
        };
      }),
    };
  }

  // Every setting resolves per character: the value the player chose in game
  // (persisted in the players file) wins, otherwise the server-wide default
  // from config/advancedUtilityDrones.json applies.
  // The keys that belong to a character rather than to one kind of drone.
  function sharedPlayerValues(overrides) {
    const stored = overrides || {};
    return {
      rangeOverrideMeters: stored.rangeOverrideMeters != null
        ? toFiniteNumber(stored.rangeOverrideMeters, 0) || null
        : null,
      minHoldFreeVolumeM3: toFiniteNumber(
        stored.minHoldFreeVolumeM3 !== undefined && stored.minHoldFreeVolumeM3 !== null
          ? stored.minHoldFreeVolumeM3
          : config.minHoldFreeVolumeM3,
        config.minHoldFreeVolumeM3,
      ),
      playerControlPolicy: stored.playerControlPolicy || config.playerControlPolicy,
    };
  }

  // The mining drones' effective settings: what the player chose in game,
  // otherwise the server-wide default. The keys stay flat because every mining
  // call site reads them flat; the per-kind split lives in the players file.
  function getPlayerState(characterID) {
    const key = toInt(characterID, 0);
    if (key <= 0) {
      return null;
    }
    const overrides = readOverride(key);
    const mining = (overrides && overrides.mining) || {};
    const pick = (field, fallback) => (
      mining[field] !== undefined && mining[field] !== null ? mining[field] : fallback
    );
    return {
      characterID: key,
      enabled: pick("enabled", config.enabledByDefault) === true,
      targetMode: pick("targetMode", config.targetMode),
      oreFilter: mining.oreFilter && typeof mining.oreFilter === "object"
        ? mining.oreFilter
        : null,
      filterFallback: pick("filterFallback", config.filterFallback),
      filterGrade: pick("filterGrade", config.filterGrade) === true,
      ...sharedPlayerValues(overrides),
      source: overrides ? "player" : "config",
    };
  }

  // The salvage drones' effective settings, read the same way. Separate from
  // getPlayerState on purpose: the two kinds are separate switches, so /aud m off
  // leaves the salvage drones working and /aud s off leaves the miners working.
  function getSalvageState(characterID) {
    const key = toInt(characterID, 0);
    if (key <= 0) {
      return null;
    }
    const overrides = readOverride(key);
    const salvage = (overrides && overrides.salvage) || {};
    const pick = (field, fallback) => (
      salvage[field] !== undefined && salvage[field] !== null ? salvage[field] : fallback
    );
    return {
      characterID: key,
      enabled: pick("enabled", config.salvageEnabled) === true,
      targetMode: pick("targetMode", config.salvageTargetMode) === TARGET_MODE_FOCUS
        ? TARGET_MODE_FOCUS
        : "spread",
      distance: pick("distance", config.salvageDistance) === SALVAGE_DISTANCE_FARTHEST
        ? SALVAGE_DISTANCE_FARTHEST
        : "nearest",
      ...sharedPlayerValues(overrides),
      source: overrides ? "player" : "config",
    };
  }

  // The reader picks which kind's state comes back: the mining setters want
  // getPlayerState, the salvage setters want getSalvageState, and a reply that
  // printed the other kind's values would be a lie ("mode: SPREAD" after a
  // successful "focus").
  function updatePlayerSettings(characterID, patch, meta = null, reader = null) {
    const key = toInt(characterID, 0);
    if (key <= 0 || !patch || typeof patch !== "object") {
      return null;
    }
    writeOverride(key, patch, meta);
    return (reader || getPlayerState)(key);
  }

  // Picks up a hand edit of the players file within a few seconds, no restart.
  function refreshPlayerOverrides(nowMs) {
    if (players && typeof players.maybeReload === "function") {
      return players.maybeReload(nowMs);
    }
    return false;
  }

  function playerStateSnapshot(characterID) {
    const key = toInt(characterID, 0);
    const state = key > 0 ? getPlayerState(key) : null;
    return state
      ? state
      : {
          characterID: 0,
          enabled: config.enabledByDefault,
          targetMode: config.targetMode,
          oreFilter: null,
          filterFallback: config.filterFallback,
          filterGrade: config.filterGrade === true,
          rangeOverrideMeters: null,
          minHoldFreeVolumeM3: config.minHoldFreeVolumeM3,
          playerControlPolicy: config.playerControlPolicy,
          source: "config",
        };
  }

  function listSceneDrones(scene) {
    if (!scene || !(scene.dynamicEntities instanceof Map)) {
      return [];
    }
    if (scene.droneEntityIDs instanceof Set && scene.droneEntityIDs.size > 0) {
      return [...scene.droneEntityIDs]
        .map((entityID) => scene.dynamicEntities.get(entityID) || null)
        .filter(Boolean);
    }
    const results = [];
    for (const entity of scene.dynamicEntities.values()) {
      if (entity && toInt(entity.categoryID, 0) === DRONE_CATEGORY_ID) {
        results.push(entity);
      }
    }
    return results;
  }

  // The rock a drone is working on right now, or 0 when it is not mining. The
  // vendor keeps the order in droneMining (droneRuntime.js sets both fields in
  // commandMineRepeatedly) and mirrors the ID on targetID.
  function currentMiningTargetID(droneEntity) {
    const mining = droneEntity && droneEntity.droneMining;
    return toInt(
      mining && mining.targetID,
      toInt(droneEntity && droneEntity.targetID, 0),
    );
  }

  // A drone this mod is flying: it holds a mining order, so re-issuing one only
  // replaces our own assignment. Idle drones are handled by isIdleMiningDrone,
  // a drone the player ordered by hand is parked, and combat, salvage and
  // repair orders are never touched.
  function isAutomatedMiningDrone(droneEntity, settings) {
    if (!droneEntity || droneEntity.droneCommand !== DRONE_COMMAND_MINE) {
      return false;
    }
    if (droneEntity.droneAssist) {
      return false;
    }
    return !isPlayerParked(droneEntity, settings);
  }

  // The queue the player may have just changed. The signature is noted once per
  // ship pass, so both a command typed in game and a hand edit of the players
  // file are picked up on the next scan without a hook in the command layer.
  const lastQueueSignature = new Map();

  function noteQueueSignature(characterID, playerState) {
    // The grade preference is part of what the drones are asked to do, so it
    // belongs in the signature as much as the queue does: switching it on has to
    // re-task a drone that is already sitting on a plain rock, the way a queue
    // edit does, instead of waiting for that rock to run out.
    const signature = `${JSON.stringify((playerState && playerState.oreFilter) || null)}` +
      `|${(playerState && playerState.filterFallback) || ""}` +
      `|${playerState && playerState.filterGrade === true ? "grade" : ""}`;
    const previous = lastQueueSignature.get(characterID);
    lastQueueSignature.set(characterID, signature);
    return previous !== undefined && previous !== signature;
  }

  function isPlayerParked(droneEntity, settings) {
    if (!droneEntity) {
      return false;
    }
    if (toFiniteNumber(droneEntity.advancedUtilityDronesPlayerParkedAtMs, 0) <= 0) {
      return false;
    }
    const policy = (settings && settings.playerControlPolicy) || PLAYER_CONTROL_HOLD;
    return policy !== PLAYER_CONTROL_OFF;
  }

  function isIdleMiningDrone(droneEntity, nowMs, settings = null) {
    if (!droneEntity) {
      return false;
    }
    if (droneEntity.droneCommand) {
      return false;
    }
    if (droneEntity.droneAssist) {
      return false;
    }
    const idleState = droneEntity.activityState;
    if (idleState !== undefined && idleState !== null && toInt(idleState, -1) !== STATE_IDLE) {
      return false;
    }
    const recalledAtMs = toFiniteNumber(droneEntity.advancedUtilityDronesRecalledAtMs, 0);
    if (recalledAtMs > 0 && nowMs - recalledAtMs < RECALL_SUPPRESSION_MS) {
      return false;
    }
    // The player is flying this one by hand: hands off until it is scooped back
    // into the bay and launched again.
    if (isPlayerParked(droneEntity, settings)) {
      return false;
    }
    // A drone that kept being re-tasked without the hold gaining anything is
    // left alone instead of being thrown at the same rock forever.
    if (droneEntity.advancedUtilityDronesStalled === true) {
      return false;
    }
    // Give the client a moment to learn about a freshly launched drone before
    // the first order goes out; otherwise the order arrives for a drone the
    // client does not know yet and is lost.
    const seenAtMs = toFiniteNumber(droneEntity.advancedUtilityDronesFirstSeenAtMs, 0);
    if (seenAtMs > 0 && nowMs - seenAtMs < config.postLaunchDelayMs) {
      return false;
    }
    return true;
  }

  function buildStorageSnapshot(characterID, shipEntity, context) {
    const shipID = toInt(shipEntity && shipEntity.itemID, 0);
    if (shipID <= 0 || characterID <= 0) {
      return null;
    }
    const projection = deps.getSimulationInventoryProjection();
    const shipItem = projection.findItemById ? projection.findItemById(shipID) : null;
    if (!shipItem) {
      return null;
    }
    const resourceState = deps.getLiveFittingState().buildShipResourceState(
      characterID,
      shipItem,
      {
        skillMap: context && context.skillMap,
        fittedItems: context && context.fittedItems,
      },
    );
    if (!resourceState) {
      return null;
    }
    const usedByFlag = new Map();
    const items = projection.listContainerItems(characterID, shipID, null) || [];
    for (const item of items) {
      const flagID = toInt(item && item.flagID, 0);
      const units = toInt(item && item.singleton, 0) === 1
        ? 1
        : Math.max(0, toInt(item && (item.stacksize ?? item.quantity), 0));
      const volume = Math.max(0, toFiniteNumber(item && item.volume, 0));
      usedByFlag.set(flagID, toFiniteNumber(usedByFlag.get(flagID), 0) + (volume * units));
    }
    const itemFlags = deps.getItemStore().ITEM_FLAGS || {};
    return {
      characterID,
      shipID,
      resourceState,
      usedByFlag,
      cargoFlagID: toInt(itemFlags.CARGO_HOLD, 0),
    };
  }

  function holdCapacity(storage, flagID) {
    if (!storage) {
      return 0;
    }
    const normalizedFlagID = toInt(flagID, 0);
    if (normalizedFlagID <= 0) {
      return 0;
    }
    if (normalizedFlagID === storage.cargoFlagID) {
      return Math.max(0, toFiniteNumber(storage.resourceState.cargoCapacity, 0));
    }
    return Math.max(0, toFiniteNumber(
      deps.getMiningInventory().getShipHoldCapacityByFlag(
        storage.resourceState,
        normalizedFlagID,
      ),
      0,
    ));
  }

  function holdFreeVolume(storage, flagID) {
    if (!storage) {
      return 0;
    }
    const used = toFiniteNumber(storage.usedByFlag.get(toInt(flagID, 0)), 0);
    return Math.max(0, holdCapacity(storage, flagID) - used);
  }

  // The bays a mining drone may deliver into, in the order the server itself
  // walks them (droneRuntime.resolveDroneMiningDestination): the preferred bay
  // first, then the specialized ore/ice/gas hold, then the hull’s general mining
  // hold, and the ordinary cargo hold only last. A hull that has a mining bay of
  // its own therefore never sees ore land in its cargo hold: the server takes the
  // first bay that has any room at all and then refuses to move a partial unit,
  // so it stops at the mining bay instead of spilling into cargo. Only a hull
  // without a mining bay of its own falls back to its cargo hold, which is then
  // the bay that actually receives the ore. Bays that cannot hold ore in the
  // first place (fuel, ship maintenance, fleet hangar) are never consulted.
  function holdDestinationFlags(storage, state) {
    const miningInventory = deps.getMiningInventory();
    const holdFlags = miningInventory.MINING_HOLD_FLAGS || {};
    const yieldKind = String((state && state.yieldKind) || "").trim().toLowerCase();
    // Salvage material is delivered into the cargo hold: the server's own
    // salvager cycle grants the reward with ITEM_FLAGS.CARGO_HOLD and stops on
    // resolveCargoSnapshot. No hull in this game data receives salvage anywhere
    // else - there is no working salvage hold to watch - so the only question
    // worth asking about a salvager is whether its cargo hold is full.
    if (yieldKind === "salvage") {
      return [storage.cargoFlagID];
    }
    const preferredFlag = toInt(
      miningInventory.getPreferredMiningHoldFlagForType(
        storage.resourceState,
        toInt(state && state.yieldTypeID, 0),
      ),
      0,
    );
    const miningFlags = [
      preferredFlag,
      yieldKind === "ore" ? holdFlags.SPECIALIZED_ASTEROID_HOLD : null,
      yieldKind === "gas" ? holdFlags.SPECIALIZED_GAS_HOLD : null,
      yieldKind === "ice" ? holdFlags.SPECIALIZED_ICE_HOLD : null,
      holdFlags.GENERAL_MINING_HOLD,
    ].filter((value, index, array) => value && array.indexOf(value) === index);
    const shipHasMiningHold = miningFlags.some((flagID) => holdCapacity(storage, flagID) > 0);
    return shipHasMiningHold ? miningFlags : [storage.cargoFlagID];
  }

  // Whether the ship can still take the next unit of what a drone is mining.
  //
  // The server (droneRuntime.resolveDroneMiningDestination) picks the first bay
  // in the same order that has any room at all and then delivers into it - and it
  // aborts the mining cycle when that one bay cannot take a whole unit rather
  // than looking at the next bay. The answer therefore has to be about the bay
  // the server would use right now: "some other bay still has room" is not
  // enough, because a hold down to its last sliver would otherwise keep the
  // drones mining rocks that can never be delivered. On top of the server’s
  // whole-unit rule the owner can ask for a minimum amount of free room, which
  // stops the drones before a
  // near-full bay turns into an endless retry loop (compressed ore is a fraction
  // of a unit, so "less than a whole unit" on its own is not enough).
  function holdStatus(storage, state, settings) {
    if (!storage || !state) {
      return {
        canAccept: true, reason: null, flagID: 0, capacity: 0, free: 0, threshold: 0, bays: [],
      };
    }
    const bays = [];
    for (const flagID of holdDestinationFlags(storage, state)) {
      const capacity = holdCapacity(storage, flagID);
      if (capacity <= 0) {
        continue;
      }
      bays.push({ flagID, capacity, free: holdFreeVolume(storage, flagID) });
    }
    if (bays.length === 0) {
      return {
        canAccept: false, reason: "no-hold", flagID: 0, capacity: 0, free: 0, threshold: 0, bays,
      };
    }
    const configuredThreshold = Math.max(
      0,
      toFiniteNumber(
        settings && settings.minHoldFreeVolumeM3 !== undefined
          ? settings.minHoldFreeVolumeM3
          : config.minHoldFreeVolumeM3,
        0,
      ),
    );
    const unitVolume = Math.max(0.000001, toFiniteNumber(state.unitVolume, 1));
    // The threshold may not swallow a bay whole: on a hull whose hold is
    // smaller than the configured figure the whole-unit rule still governs.
    const thresholdFor = (bay) => Math.min(configuredThreshold, bay.capacity * 0.5);
    // The bay reported is the one the server would deliver into right now.
    const destination = bays.find((bay) => bay.free > 0) || bays[0];
    const result = {
      flagID: destination.flagID,
      capacity: destination.capacity,
      free: destination.free,
      threshold: thresholdFor(destination),
      bays,
    };
    const wholeUnits = Math.floor(destination.free / unitVolume);
    if (destination.free >= result.threshold && wholeUnits >= 1) {
      return { ...result, canAccept: true, reason: null };
    }
    if (destination.free <= 0) {
      return { ...result, canAccept: false, reason: "hold full" };
    }
    if (result.threshold > 0 && destination.free < result.threshold) {
      return { ...result, canAccept: false, reason: "hold nearly full" };
    }
    return { ...result, canAccept: false, reason: "no room for a whole unit" };
  }

  function hasRoomForYield(storage, state, settings) {
    return holdStatus(storage, state, settings).canAccept;
  }

  // The bay figures the verbose log and the status line print, so a report about
  // a hold that refuses to fill can be answered without guessing which bays the
  // hull actually has.
  function describeHoldBays(hold) {
    if (!hold || !Array.isArray(hold.bays) || hold.bays.length === 0) {
      return "no bay";
    }
    return hold.bays
      .map((bay) => (
        `flag ${bay.flagID} ` +
        `${Math.round(bay.free * 100) / 100}/${Math.round(bay.capacity * 100) / 100} m3 free`
      ))
      .join(", ");
  }

  // Backstop for the one case the hold rules cannot see: the destination bay has
  // room on paper but the drone never gets anything into it (a rock it cannot
  // reach, a bay the server refuses, another mod fighting over the same drone).
  // Orders are counted inside a fixed window and a drone that produced nothing
  // in that window is parked instead of being thrown at the rock forever.
  function noteAssignmentProgress(droneEntity, freeVolume, nowMs) {
    const limit = toInt(config.maxStalledReassignments, 0);
    const previousFree = droneEntity.advancedUtilityDronesLastAssignHoldFree;
    const windowStartedAtMs = toFiniteNumber(droneEntity.advancedUtilityDronesLastAssignAtMs, 0);
    let strikes = toInt(droneEntity.advancedUtilityDronesStalledStrikes, 0);
    const gained = typeof previousFree === "number" && freeVolume < previousFree - 1e-6;
    if (gained || windowStartedAtMs <= 0) {
      strikes = 0;
    } else if (nowMs - windowStartedAtMs < STALL_PROBE_MS) {
      return false;
    } else {
      strikes += 1;
    }
    droneEntity.advancedUtilityDronesLastAssignHoldFree = freeVolume;
    droneEntity.advancedUtilityDronesLastAssignAtMs = nowMs;
    droneEntity.advancedUtilityDronesStalledStrikes = strikes;
    if (limit > 0 && strikes >= limit) {
      droneEntity.advancedUtilityDronesStalled = true;
      stats.stalls += 1;
      if (config.verbose) {
        log(
          `drone ${toInt(droneEntity.itemID, 0)} parked after ${strikes} orders ` +
          "with nothing mined",
        );
      }
      return true;
    }
    return false;
  }

  function recallMiningDrones(session, drones, reason, nowMs) {
    const ids = drones
      .map((drone) => toInt(drone && drone.itemID, 0))
      .filter((droneID) => droneID > 0);
    if (ids.length === 0 || !session) {
      return 0;
    }
    try {
      commandScope.run(() => deps.getDroneRuntime().commandReturnBay(session, ids));
    } catch (error) {
      logError(`recall failed (${reason}): ${error && error.message}`);
      return 0;
    }
    for (const drone of drones) {
      drone.advancedUtilityDronesRecalledAtMs = nowMs;
    }
    stats.recalls += 1;
    stats.lastRecallAtMs = nowMs;
    stats.lastRecallReason = reason;
    if (config.verbose) {
      log(`recalled ${ids.length} mining drone(s): ${reason}`);
    }
    return ids.length;
  }

  // The player took manual control of these drones, so the mod stops giving
  // them orders until they are scooped back into the bay and launched again.
  function parkDrones(droneEntities, nowMs) {
    let parked = 0;
    for (const drone of Array.isArray(droneEntities) ? droneEntities : []) {
      if (!drone) {
        continue;
      }
      if (toFiniteNumber(drone.advancedUtilityDronesPlayerParkedAtMs, 0) > 0) {
        continue;
      }
      drone.advancedUtilityDronesPlayerParkedAtMs = nowMs;
      parked += 1;
      if (config.verbose) {
        log(`parked drone ${toInt(drone.itemID, 0)}: the player is flying it by hand`);
      }
    }
    stats.parked += parked;
    return parked;
  }

  function resolveSceneDrones(scene, rawDroneIDs) {
    const ids = deps.getDroneRuntime().normalizeDroneIDList(rawDroneIDs);
    const drones = [];
    for (const droneID of ids) {
      const entity = scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(toInt(droneID, 0))
        : null;
      if (entity) {
        drones.push(entity);
      }
    }
    return drones;
  }

  // Called by the loader for every command the game itself dispatched, i.e.
  // not one this mod issued.
  function notePlayerCommand(kind, session, rawDroneIDs) {
    const characterID = toInt(session && (session.characterID || session.charid), 0);
    if (characterID <= 0) {
      return 0;
    }
    const settings = getPlayerState(characterID);
    if (!settings || settings.playerControlPolicy === PLAYER_CONTROL_OFF) {
      return 0;
    }
    if (
      settings.playerControlPolicy === PLAYER_CONTROL_RECALL &&
      !PLAYER_RECALL_COMMANDS.includes(kind)
    ) {
      return 0;
    }
    const scene = resolveSceneForSession(session);
    if (!scene) {
      return 0;
    }
    return parkDrones(resolveSceneDrones(scene, rawDroneIDs), Date.now());
  }

  // Wipes the "hands off" marks from this ship's mining drones. The player asks
  // for it with /aud m resume, and the loader calls it after a launch so a
  // drone that comes back out of the bay is automated again.
  function resumeDrones(session, asked = null) {
    const scene = resolveSceneForSession(session);
    if (!scene) {
      return 0;
    }
    const shipEntity = resolveShipEntity(session, scene);
    const shipID = toInt(shipEntity && shipEntity.itemID, 0);
    if (shipID <= 0) {
      return 0;
    }
    const itemTypeRegistry = deps.getItemTypeRegistry();
    let resumed = 0;
    for (const drone of listSceneDrones(scene)) {
      if (toInt(drone && drone.controllerID, 0) !== shipID) {
        continue;
      }
      const droneKind = classifyDroneKind(drone, itemTypeRegistry, shipEntity);
      const group = droneKind === "salvage" ? "salvage" : (droneKind ? "mining" : null);
      if (!group || (asked && group !== asked)) {
        continue;
      }
      if (
        toFiniteNumber(drone.advancedUtilityDronesPlayerParkedAtMs, 0) <= 0 &&
        drone.advancedUtilityDronesStalled !== true
      ) {
        continue;
      }
      drone.advancedUtilityDronesPlayerParkedAtMs = 0;
      drone.advancedUtilityDronesStalled = false;
      drone.advancedUtilityDronesStalledStrikes = 0;
      drone.advancedUtilityDronesLastAssignHoldFree = null;
      drone.advancedUtilityDronesLastAssignAtMs = 0;
      resumed += 1;
    }
    return resumed;
  }

  function scheduleStateRefresh(droneEntity, nowMs) {
    const schedule = Array.isArray(config.stateRefreshScheduleMs)
      ? config.stateRefreshScheduleMs
      : [];
    droneEntity.advancedUtilityDronesStateRefresh = schedule.length > 0
      ? { startedAtMs: nowMs, index: 0 }
      : null;
  }

  // Re-sends the drone’s own state. The server only notifies when something
  // changes, so an order placed right after a launch can be lost (the client
  // learns about the drone from a delayed batch and overwrites the state with
  // the pre-order snapshot). Replaying the live tuple puts the client back in
  // step: the drone window shows "approaching", and once mining the target icon
  // stays correct for every locked asteroid.
  function sendDroneStateRefresh(droneEntity, session) {
    if (!session || typeof session.sendNotification !== "function") {
      return false;
    }
    try {
      const tuple = deps.getDroneRuntime().buildDroneStateNotificationTuple(droneEntity);
      session.sendNotification("OnDroneStateChange", "charid", tuple);
      stats.stateRefreshes += 1;
      return true;
    } catch (error) {
      logError(`state refresh failed: ${error && error.message}`);
      return false;
    }
  }

  function runStateMaintenance(scene, nowMs) {
    const drones = listSceneDrones(scene);
    if (drones.length === 0) {
      return;
    }
    const sessionsByCharacter = new Map();
    const sessionFor = (characterID) => {
      if (!sessionsByCharacter.has(characterID)) {
        sessionsByCharacter.set(
          characterID,
          deps.getSessionRegistry().findSessionByCharacterID(characterID) || null,
        );
      }
      return sessionsByCharacter.get(characterID);
    };
    const schedule = Array.isArray(config.stateRefreshScheduleMs)
      ? config.stateRefreshScheduleMs
      : [];
    for (const drone of drones) {
      if (!drone) {
        continue;
      }
      if (toFiniteNumber(drone.advancedUtilityDronesFirstSeenAtMs, 0) <= 0) {
        drone.advancedUtilityDronesFirstSeenAtMs = nowMs;
      }
      const activityState = toInt(drone.activityState, STATE_IDLE);
      const pending = drone.advancedUtilityDronesStateRefresh || null;
      if (pending && activityState === STATE_MINING) {
        // The server has already told the client the interesting part.
        drone.advancedUtilityDronesStateRefresh = null;
      }
      let due = false;
      if (drone.advancedUtilityDronesStateRefresh) {
        const elapsedMs = nowMs - toFiniteNumber(
          drone.advancedUtilityDronesStateRefresh.startedAtMs,
          nowMs,
        );
        while (
          drone.advancedUtilityDronesStateRefresh.index < schedule.length &&
          elapsedMs >= toFiniteNumber(schedule[drone.advancedUtilityDronesStateRefresh.index], 0)
        ) {
          drone.advancedUtilityDronesStateRefresh.index += 1;
          due = true;
        }
        if (drone.advancedUtilityDronesStateRefresh.index >= schedule.length) {
          drone.advancedUtilityDronesStateRefresh = null;
        }
      }
      let keepAlive = false;
      if (
        !due &&
        config.stateKeepAliveMs > 0 &&
        activityState === STATE_MINING &&
        drone.droneCommand === DRONE_COMMAND_MINE
      ) {
        const lastAtMs = toFiniteNumber(drone.advancedUtilityDronesKeepAliveAtMs, 0);
        if (nowMs - lastAtMs >= config.stateKeepAliveMs) {
          drone.advancedUtilityDronesKeepAliveAtMs = nowMs;
          keepAlive = true;
        }
      }
      if (!due && !keepAlive) {
        continue;
      }
      const controllerEntity = scene.getEntityByID(toInt(drone.controllerID, 0));
      const characterID = resolveControllerCharacterID(controllerEntity);
      if (characterID <= 0) {
        continue;
      }
      sendDroneStateRefresh(drone, sessionFor(characterID));
    }
  }

  // The player's "what to mine" queue, normalized once per ship pass. The order
  // of the tokens is the priority order its rocks are mined in, and a kind no
  // token mentions is not mined at all; lib/oreQueue.js owns the grammar and
  // reads the per-kind shape 1.2.2 stored as well.
  function buildOreFilter(playerState) {
    const queue = oreQueue.readQueue(playerState && playerState.oreFilter);
    return { active: queue !== null, queue: queue || [] };
  }

  const moonGroupIDs = new Set(
    MOON_ORE_GROUP_IDS.map((value) => toInt(value, 0)).filter((value) => value > 0),
  );

  function candidateFilterRank(candidate, filter, itemTypeRegistry) {
    const rock = describeRockType(candidate && candidate.state, itemTypeRegistry);
    const scope = classifyTargetScope(
      candidate && candidate.state,
      candidate && candidate.entity,
      itemTypeRegistry,
      moonGroupIDs,
    );
    // Every rock the mod looks at tells the name catalogue what kind the live
    // mining state gives it, so a reply never disagrees with what the drones
    // actually mine.
    oreNames.remember(rock.typeID, scope);
    return oreFilterRank(filter, scope, rock.name, rock.typeID);
  }

  function candidateMatchesOreFilter(candidate, filter, itemTypeRegistry) {
    return candidateFilterRank(candidate, filter, itemTypeRegistry) >= 0;
  }

  function buildCandidates(scene, shipEntity, wantedKinds, maxRangeMeters, limit) {
    const cache = deps.getMiningRuntimeState().ensureSceneMiningState(scene);
    const byEntityID = cache && cache.byEntityID;
    if (!(byEntityID instanceof Map)) {
      return [];
    }
    const candidates = [];
    for (const state of byEntityID.values()) {
      if (!state || toInt(state.remainingQuantity, 0) <= 0) {
        continue;
      }
      const kind = String(state.yieldKind || "").trim().toLowerCase();
      if (!wantedKinds.has(kind)) {
        continue;
      }
      const entity = scene.getEntityByID(toInt(state.entityID, 0));
      if (!entity) {
        continue;
      }
      const distance = surfaceDistance(shipEntity, entity);
      if (!Number.isFinite(distance) || distance > maxRangeMeters) {
        continue;
      }
      candidates.push({ entity, state, kind, distance });
    }
    candidates.sort((left, right) => (
      left.distance - right.distance ||
      toInt(left.state.entityID, 0) - toInt(right.state.entityID, 0)
    ));
    return candidates.slice(0, Math.max(1, toInt(limit, toInt(config.maxCandidates, 48))));
  }

  // ensureSceneMiningState builds one cache per scene from the static entities
  // present at that moment, and only the dungeon and generated-resource-site
  // paths invalidate it again. A moon-ore chunk spawned into a system that was
  // already mined from is therefore absent from cache.byEntityID, which blinds
  // the vanilla mining laser and a manual drone order just as much as it blinds
  // this mod. The cache is nothing but a view over scene.staticEntities plus the
  // persisted per-system state, so dropping it re-derives identical data - the
  // same thing the upstream invalidation sites do.
  //
  // The rebuild is triggered by a CHANGE in the set of mineable-looking static
  // entities the cache does not know about, never on a timer. Geometry the cache
  // will never accept (decorative asteroids, the non-mineable companion rock)
  // enters that set once, costs one rebuild, and is then remembered, so a belt
  // full of them cannot make this rebuild in a loop.
  function refreshStaleSceneMiningCache(scene) {
    const miningRuntimeState = deps.getMiningRuntimeState();
    if (typeof miningRuntimeState.isMineableStaticEntity !== "function") {
      return false;
    }
    const cache = miningRuntimeState.ensureSceneMiningState(scene);
    const byEntityID = cache && cache.byEntityID;
    if (!(byEntityID instanceof Map) || !Array.isArray(scene.staticEntities)) {
      return false;
    }
    const known = scene.advancedUtilityDronesUnknownMineableIDs instanceof Set
      ? scene.advancedUtilityDronesUnknownMineableIDs
      : new Set();
    let discovered = 0;
    for (const entity of scene.staticEntities) {
      if (known.size >= MAX_TRACKED_UNKNOWN_MINEABLE) {
        break;
      }
      const entityID = toInt(entity && entity.itemID, 0);
      if (entityID <= 0 || byEntityID.has(entityID) || known.has(entityID)) {
        continue;
      }
      if (!miningRuntimeState.isMineableStaticEntity(entity)) {
        continue;
      }
      known.add(entityID);
      discovered += 1;
    }
    scene.advancedUtilityDronesUnknownMineableIDs = known;
    if (discovered === 0) {
      return false;
    }
    scene._miningRuntimeState = null;
    if (config.verbose) {
      log(
        `scene mining cache predates ${discovered} mineable rock(s); rebuilding it`,
      );
    }
    return true;
  }

  function resolveSceneForSession(session) {
    try {
      return deps.getDroneRuntime()._testing.resolveRuntimeSceneForSession(
        deps.getSpaceRuntime(),
        session,
      );
    } catch (_error) {
      return null;
    }
  }

  function resolveShipEntity(session, scene) {
    const characterID = toInt(session && (session.characterID || session.charid), 0);
    if (characterID <= 0 || !scene) {
      return null;
    }
    const characterState = deps.getCharacterState();
    const shipRecord = typeof characterState.getActiveShipRecord === "function"
      ? characterState.getActiveShipRecord(characterID)
      : null;
    if (!shipRecord) {
      return null;
    }
    return scene.getEntityByID(toInt(shipRecord.itemID, 0)) || null;
  }

  function runShipPass(scene, controllerID, shipDrones, nowMs, claims) {
    const controllerEntity = scene.getEntityByID(controllerID);
    if (!controllerEntity) {
      return;
    }
    const itemTypeRegistry = deps.getItemTypeRegistry();
    const miningDrones = shipDrones.filter((drone) => (
      classifyMiningDroneKind(drone, itemTypeRegistry) !== null
    ));
    if (miningDrones.length === 0) {
      return;
    }
    const characterID = resolveControllerCharacterID(controllerEntity);
    if (characterID <= 0) {
      return;
    }

    const damaged = [];
    for (const drone of miningDrones) {
      const damageFraction = readDamageFraction(drone);
      if (damageFraction === null) {
        continue;
      }
      const previous = drone.advancedUtilityDronesDamageFraction;
      drone.advancedUtilityDronesDamageFraction = damageFraction;
      if (typeof previous !== "number") {
        continue;
      }
      if (damageFraction > previous + config.damageThreshold + 1e-9) {
        damaged.push(drone);
      }
    }
    if (damaged.length > 0 && config.recallOnDamage) {
      recallMiningDrones(
        deps.getSessionRegistry().findSessionByCharacterID(characterID),
        miningDrones,
        "drone under attack",
        nowMs,
      );
      return;
    }

    const playerState = getPlayerState(characterID);
    if (!playerState.enabled) {
      return;
    }

    // A queue the player changed since the last pass is applied to the drones
    // that are already mining as well: they are re-targeted once, right here,
    // instead of waiting for their rock to run out.
    const queueChanged = noteQueueSignature(characterID, playerState);
    const retargeting = queueChanged && config.retargetOnFilterChange !== false;
    if (controllerEntity.mode === "WARP" || controllerEntity.warpState) {
      return;
    }

    const idleDrones = miningDrones.filter((drone) => (
      isIdleMiningDrone(drone, nowMs, playerState)
    ));
    // Drone ID -> the rock it is on, for the drones a queue change re-tasks.
    const retargetTargets = new Map();
    if (retargeting) {
      for (const drone of miningDrones) {
        if (!isAutomatedMiningDrone(drone, playerState)) {
          continue;
        }
        const targetID = currentMiningTargetID(drone);
        if (targetID > 0) {
          retargetTargets.set(toInt(drone.itemID, 0), targetID);
        }
      }
    }
    const assignmentDrones = retargetTargets.size > 0
      ? idleDrones.concat(
        miningDrones.filter((drone) => retargetTargets.has(toInt(drone.itemID, 0))),
      )
      : idleDrones;
    if (assignmentDrones.length === 0) {
      return;
    }
    const session = deps.getSessionRegistry().findSessionByCharacterID(characterID);
    if (!session) {
      return;
    }

    let context = null;
    try {
      context = deps.getDroneDogma()._testing.getControllerDogmaContext(controllerEntity);
    } catch (error) {
      logError(`dogma context failed: ${error && error.message}`);
    }

    const rangeInfo = controlRange.resolve(controllerEntity, characterID);
    const configuredRange = Number.isFinite(playerState.rangeOverrideMeters)
      ? playerState.rangeOverrideMeters
      : (rangeInfo && rangeInfo.rangeMeters) || config.baseRangeMeters;

    const dronesByKind = new Map();
    for (const drone of assignmentDrones) {
      const kind = classifyMiningDroneKind(drone, itemTypeRegistry);
      if (!dronesByKind.has(kind)) {
        dronesByKind.set(kind, []);
      }
      dronesByKind.get(kind).push(drone);
    }

    const wantedKinds = new Set(dronesByKind.keys());
    const oreFilter = buildOreFilter(playerState);
    // A filter has to look past the rocks the player does not want, so the scan
    // window is wider while one is set.
    const scanLimit = oreFilter.active
      ? Math.max(toInt(config.maxCandidates, 48), toInt(config.filterScanLimit, 512))
      : toInt(config.maxCandidates, 48);
    let candidates = buildCandidates(
      scene, controllerEntity, wantedKinds, configuredRange, scanLimit,
    );
    if (candidates.length === 0 && config.refreshStaleSceneCache) {
      refreshStaleSceneMiningCache(scene);
      candidates = buildCandidates(
        scene, controllerEntity, wantedKinds, configuredRange, scanLimit,
      );
    }
    if (candidates.length === 0) {
      return;
    }

    const storage = buildStorageSnapshot(characterID, controllerEntity, context);
    const droneRuntime = deps.getDroneRuntime();
    const claimPenalty = Math.max(0, toFiniteNumber(config.claimPenaltyMeters, 0));

    // Drones a queue change is re-tasking, but which the queue leaves nothing to
    // mine: they are brought home instead of finishing a rock it dropped.
    const blockedRetargets = [];
    for (const [kind, drones] of dronesByKind) {
      const retargets = new Map();
      for (const drone of drones) {
        const previousTargetID = retargetTargets.get(toInt(drone.itemID, 0)) || 0;
        if (previousTargetID > 0) {
          retargets.set(toInt(drone.itemID, 0), previousTargetID);
        }
      }
      let kindCandidates = candidates.filter((candidate) => candidate.kind === kind);
      if (kindCandidates.length === 0) {
        if (retargets.size > 0) {
          blockedRetargets.push(...drones);
        }
        continue;
      }
      // Rank of every rock this queue keeps, by entity, so the drone loop
      // below can sort by the player's priority before it sorts by distance.
      const filterRanks = new Map();
      if (oreFilter.active) {
        const matching = [];
        for (const candidate of kindCandidates) {
          const rank = candidateFilterRank(candidate, oreFilter, itemTypeRegistry);
          if (rank >= 0) {
            filterRanks.set(toInt(candidate.entity && candidate.entity.itemID, 0), rank);
            matching.push(candidate);
          }
        }
        if (matching.length > 0) {
          kindCandidates = matching;
        } else if (playerState.filterFallback === FILTER_FALLBACK_IDLE) {
          stats.filterBlocked += 1;
          if (config.verbose) {
            log(
              `filter matched nothing for controller ${controllerID}: ` +
              `${kindCandidates.length} ${kind} rock(s) ignored, drones stay idle`,
            );
          }
          kindCandidates = [];
        } else {
          stats.filterFallbacks += 1;
          if (config.verbose) {
            log(
              `filter matched nothing for controller ${controllerID}: ` +
              `mining the closest ${kind} rock anyway`,
            );
          }
        }
      }
      if (kindCandidates.length === 0) {
        if (retargets.size > 0) {
          blockedRetargets.push(...drones);
        }
        continue;
      }
      // With the grade preference on, the richest rock of a family is mined
      // before the plainer ones: the queue still decides first, and distance
      // only once two rocks carry the same grade.
      let gradeByEntity = null;
      if (playerState.filterGrade === true) {
        gradeByEntity = new Map();
        for (const candidate of kindCandidates) {
          const rock = describeRockType(candidate.state, itemTypeRegistry);
          gradeByEntity.set(
            toInt(candidate.entity && candidate.entity.itemID, 0),
            oreGrades.gradeOf(rock.name),
          );
        }
      }
      for (const drone of drones) {
        const skipTargetID = retargets.get(toInt(drone.itemID, 0)) || 0;
        const scored = kindCandidates
          .map((candidate) => {
            const claimed = toInt(claims.get(toInt(candidate.entity.itemID, 0)), 0);
            const penalty = playerState.targetMode === "focus" ? 0 : claimed * claimPenalty;
            return {
              candidate,
              // The queue decides first: a rock the player ranked above another
              // is mined first even when it is the further one.
              rank: toInt(filterRanks.get(toInt(candidate.entity.itemID, 0)), 0),
              grade: gradeByEntity
                ? toInt(gradeByEntity.get(toInt(candidate.entity.itemID, 0)), 0)
                : 0,
              score: candidate.distance + penalty,
            };
          })
          .sort((left, right) => (
            (left.rank - right.rank) ||
            (right.grade - left.grade) ||
            (left.score - right.score)
          ));
        for (const entry of scored) {
          const targetEntity = entry.candidate.entity;
          const targetID = toInt(targetEntity && targetEntity.itemID, 0);
          if (targetID <= 0) {
            continue;
          }
          let allowed = false;
          try {
            allowed = droneRuntime._testing.canPlayerCompanionActOnTarget(
              scene,
              session,
              drone,
              controllerEntity,
              targetEntity,
            ) === true;
          } catch (error) {
            logError(`visibility check failed: ${error && error.message}`);
          }
          if (!allowed) {
            continue;
          }
          const hold = holdStatus(storage, entry.candidate.state, playerState);
          if (!hold.canAccept) {
            if (config.verbose) {
              log(
                `hold stop for controller ${controllerID} (${hold.reason || "full"}): ` +
                `${describeHoldBays(hold)}, threshold ` +
                `${Math.round(hold.threshold * 100) / 100} m3`,
              );
            }
            if (config.recallOnFullHold) {
              recallMiningDrones(
                session,
                miningDrones,
                hold.reason || "mining hold full",
                nowMs,
              );
            }
            return;
          }
          if (hold.capacity > 0 && noteAssignmentProgress(drone, hold.free, nowMs)) {
            if (config.verbose) {
              log(
                `drone ${toInt(drone.itemID, 0)} produced nothing: ${describeHoldBays(hold)}`,
              );
            }
            if (config.recallOnFullHold) {
              recallMiningDrones(session, miningDrones, "drones stopped producing", nowMs);
            }
            return;
          }
          if (skipTargetID > 0 && targetID === skipTargetID) {
            // The new queue still ranks the rock this drone is on first: leave
            // the cycle alone rather than restart it for nothing.
            break;
          }
          try {
            commandScope.run(() => droneRuntime.commandMineRepeatedly(
              session,
              [toInt(drone.itemID, 0)],
              targetID,
            ));
          } catch (error) {
            logError(`assign failed: ${error && error.message}`);
            continue;
          }
          claims.set(targetID, toInt(claims.get(targetID), 0) + 1);
          stats.assignments += 1;
          if (skipTargetID > 0) {
            stats.retargets += 1;
          }
          stats.lastAssignAtMs = nowMs;
          scheduleStateRefresh(drone, nowMs);
          if (config.verbose) {
            log(
              `assigned drone ${toInt(drone.itemID, 0)} to ${kind} target ${targetID} ` +
              `at ${Math.round(entry.candidate.distance)} m, ${describeHoldBays(hold)}`,
            );
          }
          break;
        }
      }
    }
    if (blockedRetargets.length > 0) {
      recallMiningDrones(session, blockedRetargets, "queue changed", nowMs);
    }
  }

  // ─── Salvage ───────────────────────────────────────────────────────────────
  //
  // A wreck is only a target. The drones fly to the wrecks in range and work
  // them - nearest first, or farthest first when the pilot asks for that - and
  // nothing here asks whose wreck it is. In this game it is taking the loot that
  // carries the suspect flag, not stripping the hull, so a salvager that stopped
  // at a stranger's wreck would be refusing work the game itself allows.

  function safeSalvagerRuntime() {
    try {
      return deps.getSalvagerRuntime ? deps.getSalvagerRuntime() : null;
    } catch (error) {
      logError("salvager runtime unavailable: " + (error && error.message));
      return null;
    }
  }

  // A wreck that can still be salvaged, judged by the server's own rule
  // (salvagerRuntime.isSalvageableTarget) so a wreck the game would refuse is
  // never even scored. The local test is the fallback for a build whose
  // salvagerRuntime is not reachable.
  function isSalvageableWreckEntity(entity, salvagerRuntime) {
    if (!entity) {
      return false;
    }
    if (salvagerRuntime && typeof salvagerRuntime.isSalvageableTarget === "function") {
      return salvagerRuntime.isSalvageableTarget(entity) === true;
    }
    const kind = String(entity.kind || "").trim().toLowerCase();
    if (kind !== "wreck" && entity.nativeNpcWreck !== true) {
      return false;
    }
    return entity.salvaged !== true &&
      entity.salvageComplete !== true &&
      toInt(entity.itemID, 0) > 0;
  }

  function listSceneWrecks(scene, shipEntity, maxRangeMeters) {
    let entities = [];
    try {
      entities = scene && typeof scene.getAllVisibleEntities === "function"
        ? scene.getAllVisibleEntities()
        : [
            ...(scene && Array.isArray(scene.staticEntities) ? scene.staticEntities : []),
            ...(scene && scene.dynamicEntities instanceof Map
              ? [...scene.dynamicEntities.values()]
              : []),
          ];
    } catch (error) {
      logError("wreck scan failed: " + (error && error.message));
      return [];
    }
    const salvagerRuntime = safeSalvagerRuntime();
    const found = [];
    for (const entity of entities) {
      if (!isSalvageableWreckEntity(entity, salvagerRuntime)) {
        continue;
      }
      const targetID = toInt(entity.itemID, 0);
      if (targetID <= 0) {
        continue;
      }
      const distance = surfaceDistance(shipEntity, entity);
      if (!Number.isFinite(distance) || distance > maxRangeMeters) {
        continue;
      }
      found.push({ entity, targetID, distance });
    }
    found.sort((left, right) => left.distance - right.distance || left.targetID - right.targetID);
    return found;
  }

  function salvageOwnerLabel(ownerID) {
    const id = toInt(ownerID, 0);
    if (id <= 0) {
      return "nobody";
    }
    try {
      const record = deps.getCharacterState().getCharacterRecord(id);
      const name = record && (record.characterName || record.name);
      if (name && String(name).trim()) {
        return String(name).trim();
      }
    } catch (_error) {
      // A name is a courtesy here: the warning still names the wreck and its ID.
    }
    return "character " + id;
  }

  function isIdleSalvageDrone(droneEntity, nowMs, settings) {
    // Idle means the same thing for both kinds of drone, so the mining gate is
    // the gate: no standing order, no assist, the drone is sitting.
    return isIdleMiningDrone(droneEntity, nowMs, settings);
  }

  function runSalvageShipPass(scene, controllerID, shipDrones, nowMs, claims) {
    const controllerEntity = scene.getEntityByID(controllerID);
    if (!controllerEntity) {
      return;
    }
    const itemTypeRegistry = deps.getItemTypeRegistry();
    const salvageDrones = shipDrones.filter((drone) => (
      classifyDroneKind(drone, itemTypeRegistry, controllerEntity) === "salvage"
    ));
    if (salvageDrones.length === 0) {
      return;
    }
    const characterID = resolveControllerCharacterID(controllerEntity);
    if (characterID <= 0) {
      return;
    }
    const settings = getSalvageState(characterID);
    if (!settings || !settings.enabled) {
      return;
    }
    if (controllerEntity.mode === "WARP" || controllerEntity.warpState) {
      return;
    }

    // A salvage drone that took fire comes home with the rest of the squadron
    // and stays home for a while, exactly like a mining drone.
    const damaged = [];
    for (const drone of salvageDrones) {
      const damageFraction = readDamageFraction(drone);
      if (damageFraction === null) {
        continue;
      }
      const previous = drone.advancedUtilityDronesDamageFraction;
      drone.advancedUtilityDronesDamageFraction = damageFraction;
      if (typeof previous !== "number") {
        continue;
      }
      if (damageFraction > previous + config.damageThreshold + 1e-9) {
        damaged.push(drone);
      }
    }
    if (damaged.length > 0 && config.recallOnDamage) {
      recallSalvageDrones(
        deps.getSessionRegistry().findSessionByCharacterID(characterID),
        salvageDrones,
        "salvage drone under attack",
        nowMs,
      );
      return;
    }

    const idleDrones = salvageDrones.filter((drone) => (
      isIdleSalvageDrone(drone, nowMs, settings)
    ));
    if (idleDrones.length === 0) {
      return;
    }
    const session = deps.getSessionRegistry().findSessionByCharacterID(characterID);
    if (!session) {
      return;
    }
    const rangeInfo = controlRange.resolve(controllerEntity, characterID);
    const configuredRange = Number.isFinite(settings.rangeOverrideMeters)
      ? settings.rangeOverrideMeters
      : (rangeInfo && rangeInfo.rangeMeters) || config.baseRangeMeters;
    const allowed = listSceneWrecks(scene, controllerEntity, configuredRange);
    if (allowed.length === 0) {
      return;
    }

    const storage = buildStorageSnapshot(characterID, controllerEntity, null);
    const droneRuntime = deps.getDroneRuntime();
    const claimPenalty = Math.max(0, toFiniteNumber(config.claimPenaltyMeters, 0));
    const farFirst = settings.distance === SALVAGE_DISTANCE_FARTHEST;
    const holdState = { yieldKind: "salvage", unitVolume: SALVAGE_UNIT_VOLUME_M3 };

    for (const drone of idleDrones) {
      const scored = allowed
        .map((entry) => {
          const claimed = toInt(claims.get(entry.targetID), 0);
          const penalty = settings.targetMode === TARGET_MODE_FOCUS
            ? 0
            : claimed * claimPenalty;
          return {
            entry,
            score: (farFirst ? -entry.distance : entry.distance) + penalty,
          };
        })
        .sort((left, right) => (
          (left.score - right.score) ||
          (left.entry.targetID - right.entry.targetID)
        ));
      for (const candidate of scored) {
        const targetEntity = candidate.entry.entity;
        const targetID = candidate.entry.targetID;
        let visible = false;
        try {
          visible = droneRuntime._testing.canPlayerCompanionActOnTarget(
            scene,
            session,
            drone,
            controllerEntity,
            targetEntity,
          ) === true;
        } catch (error) {
          logError("visibility check failed: " + (error && error.message));
        }
        if (!visible) {
          continue;
        }
        const hold = holdStatus(storage, holdState, settings);
        if (!hold.canAccept) {
          if (config.verbose) {
            log(
              "salvage hold stop for controller " + controllerID + " (" +
              (hold.reason || "full") + "): " + describeHoldBays(hold),
            );
          }
          if (config.recallOnFullHold) {
            recallSalvageDrones(
              session,
              salvageDrones,
              hold.reason || "cargo hold full",
              nowMs,
            );
          }
          return;
        }
        try {
          commandScope.run(() => droneRuntime.commandSalvage(
            session,
            [toInt(drone.itemID, 0)],
            targetID,
          ));
        } catch (error) {
          logError("salvage assign failed: " + (error && error.message));
          continue;
        }
        claims.set(targetID, toInt(claims.get(targetID), 0) + 1);
        stats.salvageAssignments += 1;
        stats.lastSalvageAssignAtMs = nowMs;
        scheduleStateRefresh(drone, nowMs);
        if (config.verbose) {
          log(
            "assigned salvage drone " + toInt(drone.itemID, 0) + " to wreck " + targetID +
            " at " + Math.round(candidate.entry.distance) + " m",
          );
        }
        break;
      }
    }
  }

  function recallSalvageDrones(session, drones, reason, nowMs) {
    const ids = drones
      .map((drone) => toInt(drone && drone.itemID, 0))
      .filter((droneID) => droneID > 0);
    if (ids.length === 0 || !session) {
      return 0;
    }
    try {
      commandScope.run(() => deps.getDroneRuntime().commandReturnBay(session, ids));
    } catch (error) {
      logError("salvage recall failed: " + (error && error.message));
      return 0;
    }
    for (const drone of drones) {
      drone.advancedUtilityDronesRecalledAtMs = nowMs;
    }
    stats.salvageRecalls += 1;
    if (config.verbose) {
      log("recalled " + ids.length + " salvage drone(s): " + reason);
    }
    return ids.length;
  }

  function runScenePass(scene, nowMs) {
    const drones = listSceneDrones(scene);
    if (drones.length === 0) {
      return;
    }
    const byController = new Map();
    for (const drone of drones) {
      const controllerID = toInt(drone && drone.controllerID, 0);
      if (controllerID <= 0) {
        continue;
      }
      if (!byController.has(controllerID)) {
        byController.set(controllerID, []);
      }
      byController.get(controllerID).push(drone);
    }
    for (const [controllerID, shipDrones] of byController) {
      // One claim map per controller, not one per scene. A target one ship's
      // drones are already flying to must not be counted against another ship's:
      // two pilots sharing a belt, or one pilot running two hulls, would starve
      // each other - and on the third-party hulls that launch 50 drones it would
      // be the difference between a full squadron working and a handful working.
      const claims = new Map();
      try {
        runShipPass(scene, controllerID, shipDrones, nowMs, claims);
      } catch (error) {
        logError(`ship pass failed for controller ${controllerID}: ${error && error.stack}`);
      }
      try {
        runSalvageShipPass(scene, controllerID, shipDrones, nowMs, claims);
      } catch (error) {
        logError(`salvage pass failed for controller ${controllerID}: ${error && error.stack}`);
      }
    }
  }

  function onSceneTick(scene, nowMs) {
    if (!config.enabled) {
      return;
    }
    if (!scene || !(scene.dynamicEntities instanceof Map)) {
      return;
    }
    const time = toFiniteNumber(nowMs, 0) || Date.now();
    const lastPassAtMs = toFiniteNumber(scene.advancedUtilityDronesLastPassMs, 0);
    if (lastPassAtMs > 0 && (time - lastPassAtMs) < config.scanIntervalMs) {
      return;
    }
    scene.advancedUtilityDronesLastPassMs = time;
    stats.passes += 1;
    refreshPlayerOverrides(time);
    try {
      runStateMaintenance(scene, time);
    } catch (error) {
      logError(`state maintenance failed: ${error && error.message}`);
    }
    runScenePass(scene, time);
  }

  function describeStatus(session) {
    const characterID = toInt(session && (session.characterID || session.charid), 0);
    const playerState = playerStateSnapshot(characterID);
    const scene = resolveSceneForSession(session);
    const shipEntity = resolveShipEntity(session, scene);
    const itemTypeRegistry = deps.getItemTypeRegistry();
    let dronesInSpace = 0;
    let idleMiningDrones = 0;
    let miningDrones = 0;
    if (scene && shipEntity) {
      const shipID = toInt(shipEntity.itemID, 0);
      for (const drone of listSceneDrones(scene)) {
        if (toInt(drone.controllerID, 0) !== shipID) {
          continue;
        }
        if (classifyMiningDroneKind(drone, itemTypeRegistry) === null) {
          continue;
        }
        dronesInSpace += 1;
        if (drone.droneCommand === DRONE_COMMAND_MINE) {
          miningDrones += 1;
        } else if (isIdleMiningDrone(drone, Date.now(), playerState)) {
          idleMiningDrones += 1;
        }
      }
    }
    const rangeInfo = shipEntity
      ? controlRange.describe(characterID, shipEntity)
      : null;
    const oreFilter = buildOreFilter(playerState);
    let filterInfo = null;
    if (oreFilter.active && scene && shipEntity) {
      const rangeMeters = Number.isFinite(playerState.rangeOverrideMeters)
        ? playerState.rangeOverrideMeters
        : (rangeInfo && rangeInfo.rangeMeters) || config.baseRangeMeters;
      const visible = buildCandidates(
        scene,
        shipEntity,
        new Set(["ore", "ice"]),
        rangeMeters,
        Math.max(toInt(config.maxCandidates, 48), toInt(config.filterScanLimit, 512)),
      );
      let matching = 0;
      for (const candidate of visible) {
        if (candidateMatchesOreFilter(candidate, oreFilter, itemTypeRegistry)) {
          matching += 1;
        }
      }
      filterInfo = {
        queue: oreFilter.queue,
        fallback: playerState.filterFallback,
        grade: playerState.filterGrade === true,
        matching,
        scanned: visible.length,
      };
    }
    const storage = scene && shipEntity
      ? buildStorageSnapshot(characterID, shipEntity, null)
      : null;
    const hold = storage
      ? holdStatus(storage, { unitVolume: 1, yieldKind: "", yieldTypeID: 0 }, playerState)
      : null;
    return {
      characterID,
      playerState,
      hasShip: Boolean(shipEntity),
      dronesInSpace,
      miningDrones,
      idleMiningDrones,
      range: rangeInfo,
      hold,
      filter: filterInfo,
      playersFile: players && typeof players.file === "function" ? players.file() : null,
      stats: { ...stats },
    };
  }

  function salvageStateOrDefault(characterID) {
    const state = getSalvageState(characterID);
    if (state) {
      return state;
    }
    return {
      characterID: 0,
      enabled: config.salvageEnabled,
      targetMode: config.salvageTargetMode,
      distance: config.salvageDistance,
      rangeOverrideMeters: null,
      minHoldFreeVolumeM3: config.minHoldFreeVolumeM3,
      playerControlPolicy: config.playerControlPolicy,
      source: "config",
    };
  }

  function salvageRangeMeters(characterID, shipEntity, state) {
    if (Number.isFinite(state.rangeOverrideMeters)) {
      return state.rangeOverrideMeters;
    }
    const rangeInfo = shipEntity ? controlRange.describe(characterID, shipEntity) : null;
    return (rangeInfo && rangeInfo.rangeMeters) || config.baseRangeMeters;
  }

  // What the salvage drones are doing. Backs "/aud s status".
  function describeSalvageStatus(session) {
    const characterID = toInt(session && (session.characterID || session.charid), 0);
    const state = salvageStateOrDefault(characterID);
    const scene = resolveSceneForSession(session);
    const shipEntity = resolveShipEntity(session, scene);
    const itemTypeRegistry = deps.getItemTypeRegistry();
    let dronesInSpace = 0;
    let workingDrones = 0;
    let idleDrones = 0;
    if (scene && shipEntity) {
      const shipID = toInt(shipEntity.itemID, 0);
      for (const drone of listSceneDrones(scene)) {
        if (toInt(drone.controllerID, 0) !== shipID) {
          continue;
        }
        if (classifyDroneKind(drone, itemTypeRegistry, shipEntity) !== "salvage") {
          continue;
        }
        dronesInSpace += 1;
        if (drone.droneCommand === DRONE_COMMAND_SALVAGE) {
          workingDrones += 1;
        } else if (isIdleSalvageDrone(drone, Date.now(), state)) {
          idleDrones += 1;
        }
      }
    }
    const rangeInfo = shipEntity ? controlRange.describe(characterID, shipEntity) : null;
    const rangeMeters = salvageRangeMeters(characterID, shipEntity, state);
    const wrecks = scene && shipEntity ? listSceneWrecks(scene, shipEntity, rangeMeters) : [];
    const storage = scene && shipEntity
      ? buildStorageSnapshot(characterID, shipEntity, null)
      : null;
    const hold = storage ? holdStatus(storage, { yieldKind: "salvage" }, state) : null;
    return {
      characterID,
      playerState: state,
      hasShip: Boolean(shipEntity),
      dronesInSpace,
      workingDrones,
      idleDrones,
      wrecks: { total: wrecks.length },
      range: rangeInfo,
      rangeMeters,
      hold,
      playersFile: players && typeof players.file === "function" ? players.file() : null,
      stats: { ...stats },
    };
  }

  // Every wreck worth flying to around the ship, nearest first, with whose it is.
  // Backs "/aud s list".
  function describeSalvageWrecks(session, limit = 12) {
    const characterID = toInt(session && (session.characterID || session.charid), 0);
    const state = salvageStateOrDefault(characterID);
    const scene = resolveSceneForSession(session);
    const shipEntity = resolveShipEntity(session, scene);
    if (!scene || !shipEntity) {
      return { hasShip: false, rangeMeters: null, scanned: 0, entries: [] };
    }
    const rangeMeters = salvageRangeMeters(characterID, shipEntity, state);
    const wrecks = listSceneWrecks(scene, shipEntity, rangeMeters);
    const wanted = Math.max(1, toInt(limit, 12));
    const entries = [];
    for (const wreck of wrecks.slice(0, wanted)) {
      entries.push({
        targetID: wreck.targetID,
        distance: wreck.distance,
        name: String((wreck.entity && (wreck.entity.itemName || wreck.entity.name)) || "Wreck"),
        owner: salvageOwnerLabel(wreck.entity && wreck.entity.ownerID),
      });
    }
    return { hasShip: true, rangeMeters, scanned: wrecks.length, entries };
  }

  // Everything mineable around the character's ship, grouped per ore type: the
  // names a filter can be given, how much of each is left there and how far the
  // nearest rock of that type is. Backs the "list" command.
  function describeSceneOres(session, scope = null) {
    const characterID = toInt(session && (session.characterID || session.charid), 0);
    const playerState = playerStateSnapshot(characterID);
    const scene = resolveSceneForSession(session);
    const shipEntity = resolveShipEntity(session, scene);
    if (!scene || !shipEntity) {
      return { hasShip: false, scope, rangeMeters: null, scanned: 0, filterActive: false, entries: [] };
    }
    const itemTypeRegistry = deps.getItemTypeRegistry();
    const rangeInfo = controlRange.describe(characterID, shipEntity);
    const rangeMeters = Number.isFinite(playerState.rangeOverrideMeters)
      ? playerState.rangeOverrideMeters
      : (rangeInfo && rangeInfo.rangeMeters) || config.baseRangeMeters;
    const limit = Math.max(toInt(config.maxCandidates, 48), toInt(config.filterScanLimit, 512));
    const candidates = buildCandidates(
      scene, shipEntity, new Set(["ore", "ice"]), rangeMeters, limit,
    );
    const oreFilter = buildOreFilter(playerState);
    const grouped = new Map();
    for (const candidate of candidates) {
      const rock = describeRockType(candidate.state, itemTypeRegistry);
      const rockScope = classifyTargetScope(
        candidate.state, candidate.entity, itemTypeRegistry, moonGroupIDs,
      );
      oreNames.remember(rock.typeID, rockScope);
      if (!rockScope || (scope && rockScope !== scope)) {
        continue;
      }
      const remainingM3 = toFiniteNumber(candidate.state && candidate.state.remainingQuantity, 0) *
        toFiniteNumber(candidate.state && candidate.state.unitVolume, 0);
      const key = `${rockScope}:${rock.typeID}`;
      const rank = oreFilterRank(oreFilter, rockScope, rock.name, rock.typeID);
      const existing = grouped.get(key);
      if (existing) {
        existing.rocks += 1;
        existing.remainingM3 += remainingM3;
        existing.nearest = Math.min(existing.nearest, candidate.distance);
        continue;
      }
      grouped.set(key, {
        scope: rockScope,
        typeID: rock.typeID,
        name: rock.name || `type ${rock.typeID}`,
        grade: oreGrades.gradeOf(rock.name),
        rocks: 1,
        remainingM3,
        nearest: candidate.distance,
        filterRank: rank,
        matchesFilter: oreFilter.active === true && rank >= 0,
      });
    }
    // With a queue set, "list" reads in the order the drones will work through
    // it; the rocks the queue does not want come last, by distance. With the
    // grade preference on it reads the way the drones pick, richest grade first.
    const queueOrder = (entry) => (
      entry.filterRank < 0 ? Number.MAX_SAFE_INTEGER : entry.filterRank
    );
    const gradeOrder = (entry) => (playerState.filterGrade === true ? -entry.grade : 0);
    const entries = [...grouped.values()].sort((left, right) => (
      (queueOrder(left) - queueOrder(right)) ||
      (gradeOrder(left) - gradeOrder(right)) ||
      (left.nearest - right.nearest) ||
      left.name.localeCompare(right.name)
    ));
    return {
      hasShip: true,
      scope,
      rangeMeters,
      scanned: candidates.length,
      filterActive: oreFilter.active,
      entries,
    };
  }

  return Object.freeze({
    MOD_VERSION,
    describeStatus,
    describeSceneOres,
    describeOreFilterQueues,
    oreEntryKinds,
    oreFilterLabel,
    oreTypeIDsFor,
    // false when the game's asteroid table could not be read: a command then
    // cannot tell whether a number names a rock, so it refuses none.
    isOreCatalogReady: () => oreNames.isReady(),
    onSceneTick,
    getPlayerState,
    getSalvageState,
    describeSalvageStatus,
    describeSalvageWrecks,
    playerStateSnapshot,
    controlRange,
    // Every setter writes through to the per-character store, so the choice
    // survives a restart and travels with the players file.
    setPlayerEnabled(characterID, enabled, meta = null) {
      return updatePlayerSettings(characterID, { mining: { enabled: enabled === true } }, meta);
    },
    setPlayerTargetMode(characterID, targetMode, meta = null) {
      return updatePlayerSettings(characterID, {
        mining: { targetMode: targetMode === TARGET_MODE_FOCUS ? TARGET_MODE_FOCUS : "spread" },
      }, meta);
    },
    setPlayerSalvageEnabled(characterID, enabled, meta = null) {
      return updatePlayerSettings(
        characterID, { salvage: { enabled: enabled === true } }, meta, getSalvageState);
    },
    setPlayerSalvageTargetMode(characterID, targetMode, meta = null) {
      return updatePlayerSettings(characterID, {
        salvage: { targetMode: targetMode === TARGET_MODE_FOCUS ? TARGET_MODE_FOCUS : "spread" },
      }, meta, getSalvageState);
    },
    // Which end of the field a salvage squadron starts from: the nearest wreck,
    // or the furthest one.
    setPlayerSalvageDistance(characterID, distance, meta = null) {
      return updatePlayerSettings(characterID, {
        salvage: {
          distance: distance === SALVAGE_DISTANCE_FARTHEST
            ? SALVAGE_DISTANCE_FARTHEST
            : "nearest",
        },
      }, meta, getSalvageState);
    },
    setPlayerRangeOverride(characterID, rangeMeters, meta = null) {
      return updatePlayerSettings(characterID, {
        rangeOverrideMeters: Number.isFinite(rangeMeters) ? Math.round(rangeMeters) : null,
      }, meta);
    },
    setPlayerMinHoldFreeVolume(characterID, cubicMetres, meta = null) {
      const numeric = toFiniteNumber(cubicMetres, config.minHoldFreeVolumeM3);
      return updatePlayerSettings(characterID, {
        minHoldFreeVolumeM3: Math.max(0, numeric),
      }, meta);
    },
    // The filter is stored per character as the queue of tokens lib/oreQueue.js
    // defines. The tokens are normalized here, so a hand-written or half-typed
    // queue never reaches the file, and an empty queue clears the filter.
    setPlayerOreFilter(characterID, tokens, meta = null) {
      const key = toInt(characterID, 0);
      if (key <= 0) {
        return null;
      }
      const entries = tokens === null || tokens === undefined ? null : oreQueue.readQueue(tokens);
      return updatePlayerSettings(key, {
        mining: { oreFilter: entries ? oreQueue.serializeQueue(entries) : null },
      }, meta);
    },
    // The grade preference is per character and off unless it is asked for. With
    // it on the drones take the richest grade of a rock in range before the
    // plainer ones; "default" drops the override again.
    setPlayerFilterGrade(characterID, enabled, meta = null) {
      return updatePlayerSettings(characterID, {
        mining: { filterGrade: enabled === null ? null : enabled === true },
      }, meta);
    },
    // null (or "default") drops the override, so the server-wide
    // config.filterFallback applies again.
    setPlayerFilterFallback(characterID, policy, meta = null) {
      if (policy === null || policy === "default") {
        return updatePlayerSettings(characterID, { mining: { filterFallback: null } }, meta);
      }
      return updatePlayerSettings(characterID, {
        mining: {
          filterFallback: policy === FILTER_FALLBACK_IDLE
            ? FILTER_FALLBACK_IDLE
            : FILTER_FALLBACK_ANY,
        },
      }, meta);
    },
    setPlayerControlPolicy(characterID, policy, meta = null) {
      const accepted = [PLAYER_CONTROL_HOLD, PLAYER_CONTROL_RECALL, PLAYER_CONTROL_OFF];
      return updatePlayerSettings(characterID, {
        playerControlPolicy: accepted.includes(policy) ? policy : PLAYER_CONTROL_HOLD,
      }, meta);
    },
    // The raw per-character entries, for "/aud copy": it needs another
    // character's stored setup, not a value already merged with the defaults.
    allStoredPlayerSettings() {
      if (players && typeof players.all === "function") {
        return players.all();
      }
      const result = {};
      for (const [characterID, entry] of memoryOverrides) {
        result[String(characterID)] = { ...entry };
      }
      return result;
    },
    // The target ends up with exactly the source's stored entry. Returns the
    // target's resolved state, or null when the source has no entry at all.
    copyPlayerSettings(sourceID, targetID, meta = null) {
      const from = toInt(sourceID, 0);
      const to = toInt(targetID, 0);
      if (from <= 0 || to <= 0) {
        return null;
      }
      const source = readOverride(from);
      if (!source) {
        return null;
      }
      const entry = withoutMetaFields(source);
      if (players && typeof players.replace === "function") {
        players.replace(to, entry, meta);
      } else {
        memoryOverrides.set(to, {
          ...entry,
          ...(meta && typeof meta === "object" ? meta : {}),
        });
      }
      return getPlayerState(to);
    },
    // One kind's settings and nothing else: "/aud m reset" must not throw the
    // mining queue away, and "/aud s reset" must not throw the salvage switches
    // away. The shared keys - radius, threshold, takeover - belong to neither
    // kind, so they stay until "/aud reset" clears the whole entry.
    clearPlayerKindSettings(characterID, kind, meta = null) {
      const key = toInt(characterID, 0);
      const name = String(kind || "").trim().toLowerCase();
      if (key <= 0 || !Object.prototype.hasOwnProperty.call(KIND_KEYS, name)) {
        return null;
      }
      const entry = withoutMetaFields(readOverride(key) || {});
      delete entry[name];
      if (players && typeof players.replace === "function") {
        players.replace(key, entry, meta);
      } else if (Object.keys(entry).length === 0) {
        memoryOverrides.delete(key);
      } else {
        memoryOverrides.set(key, {
          ...entry,
          ...(meta && typeof meta === "object" ? meta : {}),
        });
      }
      return name === "salvage" ? getSalvageState(key) : getPlayerState(key);
    },
    clearPlayerSettings(characterID) {

      const key = toInt(characterID, 0);
      if (key <= 0) {
        return null;
      }
      if (players && typeof players.clear === "function") {
        players.clear(key);
      } else {
        memoryOverrides.delete(key);
      }
      return getPlayerState(key);
    },
    notePlayerCommand,
    resumeDrones,
    updatePlayerSettings,
    _testing: Object.freeze({
      buildOreFilter,
      currentMiningTargetID,
      isAutomatedMiningDrone,
      noteQueueSignature,
      candidateFilterRank,
      candidateMatchesOreFilter,
      classifyMiningDroneKind,
      classifyTargetScope,
      describeRockType,
      oreFilterAllows,
      describeHoldBays,
      holdDestinationFlags,
      holdStatus,
      isIdleMiningDrone,
      isIdleSalvageDrone,
      classifyDroneKind,
      classifyDroneKindByName,
      isSalvageableWreckEntity,
      listSceneWrecks,
      buildWreckCandidates: listSceneWrecks,
      isPlayerParked,
      noteAssignmentProgress,
      notePlayerCommand,
      parkDrones,
      readDamageFraction,
      refreshStaleSceneMiningCache,
      resumeDrones,
      sendDroneStateRefresh,
      surfaceDistance,
    }),
  });
}

module.exports = {
  DRONE_CATEGORY_ID,
  DRONE_COMMAND_MINE,
  DRONE_COMMAND_SALVAGE,
  MOD_VERSION,
  SALVAGE_UNIT_VOLUME_M3,
  classifyDroneKindByName,
  classifyTargetScope,
  oreFilterAllows,
  oreFilterRank,
  PLAYER_CONTROL_HOLD,
  PLAYER_CONTROL_OFF,
  PLAYER_CONTROL_RECALL,
  RECALL_SUPPRESSION_MS,
  STALL_PROBE_MS,
  STATE_IDLE,
  STATE_MINING,
  classifyMiningDroneKind,
  createRuntime,
  createServerDeps,
  readDamageFraction,
  surfaceDistance,
};