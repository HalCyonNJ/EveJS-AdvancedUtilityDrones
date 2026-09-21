"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const configModule = require(path.join(__dirname, "..", "config.js"));
const { createRuntime } = require(path.join(__dirname, "..", "lib", "runtime.js"));
const chatCommand = require(path.join(__dirname, "..", "lib", "chatCommand.js"));
const plainChat = require(path.join(__dirname, "..", "lib", "plainChat.js"));
const playerSettings = require(path.join(__dirname, "..", "lib", "playerSettings.js"));
const commandScope = require(path.join(__dirname, "..", "lib", "commandScope.js"));
const fs = require("node:fs");
const os = require("node:os");

const modDir = path.resolve(__dirname, "..");
// Requiring the loader installs it against the real mod directory, which is
// what the three loader tests below then exercise and restore.
const loaderModule = require(path.join(__dirname, "..", "loader.js"));

const ORE_DRONE_TYPE = 10246;
const ICE_DRONE_TYPE = 43699;
const LINK_AUGMENTOR_TYPE = 23527;
const DRONE_AVIONICS_TYPE = 3437;
const ADVANCED_DRONE_AVIONICS_TYPE = 23566;
const ORE_HOLD_FLAG = 182;
const GENERAL_MINING_HOLD_FLAG = 134;
const GAS_HOLD_FLAG = 135;
const ICE_HOLD_FLAG = 181;
const CARGO_HOLD_FLAG = 5;
const ICE_YIELD_TYPE = 16264;
// A salvage drone, from the SDE's own name. Its effect is not simulated here,
// which is the point: with no effect to ask about, the name decides.
const SALVAGE_DRONE_TYPE = 32444;
// A drone a third-party mod shipped under a name no rule of ours recognises.
// Nothing but the game's own effect records can tell what it does, which is
// exactly the case the effect probe exists for.
const THIRD_PARTY_DRONE_TYPE = 90001;
const WRECK_TYPE = 23;

const TYPE_NAMES = {
  [ORE_DRONE_TYPE]: "Mining Drone I",
  [ICE_DRONE_TYPE]: "Ice Harvesting Drone I",
  [SALVAGE_DRONE_TYPE]: "Salvage Drone I",
  [THIRD_PARTY_DRONE_TYPE]: "Swarm Harvester XLS",
  [LINK_AUGMENTOR_TYPE]: "Drone Link Augmentor I",
  [DRONE_AVIONICS_TYPE]: "Drone Avionics",
  [ADVANCED_DRONE_AVIONICS_TYPE]: "Advanced Drone Avionics",
  1230: "Veldspar",
  1231: "Dense Veldspar",
  1224: "Pyroxeres",
  16264: "Blue Ice",
  16262: "Glacial Mass",
  46678: "Brimful Bitumens",
  // A rock whose name is two words, which is what a line typed without a comma
  // has to put back together: "dark" and "ochre" each match this one on their
  // own, so splitting them apart never reached the warning line.
  17425: "Dark Ochre",
  17426: "Dark Ochre II-Grade",
};

// groupID per type, as the SDE carries it: 1230/1224 are ordinary asteroid
// groups, 16264 is the Ice group and 46678 sits in 1922 Rare Moon Asteroids.
const TYPE_GROUPS = {
  1230: 18,
  1231: 18,
  1224: 19,
  16264: 465,
  16262: 465,
  46678: 1922,
  17425: 18,
  17426: 18,
};

const MOON_ORE_TYPE = 46678;
const PYROXERES_TYPE = 1224;
const DENSE_VELDSPAR_TYPE = 1231;

// The item-types table the ore-name catalogue reads, as the server holds it:
// every rock in the game is category 25, and the group it sits in says which
// kind it is. The catalogue only ever reads a filter queue back to the player,
// so the handful of rocks these tests queue is all it needs.
const ORE_TYPE_ROWS = Object.entries(TYPE_NAMES)
  .filter(([typeID]) => TYPE_GROUPS[typeID])
  .map(([typeID, name]) => ({
    typeID: Number(typeID),
    name,
    groupID: TYPE_GROUPS[typeID],
    categoryID: 25,
    groupName: "",
  }));

const TYPE_ATTRIBUTES = {
  [LINK_AUGMENTOR_TYPE]: { 459: 20000 },
  [DRONE_AVIONICS_TYPE]: { 459: 5000 },
  [ADVANCED_DRONE_AVIONICS_TYPE]: { 459: 3000 },
  1373: { 458: 20000 },
};

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function toIntSafe(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function makeConfig(overrides = {}) {
  return {
    ...configModule.DEFAULTS,
    problems: [],
    // The fixtures below drive tiny synthetic timestamps, so the launch delay
    // and the state-replay schedule are switched off here and exercised by
    // their own tests instead.
    postLaunchDelayMs: 0,
    stateRefreshScheduleMs: [],
    ...overrides,
  };
}

// A throwaway players file, so a test never writes into the repository.
function makePlayersFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amd-" + label + "-"));
  return { dir, file: path.join(dir, "advancedUtilityDrones.players.json") };
}

function makeDrone(options) {
  return {
    itemID: options.itemID,
    typeID: options.typeID,
    categoryID: 18,
    controllerID: options.controllerID,
    position: options.position || { x: 0, y: 0, z: 0 },
    radius: 10,
    activityState: options.activityState ?? 0,
    droneCommand: options.droneCommand ?? null,
    droneAssist: null,
    conditionState: options.conditionState || {},
    shieldCapacity: options.shieldCapacity ?? 0,
    armorHP: 0,
    structureHP: 0,
  };
}

function makeRock(itemID, kind, yieldTypeID, distanceMeters, unitVolume = 0.1) {
  return {
    entity: {
      itemID,
      typeID: yieldTypeID,
      categoryID: 25,
      position: { x: distanceMeters, y: 0, z: 0 },
      radius: 0,
    },
    state: {
      entityID: itemID,
      yieldKind: kind,
      yieldTypeID,
      remainingQuantity: 1000,
      unitVolume,
    },
  };
}

// A wreck as the scene holds one: kind "wreck", an item ID, and the owner
// whose loot rights decide whether this pilot may touch it.
function makeWreck(itemID, distanceMeters, ownerID) {
  return {
    itemID,
    typeID: WRECK_TYPE,
    categoryID: 40,
    kind: "wreck",
    ownerID,
    itemName: "Wreck",
    position: { x: distanceMeters, y: 0, z: 0 },
    radius: 0,
  };
}

function salvageSquad(size, controllerID = 1000) {
  const drones = [];
  for (let index = 0; index < size; index += 1) {
    drones.push(makeDrone({
      itemID: 2001 + index,
      typeID: SALVAGE_DRONE_TYPE,
      controllerID,
    }));
  }
  return drones;
}

function makeWorld(options = {}) {
  const shipEntity = {
    itemID: 1000,
    typeID: 28352,
    categoryID: 6,
    kind: "ship",
    ownerID: 7,
    characterID: 7,
    position: { x: 0, y: 0, z: 0 },
    radius: 500,
    mode: "STOP",
    warpState: null,
  };
  const drones = options.drones || [
    makeDrone({ itemID: 2001, typeID: ORE_DRONE_TYPE, controllerID: 1000 }),
    makeDrone({ itemID: 2002, typeID: ICE_DRONE_TYPE, controllerID: 1000 }),
  ];
  const rocks = options.rocks || [
    makeRock(3001, "ore", 1230, 10000),
    makeRock(3002, "ore", 1230, 30000),
    makeRock(3003, "ice", 16264, 8000, 1),
  ];
  // staleRock is present in the scene but missing from the mining cache until
  // something drops the cache; unknownMineableEntities look mineable forever and
  // are never accepted into it. Both exist to exercise the stale-cache rebuild.
  const staleRock = options.staleRock || null;
  const unknownMineableEntities = options.unknownMineableEntities || [];
  const wrecks = options.wrecks || [];
  // A second hull in the same system, for the tests about two pilots sharing a
  // belt: its drones belong to it and its claims must not count against the
  // first ship's.
  const secondShip = options.secondShip
    ? {
        itemID: options.secondShip.itemID,
        typeID: 28352,
        categoryID: 6,
        kind: "ship",
        ownerID: options.secondShip.characterID,
        characterID: options.secondShip.characterID,
        position: { x: 0, y: 0, z: 0 },
        radius: 500,
        mode: "STOP",
        warpState: null,
      }
    : null;
  const entities = new Map();
  entities.set(shipEntity.itemID, shipEntity);
  if (secondShip) {
    entities.set(secondShip.itemID, secondShip);
  }
  for (const drone of drones) {
    entities.set(drone.itemID, drone);
  }
  for (const rock of rocks) {
    entities.set(rock.entity.itemID, rock.entity);
  }
  for (const entity of unknownMineableEntities) {
    entities.set(entity.itemID, entity);
  }
  for (const wreck of wrecks) {
    entities.set(wreck.itemID, wreck);
  }
  if (staleRock) {
    entities.set(staleRock.entity.itemID, staleRock.entity);
  }
  const scene = {
    systemID: 30000142,
    dynamicEntities: new Map(drones.map((drone) => [drone.itemID, drone])),
    droneEntityIDs: new Set(drones.map((drone) => drone.itemID)),
    staticEntities: [
      ...rocks.map((rock) => rock.entity),
      ...unknownMineableEntities,
      ...(staleRock ? [staleRock.entity] : []),
      ...wrecks,
    ],
    getEntityByID: (entityID) => entities.get(Number(entityID)) || null,
  };
  const byEntityID = new Map(rocks.map((rock) => [rock.entity.itemID, rock.state]));
  const miningState = {
    rebuilds: 0,
    isMineableStaticEntity: (entity) => Number(entity && entity.categoryID) === 25,
    ensureSceneMiningState: (sceneRef) => {
      const current = sceneRef ? sceneRef._miningRuntimeState : null;
      if (current && current.byEntityID) {
        return current;
      }
      if (sceneRef && current === null) {
        // A genuine rebuild, after something dropped the scene cache: only now
        // does a rock that spawned late show up in the cache at all.
        miningState.rebuilds += 1;
        if (staleRock) {
          byEntityID.set(staleRock.entity.itemID, staleRock.state);
        }
      }
      const cache = { byEntityID };
      if (sceneRef) {
        sceneRef._miningRuntimeState = cache;
      }
      return cache;
    },
  };

  const calls = { mine: [], returnBay: [], salvage: [], warnings: [] };
  const shipItem = { itemID: 1000, typeID: 28352 };
  const secondShipItem = secondShip
    ? { itemID: secondShip.itemID, typeID: 28352 }
    : null;
  const holdCapacityByFlag = {
    [ORE_HOLD_FLAG]: options.oreHoldCapacity ?? 1000,
    [GENERAL_MINING_HOLD_FLAG]: options.generalMiningHoldCapacity ?? 0,
    [CARGO_HOLD_FLAG]: options.cargoCapacity ?? 500,
  };
  const containerItems = options.containerItems || [];
  const skillMap = new Map([
    [DRONE_AVIONICS_TYPE, { typeID: DRONE_AVIONICS_TYPE, level: options.droneAvionicsLevel ?? 5 }],
    [
      ADVANCED_DRONE_AVIONICS_TYPE,
      { typeID: ADVANCED_DRONE_AVIONICS_TYPE, level: options.advancedDroneAvionicsLevel ?? 5 },
    ],
  ]);
  const fittedItems = options.fittedItems || [
    { itemID: 5001, typeID: LINK_AUGMENTOR_TYPE, flagID: 27 },
    { itemID: 5002, typeID: LINK_AUGMENTOR_TYPE, flagID: 28 },
    { itemID: 5003, typeID: LINK_AUGMENTOR_TYPE, flagID: 29 },
  ];
  const session = { characterID: 7, _space: { systemID: 30000142 } };
  const secondSession = secondShip
    ? { characterID: secondShip.characterID, _space: { systemID: 30000142 } }
    : null;

  const deps = {
    getDroneRuntime: () => ({
      commandMineRepeatedly: (activeSession, droneIDs, targetID) => {
        calls.mine.push({ session: activeSession, droneIDs, targetID });
        return { success: true };
      },
      commandSalvage: (activeSession, droneIDs, targetID) => {
        calls.salvage.push({ session: activeSession, droneIDs, targetID });
        // The drone is deliberately left idle and with no standing order: the
        // tests that care about the per-launch warning list are about the list,
        // not about the drone's own command suppressing a second attempt.
        return { success: true };
      },
      commandReturnBay: (activeSession, droneIDs) => {
        calls.returnBay.push({ session: activeSession, droneIDs });
        return { success: true };
      },
      buildDroneStateNotificationTuple: (entity) => [
        toIntSafe(entity && entity.itemID),
        7,
        toIntSafe(entity && entity.controllerID),
        toIntSafe(entity && entity.activityState),
        toIntSafe(entity && entity.typeID),
        7,
        toIntSafe(entity && entity.targetID) || null,
      ],
      normalizeDroneIDList: (ids) => (
        Array.isArray(ids)
          ? ids.map((value) => Number(value)).filter((value) => value > 0)
          : []
      ),
      _testing: {
        canPlayerCompanionActOnTarget: () => options.canActOnTarget !== false,
        resolveRuntimeSceneForSession: (_space, activeSession) => {
          const characterID = Number(activeSession && activeSession.characterID);
          if (characterID === 7) {
            return scene;
          }
          return secondShip && characterID === secondShip.characterID ? scene : null;
        },
      },
    }),
    // The game's own effect records. They answer for the drone types a test
    // lists, and stay silent for everything else, which leaves the name to
    // decide exactly as it did before the probe existed.
    getDroneDogma: () => ({
      resolveDroneSalvageSnapshot: (droneEntity) => (
        (options.salvageByEffectTypeIDs || []).includes(Number(droneEntity && droneEntity.typeID))
          ? { maxRangeMeters: 20000 }
          : null
      ),
      resolveDroneMiningSnapshot: (droneEntity) => (
        (options.miningByEffectTypeIDs || []).includes(Number(droneEntity && droneEntity.typeID))
          ? { maxRangeMeters: 20000 }
          : null
      ),
      _testing: {
        getControllerDogmaContext: () => ({
          skillMap,
          fittedItems,
          fingerprint: options.fingerprint || "fingerprint-a",
        }),
      },
    }),
    getMiningRuntimeState: () => miningState,
    getMiningInventory: () => ({
      MINING_HOLD_FLAGS: {
        GENERAL_MINING_HOLD: GENERAL_MINING_HOLD_FLAG,
        SPECIALIZED_GAS_HOLD: GAS_HOLD_FLAG,
        SPECIALIZED_ICE_HOLD: ICE_HOLD_FLAG,
        SPECIALIZED_ASTEROID_HOLD: ORE_HOLD_FLAG,
      },
      getShipHoldCapacityByFlag: (resourceState, flagID) => (
        resourceState.holdCapacityByFlag[flagID] || 0
      ),
      getPreferredMiningHoldFlagForType: (_resourceState, itemOrTypeID) => (
        Number(itemOrTypeID) === ICE_YIELD_TYPE ? ICE_HOLD_FLAG : ORE_HOLD_FLAG
      ),
    }),
    getLiveFittingState: () => ({
      buildShipResourceState: () => ({
        cargoCapacity: holdCapacityByFlag[CARGO_HOLD_FLAG],
        holdCapacityByFlag,
      }),
    }),
    getItemTypeRegistry: () => ({
      resolveItemByTypeID: (typeID) => (TYPE_NAMES[typeID]
        ? { typeID, name: TYPE_NAMES[typeID], groupID: TYPE_GROUPS[typeID] || 0 }
        : null),
    }),
    getReferenceData: () => ({
      TABLE: { ITEM_TYPES: "itemTypes" },
      readStaticRows: () => ORE_TYPE_ROWS,
    }),
    // A wreck is salvageable when the scene says it is a wreck; the server's
    // own answer is what the mod defers to, so that is what the stub returns.
    getSalvagerRuntime: () => ({
      isSalvageableTarget: (entity) => Boolean(entity && entity.kind === "wreck"),
    }),
    // The loot path's own question: may this pilot take from this wreck, and
    // would taking it flag them? By default a wreck belongs to whoever owns it,
    // and a wreck that is not the pilot's flags them - which is what makes
    // \"foreign off\" the meaningful default. options.lootAccess replaces the
    // whole answer, which is how the safety-light case is expressed.
    getSpaceLootEntitlement: () => ({
      readSpaceLootInfo: (customInfo) => (customInfo && customInfo.evejsLoot) || {},
      evaluateSpaceLootAccess: (activeSession, source) => {
        if (typeof options.lootAccess === "function") {
          return options.lootAccess(activeSession, source);
        }
        const mine = Number(source && source.ownerID) === 7;
        return {
          success: true,
          entitled: mine,
          requiresSuspectTimer: !mine,
        };
      },
    }),
    // The warning line a salvage run prints goes into local chat; the test
    // records it instead of broadcasting anything.
    getChatRuntime: () => ({
      broadcastLocalMessage: (activeSession, message) => {
        calls.warnings.push({ session: activeSession, message });
        return { entry: { message } };
      },
    }),
    getSessionRegistry: () => ({
      findSessionByCharacterID: (characterID) => {
        const id = Number(characterID);
        if (id === 7) {
          return session;
        }
        return secondShip && id === secondShip.characterID ? secondSession : null;
      },
    }),
    getCharacterState: () => ({
      getActiveShipRecord: () => shipItem,
    }),
    getSpaceRuntime: () => ({}),
    getSimulationInventoryProjection: () => ({
      findItemById: (itemID) => {
        if (Number(itemID) === 1000) {
          return shipItem;
        }
        return secondShipItem && Number(itemID) === secondShipItem.itemID
          ? secondShipItem
          : null;
      },
      listContainerItems: () => containerItems,
    }),
    getItemStore: () => ({ ITEM_FLAGS: { CARGO_HOLD: CARGO_HOLD_FLAG } }),
    getActiveImplantModifiers: () => ({}),
    getAttributeIDByNames: (...names) => {
      for (const name of names) {
        if (name === "droneRangeBonus") return 459;
        if (name === "droneControlDistance") return 458;
      }
      return null;
    },
    getTypeAttributeValue: (typeID, ...names) => {
      const attributes = TYPE_ATTRIBUTES[typeID] || {};
      for (const name of names) {
        if (name === "droneRangeBonus") return attributes[459] ?? null;
        if (name === "droneControlDistance") return attributes[458] ?? null;
      }
      return null;
    },
    buildEffectiveItemAttributeMap: (itemOrTypeID) => {
      const typeID = itemOrTypeID && typeof itemOrTypeID === "object"
        ? itemOrTypeID.typeID
        : itemOrTypeID;
      return { ...(TYPE_ATTRIBUTES[typeID] || {}) };
    },
    isEffectivelyOnlineModule: () => true,
    getControllerDogmaContext: () => ({
      skillMap,
      fittedItems,
      fingerprint: options.fingerprint || "fingerprint-a",
    }),
    getActiveImplants: () => options.implants || [],
    getActiveBoosters: () => [],
  };

  return {
    scene, deps, calls, shipEntity, drones, rocks, wrecks, session, miningState,
    containerItems, shipItem, secondShip, secondSession,
  };
}

