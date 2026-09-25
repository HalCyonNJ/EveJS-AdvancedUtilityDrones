"use strict";

const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { isMainThread } = require("node:worker_threads");

const configModule = require("./config");
const chatCommand = require("./lib/chatCommand");
const plainChat = require("./lib/plainChat");
const commandScope = require("./lib/commandScope");
const { createPlayerStore } = require("./lib/playerSettings");
const { createRuntime, createServerDeps } = require("./lib/runtime");

const MOD_VERSION = "1.0.3";
const MOD_DIR = __dirname;
const RUNTIME_ROOT = path.resolve(MOD_DIR, "../..");
const LOG_PREFIX = "[AdvancedUtilityDrones]";
const INSTALL_FLAG = "__advancedUtilityDronesLoaderInstalled";
const API_SYMBOL = "evejs.advancedUtilityDrones";
const TICK_MARKER = Symbol.for("evejs.advancedUtilityDrones.tickScene");
const COMMAND_MARKER = Symbol.for("evejs.advancedUtilityDrones.command");
const LAUNCH_MARKER = Symbol.for("evejs.advancedUtilityDrones.launch");

// Three vendor files are touched, and none of them is rewritten on disk: the
// drone runtime is wrapped through its exported tickScene, chatCommands through
// its exported executeChatCommand (the slash.SlashCmd path) and chatRuntime
// through its exported broadcastLocalMessage (the ordinary-chat path). Every
// edit happens at load time through Module._load chaining, so the other loader
// mods - including the ones that rewrite droneRuntime, space/runtime.js or
// miningRuntimeState source, or overlay chatCommands - keep working no matter
// which order they install in.
const TARGETS = Object.freeze({
  droneRuntime: "server/src/services/drone/droneRuntime.js",
  chatCommands: "server/src/services/chat/chatCommands.js",
  chatRuntime: "server/src/_secondary/chat/chatRuntime.js",
});

// The orders a player can give a drone by hand. The server dispatches every one
// of them from its own entityService, so a call that did not come from this mod
// (see lib/commandScope) is a takeover: that drone is left alone until it is
// scooped back into the bay and launched again.
const PLAYER_COMMANDS = Object.freeze([
  "commandMineRepeatedly",
  "commandEngage",
  "commandSalvage",
  "commandAssist",
  "commandGuard",
  "commandReturnHome",
  "commandReturnBay",
  "commandAbandonDrone",
  "commandReconnectToDrones",
]);

