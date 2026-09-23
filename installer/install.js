"use strict";

/**
 * Advanced Utility Drones - installer.
 *
 * The mod itself never edits EveJS source on disk; it is a loader that
 * transforms one file in memory. What has to be registered is the preload
 * itself, and each deployment offers a different place to do it:
 *
 *   Docker  docker/entrypoint.sh   --require /app/mods/beta-AdvancedUtilityDrones/loader.js
 *   Native  StartServer.bat        NODE_OPTIONS=--require %EVEJS_REPO_ROOT%\mods\...
 *                                  (inherited by both npm start branches)
 *
 * Both registrations are idempotent, both are backed up before being written,
 * and `--server` may be pointed at either kind of checkout. With no `--server`,
 * and no EVEJS_SERVER/EVEJS_ROOT, the root is discovered: beside this installer,
 * up its ancestor chain, then by a bounded sweep of the local drives.
 *
 * Usage:
 *   node install.js                     (EveJS is found on this machine)
 *   node install.js --server "D:\eve\v0.12.9"
 *   node install.js --server "D:\eve\v0.12.9" --dry-run
 *   node install.js --server "D:\eve\v0.12.9" --docker-only
 *   node install.js --status --server "D:\eve\v0.12.9"
 *
 * It also seeds config/advancedUtilityDrones.json and
 * config/advancedUtilityDrones.players.json: the first only when the operator
 * has not written one, the second only when no character has played yet. Both
 * are left untouched on every later run - except that the server file is
 * brought up to the key set of the release being installed, by adding the keys
 * a later version introduced and nothing else: see lib/configMigration.js.
 */

const fs = require("node:fs");
const path = require("node:path");

const configMigration = require("./lib/configMigration");
const deployment = require("./lib/deployment");
const loaderAudit = require("./lib/loaderAudit");
const register = require("./lib/register");

const INSTALLER_DIR = __dirname;
const COPY_EXCLUDES = new Set(deployment.DEV_ONLY_DIRECTORIES);
const COPY_EXCLUDED_FILES = new Set(deployment.DEV_ONLY_FILES);

// The two files this mod owns inside the server's config/ directory. They are
// created only when they are missing, so an operator's edits - and every
// character's saved choices - survive a reinstall untouched, and the
// uninstaller removes exactly these two.
const CONFIG_DIRNAME = "config";
const SERVER_CONFIG_FILE = "advancedUtilityDrones.json";
const PLAYERS_CONFIG_FILE = "advancedUtilityDrones.players.json";

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
    force: false,
    status: false,
    update: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--server" && argv[index + 1]) options.server = argv[(index += 1)];
    else if (arg.startsWith("--server=")) options.server = arg.slice("--server=".length);
    else if (arg === "--docker-only") options.dockerOnly = true;
    else if (arg === "--native-only") options.nativeOnly = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--status") options.status = true;
    else if (arg === "--update") options.update = true;
    else if (arg === "--help" || arg === "-h") {
      out("Usage: node install.js [--server <EveJS root>] [--docker-only|--native-only]");
      out("                      [--dry-run] [--force] [--status] [--update]");
      process.exit(0);
    } else if (!arg.startsWith("--") && !options.server) options.server = arg;
  }
  if (options.dockerOnly && options.nativeOnly) {
    fail("--docker-only and --native-only are mutually exclusive");
  }
  return options;
}

// The payload is the mod folder shipped beside the installer (`mod/` and
// `beta-AdvancedUtilityDrones/` are both accepted), and this installer's parent
// directory in the development tree, where the mod is the git checkout itself.
function payloadCandidates() {
  return [
    path.join(INSTALLER_DIR, deployment.PAYLOAD_DIRNAME),
    path.join(INSTALLER_DIR, deployment.MOD_ID),
    path.dirname(INSTALLER_DIR),
    path.join(path.dirname(INSTALLER_DIR), deployment.MOD_ID),
    path.dirname(path.dirname(INSTALLER_DIR)),
  ];
}