test("control range adds skill, module and implant bonuses onto the 20 km base", () => {
  const world = makeWorld({ implants: [{ typeID: LINK_AUGMENTOR_TYPE }] });
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps });
  const range = runtime.controlRange.resolve(world.shipEntity, 7);
  assert.equal(range.rangeMeters, 120000 + 20000);
  assert.equal(range.breakdown.base, 20000);
  assert.equal(range.breakdown.skills, 40000);
  assert.equal(range.breakdown.modules, 60000);
  assert.equal(range.breakdown.implants, 20000);

  // The reference hull: a Rorqual at all-V with three Drone Link Augmentors and
  // no implant resolves to the 120 km the client shows.
  const bare = makeWorld();
  const bareRange = createRuntime({ config: makeConfig(), deps: bare.deps })
    .controlRange.resolve(bare.shipEntity, 7);
  assert.equal(bareRange.rangeMeters, 120000);
});

test("a rock that spawned after the scene cache was built is mined, once rebuilt", () => {
  const staleRock = makeRock(3009, "ore", 1230, 9000);
  const world = makeWorld({
    rocks: [],
    staleRock,
    drones: [makeDrone({ itemID: 2001, typeID: ORE_DRONE_TYPE, controllerID: 1000 })],
  });
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps });
  runtime.onSceneTick(world.scene, 1000);
  assert.equal(world.miningState.rebuilds, 1, "the stale cache must be rebuilt exactly once");
  assert.deepEqual(world.calls.mine.map((call) => call.targetID), [3009]);
  runtime.onSceneTick(world.scene, 2000);
  assert.equal(world.miningState.rebuilds, 1, "a rebuilt cache must not be rebuilt again");
});

test("a permanently unknown mineable entity costs one rebuild, not one per scan", () => {
  const world = makeWorld({
    rocks: [],
    unknownMineableEntities: [
      { itemID: 3010, typeID: 1230, categoryID: 25, position: { x: 5000, y: 0, z: 0 }, radius: 0 },
    ],
    drones: [makeDrone({ itemID: 2001, typeID: ORE_DRONE_TYPE, controllerID: 1000 })],
  });
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps });
  runtime.onSceneTick(world.scene, 1000);
  runtime.onSceneTick(world.scene, 2000);
  runtime.onSceneTick(world.scene, 3000);
  assert.equal(world.miningState.rebuilds, 1);
  assert.equal(world.calls.mine.length, 0);
});

test("the stale-cache rebuild can be switched off", () => {
  const world = makeWorld({
    rocks: [],
    staleRock: makeRock(3009, "ore", 1230, 9000),
    drones: [makeDrone({ itemID: 2001, typeID: ORE_DRONE_TYPE, controllerID: 1000 })],
  });
  const runtime = createRuntime({
    config: makeConfig({ refreshStaleSceneCache: false }),
    deps: world.deps,
  });
  runtime.onSceneTick(world.scene, 1000);
  assert.equal(world.miningState.rebuilds, 0);
  assert.equal(world.calls.mine.length, 0);
});

test("fixed range mode ignores ship attributes", () => {
  const world = makeWorld();
  const runtime = createRuntime({
    config: makeConfig({ rangeMode: "fixed", rangeMeters: 25000 }),
    deps: world.deps,
  });
  const range = runtime.controlRange.resolve(world.shipEntity, 7);
  assert.equal(range.rangeMeters, 25000);
  assert.equal(range.breakdown.mode, "fixed");
});

test("idle mining drones are auto-assigned inside the control range only", () => {
  const world = makeWorld();
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps });
  runtime.onSceneTick(world.scene, 1000);
  assert.equal(world.calls.mine.length, 2);
  const byDrone = new Map(world.calls.mine.map((call) => [call.droneIDs[0], call.targetID]));
  assert.equal(byDrone.get(2001), 3001);
  assert.equal(byDrone.get(2002), 3003);
  assert.equal(byDrone.has(2003), false);
});

test("a drone already ordered to mine is left alone", () => {
  const world = makeWorld({
    drones: [
      makeDrone({
        itemID: 2001,
        typeID: ORE_DRONE_TYPE,
        controllerID: 1000,
        droneCommand: "MINE",
        activityState: 2,
      }),
    ],
  });
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps });
  runtime.onSceneTick(world.scene, 1000);
  assert.equal(world.calls.mine.length, 0);
});

test("spread mode claims a second rock, focus mode stacks on the first", () => {
  const drones = [
    makeDrone({ itemID: 2001, typeID: ORE_DRONE_TYPE, controllerID: 1000 }),
    makeDrone({ itemID: 2002, typeID: ORE_DRONE_TYPE, controllerID: 1000 }),
  ];
  const rocks = [
    makeRock(3001, "ore", 1230, 10000),
    makeRock(3002, "ore", 1230, 11000),
  ];
  const spread = makeWorld({ drones, rocks });
  const spreadRuntime = createRuntime({
    config: makeConfig({ targetMode: "spread", claimPenaltyMeters: 15000 }),
    deps: spread.deps,
  });
  spreadRuntime.onSceneTick(spread.scene, 1000);
  assert.deepEqual(
    spread.calls.mine.map((call) => call.targetID).sort(),
    [3001, 3002],
  );

  const focus = makeWorld({ drones, rocks });
  const focusRuntime = createRuntime({
    config: makeConfig({ targetMode: "focus" }),
    deps: focus.deps,
  });
  focusRuntime.onSceneTick(focus.scene, 1000);
  assert.deepEqual(focus.calls.mine.map((call) => call.targetID), [3001, 3001]);
});

test("a full mining hold recalls the drones instead of assigning them", () => {
  const world = makeWorld({
    oreHoldCapacity: 1000,
    cargoCapacity: 0,
    containerItems: [{ flagID: ORE_HOLD_FLAG, volume: 1000, quantity: 1 }],
  });
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps });
  runtime.onSceneTick(world.scene, 1000);
  assert.equal(world.calls.mine.length, 0);
  assert.equal(world.calls.returnBay.length, 1);
  assert.deepEqual(world.calls.returnBay[0].droneIDs.sort(), [2001, 2002]);
});

test("a full ore hold spills into the general mining hold before recalling", () => {
  const world = makeWorld({
    oreHoldCapacity: 1000,
    generalMiningHoldCapacity: 5000,
    containerItems: [{ flagID: ORE_HOLD_FLAG, volume: 1000, quantity: 1 }],
  });
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps });
  runtime.onSceneTick(world.scene, 1000);
  assert.equal(world.calls.returnBay.length, 0);
  assert.equal(world.calls.mine.length, 2);
});

test("a drone that takes damage is recalled", () => {
  const drones = [
    makeDrone({
      itemID: 2001,
      typeID: ORE_DRONE_TYPE,
      controllerID: 1000,
      shieldCapacity: 100,
      conditionState: { shieldCharge: 1 },
    }),
  ];
  const world = makeWorld({ drones });
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps });
  runtime.onSceneTick(world.scene, 1000);
  assert.equal(world.calls.mine.length, 1);
  drones[0].conditionState = { shieldCharge: 0.4 };
  runtime.onSceneTick(world.scene, 2000);
  assert.equal(world.calls.returnBay.length, 1);
  assert.deepEqual(world.calls.returnBay[0].droneIDs, [2001]);
});

test("recalled drones are not re-tasked while they fly home", () => {
  const drones = [
    makeDrone({
      itemID: 2001,
      typeID: ORE_DRONE_TYPE,
      controllerID: 1000,
      shieldCapacity: 100,
      conditionState: { shieldCharge: 1 },
    }),
  ];
  const world = makeWorld({ drones });
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps });
  runtime.onSceneTick(world.scene, 1000);
  drones[0].conditionState = { shieldCharge: 0.5 };
  runtime.onSceneTick(world.scene, 2000);
  const minesBefore = world.calls.mine.length;
  runtime.onSceneTick(world.scene, 3000);
  runtime.onSceneTick(world.scene, 4000);
  assert.equal(world.calls.mine.length, minesBefore);
});

test("scan interval throttles the scene pass", () => {
  const world = makeWorld({
    drones: [makeDrone({ itemID: 2001, typeID: ORE_DRONE_TYPE, controllerID: 1000 })],
  });
  const runtime = createRuntime({
    config: makeConfig({ scanIntervalMs: 500 }),
    deps: world.deps,
  });
  runtime.onSceneTick(world.scene, 1000);
  runtime.onSceneTick(world.scene, 1100);
  assert.equal(world.calls.mine.length, 1);
  runtime.onSceneTick(world.scene, 1600);
  assert.equal(world.calls.mine.length, 2);
});

test("a player can switch automation off", () => {
  const world = makeWorld({
    drones: [makeDrone({ itemID: 2001, typeID: ORE_DRONE_TYPE, controllerID: 1000 })],
  });
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps });
  runtime.setPlayerEnabled(7, false);
  runtime.onSceneTick(world.scene, 1000);
  assert.equal(world.calls.mine.length, 0);
});

test("the chat overlay answers on /aud m and toggles the player state", () => {
  const world = makeWorld({
    drones: [makeDrone({ itemID: 2001, typeID: ORE_DRONE_TYPE, controllerID: 1000 })],
  });
  const config = makeConfig();
  const runtime = createRuntime({ config, deps: world.deps });
  const sent = [];
  const upstream = {
    AVAILABLE_SLASH_COMMANDS: [],
    COMMANDS_HELP_TEXT: "Commands:",
    executeChatCommand: () => ({ handled: false }),
  };
  chatCommand.install(upstream, { runtime, config });
  assert.ok(upstream.AVAILABLE_SLASH_COMMANDS.includes("aud"));
  assert.ok(!upstream.AVAILABLE_SLASH_COMMANDS.includes("altmining"),
    "the mod answers to one name now");
  assert.ok(!upstream.AVAILABLE_SLASH_COMMANDS.includes("advancedutilitydrones"),
    "the long spelling is gone");
  assert.ok(upstream.COMMANDS_HELP_TEXT.includes("/aud m"));
  assert.ok(upstream.COMMANDS_HELP_TEXT.includes("/aud s"),
    "the client's /help lists both menus");
  const chatHub = {
    sendSystemMessage: (session, message) => sent.push(message),
  };
  const off = upstream.executeChatCommand(world.session, "/aud m off", chatHub, {});
  assert.equal(off.handled, true);
  assert.equal(sent.length, 1);
  assert.equal(runtime.playerStateSnapshot(7).enabled, false);
  const untouched = upstream.executeChatCommand(world.session, "/help", chatHub, {});
  assert.deepEqual(untouched, { handled: false });
  const status = upstream.executeChatCommand(world.session, "/aud m status", chatHub, {});
  assert.match(status.message, /AdvancedUtilityDrones v/);
});

test("the chat overlay answers on the dot prefix used by non-staff clients", () => {
  const world = makeWorld({
    drones: [makeDrone({ itemID: 2001, typeID: ORE_DRONE_TYPE, controllerID: 1000 })],
  });
  const config = makeConfig();
  const runtime = createRuntime({ config, deps: world.deps });
  const upstream = {
    AVAILABLE_SLASH_COMMANDS: [],
    COMMANDS_HELP_TEXT: "Commands:",
    executeChatCommand: () => ({ handled: false }),
  };
  chatCommand.install(upstream, { runtime, config });

  // Chat bodies reach the server through the XMPP handler with chatHub=null
  // and emitChatFeedback=false; the returned message is what gets pushed back
  // to the player, so it has to survive this path.
  const viaChatBody = upstream.executeChatCommand(
    world.session,
    ".aud m range",
    null,
    { emitChatFeedback: false },
  );
  assert.equal(viaChatBody.handled, true);
  assert.match(viaChatBody.message, /search radius/);

  const sent = [];
  const chatHub = { sendSystemMessage: (session, message) => sent.push(message) };
  const on = upstream.executeChatCommand(world.session, ".aud m on", chatHub, {});
  assert.equal(on.handled, true);
  assert.equal(sent.length, 1);
  assert.equal(runtime.playerStateSnapshot(7).enabled, true);

  const other = upstream.executeChatCommand(world.session, ".help", chatHub, {});
  assert.deepEqual(other, { handled: false });
});

test("configuration parsing validates ranges and modes", () => {
  const config = configModule.load(path.join(__dirname, ".."), {
    EVEJS_ADVANCED_UTILITY_DRONES_RANGE_MODE: "fixed",
    EVEJS_ADVANCED_UTILITY_DRONES_RANGE_METERS: "45000",
    EVEJS_ADVANCED_UTILITY_DRONES_TARGET_MODE: "focus",
    EVEJS_ADVANCED_UTILITY_DRONES_SCAN_INTERVAL_MS: "250",
  });
  assert.equal(config.rangeMode, "fixed");
  assert.equal(config.rangeMeters, 45000);
  assert.equal(config.targetMode, "focus");
  assert.equal(config.scanIntervalMs, 250);
  assert.deepEqual(config.problems, []);

  const broken = configModule.load(path.join(__dirname, ".."), {
    EVEJS_ADVANCED_UTILITY_DRONES_RANGE_MODE: "fixed",
    EVEJS_ADVANCED_UTILITY_DRONES_TARGET_MODE: "sideways",
    EVEJS_ADVANCED_UTILITY_DRONES_SCAN_INTERVAL_MS: "10",
  });
  assert.equal(broken.problems.length, 3);
});

