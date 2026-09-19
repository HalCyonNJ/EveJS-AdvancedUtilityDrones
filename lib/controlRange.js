"use strict";

const FALLBACK_DRONE_RANGE_BONUS_ID = 459;
const FALLBACK_DRONE_CONTROL_DISTANCE_ID = 458;
const FALLBACK_CHARACTER_TYPE_ID = 1373;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function resolveSkillLevel(record) {
  if (!record || typeof record !== "object") {
    return 0;
  }
  return Math.max(
    0,
    toInt(
      record.level ?? record.skillLevel ?? record.trainedSkillLevel ?? record.effectiveLevel,
      0,
    ),
  );
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

// Drone control range is a CHARACTER attribute (458 droneControlDistance) whose
// base is 20000 m; every bonus is an additive ItemModifier onto it:
//   * skills        - Drone Avionics 5000/level, Advanced Drone Avionics 3000/level
//                     (their 459 is scaled by level through effect 448)
//   * modules/rigs  - Drone Link Augmentor 20000/24000, Drone Control Range
//                     Augmentor rigs 15000/20000 (effect 2000 / 504, flat 459)
//   * implants and boosters - Halcyon Y-1..Y-5 4000..20000
// All of them use operation "add" (no stacking penalty), so a plain sum is the
// value the client shows. EveJS itself never resolves this attribute, which is
// why the mod has to compute it.
function createControlRangeResolver(options) {
  const config = options.config;
  const deps = options.deps;
  const log = typeof options.log === "function" ? options.log : () => {};
  const logError = typeof options.logError === "function" ? options.logError : () => {};

  let cachedAttributeIDs = null;
  function attributeIDs() {
    if (cachedAttributeIDs) {
      return cachedAttributeIDs;
    }
    let rangeBonus = null;
    let controlDistance = null;
    try {
      rangeBonus = deps.getAttributeIDByNames("droneRangeBonus");
      controlDistance = deps.getAttributeIDByNames("droneControlDistance");
    } catch (error) {
      logError(`control-range attribute lookup failed: ${error && error.message}`);
    }
    cachedAttributeIDs = {
      rangeBonus: toInt(rangeBonus, 0) || FALLBACK_DRONE_RANGE_BONUS_ID,
      controlDistance: toInt(controlDistance, 0) || FALLBACK_DRONE_CONTROL_DISTANCE_ID,
    };
    return cachedAttributeIDs;
  }

  function readRangeBonusFromItem(itemOrTypeID) {
    if (itemOrTypeID == null) {
      return 0;
    }
    const rangeBonusID = attributeIDs().rangeBonus;
    try {
      const attributes = deps.buildEffectiveItemAttributeMap(itemOrTypeID);
      const value = toFiniteNumber(attributes && attributes[rangeBonusID], 0);
      if (value > 0) {
        return value;
      }
    } catch (error) {
      logError(`control-range item attribute read failed: ${error && error.message}`);
    }
    try {
      const typeID = itemOrTypeID && typeof itemOrTypeID === "object"
        ? itemOrTypeID.typeID
        : itemOrTypeID;
      return Math.max(0, toFiniteNumber(
        deps.getTypeAttributeValue(toInt(typeID, 0), "droneRangeBonus"),
        0,
      ));
    } catch (_error) {
      return 0;
    }
  }

  function resolveBaseRange() {
    try {
      const fromData = deps.getTypeAttributeValue(
        FALLBACK_CHARACTER_TYPE_ID,
        "droneControlDistance",
      );
      const numeric = toFiniteNumber(fromData, 0);
      if (numeric > 0) {
        return numeric;
      }
    } catch (_error) {
      // Static data is unavailable or CharacterType is unpublished; the config
      // default is the same 20000 m the SDE carries.
    }
    return config.baseRangeMeters;
  }

  function sumSkillBonuses(skillMap) {
    let total = 0;
    const contributions = [];
    if (!(skillMap instanceof Map)) {
      return { total, contributions };
    }
    for (const record of skillMap.values()) {
      const typeID = toInt(record && record.typeID, 0);
      const level = resolveSkillLevel(record);
      if (typeID <= 0 || level <= 0) {
        continue;
      }
      const bonus = readRangeBonusFromItem(typeID);
      if (bonus <= 0) {
        continue;
      }
      const amount = bonus * level;
      total += amount;
      contributions.push({ typeID, level, bonus, amount });
    }
    return { total, contributions };
  }

  function sumFittedBonuses(fittedItems) {
    let total = 0;
    const contributions = [];
    if (!Array.isArray(fittedItems)) {
      return { total, contributions };
    }
    for (const item of fittedItems) {
      if (!item) {
        continue;
      }
      if (typeof deps.isEffectivelyOnlineModule === "function") {
        let online = true;
        try {
          online = deps.isEffectivelyOnlineModule(item) !== false;
        } catch (_error) {
          online = true;
        }
        if (!online) {
          continue;
        }
      }
      const bonus = readRangeBonusFromItem(item);
      if (bonus <= 0) {
        continue;
      }
      total += bonus;
      contributions.push({ typeID: toInt(item.typeID, 0), bonus });
    }
    return { total, contributions };
  }

  function sumImplantBonuses(characterID) {
    let total = 0;
    const contributions = [];
    for (const reader of ["getActiveImplants", "getActiveBoosters"]) {
      if (typeof deps[reader] !== "function") {
        continue;
      }
      let entries = [];
      try {
        entries = deps[reader](characterID) || [];
      } catch (error) {
        logError(`control-range ${reader} failed: ${error && error.message}`);
        continue;
      }
      if (!Array.isArray(entries)) {
        continue;
      }
      for (const entry of entries) {
        const bonus = readRangeBonusFromItem(toInt(entry && entry.typeID, 0));
        if (bonus <= 0) {
          continue;
        }
        total += bonus;
        contributions.push({
          typeID: toInt(entry && entry.typeID, 0),
          bonus,
          source: reader,
        });
      }
    }
    return { total, contributions };
  }

  function compute(controllerEntity, characterID) {
    if (config.rangeMode === "fixed") {
      const fixed = toFiniteNumber(config.rangeMeters, config.baseRangeMeters);
      return {
        rangeMeters: clamp(fixed, config.rangeMinMeters, config.rangeMaxMeters),
        breakdown: {
          mode: "fixed",
          base: fixed,
          skills: 0,
          modules: 0,
          implants: 0,
          raw: fixed,
          capped: clamp(fixed, config.rangeMinMeters, config.rangeMaxMeters),
          contributions: [],
        },
      };
    }

    let context = null;
    try {
      context = deps.getControllerDogmaContext(controllerEntity);
    } catch (error) {
      logError(`control-range dogma context failed: ${error && error.message}`);
    }

    const base = resolveBaseRange();
    const skills = sumSkillBonuses(context && context.skillMap);
    const modules = sumFittedBonuses(context && context.fittedItems);
    const implants = sumImplantBonuses(characterID);
    const raw = base + skills.total + modules.total + implants.total;
    const capped = clamp(raw, config.rangeMinMeters, config.rangeMaxMeters);
    return {
      fingerprint: String((context && context.fingerprint) || ""),
      rangeMeters: capped,
      breakdown: {
        mode: "ship",
        base,
        skills: skills.total,
        modules: modules.total,
        implants: implants.total,
        raw,
        capped,
        contributions: [
          ...skills.contributions,
          ...modules.contributions,
          ...implants.contributions,
        ],
      },
    };
  }

  function resolve(controllerEntity, characterID) {
    if (!controllerEntity) {
      return null;
    }
    const cached = controllerEntity.altMiningDronesRange;
    const current = compute(controllerEntity, characterID);
    if (
      cached &&
      cached.fingerprint &&
      current.fingerprint &&
      cached.fingerprint === current.fingerprint &&
      cached.rangeMeters === current.rangeMeters
    ) {
      return cached;
    }
    controllerEntity.altMiningDronesRange = current;
    if (config.verbose) {
      log(
        `control range ${Math.round(current.rangeMeters)} m ` +
        `(base ${Math.round(current.breakdown.base)}` +
        ` + skills ${Math.round(current.breakdown.skills)}` +
        ` + modules ${Math.round(current.breakdown.modules)}` +
        ` + implants ${Math.round(current.breakdown.implants)})`,
      );
    }
    return current;
  }

  return Object.freeze({
    resolve,
    describe(characterID, controllerEntity) {
      return compute(controllerEntity, characterID);
    },
  });
}

module.exports = {
  FALLBACK_CHARACTER_TYPE_ID,
  FALLBACK_DRONE_CONTROL_DISTANCE_ID,
  FALLBACK_DRONE_RANGE_BONUS_ID,
  createControlRangeResolver,
  resolveSkillLevel,
};