function resolvePayload() {
  const candidates = payloadCandidates();
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "loader.js")) && fs.existsSync(path.join(dir, "evejs-launcher.mod.json"))) {
      let version = "unknown";
      try {
        version = JSON.parse(fs.readFileSync(path.join(dir, "evejs-launcher.mod.json"), "utf8")).version || version;
      } catch (_error) {
        version = "unknown";
      }
      return { dir, version };
    }
  }
  return fail("could not find the mod payload (loader.js + evejs-launcher.mod.json) next to this installer");
}

function promptForRoot(roots) {
  if (!process.stdin.isTTY) return "";
  out("Several EveJS installations were found:");
  roots.forEach((root, index) => out(`  [${index + 1}] ${root}`));
  out("  [0] none of these");
  process.stdout.write("  Choose one: ");
  const buffer = Buffer.alloc(64);
  let answer = "";
  try {
    const read = fs.readSync(0, buffer, 0, buffer.length, null);
    answer = buffer.slice(0, read).toString("utf8").trim();
  } catch (_error) {
    return "";
  }
  const choice = Number(answer);
  return Number.isInteger(choice) && choice >= 1 && choice <= roots.length ? roots[choice - 1] : "";
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
  // Nothing near the installer, which means the package was unpacked somewhere
  // unrelated. Unzip-and-double-click is the normal way this mod is installed,
  // so sweep the local drives before asking the operator for a path.
  if (roots.length === 0) roots = deployment.findLocalEveJsRoots();
  if (roots.length === 1) return roots[0];
  if (roots.length === 0) {
    fail('no EveJS installation was found on this machine; pass --server "<EveJS root>", for example --server "D:\\Eve\\EveJS"');
  }
  const chosen = promptForRoot(roots);
  if (chosen) return chosen;
  const listed = roots.slice(0, 8).join(", ") + (roots.length > 8 ? ` and ${roots.length - 8} more` : "");
  fail(`several EveJS installations were found; pass --server <root>. Candidates: ${listed}`);
}