test("the loader wraps tickScene through Module._load and overrides chat", () => {
  const Module = require("node:module");
  const fs = require("node:fs");
  const os = require("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "advancedUtilityDrones-"));
  const write = (relative, body) => {
    const target = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, "utf8");
    return target;
  };
  const droneRuntimePath = write(
    "server/src/services/drone/droneRuntime.js",
    [
      "\"use strict\";",
      "const calls = [];",
      "module.exports = {",
      "  calls,",
      "  tickScene(scene, now) { calls.push({ scene, now }); return \"tick-result\"; },",
      "  launchDronesForSession(session) { calls.push({ launch: session }); return { ok: true }; },",
      "  commandMineRepeatedly(session, droneIDs, targetID) {",
      "    calls.push({ mine: droneIDs, targetID }); return { ok: true };",
      "  },",
      "  commandReturnBay(session, droneIDs) { calls.push({ returnBay: droneIDs }); return { ok: true }; },",
      "  buildDroneStateNotificationTuple(entity) {",
      "    return [entity.itemID, 7, entity.controllerID, entity.activityState, entity.typeID, 7, null];",
      "  },",
      "  normalizeDroneIDList(ids) { return Array.isArray(ids) ? ids : []; },",
      "  _testing: {",
      "    canPlayerCompanionActOnTarget: () => true,",
      "    resolveRuntimeSceneForSession: (_space, session) => session._scene || null,",
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  const chatCommandsPath = write(
    "server/src/services/chat/chatCommands.js",
    [
      "\"use strict\";",
      "const AVAILABLE_SLASH_COMMANDS = [\"help\"];",
      "const COMMANDS_HELP_TEXT = [\"Commands:\", \"/help\"].join(\"\\n\");",
      "function executeChatCommand() { return { handled: false }; }",
      "module.exports = { AVAILABLE_SLASH_COMMANDS, COMMANDS_HELP_TEXT, executeChatCommand };",
      "",
    ].join("\n"),
  );

  const chatRuntimePath = write(
    "server/src/_secondary/chat/chatRuntime.js",
    [
      "\"use strict\";",
      "const calls = [];",
      "module.exports = {",
      "  calls,",
      "  broadcastLocalMessage(session, message) {",
      "    calls.push(message);",
      "    return { entry: { message, createdAtMs: 1 } };",
      "  },",
      "  sendChannelMessage(session, roomName, message) {",
      "    calls.push(roomName + \":\" + message);",
      "    return { entry: { message, createdAtMs: 1 } };",
      "  },",
      "};",
      "",
    ].join("\n"),
  );

  write(
    "config/advancedUtilityDrones.json",
    JSON.stringify({ postLaunchDelayMs: 0 }, null, 2),
  );

  const world = makeWorld();
  const notifications = [];
  world.session.sendNotification = (...args) => notifications.push(args);
  world.session._scene = world.scene;
  const previousInstallFlag = globalThis[loaderModule.INSTALL_FLAG];
  const previousApi = globalThis[loaderModule.API_SYMBOL];
  delete globalThis[loaderModule.INSTALL_FLAG];
  delete globalThis[loaderModule.API_SYMBOL];
  // The mod talks to the same module object the client's RPCs reach, so the
  // re-entrancy guard has to survive a real round trip through the wrapper.
  const state = loaderModule.install({
    runtimeRoot: root,
    deps: { ...world.deps, getDroneRuntime: () => require(droneRuntimePath) },
    environment: {},
  });
  try {
    assert.equal(state.active, true);
    const droneRuntime = require(droneRuntimePath);
    assert.equal(droneRuntime.tickScene(world.scene, 4242), "tick-result");
    assert.equal(
      droneRuntime.calls.filter((entry) => entry.scene).length,
      1,
      "the vendor tick must still run",
    );
    assert.equal(
      droneRuntime.calls.filter((entry) => entry.mine).length,
      2,
      "the wrapped tick must auto-assign idle drones",
    );
    droneRuntime.tickScene(world.scene, 5242);
    assert.ok(
      notifications.some(([name]) => name === "OnDroneStateChange"),
      "the wrapped tick must replay the drone state so the client cannot go stale",
    );

    // A player order parks the drone; the mod's own order must not.
    const drone1 = world.scene.dynamicEntities.get(2001);
    const drone2 = world.scene.dynamicEntities.get(2002);
    droneRuntime.commandReturnBay(world.session, [2001]);
    assert.ok(
      drone1.advancedUtilityDronesPlayerParkedAtMs > 0,
      "a manual order must be seen as a takeover",
    );
    drone2.advancedUtilityDronesPlayerParkedAtMs = 0;
    commandScope.run(() => droneRuntime.commandReturnBay(world.session, [2002]));
    assert.equal(
      drone2.advancedUtilityDronesPlayerParkedAtMs,
      0,
      "the mod's own recall must not look like a takeover",
    );

    // Launching again hands the drone back to the automation.
    droneRuntime.launchDronesForSession(world.session, []);
    assert.equal(drone1.advancedUtilityDronesPlayerParkedAtMs, 0);
    assert.ok(droneRuntime.calls.some((entry) => entry.launch));

    const chatCommands = require(chatCommandsPath);
    assert.ok(chatCommands.AVAILABLE_SLASH_COMMANDS.includes("aud"));
    assert.ok(!chatCommands.AVAILABLE_SLASH_COMMANDS.includes("advancedutilitydrones"),
      "the long spelling is gone");
    const sent = [];
    const result = chatCommands.executeChatCommand(
      world.session,
      "/aud m focus",
      { sendSystemMessage: (session, message) => sent.push(message) },
      {},
    );
    assert.equal(result.handled, true);
    assert.equal(sent.length, 1);

    // The ordinary-chat path: a line without a leading "/" is broadcast by
    // xmppStubServer rather than dispatched as a slash command, so the trigger
    // is consumed on the broadcaster and the reply travels back as the thrown
    // error's message.
    const chatRuntime = require(chatRuntimePath);
    assert.throws(
      () => chatRuntime.broadcastLocalMessage(world.session, "!aud spread"),
      (error) => /^AdvancedUtilityDrones/.test(error.message),
    );
    assert.equal(chatRuntime.calls.length, 0, "the trigger must never be broadcast");
    chatRuntime.broadcastLocalMessage(world.session, "hello belt");
    assert.deepStrictEqual(chatRuntime.calls, ["hello belt"]);
    assert.deepStrictEqual(
      state.api.applied().sort(),
      ["chatCommands", "chatRuntime", "droneRuntime"],
    );
  } finally {
    Module._load = state.previousLoad;
    delete globalThis[loaderModule.INSTALL_FLAG];
    delete globalThis[loaderModule.API_SYMBOL];
    if (previousInstallFlag !== undefined) globalThis[loaderModule.INSTALL_FLAG] = previousInstallFlag;
    if (previousApi !== undefined) globalThis[loaderModule.API_SYMBOL] = previousApi;
    delete require.cache[require.resolve(droneRuntimePath)];
    delete require.cache[require.resolve(chatCommandsPath)];
    delete require.cache[require.resolve(chatRuntimePath)];
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the loader installs the tick hook only once", () => {
  const world = makeWorld();
  const store = makePlayersFile("loader-once");
  const players = playerSettings.createPlayerStore({ file: store.file });
  delete globalThis[loaderModule.INSTALL_FLAG];
  delete globalThis[loaderModule.API_SYMBOL];
  const options = { runtimeRoot: modDir, deps: world.deps, environment: {}, players };
  const first = loaderModule.install(options);
  const second = loaderModule.install(options);
  try {
    assert.equal(first, second, "a second install must return the first one unchanged");
  } finally {
    require("node:module")._load = first.previousLoad;
    delete globalThis[loaderModule.INSTALL_FLAG];
    delete globalThis[loaderModule.API_SYMBOL];
    fs.rmSync(store.dir, { recursive: true, force: true });
  }
});

test("an invalid configuration leaves the loader inert", () => {
  delete globalThis[loaderModule.INSTALL_FLAG];
  const state = loaderModule.install({
    runtimeRoot: modDir,
    environment: { EVEJS_ADVANCED_UTILITY_DRONES_RANGE_MODE: "sideways" },
  });
  assert.equal(state.active, false);
  assert.equal(state.reason, "invalid-config");
  assert.equal(globalThis[loaderModule.INSTALL_FLAG], undefined);
});

test("a short key in the JSON config reaches the same setting as the long one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amd-config-"));
  const configPath = path.join(dir, "advancedUtilityDrones.json");
  fs.writeFileSync(configPath, JSON.stringify({
    verbose: true,
    targetMode: "focus",
    minHoldFreeVolumeM3: 1,
    scanIntervalMs: 900,
  }), "utf8");
  const short = configModule.load(modDir, {}, { runtimeRoot: dir, configPath });
  assert.equal(short.verbose, true);
  assert.equal(short.targetMode, "focus");
  assert.equal(short.minHoldFreeVolumeM3, 1);
  assert.equal(short.scanIntervalMs, 900);
  assert.deepEqual(short.problems, []);
  assert.ok(short.playersFilename.endsWith("advancedUtilityDrones.players.json"));

  fs.writeFileSync(configPath, JSON.stringify({
    EVEJS_ADVANCED_UTILITY_DRONES_VERBOSE: "false",
    EVEJS_ADVANCED_UTILITY_DRONES_TARGET_MODE: "spread",
  }), "utf8");
  const long = configModule.load(modDir, {}, { runtimeRoot: dir, configPath });
  assert.equal(long.verbose, false);
  assert.equal(long.targetMode, "spread");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a character's choices are persisted and override the server defaults", () => {
  const store = makePlayersFile("players");
  const players = playerSettings.createPlayerStore({ file: store.file });
  const world = makeWorld({
    drones: [makeDrone({ itemID: 2001, typeID: ORE_DRONE_TYPE, controllerID: 1000 })],
  });
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps, players });
  runtime.setPlayerTargetMode(7, "focus");
  runtime.setPlayerMinHoldFreeVolume(7, 1);
  runtime.setPlayerControlPolicy(7, "recall");
  const mine = runtime.getPlayerState(7);
  assert.equal(mine.targetMode, "focus");
  assert.equal(mine.minHoldFreeVolumeM3, 1);
  assert.equal(mine.playerControlPolicy, "recall");
  assert.equal(mine.source, "player");

  const reopened = playerSettings.createPlayerStore({ file: store.file });
  const restarted = createRuntime({ config: makeConfig(), deps: world.deps, players: reopened });
  assert.equal(restarted.getPlayerState(7).minHoldFreeVolumeM3, 1);
  const untouched = restarted.getPlayerState(8);
  assert.equal(untouched.source, "config");
  fs.rmSync(store.dir, { recursive: true, force: true });
});

test("the hull's own mining bay decides when the drones come home", () => {
  const occupied = [{ flagID: ORE_HOLD_FLAG, volume: 1000, quantity: 1 }];
  const mining = makeWorld({
    oreHoldCapacity: 1000,
    cargoCapacity: 500,
    containerItems: occupied,
  });
  const miningRuntime = createRuntime({ config: makeConfig(), deps: mining.deps });
  miningRuntime.onSceneTick(mining.scene, 1000);
  assert.equal(mining.calls.mine.length, 0, "a full mining bay must not be mined into");
  assert.equal(mining.calls.returnBay.length, 1);
});

test("room in the ordinary cargo hold never keeps a mining hull working", () => {
  // The ore bay is down to its last sliver, so the server - which takes the
  // first bay with any room at all and then abandons a cycle it cannot fit a
  // whole unit into - never reaches the cargo hold behind it. Even with the
  // margin switched off the drones must come home instead of mining into a bay
  // that cannot take the yield.
  const world = makeWorld({
    oreHoldCapacity: 100,
    cargoCapacity: 500,
    containerItems: [{ flagID: ORE_HOLD_FLAG, volume: 99.95, quantity: 1 }],
    drones: [makeDrone({ itemID: 2001, typeID: ORE_DRONE_TYPE, controllerID: 1000 })],
  });
  const runtime = createRuntime({
    config: makeConfig({ minHoldFreeVolumeM3: 0 }),
    deps: world.deps,
  });
  runtime.onSceneTick(world.scene, 1000);
  assert.equal(world.calls.mine.length, 0);
  assert.equal(world.calls.returnBay.length, 1);
  const status = runtime.describeStatus(world.session);
  assert.equal(status.stats.lastRecallReason, "no room for a whole unit");
  assert.deepEqual(status.hold.bays.map((bay) => bay.flagID), [ORE_HOLD_FLAG]);
});

test("a hull without a mining bay is judged on its cargo hold", () => {
  const emptyCargo = makeWorld({
    oreHoldCapacity: 0,
    cargoCapacity: 500,
    containerItems: [{ flagID: CARGO_HOLD_FLAG, volume: 100, quantity: 1 }],
    drones: [makeDrone({ itemID: 2001, typeID: ORE_DRONE_TYPE, controllerID: 1000 })],
  });
  const working = createRuntime({ config: makeConfig(), deps: emptyCargo.deps });
  working.onSceneTick(emptyCargo.scene, 1000);
  assert.equal(emptyCargo.calls.mine.length, 1);
  assert.equal(emptyCargo.calls.returnBay.length, 0);

  const fullCargo = makeWorld({
    oreHoldCapacity: 0,
    cargoCapacity: 500,
    containerItems: [{ flagID: CARGO_HOLD_FLAG, volume: 500, quantity: 1 }],
    drones: [makeDrone({ itemID: 2001, typeID: ORE_DRONE_TYPE, controllerID: 1000 })],
  });
  const stopped = createRuntime({ config: makeConfig(), deps: fullCargo.deps });
  stopped.onSceneTick(fullCargo.scene, 1000);
  assert.equal(fullCargo.calls.mine.length, 0);
  assert.equal(fullCargo.calls.returnBay.length, 1);
});

test("a bay that is nearly full stops the drones at the configured threshold", () => {
  const nearlyFull = [{ flagID: ORE_HOLD_FLAG, volume: 99.5, quantity: 1 }];
  const world = makeWorld({
    oreHoldCapacity: 100,
    cargoCapacity: 0,
    containerItems: nearlyFull,
    drones: [makeDrone({ itemID: 2001, typeID: ORE_DRONE_TYPE, controllerID: 1000 })],
  });
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps });
  runtime.onSceneTick(world.scene, 1000);
  assert.equal(world.calls.mine.length, 0);
  assert.equal(world.calls.returnBay.length, 1);
  assert.equal(runtime.describeStatus(world.session).stats.lastRecallReason, "hold nearly full");

  const tight = makeWorld({
    oreHoldCapacity: 100,
    cargoCapacity: 0,
    containerItems: [{ flagID: ORE_HOLD_FLAG, volume: 99.5, quantity: 1 }],
    drones: [makeDrone({ itemID: 2001, typeID: ORE_DRONE_TYPE, controllerID: 1000 })],
  });
  const store = makePlayersFile("threshold");
  const players = playerSettings.createPlayerStore({ file: store.file });
  players.set(7, { minHoldFreeVolumeM3: 0.2 });
  const tightRuntime = createRuntime({ config: makeConfig(), deps: tight.deps, players });
  tightRuntime.onSceneTick(tight.scene, 1000);
  assert.equal(tight.calls.returnBay.length, 0, "a smaller threshold keeps the drones working");
  assert.equal(tight.calls.mine.length, 1);
  fs.rmSync(store.dir, { recursive: true, force: true });
});

test("an order that puts nothing in the bay parks the drone instead of looping", () => {
  const items = [{ flagID: ORE_HOLD_FLAG, volume: 0, quantity: 1 }];
  const world = makeWorld({
    oreHoldCapacity: 1000,
    cargoCapacity: 0,
    containerItems: items,
    drones: [makeDrone({ itemID: 2001, typeID: ORE_DRONE_TYPE, controllerID: 1000 })],
  });
  const runtime = createRuntime({
    config: makeConfig({ maxStalledReassignments: 2 }),
    deps: world.deps,
  });
  runtime.onSceneTick(world.scene, 1000);
  assert.equal(world.calls.mine.length, 1);
  runtime.onSceneTick(world.scene, 17000);
  assert.equal(world.calls.mine.length, 2, "the probe window has to expire before it counts");
  runtime.onSceneTick(world.scene, 33000);
  assert.equal(world.calls.mine.length, 2, "a fruitless drone is not ordered again");
  assert.equal(world.calls.returnBay.length, 1);
  assert.equal(runtime.describeStatus(world.session).stats.stalls, 1);
});

test("an order that does deliver ore clears the stall counter", () => {
  const items = [{ flagID: ORE_HOLD_FLAG, volume: 0, quantity: 1 }];
  const world = makeWorld({
    oreHoldCapacity: 1000,
    cargoCapacity: 0,
    containerItems: items,
    drones: [makeDrone({ itemID: 2001, typeID: ORE_DRONE_TYPE, controllerID: 1000 })],
  });
  const runtime = createRuntime({
    config: makeConfig({ maxStalledReassignments: 2 }),
    deps: world.deps,
  });
  runtime.onSceneTick(world.scene, 1000);
  items[0].volume = 5;
  runtime.onSceneTick(world.scene, 17000);
  runtime.onSceneTick(world.scene, 33000);
  assert.equal(world.calls.mine.length, 3, "delivered ore keeps the drone working");
  assert.equal(world.calls.returnBay.length, 0);
  assert.equal(runtime.describeStatus(world.session).stats.stalls, 0);
});

test("a manual order parks the drones until they are launched again", () => {
  const world = makeWorld({
    drones: [
      makeDrone({ itemID: 2001, typeID: ORE_DRONE_TYPE, controllerID: 1000 }),
      makeDrone({ itemID: 2002, typeID: ORE_DRONE_TYPE, controllerID: 1000 }),
    ],
  });
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps });
  runtime.onSceneTick(world.scene, 1000);
  assert.equal(world.calls.mine.length, 2);
  world.calls.mine.length = 0;
  assert.equal(runtime._testing.notePlayerCommand("returnHome", world.session, [2001]), 1);
  runtime.onSceneTick(world.scene, 2000);
  assert.deepEqual(world.calls.mine.map((call) => call.droneIDs[0]), [2002]);
  assert.equal(runtime.resumeDrones(world.session), 1);
  world.calls.mine.length = 0;
  runtime.onSceneTick(world.scene, 3000);
  assert.deepEqual(world.calls.mine.map((call) => call.droneIDs[0]), [2001, 2002]);
});

test("the player-control policy decides which manual orders park a drone", () => {
  const world = makeWorld({
    drones: [makeDrone({ itemID: 2001, typeID: ORE_DRONE_TYPE, controllerID: 1000 })],
  });
  const store = makePlayersFile("control");
  const players = playerSettings.createPlayerStore({ file: store.file });
  players.set(7, { playerControlPolicy: "recall" });
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps, players });
  assert.equal(
    runtime._testing.notePlayerCommand("commandMineRepeatedly", world.session, [2001]),
    0,
    "an ordinary order is not a takeover under the recall policy",
  );
  assert.equal(runtime._testing.notePlayerCommand("returnBay", world.session, [2001]), 1);
  world.scene.dynamicEntities.get(2001).advancedUtilityDronesPlayerParkedAtMs = 0;
  players.set(7, { playerControlPolicy: "off" });
  assert.equal(runtime._testing.notePlayerCommand("returnHome", world.session, [2001]), 0);
  fs.rmSync(store.dir, { recursive: true, force: true });
});

test("a launched drone's state is replayed until it reports mining", () => {
  const world = makeWorld({
    drones: [makeDrone({ itemID: 2001, typeID: ORE_DRONE_TYPE, controllerID: 1000 })],
  });
  const sent = [];
  world.session.sendNotification = (...args) => sent.push(args);
  const runtime = createRuntime({
    config: makeConfig({ stateRefreshScheduleMs: [0, 1000] }),
    deps: world.deps,
  });
  runtime.onSceneTick(world.scene, 1000);
  assert.equal(world.calls.mine.length, 1);
  assert.equal(sent.length, 0, "the schedule starts with the order, not before it");
  runtime.onSceneTick(world.scene, 2000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], "OnDroneStateChange");
  assert.equal(sent[0][2][0], 2001);
  world.drones[0].activityState = 2;
  world.drones[0].droneCommand = "MINE";
  runtime.onSceneTick(world.scene, 3000);
  assert.equal(sent.length, 1, "once the server reports mining the replay stops");
});

test("a plain chat line drives the mod so a character without staff rights can use it", () => {
  const world = makeWorld();
  const config = makeConfig();
  const runtime = createRuntime({ config, deps: world.deps });
  const broadcast = [];
  const upstream = {
    broadcastLocalMessage(session, message) {
      broadcast.push(message);
      return { entry: { message } };
    },
    sendChannelMessage(session, roomName, message) {
      broadcast.push(roomName + ":" + message);
      return { entry: { message } };
    },
  };
  plainChat.install(upstream, { runtime, config, chatCommand });

  // The reply is the thrown error: xmppStubServer catches it and sends
  // error.message back to the sender alone, so the line never reaches anybody
  // else. Throwing is the reply, not a failure.
  assert.throws(
    () => upstream.broadcastLocalMessage(world.session, "!aud m focus"),
    (error) => /^AdvancedUtilityDrones/.test(error.message),
  );
  assert.equal(broadcast.length, 0, "the trigger must never be broadcast");
  assert.equal(runtime.getPlayerState(7).targetMode, "focus");

  // The same command with no kind answers with the two menus, and changes
  // nothing.
  assert.throws(
    () => upstream.broadcastLocalMessage(world.session, "!aud"),
    (error) => /pick the drones to control/.test(error.message),
  );
  assert.equal(runtime.getPlayerState(7).targetMode, "focus");

  // "!amd" is not this mod's spelling any more: the abbreviation is claimed by
  // other mods on a shared server, so the line has to reach the channel intact
  // instead of being swallowed here.
  upstream.sendChannelMessage(world.session, "corp.1", "!amd on");
  assert.deepStrictEqual(broadcast, ["corp.1:!amd on"], "!amd is ordinary chat now");

  // Somebody else's line is passed straight through, in either channel.
  upstream.broadcastLocalMessage(world.session, "!hello there");
  upstream.sendChannelMessage(world.session, "corp.1", "hello corp");
  assert.deepStrictEqual(broadcast, ["corp.1:!amd on", "!hello there", "corp.1:hello corp"]);
});

