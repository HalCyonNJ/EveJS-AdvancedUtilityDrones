"use strict";

/**
 * Advanced Utility Drones - uninstall / rollback.
 *
 * Removes the two preload registrations (Docker entrypoint and the native
 * StartServer.bat launcher) and retires the mod folder. The removals are surgical rather than
 * restored from a whole-file backup, so uninstalling this mod never undoes
 * another mod that registered itself later.
 *
 * Usage:
 *   node uninstall.js                   (EveJS is found on this machine)
 *   node uninstall.js --server "D:\eve\v0.12.9"
 *   node uninstall.js --server "D:\eve\v0.12.9" --dry-run
 *   node uninstall.js --server "D:\eve\v0.12.9" --keep-files
 *   node uninstall.js --status --server "D:\eve\v0.12.9"
 */

const fs = require("node:fs");
const path = require("node:path");

const deployment = require("./lib/deployment");
const loaderAudit = require("./lib/loaderAudit");
const register = require("./lib/register");

const INSTALLER_DIR = __dirname;

// Exactly the two files the installer created for this mod.
const CONFIG_DIRNAME = "config";
const CONFIG_FILES = Object.freeze([
  "advancedUtilityDrones.json",
  "advancedUtilityDrones.players.json",
]);

function out(line = "") {
  process.stdout.write(`${line}\n`);
}