function copyPayload(source, target) {
  // The installer may be run from the folder it is asked to install into - the
  // README's "put the folder in mods/beta-AdvancedUtilityDrones and run the installer
  // from inside it". There source and target are one directory, so the copy
  // would be a no-op at best and the prune below would delete the installer the
  // operator is still holding, update.bat and uninstall.bat included. Skip it.
  if (deployment.sameDirectory(source, target)) return;
  fs.mkdirSync(target, { recursive: true });
  // Prune development-only leftovers so refreshing an existing install leaves
  // exactly the payload behind.
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (COPY_EXCLUDES.has(entry.name) || COPY_EXCLUDED_FILES.has(entry.name)) {
      fs.rmSync(path.join(target, entry.name), { recursive: true, force: true });
    }
  }
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (COPY_EXCLUDES.has(entry.name) || COPY_EXCLUDED_FILES.has(entry.name)) continue;
    // A local .env is the operator's configuration; never overwrite it on
    // reinstall. Delete it first if the shipped defaults are wanted.
    if (entry.name === ".env" && fs.existsSync(path.join(target, ".env"))) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyPayload(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

// Documentation only: the loader writes the same header when it has to create
// the file itself, and this copy is only here so an operator sees the shape of
// the file before anybody has played.
function playersFileBody(payload) {
  const document = {
    _comment:
      "Per-character settings for beta-AdvancedUtilityDrones. The key is the character ID " +
      "and every key inside an entry is optional: anything a character does not set " +
      "falls back to " + CONFIG_DIRNAME + "/" + SERVER_CONFIG_FILE + ". Values set in " +
      "game through /aud mining or /aud salvage (or the plain-chat !aud trigger) are written " +
      "here automatically.",
    _help:
      "enabled: true|false - automate this character's mining drones. " +
      "targetMode: spread|focus - one rock per drone, or every drone on one rock. " +
      "rangeOverrideMeters: number|null - search radius, null follows the ship. " +
      "minHoldFreeVolumeM3: number - stop once the destination hold has less than " +
      "this much room left. " +
      "playerControlPolicy: hold|recall|off - what happens after the player takes " +
      "manual control of drones.",
    characters: {},
  };
  try {
    const shared = require(path.join(payload.dir, "lib", "playerSettings.js"));
    if (shared && shared.FILE_COMMENT) document._comment = shared.FILE_COMMENT;
    if (shared && shared.FILE_HELP) document._help = shared.FILE_HELP;
  } catch (_error) {
    // The header is documentation; an empty character map is the real content.
  }
  return JSON.stringify(document, null, 2) + "\n";
}

// config/ is seeded once and then owned by the operator, so the server file is
// also brought up to this release's key set on every run: a setting a later
// version added is absent from a file an earlier one wrote, and the mod falls
// back to its default without ever saying so. The migration adds the missing
// keys and the version stamp, never rewrites a value that is there, and the file
// is archived first. The players file is never touched - it holds what the
// characters did in game, and every shape of it is read as it is.
// This release renamed the mod from Alternate Mining Drones, so the two files
// an operator already owns carry a name the mod no longer reads. They are
// renamed into place instead of being left behind: without this an upgrade
// would silently start from the packaged defaults and every character's saved
// choices would be orphaned. A file already sitting under the new name is the
// operator's and is never touched, and the migration then brings it up to this
// release's key set like any other.
const LEGACY_FILES = Object.freeze({
  [SERVER_CONFIG_FILE]: "alternateMiningDrones.json",
  [PLAYERS_CONFIG_FILE]: "alternateMiningDrones.players.json",
});

function carryOverLegacyFiles(configDir, options) {
  for (const [name, legacyName] of Object.entries(LEGACY_FILES)) {
    const file = path.join(configDir, name);
    const legacy = path.join(configDir, legacyName);
    if (fs.existsSync(file) || !fs.existsSync(legacy)) {
      continue;
    }
    if (options.dryRun) {
      out("[PLAN] " + CONFIG_DIRNAME + "/" + legacyName + ": would be renamed to " + name);
      continue;
    }
    try {
      fs.renameSync(legacy, file);
      out(
        "[ OK ] " + CONFIG_DIRNAME + "/" + name + ": carried over from " + legacyName +
        " (the mod was renamed)",
      );
    } catch (error) {
      out("[WARN] " + CONFIG_DIRNAME + "/" + legacyName + ": " + error.message);
      out("       rename it to " + name + " by hand to keep the settings in it");
    }
  }
}

function seedConfig(root, payload, options, hooks = {}) {
  const configDir = path.join(root, CONFIG_DIRNAME);
  carryOverLegacyFiles(configDir, options);
  const example = path.join(payload.dir, "config.example.json");
  const exampleText = fs.existsSync(example) ? deployment.readText(example) : "";
  const entries = [
    { name: SERVER_CONFIG_FILE, body: exampleText, migrate: true },
    { name: PLAYERS_CONFIG_FILE, body: playersFileBody(payload), migrate: false },
  ];
  for (const entry of entries) {
    const file = path.join(configDir, entry.name);
    if (fs.existsSync(file)) {
      if (!entry.migrate) {
        out("[SKIP] " + CONFIG_DIRNAME + "/" + entry.name + ": already there, left as it is");
        continue;
      }
      const migration = configMigration.migrate(deployment.readText(file), { exampleText });
      if (migration.error) {
        out("[WARN] " + CONFIG_DIRNAME + "/" + entry.name + ": " + migration.error);
        out("       left as it is; a key the file does not set falls back to its default");
        continue;
      }
      if (!migration.changed) {
        out("[SKIP] " + CONFIG_DIRNAME + "/" + entry.name + ": already at the v" + migration.version + " key set");
        continue;
      }
      const added = migration.added.length > 0
        ? " (added " + migration.added.join(", ") + ")"
        : " (added the version stamp)";
      if (options.dryRun) {
        out("[PLAN] " + CONFIG_DIRNAME + "/" + entry.name + ": would go from the v" + migration.from + " shape to v" + migration.version + added);
        continue;
      }
      try {
        if (typeof hooks.archiveOnce === "function") hooks.archiveOnce(file);
        deployment.writeText(file, migration.text);
        out("[ OK ] " + CONFIG_DIRNAME + "/" + entry.name + ": updated, v" + migration.from + " shape -> v" + migration.version + added);
      } catch (error) {
        out("[WARN] " + CONFIG_DIRNAME + "/" + entry.name + ": " + error.message);
      }
      continue;
    }
    if (options.dryRun) {
      out("[PLAN] " + CONFIG_DIRNAME + "/" + entry.name + ": would be created");
      continue;
    }
    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(file, entry.body, "utf8");
      out("[ OK ] " + CONFIG_DIRNAME + "/" + entry.name + ": created");
    } catch (error) {
      out("[WARN] " + CONFIG_DIRNAME + "/" + entry.name + ": " + error.message);
      out("       the mod keeps working with its built-in defaults");
    }
  }
}