test("the plain-chat trigger only answers its own name, and only when it is enabled", () => {
  const config = makeConfig();
  assert.equal(chatCommand.matchTrigger("!aud", config), "");
  assert.equal(chatCommand.matchTrigger("!aud m off", config), "m off");
  assert.equal(chatCommand.matchTrigger("!aud s foreign warn", config), "s foreign warn");
  assert.equal(chatCommand.matchTrigger("!amd   spread", config), null,
    "the amd abbreviation is not this mod's spelling any more");
  assert.equal(chatCommand.matchTrigger("!/aud m status", config), null);
  assert.equal(chatCommand.matchTrigger("!hello there", config), null);
  // The retired names are matched so the rename notice can be printed, and the
  // name is kept in front of the reply so the router knows which one was typed.
  assert.equal(chatCommand.matchTrigger("!atm off", config), "atm off");
  assert.equal(chatCommand.matchTrigger("!altmining focus", config), "altmining focus");
  // A slash or dot line is the slash.SlashCmd path, and must not be consumed twice.
  assert.equal(chatCommand.matchTrigger("/aud m status", config), null);
  assert.equal(chatCommand.matchTrigger(".aud m status", config), null);
  assert.equal(
    chatCommand.matchTrigger("!aud on", makeConfig({ chatTrigger: false })),
    null,
  );
});

test("the plain-chat trigger is inert when it is switched off", () => {
  const world = makeWorld();
  const config = makeConfig({ chatTrigger: false });
  const runtime = createRuntime({ config, deps: world.deps });
  const broadcast = [];
  const upstream = {
    broadcastLocalMessage(session, message) {
      broadcast.push(message);
      return { entry: { message } };
    },
  };
  plainChat.install(upstream, { runtime, config, chatCommand });
  upstream.broadcastLocalMessage(world.session, "!aud focus");
  assert.deepStrictEqual(broadcast, ["!aud focus"]);
  assert.equal(runtime.getPlayerState(7).targetMode, config.targetMode);
});

test("the chat overlay covers threshold, control and resume", () => {
  const world = makeWorld();
  const store = makePlayersFile("chat");
  const players = playerSettings.createPlayerStore({ file: store.file });
  const config = makeConfig();
  const runtime = createRuntime({ config, deps: world.deps, players });
  const upstream = { executeChatCommand: () => ({ handled: false }) };
  chatCommand.install(upstream, { runtime, config });
  const sent = [];
  const chatHub = { sendSystemMessage: (session, message) => sent.push(message) };

  const removed = upstream.executeChatCommand(world.session, "/aud m hold all", chatHub, {});
  assert.match(removed.message, /unknown option "hold"/);
  upstream.executeChatCommand(world.session, "/aud m threshold 4", chatHub, {});
  upstream.executeChatCommand(world.session, "/aud m control recall", chatHub, {});
  const state = runtime.getPlayerState(7);
  assert.equal(state.minHoldFreeVolumeM3, 4);
  assert.equal(state.playerControlPolicy, "recall");
  assert.equal(state.holdStopMode, undefined);

  const status = upstream.executeChatCommand(world.session, "/aud m status", chatHub, {});
  assert.match(status.message, /threshold\s*: 4 m3/);
  assert.match(status.message, /takeover\s*: recall/);

  upstream.executeChatCommand(world.session, "/aud m resume", chatHub, {});

  // "reset" inside a menu clears that kind and nothing else: the mining keys
  // go, while the takeover setting the same menu set is shared and stays.
  const reset = upstream.executeChatCommand(world.session, "/aud m reset", chatHub, {});
  assert.equal(reset.handled, true);
  assert.match(reset.message, /the mining settings were cleared/);
  const afterKindReset = runtime.getPlayerState(7);
  assert.equal(afterKindReset.playerControlPolicy, "recall");
  assert.equal(afterKindReset.minHoldFreeVolumeM3, 4,
    "the threshold is shared, so a kind reset leaves it alone");
  assert.equal(afterKindReset.source, "player",
    "the shared keys keep the entry alive");

  // "/aud reset" is the one that clears the whole entry, shared keys and all.
  const resetAll = upstream.executeChatCommand(world.session, "/aud reset", chatHub, {});
  assert.equal(resetAll.handled, true);
  assert.match(resetAll.message, /all your personal settings were cleared/);
  assert.equal(runtime.getPlayerState(7).source, "config");
  assert.equal(runtime.getPlayerState(7).minHoldFreeVolumeM3, config.minHoldFreeVolumeM3,
    "the shared threshold is only cleared by /aud reset");
  fs.rmSync(store.dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// What to mine: the ore/ice/moon filter
// ---------------------------------------------------------------------------

function oreRocks() {
  return [
    makeRock(3001, "ore", 1230, 9000),
    makeRock(3002, "ore", 1230, 30000),
    makeRock(3003, "ice", ICE_YIELD_TYPE, 8000, 1),
  ];
}

function oneOreDroneWorld(rocks) {
  return makeWorld({
    rocks,
    drones: [makeDrone({ itemID: 2001, typeID: ORE_DRONE_TYPE, controllerID: 1000 })],
  });
}

test("filter: the named ore wins even when another one is closer", () => {
  const rocks = [
    makeRock(3001, "ore", 1230, 9000),
    makeRock(3002, "ore", PYROXERES_TYPE, 20000),
  ];
  const plainWorld = oneOreDroneWorld(rocks.map((rock) => ({ ...rock })));
  const plain = createRuntime({ config: makeConfig(), deps: plainWorld.deps });
  plain.onSceneTick(plainWorld.scene, 1000);
  assert.deepEqual(
    plainWorld.calls.mine.map((call) => call.targetID),
    [3001],
    "with no filter the closest rock is the one mined",
  );

  const world = oneOreDroneWorld(rocks.map((rock) => ({ ...rock })));
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps });
  runtime.setPlayerOreFilter(7, { ore: ["pyroxeres"] });
  runtime.onSceneTick(world.scene, 1000);
  assert.deepEqual(world.calls.mine.map((call) => call.targetID), [3002]);
});

test("filter: a name matches every variant of that ore", () => {
  const rocks = [
    makeRock(3001, "ore", DENSE_VELDSPAR_TYPE, 9000),
    makeRock(3002, "ore", PYROXERES_TYPE, 12000),
  ];
  const world = oneOreDroneWorld(rocks);
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps });
  runtime.setPlayerOreFilter(7, { ore: ["veldspar"] });
  runtime.onSceneTick(world.scene, 1000);
  assert.deepEqual(
    world.calls.mine.map((call) => call.targetID),
    [3001],
    "Dense Veldspar has to be reached by the name veldspar",
  );
});

test("filter: moon ore is its own bucket, never reached with an ore filter", () => {
  const moonRock = makeRock(3005, "ore", MOON_ORE_TYPE, 9000);
  moonRock.entity.generatedMoonOreChunk = true;
  const rocks = () => [makeRock(3001, "ore", 1230, 12000), moonRock];

  const moonWorld = oneOreDroneWorld(rocks());
  const moon = createRuntime({ config: makeConfig(), deps: moonWorld.deps });
  moon.setPlayerOreFilter(7, { moon: ["bitumens"] });
  moon.onSceneTick(moonWorld.scene, 1000);
  assert.deepEqual(moonWorld.calls.mine.map((call) => call.targetID), [3005]);

  // "ore" alone must not touch the moon rock, even though it is closer.
  const oreWorld = oneOreDroneWorld(rocks());
  const ore = createRuntime({ config: makeConfig(), deps: oreWorld.deps });
  ore.setPlayerOreFilter(7, { ore: [] });
  ore.onSceneTick(oreWorld.scene, 1000);
  assert.deepEqual(oreWorld.calls.mine.map((call) => call.targetID), [3001]);

  // Without the chunk flag the group table still identifies a moon ore.
  const unflagged = makeRock(3006, "ore", MOON_ORE_TYPE, 9000);
  const groupWorld = oneOreDroneWorld([makeRock(3001, "ore", 1230, 12000), unflagged]);
  const group = createRuntime({ config: makeConfig(), deps: groupWorld.deps });
  group.setPlayerOreFilter(7, { moon: [] });
  group.onSceneTick(groupWorld.scene, 1000);
  assert.deepEqual(groupWorld.calls.mine.map((call) => call.targetID), [3006]);
});

test("filter: an ice drone follows the ice bucket, not the ore one", () => {
  const world = makeWorld({
    rocks: oreRocks(),
    drones: [
      makeDrone({ itemID: 2001, typeID: ORE_DRONE_TYPE, controllerID: 1000 }),
      makeDrone({ itemID: 2002, typeID: ICE_DRONE_TYPE, controllerID: 1000 }),
    ],
  });
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps });
  runtime.setPlayerOreFilter(7, { ice: [] });
  runtime.setPlayerFilterFallback(7, "idle");
  runtime.onSceneTick(world.scene, 1000);
  assert.deepEqual(world.calls.mine.map((call) => call.droneIDs[0]), [2002]);
  assert.deepEqual(world.calls.mine.map((call) => call.targetID), [3003]);
});

test("filter: nothing in range matches - any mines on, idle parks the drones", () => {
  const anyWorld = oneOreDroneWorld(oreRocks());
  const any = createRuntime({ config: makeConfig(), deps: anyWorld.deps });
  any.setPlayerOreFilter(7, { ore: ["arkonor"] });
  any.onSceneTick(anyWorld.scene, 1000);
  assert.deepEqual(
    anyWorld.calls.mine.map((call) => call.targetID),
    [3001],
    "the default fallback mines the closest rock anyway",
  );

  const idleWorld = oneOreDroneWorld(oreRocks());
  const idle = createRuntime({ config: makeConfig(), deps: idleWorld.deps });
  idle.setPlayerOreFilter(7, { ore: ["arkonor"] });
  idle.setPlayerFilterFallback(7, "idle");
  idle.onSceneTick(idleWorld.scene, 1000);
  assert.equal(idleWorld.calls.mine.length, 0);
});

test("filter: the scan reaches past the nearest rocks for the ore that was asked for", () => {
  const rocks = [];
  for (let index = 0; index < 60; index += 1) {
    rocks.push(makeRock(4000 + index, "ore", 1230, 1000 + (index * 100)));
  }
  rocks.push(makeRock(4999, "ore", PYROXERES_TYPE, 30000));

  const plainWorld = oneOreDroneWorld(rocks.map((rock) => ({ ...rock })));
  const plain = createRuntime({ config: makeConfig(), deps: plainWorld.deps });
  plain.onSceneTick(plainWorld.scene, 1000);
  assert.notEqual(
    plainWorld.calls.mine[0].targetID,
    4999,
    "the plain maxCandidates window does not reach the 61st rock",
  );

  const world = oneOreDroneWorld(rocks.map((rock) => ({ ...rock })));
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps });
  runtime.setPlayerOreFilter(7, { ore: ["pyroxeres"] });
  runtime.onSceneTick(world.scene, 1000);
  assert.deepEqual(world.calls.mine.map((call) => call.targetID), [4999]);
});

test("filter: the players file keeps the queue, the validator trims it", () => {
  const store = makePlayersFile("filter");
  const world = makeWorld();
  const players = playerSettings.createPlayerStore({ file: store.file });
  const runtime = createRuntime({
    config: makeConfig(),
    deps: world.deps,
    players,
  });
  runtime.setPlayerOreFilter(7, [" Veldspar ", "veldsPar", "PYROXERES", "moon"]);
  const saved = JSON.parse(fs.readFileSync(store.file, "utf8"));
  assert.deepEqual(saved.characters["7"].mining.oreFilter, ["veldspar", "pyroxeres", "moon"]);

  // A file 1.2.2 wrote holds three per-kind buckets; they still mean the queue
  // they describe, with an empty bucket standing for the whole kind.
  const legacy = playerSettings.normalizeEntry({
    oreFilter: { ore: [" Veldspar ", "any"], ice: [], moon: ["Bitumens"], gas: ["nope"] },
  });
  assert.deepEqual(
    legacy.mining.oreFilter,
    ["ore:veldspar", "ore", "ice", "moon:bitumens"],
    "the old buckets are read as the queue, and an unknown bucket is dropped",
  );

  const normalized = playerSettings.normalizeEntry({
    oreFilter: ["ok", "waytoolongforapatternxxxxxxxxxxxx", "!!!", "ice", "any", "1231"],
  });
  assert.deepEqual(
    normalized.mining.oreFilter,
    ["ok", "ice", "*", "1231"],
    "junk and over-long names are dropped; a kind word, \"*\" and a type ID stay",
  );
  assert.equal(
    playerSettings.normalizeEntry({ oreFilter: { ore: ["x".repeat(30)] } }),
    null,
    "a filter with nothing valid left is not stored at all",
  );
  fs.rmSync(store.dir, { recursive: true, force: true });
});

test("filter: a typed entry is a rock name or a type ID, and nothing else", () => {
  const queue = require(path.join(__dirname, "..", "lib", "oreQueue.js"));

  // What a players file holds keeps the wider grammar an older release wrote: a
  // kind word, "*" and a "kind:name" pin all still mean exactly what they meant.
  assert.deepEqual(queue.readQueue(["Veldspar", "ICE", "any", "1231", "ice:glacial mass"]), [
    { kind: null, pattern: "veldspar" },
    { kind: "ice", pattern: "*" },
    { kind: null, pattern: "*" },
    { kind: null, pattern: "1231" },
    { kind: "ice", pattern: "glacial mass" },
  ]);
  assert.equal(queue.readQueue(["!!!"]), null, "a token that cannot mean anything is not stored");
  assert.equal(queue.readQueue([]), null);

  const tokens = ["ice:glacial mass", "ice", "1231"];
  assert.equal(queue.rank(queue.readQueue(tokens), "ice", "Glacial Mass", 16264), 0,
    "the named rock is mined before the whole kind under it");
  assert.equal(queue.rank(queue.readQueue(tokens), "ice", "Blue Ice", 16264), 1);
  assert.equal(queue.rank(queue.readQueue(tokens), "ore", "Veldspar", 1230), -1,
    "a kind the queue never mentions is not mined");
  assert.equal(queue.rank(queue.readQueue(["1231"]), "ore", "Dense Veldspar", 1231), 0,
    "a number is a type ID");
  assert.equal(queue.rank(queue.readQueue(["*"]), "moon", "Bitumens", 46678), 0);

  // The typed grammar is narrower: a rock's name, or a type ID. "ice" is a word
  // inside real rock names, so it is a name like any other, and the two spellings
  // that used to stand for a whole kind are not tokens at all.
  assert.deepEqual(queue.parseTypedToken("Azure Ice"), { kind: null, pattern: "azure ice" });
  assert.deepEqual(queue.parseTypedToken("16268"), { kind: null, pattern: "16268" });
  assert.equal(queue.parseTypedToken("*"), null, "\"*\" can no longer reach a queue");
  assert.equal(queue.parseTypedToken("ice:glacial"), null, "and neither can the kind pin");

  // One line, sorted into what a filter command may do with each word: "ice" and
  // "any" name a whole kind of rock and are passed over, the pin is refused
  // outright because that spelling is gone, and so is rubbish.
  assert.deepEqual(
    queue.classifyTypedWords(["Azure Ice", "ice", "16266", "any", "!!!", "ice:glacial"]),
    {
      usable: ["azure ice", "16266"],
      reserved: ["ice", "any"],
      pinned: ["ice:glacial"],
      unusable: ["!!!"],
    },
  );

  const kinds = (token) => ({
    veldspar: ["ore"],
    kernite: ["ore"],
    "blue ice": ["ice"],
    "glacial mass": ["ice"],
    zeolites: ["moon"],
  }[token] || []);

  // A position is what "move" reads, and only "move": in "add" a number is a type
  // ID like any other number.
  assert.deepEqual(
    queue.parseEdits(["veldspar", "2", "kernite"]).map((edit) => [edit.token, edit.position]),
    [["veldspar", null], ["2", null], ["kernite", null]],
    "add takes no positions, so a number of its own stays a type ID",
  );
  assert.deepEqual(
    queue.parseEdits(["veldspar", "2", "kernite"], { positions: true })
      .map((edit) => [edit.token, edit.position]),
    [["veldspar", 2], ["kernite", null]],
    "move reads a number right after a name as that name's place",
  );

  assert.deepEqual(
    queue.placeTokens(
      ["veldspar", "kernite", "blue ice"],
      queue.parseEdits(["kernite", "1"], { positions: true }),
      kinds,
    ).tokens,
    ["kernite", "veldspar", "blue ice"],
    "position 1 is the top of that rock's own list",
  );
  assert.deepEqual(
    queue.placeTokens(
      ["veldspar", "kernite", "blue ice"],
      queue.parseEdits(["veldspar", "9"], { positions: true }),
      kinds,
    ).tokens,
    ["kernite", "veldspar", "blue ice"],
    "a position past the end of the list lands at its end",
  );
  assert.deepEqual(
    queue.placeTokens(
      ["veldspar", "kernite"],
      queue.parseEdits(["veldspar"], { positions: true }),
      kinds,
      { groupEnd: true },
    ).tokens,
    ["kernite", "veldspar"],
    "no position and \"move\" means the end of that rock's own list",
  );
  assert.deepEqual(
    queue.placeTokens(
      ["veldspar"], queue.parseEdits(["zeolites", "5"], { positions: true }), kinds,
    ).tokens,
    ["veldspar", "zeolites"],
    "the only entry of a list stays where it is, however big the number is",
  );
  assert.deepEqual(
    queue.placeTokens(
      ["veldspar"],
      queue.parseEdits(["kernite"], { positions: true }),
      kinds,
      { onlyExisting: true },
    ),
    { tokens: ["veldspar"], placed: [], skipped: [], missed: ["kernite"], rejected: [], discarded: [] },
    "move reports a name that is not queued instead of adding it",
  );

  // One list at a time: the kind of the first name typed picks the list that is
  // edited, and an entry of another kind is passed over - the one thing the flat
  // queue could not say for itself.
  const scoped = queue.placeTokens(
    ["veldspar", "kernite", "blue ice", "glacial mass"],
    queue.parseEdits(["glacial mass", "1", "kernite", "1"], { positions: true }),
    kinds,
    { groupEnd: true, onlyExisting: true, onlyKind: "ice" },
  );
  assert.deepEqual(scoped.tokens, ["veldspar", "kernite", "glacial mass", "blue ice"],
    "the ice list moved and the ore list did not");
  assert.deepEqual(scoped.placed, ["glacial mass"]);
  assert.deepEqual(scoped.discarded, ["kernite"], "the ore entry was passed over, not moved");

  assert.deepEqual(
    queue.removeMatching(["ore", "veldspar", "ice", "moon:bitumens"], ["ice"], kinds),
    { tokens: ["ore", "veldspar", "moon:bitumens"], removed: ["ice"], missed: [] },
    "a kind word drops that whole list - the branch \"filter clear\" reaches for",
  );
  assert.deepEqual(
    queue.removeMatching(["veldspar", "ice:glacial mass"], ["glacial"], kinds).tokens,
    ["veldspar"],
    "a name inside a pinned token is found too",
  );
  assert.deepEqual(queue.removeMatching(["veldspar", "ice"], ["*"], kinds).tokens, []);
  assert.deepEqual(queue.removeMatching(["veldspar"], ["kernite"], kinds).missed, ["kernite"]);

  assert.deepEqual(queue.groupByKind(["veldspar", "glacial mass", "kernite"], kinds), {
    groups: {
      ore: [{ order: 1, token: "veldspar" }, { order: 2, token: "kernite" }],
      ice: [{ order: 1, token: "glacial mass" }],
      moon: [],
    },
    unknown: [],
  }, "the numbers restart in every list");
  assert.deepEqual(
    queue.groupByKind(["veldsparx"], () => []).unknown,
    [{ order: 1, token: "veldsparx" }],
  );
  assert.equal(queue.describeToken("ice"), "ice (any ice rock)",
    "an old token still says what it stands for");
});
test("filter: the queue is a priority list, not just a whitelist", () => {
  const rocks = () => [
    makeRock(3001, "ore", PYROXERES_TYPE, 9000),
    makeRock(3002, "ore", 1230, 25000),
  ];

  const first = oneOreDroneWorld(rocks());
  const runtime = createRuntime({ config: makeConfig(), deps: first.deps });
  runtime.setPlayerOreFilter(7, { ore: ["veldspar", "pyroxeres"] });
  runtime.onSceneTick(first.scene, 1000);
  assert.deepEqual(
    first.calls.mine.map((call) => call.targetID),
    [3002],
    "the first entry of the queue is mined even though the second one is closer",
  );

  const second = oneOreDroneWorld(rocks());
  const other = createRuntime({ config: makeConfig(), deps: second.deps });
  other.setPlayerOreFilter(7, { ore: ["pyroxeres", "veldspar"] });
  other.onSceneTick(second.scene, 1000);
  assert.deepEqual(
    second.calls.mine.map((call) => call.targetID),
    [3001],
    "swap the two entries and the other rock is the one mined",
  );
});