function fail(message) {
  out("");
  out(`[FAIL] ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {
    server: "",
    dockerOnly: false,
    nativeOnly: false,
    dryRun: false,
    keepFiles: false,
    keepConfig: false,
    status: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--server" && argv[index + 1]) options.server = argv[(index += 1)];
    else if (arg.startsWith("--server=")) options.server = arg.slice("--server=".length);
    else if (arg === "--docker-only") options.dockerOnly = true;
    else if (arg === "--native-only") options.nativeOnly = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--keep-files") options.keepFiles = true;
    else if (arg === "--keep-config") options.keepConfig = true;
    else if (arg === "--status") options.status = true;
    else if (arg === "--help" || arg === "-h") {
      out("Usage: node uninstall.js [--server <EveJS root>] [--docker-only|--native-only]");
      out("                      [--dry-run] [--keep-files] [--keep-config] [--status]");
      process.exit(0);
    } else if (!arg.startsWith("--") && !options.server) options.server = arg;
  }
  if (options.dockerOnly && options.nativeOnly) {
    fail("--docker-only and --native-only are mutually exclusive");
  }
  return options;
}

function resolveRoot(options) {
  const explicit = options.server || process.env.EVEJS_SERVER || process.env.EVEJS_ROOT || "";
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!deployment.isEveJsRoot(resolved)) {
      fail(`${resolved} does not look like an EveJS 0.12.9 root (server/index.js and droneRuntime.js must exist)`);
    }
    return resolved;
  }
  const starts = [INSTALLER_DIR, process.cwd()];
  let roots = deployment.findEveJsRoots(starts);
  if (roots.length === 0) roots = deployment.findDeeperEveJsRoots(starts);
  // Same last resort as the installer, so an uninstall works from wherever
  // the package happens to sit. An ambiguous result is never guessed at:
  // this path removes a preload, and the wrong tree must not be touched.
  if (roots.length === 0) roots = deployment.findLocalEveJsRoots();
  if (roots.length === 1) return roots[0];
  if (roots.length === 0) {
    fail('no EveJS installation was found on this machine; pass --server "<EveJS root>", for example --server "D:\\Eve\\EveJS"');
  }
  const listed = roots.slice(0, 8).join(", ") + (roots.length > 8 ? ` and ${roots.length - 8} more` : "");
  fail(`several EveJS installations were found; pass --server <root>. Candidates: ${listed}`);
}

// A mod folder that no chain mentions is installed and completely inert - it
// loads nothing, logs nothing and does nothing, and no EveJS surface says so.
// A note, not a warning: both entry points usually exist while the owner runs
// only one, and the mods named here belong to other authors.
function reportUnpreloaded(root, chains) {
  const installed = deployment.installedLoaderMods(root);
  for (const chain of chains) {
    const missing = installed.filter((id) => !chain.ids.includes(id));
    if (missing.length > 0) {
      out(`  [note] ${chain.label}: in mods/ but not preloaded by this launcher: ${missing.join(", ")}`);
    }
  }
}

// Honours the same --docker-only / --native-only switches as the install, so a
// single-deployment setup reports a single deployment.
function reportStatus(root, deployments, options = {}) {
  const modDir = path.join(root, "mods", deployment.MOD_ID);
  out(`EveJS root : ${root}`);
  out(`Mod folder : ${modDir} (${fs.existsSync(path.join(modDir, "loader.js")) ? "present" : "absent"})`);
  const chains = [];
  if (deployments.docker.present && !options.nativeOnly) {
    const text = deployment.readText(deployments.docker.entrypoint);
    const registered = register.hasEntrypointPreload(text, { requirePath: register.containerRequirePath(deployment.MOD_ID) });
    out(`Docker     : ${registered ? "registered" : "not registered"} (${deployments.docker.entrypoint})`);
    const audit = loaderAudit.auditEntrypointPreloads(text, { modId: deployment.MOD_ID });
    for (const line of loaderAudit.formatEntrypointAudit(audit)) out(line);
    chains.push({ label: "Docker", ids: audit.chain });
  }
  if (deployments.native.present && !options.dockerOnly) {
    const text = deployment.readText(deployments.native.startServerBat);
    const registered = register.hasStartServerPreload(text);
    out(`Native     : ${registered ? "registered" : "not registered"} (${deployments.native.startServerBat})`);
    // Even here the chain is worth reading back: a mod installed after this one
    // can erase its preload without any error, and this is where that shows up.
    const audit = loaderAudit.auditStartServerPreloads(text);
    for (const line of loaderAudit.formatStartServerAudit(audit)) out(line);
    chains.push({ label: "Native", ids: audit.loadedIds });
  }
  reportUnpreloaded(root, chains);
}

function removeRegistration(options) {
  const { file, label, result, preload, dryRun, write } = options;
  if (!result.ok) {
    out(`[WARN] ${label}: ${result.reason}`);
    return { failed: true };
  }
  if (!result.changed) {
    out(`[SKIP] ${label}: nothing to remove`);
    return { failed: false };
  }
  if (dryRun) {
    out(`[PLAN] ${label}: would remove ${preload}`);
    return { failed: false };
  }
  write();
  out(`[ OK ] ${label}: removed ${preload}`);
  return { failed: false };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = resolveRoot(options);
  const deployments = deployment.detectDeployments(root);

  if (options.status) {
    reportStatus(root, deployments, options);
    return;
  }

  const useDocker = deployments.docker.present && !options.nativeOnly;
  const useNative = deployments.native.present && !options.dockerOnly;

  out("============================================================");
  out("  Advanced Utility Drones - Uninstall / Rollback");
  out("============================================================");
  out(`  EveJS root : ${root}`);
  if (options.dryRun) out("  DRY RUN    : nothing will be written");
  out("------------------------------------------------------------");

  const backupRoot = path.join(root, deployment.BACKUP_DIRNAME, deployment.timestamp());

  if (useDocker) {
    const file = deployments.docker.entrypoint;
    const preload = register.containerRequirePath(deployment.MOD_ID);
    const result = register.removeEntrypointPreload(deployment.readText(file), { requirePath: preload });
    removeRegistration({
      file,
      label: "docker/entrypoint.sh",
      preload,
      result,
      dryRun: options.dryRun,
      write() {
        deployment.archivePath(root, file, backupRoot);
        deployment.writeText(file, result.text);
      },
    });
  }

  if (useNative) {
    const file = deployments.native.startServerBat;
    const preload = register.nativeRequirePath(deployment.MOD_ID);
    const result = register.removeStartServerPreload(deployment.readText(file));
    removeRegistration({
      file,
      label: deployment.NATIVE_START_SERVER,
      preload,
      result,
      dryRun: options.dryRun,
      write() {
        deployment.archivePath(root, file, backupRoot);
        deployment.writeText(file, result.text);
      },
    });
  }

  const modDir = path.join(root, "mods", deployment.MOD_ID);
  const present = fs.existsSync(modDir);
  if (!present) {
    out(`[SKIP] mods/${deployment.MOD_ID}: not present`);
  } else if (options.keepFiles) {
    out(`[SKIP] mods/${deployment.MOD_ID}: kept (--keep-files)`);
  } else if (options.dryRun) {
    out(`[PLAN] mods/${deployment.MOD_ID}: would archive and remove`);
  } else {
    const archived = deployment.archivePath(root, modDir, backupRoot);
    fs.rmSync(modDir, { recursive: true, force: true });
    out(`[ OK ] mods/${deployment.MOD_ID}: removed (archived at ${archived})`);
  }

  // 4. The mod's own configuration. Both files belong to this mod alone, so
  //    they go with it - archived first, and skipped entirely with
  //    --keep-config for an operator who wants to keep their settings.
  const configDir = path.join(root, CONFIG_DIRNAME);
  for (const name of CONFIG_FILES) {
    const file = path.join(configDir, name);
    if (!fs.existsSync(file)) {
      out(`[SKIP] ${CONFIG_DIRNAME}/${name}: not present`);
    } else if (options.keepConfig) {
      out(`[SKIP] ${CONFIG_DIRNAME}/${name}: kept (--keep-config)`);
    } else if (options.dryRun) {
      out(`[PLAN] ${CONFIG_DIRNAME}/${name}: would archive and remove`);
    } else {
      const archived = deployment.archivePath(root, file, backupRoot);
      fs.rmSync(file, { force: true });
      out(`[ OK ] ${CONFIG_DIRNAME}/${name}: removed (archived at ${archived})`);
    }
  }
  try {
    if (fs.existsSync(configDir) && fs.readdirSync(configDir).length === 0) {
      fs.rmdirSync(configDir);
    }
  } catch (_error) {
    // A config directory somebody else uses must never be in the way.
  }

  out("------------------------------------------------------------");
  out("");
  out("  Next steps");
  if (useDocker) {
    out("    Docker : docker compose build && docker compose up -d --no-deps server");
  }
  if (useNative) {
    out("    Native : restart the server with StartServer.bat");
  }
  out("");
  out("  With the preload gone mining drones stay manual, exactly like vanilla");
  out("  EveJS: launch them and they sit idle until you order them onto a rock.");
  out("");
  out("  Archived configuration is under " + backupRoot + "; use --keep-config");
  out("  next time to leave the settings in place.");
}

// A stray require() must never install anything: only a direct
// `node install.js` (or uninstall.js) is allowed to touch the server tree.
// The test suite imports the pure helpers, not this entry point.
if (require.main === module) {
  try {
    main();
  } catch (error) {
    if (!process.exitCode) process.exitCode = 1;
    if (process.env.EVEJS_ADVANCED_UTILITY_DRONES_DEBUG) out(error.stack);
  }
}

module.exports = { main, reportStatus };