function applyRegistration(options) {
  const { file, label, result, write } = options;
  if (!result.ok) {
    out(`[WARN] ${label}: ${result.reason}`);
    out(`       ${label} was left untouched; register the preload by hand:`);
    out(`       ${file}`);
    return { changed: false, failed: true };
  }
  if (!result.changed) {
    out(`[SKIP] ${label}: preload already registered`);
    return { changed: false, failed: false };
  }
  const verb = result.moved ? "moved" : "added";
  if (options.dryRun) {
    out(`[PLAN] ${label}: would ${verb} ${options.preload}`);
    if (result.moved) out(`       another loader mod was registered before this one, so the block moves to the end of the chain`);
    return { changed: true, failed: false };
  }
  write();
  out(`[ OK ] ${label}: ${verb} ${options.preload}`);
  if (result.moved) {
    out("       another loader mod was registered before this one; the block was moved behind it");
    out("       so this loader is required last and owns the outermost hook");
  }
  return { changed: true, failed: false };
}

// A mod folder that no chain mentions is installed and completely inert - it
// loads nothing, logs nothing and does nothing, and no EveJS surface says so.
// Reported as a note rather than a warning: a tree usually carries both entry
// points while the owner runs only one of them, and the mods this names belong
// to other authors.
function reportUnpreloaded(root, chains) {
  const installed = deployment.installedLoaderMods(root);
  for (const chain of chains) {
    const missing = installed.filter((id) => !chain.ids.includes(id));
    if (missing.length > 0) {
      out(`  [note] ${chain.label}: in mods/ but not preloaded by this launcher: ${missing.join(", ")}`);
    }
  }
}

// The same --docker-only / --native-only switches that restrain the install
// restrain the report: someone who runs one deployment does not need to be told
// about the other one's list.
function reportStatus(root, payload, deployments, options = {}) {
  const modDir = path.join(root, "mods", deployment.MOD_ID);
  const installed = fs.existsSync(path.join(modDir, "loader.js"));
  const installedDigest = installed ? deployment.digestTree(modDir) : "";
  const payloadDigest = payload ? deployment.digestTree(payload.dir) : "";
  out(`EveJS root : ${root}`);
  out(`Mod folder : ${modDir}`);
  out(`             ${installed ? `installed (${installedDigest.slice(0, 12)}${payload ? `, shipped ${payloadDigest.slice(0, 12)}` : ""})` : "not installed"}`);
  // A difference is not automatically a fault: a hand-edited file, a folder
  // left by an older release and the copy inside a Docker image (whose
  // .dockerignore drops **/.env) all read as one. Say so instead of leaving
  // two hashes to stare at.
  if (installed && payloadDigest && installedDigest !== payloadDigest) {
    out("             digests differ - the folder is not this package byte for byte:");
    out("             hand-edited files, a folder left by another release, or the copy inside a");
    out("             Docker image (.dockerignore drops **/.env before the build) all look like this.");
  }
  const chains = [];
  const configPath = path.join(root, CONFIG_DIRNAME, SERVER_CONFIG_FILE);
  if (fs.existsSync(configPath) && payload) {
    const example = path.join(payload.dir, "config.example.json");
    const migration = configMigration.migrate(deployment.readText(configPath), {
      exampleText: fs.existsSync(example) ? deployment.readText(example) : "",
    });
    if (migration.error) {
      out("Config     : " + CONFIG_DIRNAME + "/" + SERVER_CONFIG_FILE + " was not read - " + migration.error);
    } else if (migration.changed) {
      out("Config     : v" + migration.from + " shape, missing " + migration.missing.join(", "));
      out("             update.bat adds those keys and leaves every value in the file alone");
    } else {
      out("Config     : v" + migration.version + " key set (" + CONFIG_DIRNAME + "/" + SERVER_CONFIG_FILE + ")");
    }
  }
  if (deployments.docker.present && !options.nativeOnly) {
    const text = deployment.readText(deployments.docker.entrypoint);
    const registered = register.hasEntrypointPreload(text, { requirePath: register.containerRequirePath(deployment.MOD_ID) });
    out(`Docker     : ${registered ? "registered" : "NOT registered"} (${deployments.docker.entrypoint})`);
    // The container list is fixed, so nothing can be erased - but the order
    // still decides who wraps whom, and this prints what node will really see.
    const audit = loaderAudit.auditEntrypointPreloads(text, { modId: deployment.MOD_ID });
    for (const line of loaderAudit.formatEntrypointAudit(audit)) out(line);
    chains.push({ label: "Docker", ids: audit.chain });
  }
  if (deployments.native.present && !options.dockerOnly) {
    const text = deployment.readText(deployments.native.startServerBat);
    const registered = register.hasStartServerPreload(text);
    out(`Native     : ${registered ? "registered" : "NOT registered"} (${deployments.native.startServerBat})`);
    // NODE_OPTIONS in the launcher is the native loader chain, and a neighbour
    // installed later can erase this mod from it without any error: report what
    // the file actually produces instead of what it is supposed to contain.
    const audit = loaderAudit.auditStartServerPreloads(text);
    for (const line of loaderAudit.formatStartServerAudit(audit)) out(line);
    if (!audit.loadedIds.includes(deployment.MOD_ID)) {
      out(`  [WARN] ${deployment.MOD_ID} does not load from this file; the chain above says who wins`);
    }
    chains.push({ label: "Native", ids: audit.loadedIds });
  }
  reportUnpreloaded(root, chains);
  return installed;
}