test("filter: a queue entry can stand for a whole kind", () => {
  const rocks = [
    makeRock(3001, "ore", 1230, 9000),
    makeRock(3002, "ore", PYROXERES_TYPE, 30000),
  ];
  const world = oneOreDroneWorld(rocks);
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps });
  runtime.setPlayerOreFilter(7, { ore: ["pyroxeres", "any"] });
  runtime.onSceneTick(world.scene, 1000);
  assert.deepEqual(
    world.calls.mine.map((call) => call.targetID),
    [3002],
    "the named ore is still mined before the catch-all entry",
  );

  const wildcardFirst = oneOreDroneWorld(rocks.map((rock) => ({ ...rock })));
  const wildcard = createRuntime({ config: makeConfig(), deps: wildcardFirst.deps });
  wildcard.setPlayerOreFilter(7, { ore: ["*"] });
  wildcard.onSceneTick(wildcardFirst.scene, 1000);
  assert.deepEqual(wildcardFirst.calls.mine.map((call) => call.targetID), [3001]);
});

// A drone the mod itself is flying: it holds a mining order, so a queue change
// may re-issue it, exactly like the drone window's own target.
function makeMiningDroneOnRock(droneID, rockID) {
  const drone = makeDrone({
    itemID: droneID,
    typeID: ORE_DRONE_TYPE,
    controllerID: 1000,
    activityState: 2,
    droneCommand: "MINE",
  });
  drone.targetID = rockID;
  drone.droneMining = { targetID: rockID };
  return drone;
}

test("filter: a queue change re-tasks a drone that is already mining", () => {
  const rocks = [
    makeRock(3001, "ore", 1230, 25000),
    makeRock(3002, "ore", PYROXERES_TYPE, 9000),
  ];
  const world = makeWorld({ rocks, drones: [makeMiningDroneOnRock(2001, 3002)] });
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps });

  // The first pass notes the queue the ship is working with and does nothing:
  // the drone holds an order of ours already.
  runtime.onSceneTick(world.scene, 1000);
  assert.equal(world.calls.mine.length, 0);

  runtime.setPlayerOreFilter(7, { ore: ["veldspar"] });
  runtime.onSceneTick(world.scene, 2000);
  assert.deepEqual(
    world.calls.mine.map((call) => call.targetID),
    [3001],
    "the drone leaves the rock the new queue does not want, without waiting for it",
  );
  assert.equal(runtime.describeStatus(world.session).stats.retargets, 1);

  // Nothing changed since, so the drone is left alone on its new rock.
  runtime.onSceneTick(world.scene, 3000);
  assert.equal(world.calls.mine.length, 1);
});

test("filter: a higher-priority ore moves a drone off a rock that is still wanted", () => {
  const rocks = [
    makeRock(3001, "ore", 1230, 25000),
    makeRock(3002, "ore", PYROXERES_TYPE, 9000),
  ];
  const drone = makeMiningDroneOnRock(2001, 3002);
  const world = makeWorld({ rocks, drones: [drone] });
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps });
  runtime.onSceneTick(world.scene, 1000);

  // Pyroxeres is still wanted, but behind Veldspar - and the drone is on it.
  runtime.setPlayerOreFilter(7, { ore: ["veldspar", "pyroxeres"] });
  runtime.onSceneTick(world.scene, 2000);
  assert.deepEqual(world.calls.mine.map((call) => call.targetID), [3001]);

  // The vendor moves the drone; the queue did not change, so it is left there.
  drone.targetID = 3001;
  drone.droneMining.targetID = 3001;
  runtime.onSceneTick(world.scene, 3000);
  // A second change, one the drone already satisfies: nothing is re-issued.
  runtime.setPlayerOreFilter(7, { ore: ["veldspar"] });
  runtime.onSceneTick(world.scene, 4000);
  assert.equal(world.calls.mine.length, 1);
});

test("filter: a drone already on the top-ranked rock is left alone", () => {
  const rocks = [
    makeRock(3001, "ore", 1230, 9000),
    makeRock(3002, "ore", PYROXERES_TYPE, 25000),
  ];
  const world = makeWorld({ rocks, drones: [makeMiningDroneOnRock(2001, 3001)] });
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps });
  runtime.onSceneTick(world.scene, 1000);

  runtime.setPlayerOreFilter(7, { ore: ["veldspar"] });
  runtime.onSceneTick(world.scene, 2000);
  assert.equal(
    world.calls.mine.length,
    0,
    "no order is re-issued for the rock it is already on",
  );
});

test("filter: a queue that blocks the current rock brings the drone home", () => {
  const rocks = [
    makeRock(3001, "ore", 1230, 9000),
    makeRock(3002, "ore", PYROXERES_TYPE, 12000),
  ];
  const world = makeWorld({ rocks, drones: [makeMiningDroneOnRock(2001, 3002)] });
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps });
  runtime.onSceneTick(world.scene, 1000);

  runtime.setPlayerOreFilter(7, { ore: ["arkonor"] });
  runtime.setPlayerFilterFallback(7, "idle");
  runtime.onSceneTick(world.scene, 2000);
  assert.equal(world.calls.mine.length, 0);
  assert.deepEqual(world.calls.returnBay.map((call) => call.droneIDs), [[2001]]);
  assert.equal(runtime.describeStatus(world.session).stats.lastRecallReason, "queue changed");
});

test("filter: a hand-ordered drone is not re-targeted by a queue change", () => {
  const rocks = [
    makeRock(3001, "ore", 1230, 25000),
    makeRock(3002, "ore", PYROXERES_TYPE, 9000),
  ];
  const drone = makeMiningDroneOnRock(2001, 3002);
  drone.advancedUtilityDronesPlayerParkedAtMs = 900;
  const world = makeWorld({ rocks, drones: [drone] });
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps });
  runtime.onSceneTick(world.scene, 1000);

  runtime.setPlayerOreFilter(7, { ore: ["veldspar"] });
  runtime.onSceneTick(world.scene, 2000);
  assert.equal(world.calls.mine.length, 0);
});

test("filter: retargetOnFilterChange off keeps the old behaviour", () => {
  const rocks = [
    makeRock(3001, "ore", 1230, 25000),
    makeRock(3002, "ore", PYROXERES_TYPE, 9000),
  ];
  const world = makeWorld({ rocks, drones: [makeMiningDroneOnRock(2001, 3002)] });
  const runtime = createRuntime({
    config: makeConfig({ retargetOnFilterChange: false }),
    deps: world.deps,
  });
  runtime.onSceneTick(world.scene, 1000);

  runtime.setPlayerOreFilter(7, { ore: ["veldspar"] });
  runtime.onSceneTick(world.scene, 2000);
  assert.equal(world.calls.mine.length, 0, "the switch keeps the 1.2.0 behaviour");
});