function log(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

function logError(message, error = null) {
  console.error(`${LOG_PREFIX} ${message}`);
  if (error && error.stack) {
    console.error(error.stack);
  }
}

function canonicalize(filename, options = {}) {
  const platform = options.platform || process.platform;
  const resolved = path.resolve(String(filename || ""));
  const realpath = options.realpath || (fs.realpathSync.native || fs.realpathSync);
  let canonical;
  try {
    canonical = realpath(resolved);
  } catch (_error) {
    canonical = resolved;
  }
  if (platform === "win32") {
    return path.win32.normalize(canonical.replace(/\//gu, "\\")).toLowerCase();
  }
  return path.posix.normalize(canonical.replace(/\\/gu, "/"));
}

function resolveFilename(request, parent, isMain) {
  try {
    return Module._resolveFilename(request, parent, isMain);
  } catch (_error) {
    return null;
  }
}

function buildTargetMap(runtimeRoot, options = {}) {
  const targetMap = new Map();
  for (const [key, relative] of Object.entries(TARGETS)) {
    const filename = path.resolve(runtimeRoot, ...relative.split("/"));
    targetMap.set(canonicalize(filename, options), Object.freeze({
      key,
      relative,
      filename,
    }));
  }
  return targetMap;
}

function install(options = {}) {
  if (!isMainThread && options.allowWorker !== true) {
    return { active: false, reason: "worker-thread" };
  }
  if (globalThis[INSTALL_FLAG]) {
    return globalThis[INSTALL_FLAG];
  }

  const runtimeRoot = path.resolve(options.runtimeRoot || RUNTIME_ROOT);
  const environment = options.environment || process.env;
  const config = configModule.load(MOD_DIR, environment, { runtimeRoot });
  if (!config.enabled) {
    log("inert — disabled by configuration; mining drones stay manual");
    return { active: false, reason: "disabled", config };
  }
  if (config.problems.length > 0) {
    for (const problem of config.problems) {
      logError(problem);
    }
    logError("invalid mod-owned configuration — no hooks installed");
    return { active: false, reason: "invalid-config", config };
  }

  const deps = options.deps || createServerDeps(runtimeRoot);
  const players = options.players || createPlayerStore({
    file: config.playersFilename,
    log: config.verbose ? log : () => {},
    logError: (message, error) => logError(message, error),
  });
  const runtime = createRuntime({
    config,
    deps,
    players,
    runtimeRoot,
    log: config.verbose ? log : () => {},
    logError: (message, error) => logError(message, error),
  });
  const targetMap = buildTargetMap(runtimeRoot, options);
  const previousLoad = Module._load;
  const applied = new Set();

  function applyTarget(target, exported) {
    if (!exported || typeof exported !== "object") {
      return exported;
    }
    if (target.key === "droneRuntime") {
      return wrapDroneRuntime(exported);
    }
    if (target.key === "chatCommands") {
      return overlayChatCommands(exported);
    }
    return overlayChatRuntime(exported);
  }

  function wrapDroneRuntime(exported) {
    if (typeof exported.tickScene !== "function") {
      logError("droneRuntime.tickScene is missing — no auto-mining hook installed");
      return exported;
    }
    if (exported.tickScene[TICK_MARKER] === true) {
      return exported;
    }
    const descriptor = Object.getOwnPropertyDescriptor(exported, "tickScene");
    if (!descriptor || descriptor.writable !== true) {
      logError("droneRuntime.tickScene is not writable — no auto-mining hook installed");
      return exported;
    }
    const original = exported.tickScene;
    const wrapped = function advancedUtilityDronesTickScene(scene, now) {
      const result = original.call(this, scene, now);
      try {
        runtime.onSceneTick(scene, now);
      } catch (error) {
        logError(`scene pass failed: ${error && error.message}`);
      }
      return result;
    };
    wrapped[TICK_MARKER] = true;
    exported.tickScene = wrapped;
    wrapPlayerCommands(exported);
    wrapDroneLaunch(exported);
    applied.add("droneRuntime");
    log(
      `drone tick hook installed — idle drones are re-tasked every ` +
      `${config.scanIntervalMs} ms (mining ${config.targetMode}, ` +
      `salvage ${config.salvageTargetMode})`,
    );
    return exported;
  }

  // entityService destructures these functions once and then calls them forever,
  // so marking our own calls through lib/commandScope is the only way to tell a
  // player's order from the one this mod just issued.
  function wrapPlayerCommands(exported) {
    for (const name of PLAYER_COMMANDS) {
      const original = exported[name];
      if (typeof original !== "function" || original[COMMAND_MARKER] === true) {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(exported, name);
      if (!descriptor || descriptor.writable !== true) {
        continue;
      }
      const wrapped = function advancedUtilityDronesPlayerCommand(session, first) {
        if (!commandScope.isInternal()) {
          try {
            runtime.notePlayerCommand(name, session, first);
          } catch (error) {
            logError("could not track a manual order: " + (error && error.message));
          }
        }
        return original.apply(this, arguments);
      };
      wrapped[COMMAND_MARKER] = true;
      exported[name] = wrapped;
    }
  }

  // A drone that comes back out of the bay is automated again, whatever the
  // player did with the one that went in.
  function wrapDroneLaunch(exported) {
    const original = exported.launchDronesForSession;
    if (typeof original !== "function" || original[LAUNCH_MARKER] === true) {
      return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(exported, "launchDronesForSession");
    if (!descriptor || descriptor.writable !== true) {
      return;
    }
    const wrapped = function advancedUtilityDronesLaunchDrones(session, ...rest) {
      const result = original.apply(this, [session, ...rest]);
      try {
        runtime.resumeDrones(session);
      } catch (error) {
        logError("could not reset a launched drone: " + (error && error.message));
      }
      return result;
    };
    wrapped[LAUNCH_MARKER] = true;
    exported.launchDronesForSession = wrapped;
  }

  function overlayChatCommands(exported) {
    try {
      const result = chatCommand.install(exported, { runtime, config });
      if (result && result[chatCommand.OVERLAY_MARKER] && !applied.has("chatCommands")) {
        applied.add("chatCommands");
        log(
          `chat command overlay installed — /${chatCommand.COMMAND_NAMES[0]} works for every ` +
          "character and needs no staff rights",
        );
      }
    } catch (error) {
      logError(`chat command overlay failed: ${error && error.message}`);
    }
    return exported;
  }

  // The ordinary-chat path. A line without a leading "/" never becomes a
  // slash.SlashCmd call, so the !trigger has to be consumed where the message
  // would otherwise be broadcast; lib/plainChat.js explains why the thrown error
  // there is the reply rather than a failure.
  function overlayChatRuntime(exported) {
    try {
      const result = plainChat.install(exported, { runtime, config, chatCommand });
      if (result && result[plainChat.OVERLAY_MARKER] && !applied.has("chatRuntime")) {
        applied.add("chatRuntime");
        log(
          `plain-chat trigger installed — !${chatCommand.TRIGGER_NAMES[0]} works for every ` +
          "character, staff or not, and the line is never broadcast",
        );
      }
    } catch (error) {
      logError(`plain-chat overlay failed: ${error && error.message}`);
    }
    return exported;
  }

  function tryApplyCachedTargets() {
    for (const filename of Object.keys(Module._cache)) {
      const target = targetMap.get(canonicalize(filename, options));
      if (!target || applied.has(target.key)) {
        continue;
      }
      const cached = Module._cache[filename];
      if (cached && cached.exports) {
        applyTarget(target, cached.exports);
      }
    }
  }

  function hookedLoad(request, parent, isMain) {
    const exported = previousLoad.apply(this, arguments);
    if (Module.isBuiltin(request)) {
      return exported;
    }
    const filename = resolveFilename(request, parent, isMain);
    if (!filename) {
      return exported;
    }
    const target = targetMap.get(canonicalize(filename, options));
    if (!target) {
      return exported;
    }
    try {
      return applyTarget(target, exported) || exported;
    } catch (error) {
      logError(`target patch failed: ${error && error.message}`);
      return exported;
    }
  }

  Module._load = hookedLoad;
  tryApplyCachedTargets();

  const api = Object.freeze({
    version: MOD_VERSION,
    config,
    runtime,
    players,
    targets: Object.freeze({ ...TARGETS }),
    applied: () => [...applied],
  });
  const installState = Object.freeze({
    active: true,
    reason: null,
    config,
    runtime,
    targetMap,
    previousLoad,
    hookedLoad,
    api,
  });
  globalThis[API_SYMBOL] = api;
  globalThis[INSTALL_FLAG] = installState;
  log(
    `v${MOD_VERSION} loader ready — control range follows the ship by default; ` +
    `settings come from config/${configModule.CONFIG_FILENAME}, the mod's .env ` +
    `or ${configModule.KEYS.rangeMeters}` +
    (config.sources.length > 0 ? ` (read: ${config.sources.join(", ")})` : ""),
  );
  log(
    `per-character choices live in ${config.playersFilename} ` +
    `(loaded: ${players.stats().characters} character(s)); ` +
    (config.chatTrigger
      ? "the /aud command and the plain-chat !aud trigger work for every character " +
        "(/aud mining for the mining drones, /aud salvage for the salvage drones)"
      : "the plain-chat !aud trigger is switched off by configuration"),
  );
  return installState;
}

let installResult = null;
try {
  installResult = install();
} catch (error) {
  logError("loader failed before activation", error);
  installResult = { active: false, reason: "exception", error };
}

module.exports = {
  API_SYMBOL,
  INSTALL_FLAG,
  LOG_PREFIX,
  MOD_DIR,
  MOD_VERSION,
  PLAYER_COMMANDS,
  RUNTIME_ROOT,
  TARGETS,
  installResult,
  install,
  _testing: Object.freeze({
    buildTargetMap,
    canonicalize,
  }),
};