function main(mode = "install") {
  const options = parseArgs(process.argv.slice(2));
  const updating = mode === "update" || options.update === true;
  const payload = resolvePayload();
  const root = resolveRoot(options);
  const deployments = deployment.detectDeployments(root);

  if (options.status) {
    reportStatus(root, payload, deployments, options);
    return;
  }

  const useDocker = deployments.docker.present && !options.nativeOnly;
  const useNative = deployments.native.present && !options.dockerOnly;
  if (!useDocker && !useNative) {
    fail(`no ${options.dockerOnly ? "Docker" : "native"} integration point found under ${root}`);
  }

  out("============================================================");
  out(`  Advanced Utility Drones Beta v${payload.version} - ${updating ? "Updater" : "Installer"}`);
  out("============================================================");
  out(`  EveJS root : ${root}`);
  out(`  Payload    : ${payload.dir}`);
  out(`  Targets    : ${[useDocker ? "docker" : null, useNative ? "native" : null].filter(Boolean).join(" + ")}`);
  if (updating) {
    const installedManifest = path.join(root, "mods", deployment.MOD_ID, "evejs-launcher.mod.json");
    let installedVersion = "";
    if (fs.existsSync(installedManifest)) {
      try {
        installedVersion = JSON.parse(deployment.readText(installedManifest)).version || "";
      } catch (_error) {
        installedVersion = "";
      }
    }
    out(`  Installed  : ${installedVersion ? `v${installedVersion}` : "not installed yet - this is a fresh install"}`);
    out(`  Updating to: v${payload.version}`);
    out("               configuration, the players file and a local .env are kept");
  }
  if (options.dryRun) out("  DRY RUN    : nothing will be written");
  out("------------------------------------------------------------");

  const backupRoot = path.join(root, deployment.BACKUP_DIRNAME, deployment.timestamp());
  const archived = new Set();
  const archiveOnce = (target) => {
    if (archived.has(target)) return;
    archived.add(target);
    deployment.archivePath(root, target, backupRoot);
  };

  // 1. The mod folder itself.
  const modDir = path.join(root, "mods", deployment.MOD_ID);
  const existed = fs.existsSync(path.join(modDir, "loader.js"));
  // The payload may BE the target: an installer run from an installed
  // mods/beta-AdvancedUtilityDrones. Nothing is copied then, and the report says so
  // rather than claiming an update it did not make.
  const selfInstall = deployment.sameDirectory(payload.dir, modDir);
  if (existed && !options.dryRun && !options.force) archiveOnce(modDir);
  if (options.dryRun) {
    out(
      `[PLAN] mods/${deployment.MOD_ID}: would ` +
        (selfInstall
          ? "stay in place (the installer is running from the installed folder)"
          : `${existed ? "replace" : "create"} from payload`),
    );
  } else {
    fs.mkdirSync(path.dirname(modDir), { recursive: true });
    copyPayload(payload.dir, modDir);
    out(
      `[ OK ] mods/${deployment.MOD_ID}: ` +
        (selfInstall
          ? "already in place (the installer is running from the installed folder)"
          : `${existed ? "updated" : "installed"}`),
    );
  }

  // 2. Docker: preload the loader from docker/entrypoint.sh.
  if (useDocker) {
    const file = deployments.docker.entrypoint;
    const preload = register.containerRequirePath(deployment.MOD_ID);
    const text = deployment.readText(file);
    const result = register.applyEntrypointPreload(text, { requirePath: preload });
    applyRegistration({
      file,
      label: "docker/entrypoint.sh",
      preload,
      result,
      dryRun: options.dryRun,
      write() {
        archiveOnce(file);
        deployment.writeText(file, result.text);
      },
    });
    const audit = loaderAudit.auditEntrypointPreloads(result.text, { modId: deployment.MOD_ID });
    out("");
    for (const line of loaderAudit.formatEntrypointAudit(audit, { indent: "  " })) out(line);
  }

  // 3. Native: preload the loader from the Windows launcher.
  if (useNative) {
    const file = deployments.native.startServerBat;
    const preload = register.nativeRequirePath(deployment.MOD_ID);
    const text = deployment.readText(file);
    const result = register.applyStartServerPreload(text, {
      requirePath: preload,
      existPath: register.nativeExistPath(deployment.MOD_ID),
    });
    applyRegistration({
      file,
      label: "StartServer.bat",
      preload,
      result,
      dryRun: options.dryRun,
      write() {
        archiveOnce(file);
        deployment.writeText(file, result.text);
      },
    });
    const audit = loaderAudit.auditStartServerPreloads(result.text);
    out("");
    out("  StartServer.bat loader chain (NODE_OPTIONS order)");
    for (const line of loaderAudit.formatStartServerAudit(audit, { indent: "    " })) out(line);
    if (!audit.loadedIds.includes(deployment.MOD_ID)) {
      out(`    [WARN] ${deployment.MOD_ID} would not load from this file; see the warnings above`);
      out("    [WARN] Only a block that runs after this one can cause that. Move it");
      out("    [WARN] above this block, or make it append to NODE_OPTIONS.");
    }
  }

  // 4. The mod's own configuration, seeded once and never overwritten.
  out("");
  seedConfig(root, payload, options, { archiveOnce, backupRoot });

  out("------------------------------------------------------------");
  if (archived.size > 0) out(`  Backups    : ${backupRoot}`);
  out("");
  out("  Next steps");
  if (useDocker) {
    out("    Docker : docker compose build");
    out("             docker compose up -d --no-deps server");
    out("             (mods/ is inside the image, so a rebuild is required)");
  }
  if (useNative) {
    out("    Native : restart the server with StartServer.bat");
  }
  out("");
  out(`  Confirm a boot line: [beta-AdvancedUtilityDrones] v${payload.version} loader ready`);
  out("                        [beta-AdvancedUtilityDrones] drone tick hook installed");
  out("");
  out("  Configuration — nothing is required: the default follows the drone");
  out("  control range of whatever ship launched the drones.");
  out("    Server    : config/advancedUtilityDrones.json (created for you, then");
  out("                never overwritten). ./config is bind-mounted under Docker,");
  out("                so editing it needs a container restart, not a rebuild.");
  out("    Players   : config/advancedUtilityDrones.players.json holds one entry per");
  out("                character; /aud writes it, and it travels with the mod.");
  out("    Native    : mods/beta-AdvancedUtilityDrones/.env");
  out("    Docker    : the server service env in compose.yaml, e.g.");
  out("                EVEJS_ADVANCED_UTILITY_DRONES_TARGET_MODE=focus");
  out("    Precedence: environment > config/advancedUtilityDrones.json > .env > defaults.");
  out("    In game   : /aud help, or !aud help from ordinary chat for characters");
  out("                without staff rights.");
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