test("chat: filter takes add, move, del and clear, and nothing else", () => {
  const world = makeWorld();
  const config = makeConfig();
  const runtime = createRuntime({ config, deps: world.deps });
  const run = (line) => chatCommand.handleCommand(runtime, config, world.session, "m " + line);
  const queue = () => runtime.getPlayerState(7).oreFilter;

  // One command, one queue: the order typed is the order mined, printed per kind
  // of rock so each list can be read on its own.
  const added = run("filter add veldspar pyroxeres blue ice");
  assert.match(added.message, /added veldspar, pyroxeres, blue ice\./);
  assert.match(added.message, /\n {2}ore {3}: 1\. veldspar, 2\. pyroxeres\n/);
  assert.match(added.message, /\n {2}ice {3}: 1\. blue ice\n/);
  assert.match(added.message, /\n {2}moon {2}: nothing$/);
  assert.match(added.message, /Matching in range: Veldspar/);
  assert.match(added.message, /switch to the new queue within a second/);
  assert.deepEqual(queue(), ["veldspar", "pyroxeres", "blue ice"]);

  // A whole kind of rock is not an entry, and saying so is the point: "ice" is a
  // word inside real rock names, so it can never mean the kind as well. The rest
  // of the line is queued and a warning line says what was passed over.
  const skipped = run("filter add 16262, ice, bitumens");
  assert.match(skipped.message, /\n +warning: "ice" names a whole kind of rock/);
  assert.match(skipped.message, /\/aud m filter clear ice empties the ice list/);
  assert.match(skipped.message, /\n {2}ice {4}: 1\. blue ice, 2\. Glacial Mass\n/,
    "an entry queued as a type ID reads back as the rock it stands for");
  assert.deepEqual(queue(), ["veldspar", "pyroxeres", "blue ice", "16262", "bitumens"]);

  // A bare number is a type ID, and one that names no rock can never match
  // anything. It costs only itself: the rest of the line is queued, and the
  // warning line says which number was dropped and where a place is set.
  const orphan = run("filter add veldspar, 1, pyroxeres, dark ochre");
  assert.match(orphan.message, /added dark ochre\./);
  assert.match(orphan.message, /warning: "1" is not a rock's type ID/);
  assert.match(orphan.message, /\/aud m filter move <name> 1/);
  assert.match(
    orphan.message,
    /warning: veldspar, pyroxeres are already in the queue and keep the place they have/,
    "an entry that is already queued is not moved: \"add\" is not \"move\"",
  );
  assert.match(orphan.message, /\n {2}ore {4}: 1\. veldspar, 2\. pyroxeres, 3\. dark ochre\n/);
  assert.deepEqual(queue(), ["veldspar", "pyroxeres", "blue ice", "16262", "bitumens", "dark ochre"],
    "the two good names went in where they were, and the number no rock has was dropped");
  run("filter del dark ochre");

  // "add" never reorders, so adding a queued name on its own says so instead of
  // quietly moving it to the end of the list.
  const again = run("filter add veldspar");
  assert.match(again.message, /nothing new to add/);
  assert.match(again.message, /veldspar is already in the queue and keeps the place it has/);
  assert.deepEqual(queue(), ["veldspar", "pyroxeres", "blue ice", "16262", "bitumens"]);

  // A number that does name a rock is queued, and reads back as that rock rather
  // than as the number that was typed.
  const byID = run("filter add 1231");
  assert.match(byID.message, /added Dense Veldspar\./);
  assert.deepEqual(queue(), ["veldspar", "pyroxeres", "blue ice", "16262", "bitumens", "1231"]);
  run("filter del 1231");
  run("filter del 20");

  // "move" reads a name and the place that name takes in its own list; a name
  // with no number goes to the end of that list.
  const moved = run("filter move veldspar 2");
  assert.match(moved.message, /moved veldspar\./);
  assert.match(moved.message, /\n {2}ore {3}: 1\. pyroxeres, 2\. veldspar\n/);
  assert.deepEqual(queue(), ["pyroxeres", "veldspar", "blue ice", "16262", "bitumens"]);

  const toEnd = run("filter move pyroxeres");
  assert.match(toEnd.message, /\n {2}ore {4}: 1\. veldspar, 2\. pyroxeres\n/);
  assert.match(
    toEnd.message,
    /warning: pyroxeres without a number, so it was placed at the end of the list/,
    "a name typed without a number says where it went",
  );
  assert.deepEqual(queue(), ["veldspar", "pyroxeres", "blue ice", "16262", "bitumens"]);

  // The kind of the first name typed picks the list that is edited, and an entry
  // of another kind is passed over instead of landing in the wrong list: naming an
  // ice rock means the numbers count in the ice list and nothing else moves.
  const scoped = run("filter move blue ice veldspar");
  assert.match(scoped.message, /moved blue ice\./);
  assert.match(scoped.message, /veldspar is not ice rock/);
  assert.match(scoped.message, /\n {2}ice {4}: 1\. Glacial Mass, 2\. blue ice\n/);
  assert.deepEqual(queue(), ["veldspar", "pyroxeres", "16262", "blue ice", "bitumens"]);

  // "del" takes a name or a type ID, and the two are the same entry: the reply
  // prints Glacial Mass for the queue that stores 16262, so the name finds it.
  const byName = run("filter del Glacial Mass");
  assert.match(byName.message, /dropped Glacial Mass\./);
  // The other direction works too: the queue can hold the name while the player
  // types the ID, because the reply prints nothing but names and that is what a
  // player has in front of them. The line names what was stored, as always.
  run("filter add glacial mass");
  const droppedByID = run("filter del 16262");
  assert.match(droppedByID.message, /dropped glacial mass\./);
  assert.deepEqual(queue(), ["veldspar", "pyroxeres", "blue ice", "bitumens"]);
  assert.deepEqual(queue(), ["veldspar", "pyroxeres", "blue ice", "bitumens"]);

  // "clear" empties one kind's list and nothing else. It is the only command that
  // takes a kind word, which is what "filter add ice" is answered with.
  const cleared = run("filter clear ice");
  assert.match(cleared.message, /dropped blue ice from the ice list\./);
  assert.deepEqual(queue(), ["veldspar", "pyroxeres", "bitumens"]);
  assert.match(run("filter clear ice").message, /the ice list is already empty/);
  assert.match(run("filter clear gas").message, /clear takes one kind of rock/);
  assert.match(run("filter clear").message, /clear takes one kind of rock/);
  assert.match(run("filter clear ore ice").message, /clear takes one kind of rock/);
  assert.deepEqual(queue(), ["veldspar", "pyroxeres", "bitumens"]);

  // A word that cannot be an entry is refused, the 1.2.5 pin says what replaced
  // it, and the queue has a ceiling the reply and the validator both enforce.
  assert.match(run("filter add !!!").message, /is not a usable ore name/);
  assert.match(run("filter add ice:glacial mass").message, /hangs a name off a kind of rock/);
  assert.match(run("filter add").message, /add needs a name/);
  assert.match(run("filter del").message, /del needs a name/);
  assert.match(run("filter move").message, /move needs a name/);
  assert.match(
    run(`filter add ${Array.from({ length: 17 }, (_value, index) => `ore${index}`).join(" ")}`)
      .message,
    /at most 16 entries/,
  );
  assert.deepEqual(queue(), ["veldspar", "pyroxeres", "bitumens"],
    "none of those changed the queue");

  // "del" on everything it holds leaves the queue empty again.
  const all = run("filter del veldspar pyroxeres bitumens");
  assert.match(all.message, /The queue is now empty, so every mineable rock counts again\./);
  assert.equal(queue(), null, "an emptied queue stops filtering");
});

test("queue: a comma separates names, and one name may hold a space", () => {
  const queue = require(path.join(__dirname, "..", "lib", "oreQueue.js"));
  const kindsOf = (pattern) => ({
    gneiss: ["ore"],
    "dark ochre": ["ore"],
    veldspar: ["ore"],
    kernite: ["ore"],
    "azure ice": ["ice"],
  }[pattern] || []);

  assert.deepEqual(queue.splitTypedWords("gneiss dark ochre", kindsOf), ["gneiss", "dark ochre"]);
  assert.deepEqual(queue.splitTypedWords("dark ochre veldspar", kindsOf), ["dark ochre", "veldspar"]);
  assert.deepEqual(queue.splitTypedWords("dark ochre, gneiss", kindsOf), ["dark ochre", "gneiss"]);
  assert.deepEqual(queue.splitTypedWords("dark, ochre", kindsOf), ["dark", "ochre"]);
  assert.deepEqual(queue.splitTypedWords("dark,ochre", kindsOf), ["dark", "ochre"]);
  assert.deepEqual(queue.splitTypedWords(" veldspar , kernite ", kindsOf), ["veldspar", "kernite"]);

  // A number is a type ID and never part of a name.
  assert.deepEqual(queue.splitTypedWords("dark ochre 2", kindsOf), ["dark ochre", "2"]);
  assert.deepEqual(queue.splitTypedWords("1231 dark ochre", kindsOf), ["1231", "dark ochre"]);

  // A word that used to stand for a whole kind is a word inside a real name now,
  // so "azure ice" is put back together like any other name of two words - and on
  // its own the word stays a word, for a command to refuse.
  assert.deepEqual(queue.splitTypedWords("azure ice", kindsOf), ["azure ice"]);
  assert.deepEqual(queue.splitTypedWords("azure ice, veldspar", kindsOf), ["azure ice", "veldspar"]);
  assert.deepEqual(queue.splitTypedWords("ice", kindsOf), ["ice"]);

  // A word that cannot be an entry at all is left as typed, for the same reason.
  assert.deepEqual(queue.splitTypedWords("gneiss !!!", kindsOf), ["gneiss", "!!!"]);
  assert.deepEqual(queue.splitTypedWords("ice:glacial mass", kindsOf), ["ice:glacial", "mass"]);

  // No catalogue to ask - an item table that cannot be read - reads exactly as it
  // did before the joining rule existed.
  assert.deepEqual(queue.splitTypedWords("gneiss dark ochre", null), ["gneiss", "dark", "ochre"]);
});

test("chat: a rock whose name is two words stays one entry", () => {
  const world = makeWorld();
  const config = makeConfig();
  const runtime = createRuntime({ config, deps: world.deps });
  const run = (line) => chatCommand.handleCommand(runtime, config, world.session, "m " + line);
  const queue = () => runtime.getPlayerState(7).oreFilter;

  // Typed without a comma, the words that name one rock stay together: this is
  // what used to become "dark" and "ochre", two patterns that each match
  // something, so nothing ever said the queue was not what the player meant.
  const joined = run("filter add veldspar dark ochre");
  assert.match(joined.message, /added veldspar, dark ochre\./);
  assert.match(joined.message, /\n {2}ore {3}: 1\. veldspar, 2\. dark ochre\n/);
  assert.deepEqual(queue(), ["veldspar", "dark ochre"]);

  // The comma is the escape hatch: the same words, asked for as two patterns.
  const apart = run("filter add dark, ochre");
  assert.match(apart.message, /added dark, ochre\./);
  assert.deepEqual(queue(), ["veldspar", "dark ochre", "dark", "ochre"]);

  // A rock's place can follow a name of two words.
  const placed = run("filter move dark ochre 1");
  assert.match(placed.message, /moved dark ochre\./);
  assert.deepEqual(queue(), ["dark ochre", "veldspar", "dark", "ochre"]);

  // A misspelt second word is not joined, and lands on the warning line the way
  // any name no rock has does.
  run("filter clear ore");
  const typo = run("filter add dark ocre");
  assert.match(typo.message, /\n +warning: 1\. ocre \(no rock matches that name/);
  assert.match(typo.message, /\n +ore +: 1\. dark$/m);
  assert.deepEqual(queue(), ["dark", "ocre"]);

  // A queue an older release wrote can hold the two words apart; "del" still
  // drops what the player typed.
  runtime.setPlayerOreFilter(7, ["dark", "ochre"]);
  const cleaned = run("filter del dark ochre");
  assert.match(cleaned.message, /dropped dark, ochre\./);
  assert.equal(queue(), null);
});

test("chat: the forms that left the grammar say what took their place", () => {
  const world = makeWorld();
  const config = makeConfig();
  const runtime = createRuntime({ config, deps: world.deps });
  const run = (line) => chatCommand.handleCommand(runtime, config, world.session, "m " + line);

  // A kind word is no longer a way into the queue - "clear" is the command that
  // empties one kind's list, and the warning line says so.
  assert.match(run("filter add ice").message, /"ice" names a whole kind of rock/);
  assert.match(run("filter del ice").message, /\/aud m filter clear ice empties the ice list/);
  assert.match(run("filter add any").message, /"any" stands for every rock/);
  assert.match(run("filter add *").message, /"\*" stands for every rock/);
  assert.equal(runtime.getPlayerState(7).oreFilter, null, "none of those queued anything");

  // The pin a name could hang off one kind is gone, and naming it is friendlier
  // than "not a usable ore name".
  assert.match(
    run("filter add ice:glacial mass").message,
    /hangs a name off a kind of rock, and that spelling is gone/,
  );

  // A kind on its own is a kind of rock, not a command.
  assert.match(run("filter ore").message, /is a kind of rock, not a command/);
  assert.match(run("filter ice add veldspar").message, /is a kind of rock, not a command/);

  // The list of what is around you keeps a command of its own.
  assert.match(run("filter list").message, /"\/aud m list" shows the rocks in range/);

  // Anything else says how to add a name instead of guessing at it.
  assert.match(run("filter veldspar").message, /filter takes add, move, del, clear, grade/);
  assert.equal(runtime.getPlayerState(7).oreFilter, null, "none of them changed the queue");

  // "filter" on its own is still how the queue is read back.
  const shown = run("filter");
  assert.match(shown.message, /nothing is queued/);
  assert.match(shown.message, /fallback: any/);
  assert.match(shown.message, /grade {3}: off/);
  assert.match(shown.message, /commands: "\/aud m filter help"/);
});

test("chat: /aud m help and /aud m filter help are two lists", () => {
  const world = makeWorld();
  const config = makeConfig();
  const runtime = createRuntime({ config, deps: world.deps });
  const run = (line) => chatCommand.handleCommand(runtime, config, world.session, "m " + line);

  // The top-level list is the commands that follow "/aud m" and nothing else: it
  // points at the filter's own list instead of carrying it along.
  const top = run("help").message;
  assert.match(top, /the commands that follow \/aud m/);
  assert.match(top, /\/aud m filter help/);
  assert.match(top, /"\/aud m f \.\.\." is the same as "\/aud m filter \.\.\."/,
    "the top-level list names the filter's short spelling");
  assert.equal(top.includes("filter add"), false,
    "the filter's own commands no longer pad the top-level list");
  assert.equal(top.includes("filter grade"), false);

  // "/aud m filter help" carries them in the same shape as the list above: one
  // line per command, the line is what to type, and the detail lines sit under
  // it indented by four spaces - no paragraphs.
  const filterHelp = run("filter help").message;
  assert.match(filterHelp, /the commands that follow \/aud m filter/);
  assert.match(filterHelp, /\n {2}\/aud m filter add <name\|id>/);
  assert.match(filterHelp, /\n {2}\/aud m filter move <name\|id> <place>/);
  assert.match(filterHelp, /\n {2}\/aud m filter del <name\|id>/);
  assert.match(filterHelp, /\n {2}\/aud m filter clear ore\|ice\|moon/);
  assert.match(filterHelp, /\n {2}\/aud m filter grade on\|off/);
  assert.match(filterHelp, /\n {2}\/aud m filter fallback any\|idle/);
  assert.match(filterHelp, /\n {2}\/aud m filter - show the queue/);
  assert.match(filterHelp, /\n {2}\/aud m filter help - this list/);
  assert.match(filterHelp, /\n {2}"\/aud m f <arguments>" is the same as/);
  const widest = filterHelp.split("\n").reduce((most, line) => Math.max(most, line.length), 0);
  assert.ok(widest <= 84, "the filter list stays as narrow as the top-level one (" + widest + ")");
  assert.equal(filterHelp.includes("first entry mined first:"), false,
    "the paragraph under \"add\" is gone");

  // Reading the queue still says where the list of commands is.
  assert.match(run("filter").message, /\/aud m filter help/);
});

test("chat: f is the filter's short spelling", () => {
  const world = makeWorld();
  const config = makeConfig();
  const runtime = createRuntime({ config, deps: world.deps });
  const run = (line) => chatCommand.handleCommand(runtime, config, world.session, "m " + line);

  // "/aud m f" is "/aud m filter" under a shorter name: the queue read back, the
  // same verbs, the same help, the same wording.
  assert.equal(run("f").message, run("filter").message);
  assert.equal(run("f help").message, run("filter help").message);

  const added = run("f add veldspar, pyroxeres");
  assert.match(added.message, /added veldspar, pyroxeres\./);
  assert.match(added.message, /\n {2}ore {3}: 1\. veldspar, 2\. pyroxeres\n/);
  assert.match(run("f").message, /1\. veldspar, 2\. pyroxeres/);

  assert.match(run("f move pyroxeres 1").message, /\n {2}ore {3}: 1\. pyroxeres, 2\. veldspar\n/);
  assert.match(run("f grade on").message, /filter grade: on/);
  assert.match(run("f fallback idle").message, /filter fallback: idle/);
  assert.match(run("f del pyroxeres").message, /dropped pyroxeres/);
  assert.match(run("f clear ore").message, /queue is now empty/);
  assert.match(run("f bogus").message, /"\/aud m f" is the same command/);

  // The short spelling is a filter verb, not a top-level command of its own:
  // "/aud m fallback" still means what it always did, and only "filter" grew one.
  assert.match(run("fallback idle").message, /filter fallback: idle/);
  assert.equal(chatCommand.matchCommand("/aud m f", config), "m f");
  assert.equal(chatCommand.matchCommand("/aud m fallback", config), "m fallback");
  assert.equal(chatCommand.matchCommand("/aud m fill", config), "m fill");
});

test("chat: switching the grade preference re-tasks working drones", () => {
  const world = makeWorld();
  const config = makeConfig();
  const runtime = createRuntime({ config, deps: world.deps });
  const note = (patch) => runtime._testing.noteQueueSignature(7, {
    oreFilter: ["veldspar"], filterFallback: "any", filterGrade: false, ...patch,
  });

  assert.equal(note({}), false, "the first pass only notes the setup");
  assert.equal(note({}), false, "an unchanged setup is not a change");
  assert.equal(note({ filterGrade: true }), true,
    '"filter grade on" re-tasks the way a queue edit does');
  assert.equal(note({ filterGrade: true }), false);
  assert.equal(note({ filterGrade: false }), true, '"filter grade off" re-tasks as well');
});
test("filter: the ore name catalogue reads the game's own rock groups", () => {
  const oreNames = require(path.join(__dirname, "..", "lib", "oreNames.js"));
  const rows = [
    { typeID: 1230, name: "Veldspar", groupID: 462, categoryID: 25, groupName: "Veldspar" },
    { typeID: 1231, name: "Compressed Veldspar", groupID: 462, categoryID: 25, groupName: "Veldspar" },
    { typeID: 16264, name: "Blue Ice", groupID: 465, categoryID: 25, groupName: "Ice" },
    { typeID: 17978, name: "Clear Icicle IV-Grade", groupID: 465, categoryID: 25, groupName: "Ice" },
    { typeID: 45490, name: "Zeolites", groupID: 1884, categoryID: 25, groupName: "Ubiquitous Moon Asteroids" },
    { typeID: 4094, name: "Cosmetic Asteroid 1", groupID: 4094, categoryID: 25, groupName: "Scalable Decorative Asteroid" },
    { typeID: 2, name: "Corporation", groupID: 2, categoryID: 1, groupName: "Corporation" },
  ];
  const catalog = oreNames.createOreCatalog({
    readRows: () => rows,
    moonGroupIDs: [1884, 1920, 1921, 1922, 1923],
  });
  assert.equal(catalog.isReady(), true, "the game's asteroid rows are the catalogue");
  assert.deepEqual(catalog.kindsFor("veldspar"), ["ore"]);
  assert.deepEqual(catalog.kindsFor("1230"), ["ore"], "a type ID groups like its name");
  assert.deepEqual(catalog.kindsFor("16264"), ["ice"]);
  assert.deepEqual(catalog.kindsFor("iv-grade"), ["ice"]);
  assert.deepEqual(catalog.kindsFor("zeolites"), ["moon"]);
  assert.deepEqual(catalog.kindsFor("cosmetic"), [], "a decorative rock is not a target");
  assert.deepEqual(catalog.kindsFor("kernite"), [], "no rock in this table has that name");
  assert.deepEqual(catalog.suggestionsFor("veldsparx"), ["Veldspar"]);
  assert.deepEqual(catalog.suggestionsFor("zeolite"), ["Zeolites"]);
  assert.deepEqual(catalog.suggestionsFor("zzzzzzzz"), []);

  // What the live mining runtime calls a rock outranks the static table: this
  // is what keeps a reply in step with a server whose data says otherwise.
  catalog.remember(1231, "moon");
  assert.deepEqual(catalog.kindsFor("compressed veldspar"), ["moon"]);
  assert.deepEqual(catalog.kindsFor("veldspar"), ["ore", "moon"],
    "a name that spans both grades is listed under both kinds");

  // A server whose item types cannot be read leaves the queue ungrouped
  // instead of guessing a kind for every entry.
  const blind = oreNames.createOreCatalog({
    readRows: () => { throw new Error("no item types"); },
  });
  assert.equal(blind.isReady(), false);
  assert.deepEqual(blind.kindsFor("veldspar"), []);
});

test("chat: every filter command prints the lists the numbers count in", () => {
  const world = makeWorld();
  const config = makeConfig();
  const runtime = createRuntime({ config, deps: world.deps });
  const run = (line) => chatCommand.handleCommand(runtime, config, world.session, "m " + line);

  // One line per kind of rock, and the number restarts in every list, because
  // that is the number "move" takes.
  const added = run("filter add veldspar blue ice bitumens");
  assert.match(added.message, /\n {2}ore {3}: 1\. veldspar\n/);
  assert.match(added.message, /\n {2}ice {3}: 1\. blue ice\n/);
  assert.match(added.message, /\n {2}moon {2}: 1\. bitumens$/);

  // A word that was passed over adds its own line, and the lists are still
  // printed underneath it.
  const skipped = run("filter add 16262, ore");
  assert.match(skipped.message, /"ore" names a whole kind of rock/);
  assert.match(skipped.message, /\n {2}ice {4}: 1\. blue ice, 2\. Glacial Mass\n/);

  // del answers the same way, so nobody has to ask twice.
  const dropped = run("filter del blue ice");
  assert.match(dropped.message, /\n {2}ice {3}: 1\. Glacial Mass\n/);

  // And so does clear.
  const cleared = run("filter clear moon");
  assert.match(cleared.message, /\n {2}moon {2}: nothing$/);

  // An empty queue has nothing to list and says so instead.
  assert.match(run("filter clear ice").message, /dropped Glacial Mass from the ice list\./);
  const emptied = run("filter clear ore");
  assert.match(emptied.message, /The queue is now empty/);
  assert.equal(/ore {3}:/.test(emptied.message), false);
  assert.equal(runtime.getPlayerState(7).oreFilter, null);
});

test("chat: an entry that matches no rock gets a warning line", () => {
  const world = makeWorld();
  const config = makeConfig();
  const runtime = createRuntime({ config, deps: world.deps });
  const run = (line) => chatCommand.handleCommand(runtime, config, world.session, "m " + line);

  const typo = run("filter add veldsparx");
  assert.match(
    typo.message,
    /\n +warning: 1\. veldsparx \(no rock matches that name, did you mean Veldspar\?\)$/,
  );
  assert.deepEqual(runtime.getPlayerState(7).oreFilter, ["veldsparx"],
    "the entry is kept: the mod does not correct a player on its own");

  // An entry queued as a type ID is grouped by the kind of rock it names, and
  // printed as the name of that rock rather than as a number to go looking up.
  const byID = run("filter add 16264");
  assert.match(byID.message, /\n +ice +: 1\. Blue Ice\n/);
  assert.deepEqual(runtime.getPlayerState(7).oreFilter, ["veldsparx", "16264"]);

  // Nothing is close enough to suggest, so the line just says so.
  const garbage = run("filter add zzzzzzzz");
  assert.match(garbage.message, /\n +warning: 2\. zzzzzzzz \(no rock matches that name\)$/);
  assert.match(garbage.message, /\n +ice +: 1\. Blue Ice\n/);
});

test("chat: move reorders with the same numbers the reply prints", () => {
  const world = makeWorld();
  const config = makeConfig();
  const runtime = createRuntime({ config, deps: world.deps });
  const run = (line) => chatCommand.handleCommand(runtime, config, world.session, "m " + line);
  const queue = () => runtime.getPlayerState(7).oreFilter;

  run("filter add veldspar pyroxeres blue ice bitumens");

  // The number counts inside that rock's own list, and the entry that was there
  // shifts along.
  const moved = run("filter move pyroxeres 1");
  assert.match(moved.message, /moved pyroxeres\./);
  assert.match(moved.message, /\n {2}ore {3}: 1\. pyroxeres, 2\. veldspar\n/);
  assert.deepEqual(queue(), ["pyroxeres", "veldspar", "blue ice", "bitumens"]);

  // With no number the entry goes to the end of its own list.
  const toEnd = run("filter move pyroxeres");
  assert.match(toEnd.message, /\n {2}ore {4}: 1\. veldspar, 2\. pyroxeres\n/);
  assert.match(toEnd.message, /warning: pyroxeres without a number/);
  assert.deepEqual(queue(), ["veldspar", "pyroxeres", "blue ice", "bitumens"]);

  // A number past the end of a list lands at the end of it, and the only entry of
  // a list stays where it is however big the number is.
  const far = run("filter move veldspar 9");
  assert.match(far.message, /\n {2}ore {3}: 1\. pyroxeres, 2\. veldspar\n/);
  run("filter move bitumens 5");
  assert.deepEqual(queue(), ["pyroxeres", "veldspar", "blue ice", "bitumens"],
    "the only moon ore is already at the end of the moon list");

  // A name that is not queued is reported, not added: this reorders the queue.
  const missing = run("filter move kernite 1");
  assert.match(missing.message, /nothing in the queue matches kernite/);
  const unclear = run("filter move");
  assert.match(unclear.message, /move needs a name/);

  // The first name picks the list, so a number meant for another kind of rock is
  // not a number this command can use.
  const foreign = run("filter move blue ice 1 pyroxeres 1");
  assert.match(foreign.message, /pyroxeres is not ice rock/);
  assert.deepEqual(queue(), ["pyroxeres", "veldspar", "blue ice", "bitumens"],
    "the ore list was left alone");

  run("filter del veldspar pyroxeres blue ice bitumens");
  const empty = run("filter move veldspar 1");
  assert.match(empty.message, /the queue is empty/);
});

test("grade: a rock's type name is where its grade is written", () => {
  const grades = require(path.join(__dirname, "..", "lib", "oreGrades.js"));
  assert.equal(grades.gradeOf("Veldspar"), 1, "the bare name is grade I");
  assert.equal(grades.gradeOf("Veldspar 0-Grade"), 0, "and 0-Grade is the one below it");
  assert.equal(grades.gradeOf("Veldspar II-Grade"), 2);
  assert.equal(grades.gradeOf("Veldspar III-Grade"), 3);
  assert.equal(grades.gradeOf("Veldspar IV-Grade"), 4);
  assert.equal(grades.gradeOf("Compressed Veldspar IV-Grade"), 4,
    "the compressed prefix says nothing about the grade");
  assert.equal(grades.gradeOf("Ancient Compressed Blue Ice IV-Grade"), 4);
  assert.equal(grades.gradeOf("Blue Ice"), 1);
  assert.equal(grades.gradeOf("Raspite X-Grade"), 10, "the moon families go to X");
  assert.equal(grades.gradeOf("Dense Veldspar"), 1, "a word that is not a mark is not a grade");
  assert.equal(grades.gradeOf("Dark Ochre II-Grade"), 2);
  assert.equal(grades.gradeOf(""), 1);
  assert.equal(grades.gradeOf(null), 1);
});

test("filter: the grade preference mines the richest rock of a family first", () => {
  const rocks = () => [
    makeRock(3001, "ore", 17425, 9000),
    makeRock(3002, "ore", 17426, 30000),
  ];

  // Off by default: the closer rock wins even though its grade is the lower one.
  const plain = oneOreDroneWorld(rocks());
  const runtime = createRuntime({ config: makeConfig(), deps: plain.deps });
  assert.equal(runtime.getPlayerState(7).filterGrade, false);
  runtime.onSceneTick(plain.scene, 1000);
  assert.deepEqual(plain.calls.mine.map((call) => call.targetID), [3001],
    "with the preference off, Dark Ochre is mined because it is the closer one");

  // On, the II-Grade rock is mined first even though it is the further one, and
  // "list" reads in the order the drones will work through.
  const graded = oneOreDroneWorld(rocks());
  const gradeRuntime = createRuntime({ config: makeConfig(), deps: graded.deps });
  gradeRuntime.setPlayerFilterGrade(7, true);
  assert.equal(gradeRuntime.getPlayerState(7).filterGrade, true);
  gradeRuntime.onSceneTick(graded.scene, 1000);
  assert.deepEqual(graded.calls.mine.map((call) => call.targetID), [3002],
    "the higher grade wins over the shorter distance");
  assert.deepEqual(
    gradeRuntime.describeSceneOres(graded.session, null).entries.map((entry) => entry.name),
    ["Dark Ochre II-Grade", "Dark Ochre"],
  );

  // The queue still comes first: a rock the player ranked above another is mined
  // before it even when the other one carries the richer grade.
  const ordered = oneOreDroneWorld(rocks());
  const orderedRuntime = createRuntime({ config: makeConfig(), deps: ordered.deps });
  orderedRuntime.setPlayerFilterGrade(7, true);
  orderedRuntime.setPlayerOreFilter(7, ["17425", "17426"]);
  orderedRuntime.onSceneTick(ordered.scene, 1000);
  assert.deepEqual(ordered.calls.mine.map((call) => call.targetID), [3001],
    "priority beats grade");

  // A per-character choice that travels with the players file, and "default"
  // hands it back to the server setting.
  gradeRuntime.setPlayerFilterGrade(7, null);
  assert.equal(gradeRuntime.getPlayerState(7).filterGrade, false);
});

test("chat: the grade preference is per character and off unless asked for", () => {
  const world = makeWorld();
  const config = makeConfig();
  const runtime = createRuntime({ config, deps: world.deps });
  const run = (line) => chatCommand.handleCommand(runtime, config, world.session, "m " + line);

  assert.match(run("filter grade").message, /filter grade: off/);
  assert.match(run("filter grade on").message, /filter grade: on/);
  assert.match(run("filter grade on").message, /switch to the new queue within a second/,
    "the grade switch re-tasks working drones, so the reply says so");
  assert.equal(runtime.getPlayerState(7).filterGrade, true);
  assert.match(run("filter grade").message, /filter grade: on/);
  assert.match(run("filter grade default").message, /filter grade: off/);
  assert.equal(runtime.getPlayerState(7).filterGrade, false);
  assert.match(run("filter grade sideways").message, /grade must be "on", "off" or "default"/);

  run("filter grade on");
  assert.match(run("filter").message, /grade {3}: on/);
  run("filter add veldspar");
  assert.match(run("status").message, /grade on/);

  // The players file takes the same spellings a config file does, and an entry
  // that only holds it can be dropped again by setting it to null.
  assert.equal(playerSettings.normalizeEntry({ filterGrade: "on" }).mining.filterGrade, true);
  assert.equal(playerSettings.normalizeEntry({ filterGrade: null }), null);
});
test("chat: the kind comes first, and the retired spellings only say so", () => {
  const world = makeWorld();
  const config = makeConfig();
  const runtime = createRuntime({ config, deps: world.deps });
  // One name, two scopes: the kind is the first word after /aud, and the rest
  // of the line is that kind's menu, verbatim.
  assert.equal(chatCommand.matchCommand("/aud m status", config), "m status");
  assert.equal(chatCommand.matchCommand("!aud status", config), "status");
  assert.equal(chatCommand.matchCommand("/aud s", config), "s");
  assert.equal(chatCommand.matchTrigger("!aud filter ore clear", config), "filter ore clear");

  // A bare /aud is the two menus and nothing else: no kind is guessed, so a
  // verb typed without one is answered with both spellings of itself.
  assert.equal(chatCommand.matchCommand("/aud", config), "");
  const menu = chatCommand.handleCommand(runtime, config, world.session, "");
  assert.match(menu.message, /pick the drones to control/);
  assert.match(menu.message, /\/aud m \[command\]/);
  assert.match(menu.message, /\/aud s \[command\]/);
  const ambiguous = chatCommand.handleCommand(runtime, config, world.session, "spread");
  assert.match(ambiguous.message, /\/aud m spread\" for the mining drones/);
  assert.match(ambiguous.message, /\/aud s spread\" for the salvage drones/);
  assert.equal(runtime.getPlayerState(7).targetMode, "spread",
    "a verb with no kind changes nothing");

  // The retired spellings are matched, so a player whose fingers still type
  // them is told about the rename instead of being ignored - and the name stays
  // in front of the reply so the router knows which one was typed.
  assert.equal(chatCommand.matchTrigger("!atm", config), "atm");
  assert.equal(
    chatCommand.matchTrigger("!altmining filter ore clear", config),
    "altmining filter ore clear",
  );
  assert.equal(
    chatCommand.matchCommand("/advancedutilitydrones status", config),
    null,
    "the long spelling is gone - /aud is the whole set",
  );
  assert.equal(
    chatCommand.matchCommand("/somethingelse status", config),
    null,
    "another command still goes to the vendor handler",
  );
  const renamed = chatCommand.handleCommand(runtime, config, world.session, "atm off");
  assert.match(renamed.message, /was renamed/);
  assert.match(renamed.message, /\/aud m/);
  assert.match(renamed.message, /\/aud s/);
  assert.equal(runtime.getPlayerState(7).enabled, true,
    "the retired spelling says its piece and does nothing else");

  const redirected = chatCommand.handleCommand(runtime, config, world.session, "m ore veldspar");
  assert.match(redirected.message, /is a kind of rock, not a command/);
  assert.match(redirected.message, /\/aud m filter clear ore/,
    "the redirect names the command that still takes a kind word");
  assert.equal(/filter add ore/.test(redirected.message), false,
    "and not the spelling 1.2.9 stopped accepting");
  assert.equal(runtime.getPlayerState(7).oreFilter, null, "the old form changes nothing");

  const shown = chatCommand.handleCommand(runtime, config, world.session, "m filter ore");
  assert.match(shown.message, /is a kind of rock, not a command/);
});
test("chat: fallback is per character and can go back to the server default", () => {
  const world = makeWorld();
  const config = makeConfig();
  const runtime = createRuntime({ config, deps: world.deps });
  assert.equal(runtime.getPlayerState(7).filterFallback, "any");

  const idle = chatCommand.handleCommand(runtime, config, world.session, "m " + "fallback idle");
  assert.match(idle.message, /fallback: idle/);
  assert.equal(runtime.getPlayerState(7).filterFallback, "idle");

  chatCommand.handleCommand(runtime, config, world.session, "m " + "filter fallback default");
  assert.equal(runtime.getPlayerState(7).filterFallback, "any");

  const bad = chatCommand.handleCommand(runtime, config, world.session, "m " + "fallback sideways");
  assert.match(bad.message, /must be "any", "idle" or "default"/);
});

test("chat: list names the ore around the ship, status shows the filter", () => {
  const world = makeWorld();
  const config = makeConfig();
  const runtime = createRuntime({ config, deps: world.deps });

  const withoutFilter = chatCommand.buildStatusText(runtime, world.session);
  assert.equal(/filter\s+:/u.test(withoutFilter), false, "an inactive filter is not worth a line");

  runtime.setPlayerOreFilter(7, ["veldspar"]);
  const status = chatCommand.buildStatusText(runtime, world.session);
  assert.match(status, /filter\s+: veldspar \(fallback any/u);
  assert.match(status, /2 of 3 rocks in range match/u);

  const list = chatCommand.handleCommand(runtime, config, world.session, "m " + "list");
  assert.match(list.message, /Veldspar/);
  assert.match(list.message, /Blue Ice/);
  assert.match(list.message, /2 rocks, 200 m3 left, nearest 9500 m/u);
  assert.match(list.message, /\* ore/u, "the rock the filter already matches is marked");

  const iceOnly = chatCommand.handleCommand(runtime, config, world.session, "m " + "list ice");
  assert.match(iceOnly.message, /Blue Ice/);
  assert.equal(/Veldspar/u.test(iceOnly.message), false);

  const badScope = chatCommand.handleCommand(runtime, config, world.session, "m " + "list gas");
  assert.match(badScope.message, /list takes "ore", "ice" or "moon"/);
});

test("chat: list and filter still answer when players may not change settings", () => {
  const world = makeWorld();
  const config = makeConfig({ allowPlayerToggle: false });
  const runtime = createRuntime({ config, deps: world.deps });
  const list = chatCommand.handleCommand(runtime, config, world.session, "m " + "list");
  assert.match(list.message, /mineable rocks in range/);
  const shown = chatCommand.handleCommand(runtime, config, world.session, "m " + "filter");
  assert.match(shown.message, /nothing is queued/);
  const refused = chatCommand.handleCommand(runtime, config, world.session, "m " + "filter ore add 1 veldspar");
  assert.match(refused.message, /disabled by the server/);
});

test("copy: the identifier takes an id, a User: label or a unique name", () => {
  const copy = require(path.join(__dirname, "..", "lib", "copySettings.js"));
  assert.deepEqual(copy.parseCopyTarget("User:140000005"), { raw: "140000005" });
  assert.deepEqual(copy.parseCopyTarget(" id : 140000005 "), { raw: "140000005" });
  assert.deepEqual(copy.parseCopyTarget("140000005"), { raw: "140000005" });
  assert.deepEqual(copy.parseCopyTarget("Example Miner"), { raw: "Example Miner" });
  assert.equal(copy.parseCopyTarget("   "), null);
  assert.equal(copy.parseCopyTarget("User:"), null);

  const entries = {
    "8": { characterName: "Fleet Lead" },
    "9": { characterName: "Fleet Wing" },
    "10": {},
  };
  assert.equal(copy.matchCopySource(entries, "8").characterID, 8);
  const labeled = copy.parseCopyTarget("user:10");
  assert.equal(copy.matchCopySource(entries, labeled.raw).characterID, 10,
    "an entry with no name stored is still reachable by its id");
  assert.equal(copy.matchCopySource(entries, "fleet lead").characterID, 8);
  assert.equal(copy.matchCopySource(entries, "FLEET WING").characterID, 9);
  assert.equal(copy.matchCopySource(entries, "fleet l").characterID, 8, "a unique prefix is enough");
  assert.equal(copy.matchCopySource(entries, "eet wi").characterID, 9, "so is a unique substring");
  assert.equal(copy.matchCopySource(entries, "fleet").error, "ambiguous");
  assert.deepEqual(copy.matchCopySource(entries, "fleet").candidates, ["8", "9"]);
  assert.equal(copy.matchCopySource(entries, "nobody").error, "not-found");
  assert.equal(copy.matchCopySource(entries, "140000099").error, "not-found");
  // The listing asks the same questions but keeps every answer, so "copy list
  // fleet" can show both characters where "copy fleet" refuses to guess one.
  assert.deepEqual(copy.matchStoredCharacters(entries, "fleet"), [8, 9]);
  assert.deepEqual(copy.matchStoredCharacters(entries, "fleet l"), [8], "the tightest tier wins");
  assert.deepEqual(copy.matchStoredCharacters(entries, "10"), [10], "an id is an id");
  assert.deepEqual(copy.matchStoredCharacters(entries, "nobody"), []);
  assert.deepEqual(copy.matchStoredCharacters(entries, "   "), []);
  assert.equal(copy.hasCopyableSettings(entries["8"]), false, "a name alone is not a setup");
  assert.equal(copy.hasCopyableSettings({ characterName: "x", targetMode: "focus" }), true);
});

test("chat: /aud m copy finds a character and hands their setup over", () => {
  const store = makePlayersFile("copy");
  const players = playerSettings.createPlayerStore({ file: store.file });
  const world = makeWorld({
    drones: [makeDrone({ itemID: 2001, typeID: ORE_DRONE_TYPE, controllerID: 1000 })],
  });
  const config = makeConfig();
  const runtime = createRuntime({ config, deps: world.deps, players });
  const lead = { characterID: 8, characterName: "Fleet Lead" };
  const alt = { characterID: 7, characterName: "Alt Two" };

  chatCommand.handleCommand(runtime, config, lead, "m " + "focus");
  chatCommand.handleCommand(runtime, config, lead, "m " + "threshold 3");
  chatCommand.handleCommand(runtime, config, lead, "m " + "range 45000");
  chatCommand.handleCommand(runtime, config, lead, "m " + "filter add pyroxeres veldspar");
  chatCommand.handleCommand(runtime, config, lead, "m " + "fallback idle");
  runtime.setPlayerControlPolicy(7, "off", { characterName: "Alt Two" });

  // "/aud m copy" on its own is the shape of the command and nothing else, and
  // the roster answers to "copy list" so a bare copy stays short.
  const usage = chatCommand.handleCommand(runtime, config, alt, "copy");
  assert.match(usage.message, /part of a name is enough/);
  assert.match(usage.message, /\/aud copy User:140000005/);
  assert.match(usage.message, /\/aud copy list \[name\]/);
  assert.equal(/Fleet Lead/.test(usage.message), false, "a bare copy lists nobody");

  const listed = chatCommand.handleCommand(runtime, config, alt, "copy list");
  assert.match(listed.message, /copy list - 2 character\(s\) stored here/);
  assert.match(listed.message, /character\(s\) stored here/);
  assert.match(listed.message, /Fleet Lead/);
  assert.match(listed.message, /pyroxeres, veldspar/);
  assert.match(listed.message, /\(you\)/, "the caller is marked in the list");

  // The listing narrows itself with the same name matching a copy takes, and
  // it keeps every match instead of refusing an ambiguous one.
  const narrowed = chatCommand.handleCommand(runtime, config, alt, "copy list fleet");
  assert.match(narrowed.message, /copy list "fleet" - 1 of 2 character\(s\) match/);
  assert.equal(/Alt Two/.test(narrowed.message), false, "the caller is filtered out too");
  const byLabel = chatCommand.handleCommand(runtime, config, alt, "copy list User:8");
  assert.match(byLabel.message, /copy list "8" - 1 of 2 character\(s\) match/,
    "the label the client shows works as a filter too");
  const noMatch = chatCommand.handleCommand(runtime, config, alt, "copy list nobody");
  assert.match(noMatch.message, /nobody stored here matches "nobody"/);

  const copied = chatCommand.handleCommand(runtime, config, alt, "copy User:8");
  assert.match(copied.message, /copied Fleet Lead \(8\) onto you/);
  assert.match(copied.message, /automation : ON \(focus\)/);
  assert.match(copied.message, /threshold  : 3 m3/);
  assert.match(copied.message, /range      : 45\.0 km/);
  assert.match(copied.message, /fallback idle/);
  assert.match(copied.message, /new queue within a second/);

  const source = runtime.getPlayerState(8);
  const target = runtime.getPlayerState(7);
  for (const field of [
    "enabled", "targetMode", "rangeOverrideMeters", "minHoldFreeVolumeM3",
    "playerControlPolicy", "filterFallback",
  ]) {
    assert.deepEqual(target[field], source[field], field + " must match the source");
  }
  assert.deepEqual(target.oreFilter, source.oreFilter);
  assert.equal(target.playerControlPolicy, "hold",
    "the leftover takeover setting is replaced instead of merged");

  runtime.clearPlayerSettings(7);
  const byName = chatCommand.handleCommand(runtime, config, alt, "copy fleet lead");
  assert.match(byName.message, /copied Fleet Lead \(8\) onto you/);
  assert.deepEqual(runtime.getPlayerState(7).oreFilter, ["pyroxeres", "veldspar"]);

  runtime.clearPlayerSettings(7);
  const misspelt = chatCommand.handleCommand(runtime, config, alt, "copy fleet leda");
  assert.match(misspelt.message, /copied Fleet Lead \(8\) onto you/,
    "a name that is one letter off still finds the character");

  runtime.setPlayerEnabled(9, true, { characterName: "Fleet Lead Two" });
  const ambiguous = chatCommand.handleCommand(runtime, config, alt, "copy fleet");
  assert.match(ambiguous.message, /more than one character/);
  assert.match(ambiguous.message, /9 \(Fleet Lead Two\)/);

  const reordered = chatCommand.handleCommand(runtime, config, alt, "copy lead two");
  assert.match(reordered.message, /copied Fleet Lead Two \(9\) onto you/,
    "the words of a name may be typed in any order");

  const unknown = chatCommand.handleCommand(runtime, config, alt, "copy nobody");
  assert.match(unknown.message, /no character matching "nobody" has settings stored here/);

  const self = chatCommand.handleCommand(runtime, config, lead, "copy 8");
  assert.match(self.message, /that is you/);

  const off = chatCommand.handleCommand(runtime, makeConfig({ allowPlayerCopy: false }), alt, "copy 8");
  assert.match(off.message, /disabled by the server/);

  const readOnly = makeConfig({ allowPlayerToggle: false });
  const gated = chatCommand.handleCommand(runtime, readOnly, alt, "copy 8");
  assert.match(gated.message, /disabled by the server/);
  const stillListed = chatCommand.handleCommand(runtime, readOnly, alt, "copy list");
  assert.match(stillListed.message, /Fleet Lead/, "the list is read-only, so it still answers");
  const offListing = chatCommand.handleCommand(
    runtime, makeConfig({ allowPlayerCopy: false }), alt, "copy list");
  assert.match(offListing.message, /disabled by the server/,
    "allowPlayerCopy: false removes the listing too");

  fs.rmSync(store.dir, { recursive: true, force: true });
});
// ---------------------------------------------------------------------------
// Salvage: another kind of drone, another set of wrecks
// ---------------------------------------------------------------------------

test("salvage: only the pilot's own wreck is worked, and the nearest one first", () => {
  const world = makeWorld({
    rocks: [],
    drones: salvageSquad(1),
    wrecks: [makeWreck(4001, 9000, 7), makeWreck(4002, 5000, 99)],
  });
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps });
  assert.equal(runtime.getSalvageState(7).foreign, "off",
    "own wrecks only is the default, as the game's own auto-salvage is");
  runtime.onSceneTick(world.scene, 1000);
  assert.deepEqual(world.calls.salvage.map((call) => call.targetID), [4001]);
  assert.equal(world.calls.warnings.length, 0,
    "a wreck that is skipped in silence must not be announced");
  assert.equal(world.calls.mine.length, 0, "no rock, no mining order");

  // A nearer wreck of the pilot's own wins over a further one.
  const nearer = makeWorld({
    rocks: [],
    drones: salvageSquad(1),
    wrecks: [makeWreck(4001, 30000, 7), makeWreck(4002, 5000, 7)],
  });
  const nearerRuntime = createRuntime({ config: makeConfig(), deps: nearer.deps });
  nearerRuntime.onSceneTick(nearer.scene, 1000);
  assert.deepEqual(nearer.calls.salvage.map((call) => call.targetID), [4002]);
});

test("salvage: distance farthest starts at the far end of the field", () => {
  const world = makeWorld({
    rocks: [],
    drones: salvageSquad(1),
    wrecks: [makeWreck(4001, 9000, 7), makeWreck(4002, 30000, 7)],
  });
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps });
  assert.equal(runtime.getSalvageState(7).distance, "nearest");
  assert.match(runtime.setPlayerSalvageDistance(7, "farthest") ? "ok" : "", /ok/);
  runtime.onSceneTick(world.scene, 1000);
  assert.deepEqual(world.calls.salvage.map((call) => call.targetID), [4002],
    "farthest first is for a pilot clearing a belt from the far end");
});

test("salvage: another pilot's wreck is worked, and warned about once per launch", () => {
  const world = makeWorld({
    rocks: [],
    drones: salvageSquad(1),
    wrecks: [makeWreck(4002, 5000, 99)],
  });
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps });
  runtime.setPlayerSalvageForeign(7, "warn");
  runtime.onSceneTick(world.scene, 1000);
  assert.deepEqual(world.calls.salvage.map((call) => call.targetID), [4002]);
  assert.equal(world.calls.warnings.length, 1);
  assert.match(world.calls.warnings[0].message, /^AdvancedUtilityDrones warning: wreck 4002/);
  assert.match(world.calls.warnings[0].message, /belongs to character 99/);
  assert.match(world.calls.warnings[0].message, /salvaging it makes you a suspect/);
  assert.match(world.calls.warnings[0].message, /"\/aud s foreign off"/);

  // The same wreck on the next scan is not announced a second time: the warning
  // is per launch, not per scan.
  runtime.onSceneTick(world.scene, 2000);
  assert.equal(world.calls.warnings.length, 1);
  assert.equal(world.calls.salvage.length, 2, "the drones are still sent to work it");

  // Launching them again is a fresh start, which is when the pilot is told
  // again - the operator's own words: every time the drones go out.
  runtime.resumeDrones(world.session, "salvage");
  runtime.onSceneTick(world.scene, 3000);
  assert.equal(world.calls.warnings.length, 2);

  // "allow" works the same wreck without a word.
  const quiet = makeWorld({
    rocks: [],
    drones: salvageSquad(1),
    wrecks: [makeWreck(4002, 5000, 99)],
  });
  const quietRuntime = createRuntime({ config: makeConfig(), deps: quiet.deps });
  quietRuntime.setPlayerSalvageForeign(7, "allow");
  quietRuntime.onSceneTick(quiet.scene, 1000);
  assert.deepEqual(quiet.calls.salvage.map((call) => call.targetID), [4002]);
  assert.equal(quiet.calls.warnings.length, 0);
});

test("salvage: a wreck the safety light refuses is skipped, with a warning", () => {
  const world = makeWorld({
    rocks: [],
    drones: salvageSquad(1),
    wrecks: [makeWreck(4001, 9000, 7), makeWreck(4002, 5000, 99)],
    lootAccess: () => ({
      success: false,
      errorMsg: "SafetyActivated",
      entitled: false,
      requiresSuspectTimer: false,
    }),
  });
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps });
  runtime.setPlayerSalvageForeign(7, "allow");
  runtime.onSceneTick(world.scene, 1000);
  assert.equal(world.calls.salvage.length, 0,
    "a wreck the loot rules refuse is never sent a drone, whatever \"foreign\" says");
  assert.equal(world.calls.warnings.length, 2, "one line per wreck, once");
  assert.match(world.calls.warnings[0].message, /safety light will not allow/);
  assert.match(world.calls.warnings[0].message, /Set the light to yellow/);

  // Still once per wreck per launch, not once per scan.
  runtime.onSceneTick(world.scene, 2000);
  assert.equal(world.calls.warnings.length, 2);
  runtime.resumeDrones(world.session, "salvage");
  runtime.onSceneTick(world.scene, 3000);
  assert.equal(world.calls.warnings.length, 4);
});

test("salvage: a hull that launches fifty drones puts every one of them to work", () => {
  const wrecks = () => [makeWreck(4001, 9000, 7), makeWreck(4002, 20000, 7)];

  // spread: the near wreck fills up and the rest spill onto the far one, instead
  // of a claim map made for a five-drone squadron leaving the rest idle.
  const spread = makeWorld({ rocks: [], drones: salvageSquad(50), wrecks: wrecks() });
  const spreadRuntime = createRuntime({ config: makeConfig(), deps: spread.deps });
  spreadRuntime.onSceneTick(spread.scene, 1000);
  assert.equal(spread.calls.salvage.length, 50, "every idle drone gets a wreck");
  const byWreck = new Map();
  for (const call of spread.calls.salvage) {
    byWreck.set(call.targetID, (byWreck.get(call.targetID) || 0) + 1);
  }
  assert.equal((byWreck.get(4001) || 0) + (byWreck.get(4002) || 0), 50);
  assert.ok((byWreck.get(4001) || 0) > 0 && (byWreck.get(4002) || 0) > 0,
    "spread mode spills onto the second wreck");

  // focus: one wreck, fifty drones, none left home.
  const focus = makeWorld({ rocks: [], drones: salvageSquad(50), wrecks: wrecks() });
  const focusRuntime = createRuntime({
    config: makeConfig({ salvageTargetMode: "focus" }),
    deps: focus.deps,
  });
  focusRuntime.onSceneTick(focus.scene, 1000);
  assert.equal(focus.calls.salvage.length, 50);
  assert.deepEqual([...new Set(focus.calls.salvage.map((call) => call.targetID))], [4001]);
});

test("mining: a hull that launches fifty drones puts every one of them to work", () => {
  const drones = [];
  for (let index = 0; index < 50; index += 1) {
    drones.push(makeDrone({ itemID: 2001 + index, typeID: ORE_DRONE_TYPE, controllerID: 1000 }));
  }
  const world = makeWorld({
    drones,
    rocks: [makeRock(3001, "ore", 1230, 9000), makeRock(3002, "ore", 1230, 20000)],
  });
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps });
  runtime.onSceneTick(world.scene, 1000);
  assert.equal(world.calls.mine.length, 50, "every idle drone gets a rock");
  const byRock = new Map();
  for (const call of world.calls.mine) {
    byRock.set(call.targetID, (byRock.get(call.targetID) || 0) + 1);
  }
  assert.equal((byRock.get(3001) || 0) + (byRock.get(3002) || 0), 50);
});

test("salvage: two hulls sharing a field do not count a wreck against each other", () => {
  // Three drones on one hull and one on another, and two wrecks both pilots may
  // take. The first hull's drones claim the near wreck; the second hull's drone
  // must still fly to the nearest one rather than be pushed to the far wreck by
  // claims that are not its own.
  const world = makeWorld({
    rocks: [],
    drones: [
      ...salvageSquad(3),
      makeDrone({ itemID: 2101, typeID: SALVAGE_DRONE_TYPE, controllerID: 1001 }),
    ],
    wrecks: [makeWreck(4001, 10000, 7), makeWreck(4002, 20000, 7)],
    secondShip: { itemID: 1001, characterID: 8 },
    lootAccess: () => ({ success: true, entitled: true, requiresSuspectTimer: false }),
  });
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps });
  runtime.onSceneTick(world.scene, 1000);
  assert.equal(world.calls.salvage.length, 4);
  const firstHull = world.calls.salvage.slice(0, 3).map((call) => call.targetID);
  assert.deepEqual(firstHull, [4001, 4002, 4001],
    "the near wreck fills first, then the second drone spills onto the far one");
  const secondHull = world.calls.salvage[3];
  assert.deepEqual(secondHull.droneIDs, [2101]);
  assert.equal(secondHull.targetID, 4001,
    "the second hull's drone goes to the nearest wreck: one claim map per hull");
});

test("drones: a third-party hull's drones are flown by their effect, not their name", () => {
  // "Swarm Harvester XLS" contains no word any rule of ours looks for: with the
  // game's effect records saying what it does, it is still flown - and the same
  // probe says which kind.
  const salvage = makeWorld({
    rocks: [],
    drones: [makeDrone({ itemID: 2001, typeID: THIRD_PARTY_DRONE_TYPE, controllerID: 1000 })],
    wrecks: [makeWreck(4001, 9000, 7)],
    salvageByEffectTypeIDs: [THIRD_PARTY_DRONE_TYPE],
  });
  const salvageRuntime = createRuntime({ config: makeConfig(), deps: salvage.deps });
  assert.equal(
    salvageRuntime._testing.classifyDroneKind(
      salvage.drones[0], salvage.deps.getItemTypeRegistry(), salvage.shipEntity),
    "salvage",
  );
  salvageRuntime.onSceneTick(salvage.scene, 1000);
  assert.deepEqual(salvage.calls.salvage.map((call) => call.targetID), [4001]);

  const mining = makeWorld({
    drones: [makeDrone({ itemID: 2001, typeID: THIRD_PARTY_DRONE_TYPE, controllerID: 1000 })],
    rocks: [makeRock(3001, "ore", 1230, 9000)],
    miningByEffectTypeIDs: [THIRD_PARTY_DRONE_TYPE],
  });
  const miningRuntime = createRuntime({ config: makeConfig(), deps: mining.deps });
  assert.equal(
    miningRuntime._testing.classifyDroneKind(
      mining.drones[0], mining.deps.getItemTypeRegistry(), mining.shipEntity),
    "ore",
  );
  miningRuntime.onSceneTick(mining.scene, 1000);
  assert.deepEqual(mining.calls.mine.map((call) => call.targetID), [3001]);

  // A drone whose name and effect both say nothing is still left alone: the mod
  // flies ore, ice and salvage, and nothing else.
  const combat = makeWorld({
    drones: [makeDrone({ itemID: 2001, typeID: 99999, controllerID: 1000 })],
    wrecks: [makeWreck(4001, 9000, 7)],
  });
  const combatRuntime = createRuntime({ config: makeConfig(), deps: combat.deps });
  assert.equal(
    combatRuntime._testing.classifyDroneKind(
      combat.drones[0], combat.deps.getItemTypeRegistry(), combat.shipEntity),
    null,
  );
  combatRuntime.onSceneTick(combat.scene, 1000);
  assert.equal(combat.calls.salvage.length + combat.calls.mine.length, 0);
});

test("chat: the salvage menu is its own set of switches", () => {
  const world = makeWorld({
    rocks: [],
    drones: salvageSquad(1),
    wrecks: [makeWreck(4001, 9000, 7)],
  });
  const config = makeConfig();
  const runtime = createRuntime({ config, deps: world.deps });
  const run = (line) => chatCommand.handleCommand(runtime, config, world.session, line);

  assert.match(run("s help").message, /the commands that follow \/aud s/);
  assert.match(run("s help").message, /\/aud s foreign off\|warn\|allow/);
  assert.match(run("s status").message, /AdvancedUtilityDrones v.* salvage/);
  assert.match(run("s status").message, /foreign\s+: off/);
  assert.match(run("s status").message, /cargo hold/);
  assert.match(run("s list").message, /wrecks in range/);
  assert.match(run("s list").message, /\(4001\) .*yours to take, no flag/);

  assert.match(run("s off").message, /salvage OFF for you/);
  assert.equal(runtime.getSalvageState(7).enabled, false);
  assert.equal(runtime.getPlayerState(7).enabled, true,
    "the mining switch is a different switch");
  assert.match(run("s on").message, /salvage ON for you/);
  assert.equal(runtime.getSalvageState(7).enabled, true);

  assert.match(run("s focus").message, /salvage targeting mode: FOCUS/);
  assert.equal(runtime.getSalvageState(7).targetMode, "focus");
  assert.equal(runtime.getPlayerState(7).targetMode, "spread");

  assert.match(run("s distance").message, /distance: nearest first/);
  assert.match(run("s distance farthest").message, /distance: farthest first/);
  assert.match(run("s distance sideways").message, /must be "nearest" or "farthest"/);

  assert.match(run("s foreign").message, /foreign: off/);
  assert.match(run("s foreign warn").message, /foreign: warn/);
  assert.match(run("s foreign off").message, /foreign: off/);
  assert.match(run("s foreign sideways").message, /must be "off", "warn" or "allow"/);
  assert.match(run("s bogus").message, /unknown option "bogus"/);

  // The shared commands answer from this menu too, and so does the whole-character
  // reset - one kind at a time.
  assert.match(run("s range 45000").message, /search radius set to 45\.0 km/);
  assert.match(run("s threshold 5").message, /threshold: 5 m3/);
  assert.match(run("s control recall").message, /takeover: RECALL/);
  run("s foreign warn");
  run("s reset");
  const afterReset = runtime.getSalvageState(7);
  assert.equal(afterReset.foreign, "off", "the salvage keys are back on the defaults");
  assert.equal(afterReset.targetMode, "spread");
  assert.equal(afterReset.rangeOverrideMeters, 45000,
    "the radius is shared, so a kind reset leaves it alone");
  assert.equal(afterReset.playerControlPolicy, "recall");
});

test("players: a 1.3.0 flat entry is read as the mining kind", () => {
  const store = makePlayersFile("flat");
  fs.mkdirSync(store.dir, { recursive: true });
  fs.writeFileSync(store.file, JSON.stringify({
    characters: {
      "7": {
        characterName: "Flat Entry",
        enabled: false,
        targetMode: "focus",
        oreFilter: ["veldspar"],
        filterFallback: "idle",
        filterGrade: true,
        minHoldFreeVolumeM3: 7,
        playerControlPolicy: "off",
        rangeOverrideMeters: 42000,
      },
    },
  }, null, 2), "utf8");
  const players = playerSettings.createPlayerStore({ file: store.file });
  const world = makeWorld();
  const runtime = createRuntime({ config: makeConfig(), deps: world.deps, players });

  const mining = runtime.getPlayerState(7);
  assert.equal(mining.source, "player");
  assert.equal(mining.enabled, false);
  assert.equal(mining.targetMode, "focus");
  assert.deepEqual(mining.oreFilter, ["veldspar"]);
  assert.equal(mining.filterFallback, "idle");
  assert.equal(mining.filterGrade, true);
  assert.equal(mining.minHoldFreeVolumeM3, 7);
  assert.equal(mining.playerControlPolicy, "off");
  assert.equal(mining.rangeOverrideMeters, 42000);

  // The flat entry says nothing about salvage, so the salvage switches are on
  // the server defaults - and the shared keys are shared.
  const salvage = runtime.getSalvageState(7);
  assert.equal(salvage.enabled, configModule.DEFAULTS.salvageEnabled);
  assert.equal(salvage.targetMode, configModule.DEFAULTS.salvageTargetMode);
  assert.equal(salvage.distance, "nearest");
  assert.equal(salvage.foreign, "off");
  assert.equal(salvage.minHoldFreeVolumeM3, 7, "the threshold is shared");
  assert.equal(salvage.rangeOverrideMeters, 42000, "and so is the radius");

  // Writing one salvage key must not rewrite the mining half into the salvage
  // half, or drop either of them.
  runtime.setPlayerSalvageForeign(7, "warn");
  const written = JSON.parse(fs.readFileSync(store.file, "utf8")).characters["7"];
  assert.equal(written.salvage.foreign, "warn");
  assert.equal(written.mining.targetMode, "focus");
  assert.deepEqual(written.mining.oreFilter, ["veldspar"]);
  assert.equal(written.minHoldFreeVolumeM3, 7);
  fs.rmSync(store.dir, { recursive: true, force: true });
});
// The installer suite ships beside the mod in the development tree and in the
// installer package; a mod folder copied straight into mods/ has neither.
require("./installer.js")({ test, modDir });

let failures = 0;
for (const entry of tests) {
  try {
    entry.fn();
    console.log(`  ok  ${entry.name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${entry.name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}
console.log(`\n${tests.length - failures}/${tests.length} passed`);
if (failures > 0) {
  process.exitCode = 1;
}