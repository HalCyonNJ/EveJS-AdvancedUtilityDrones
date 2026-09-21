"use strict";

// Filesystem-side helpers for the installer: locating an EveJS root, detecting
// which deployments are present, archiving what is about to change, and
// copying the payload. Kept apart from lib/register.js so the text transforms
// stay testable without a real checkout.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MOD_ID = "AdvancedUtilityDrones";
const PAYLOAD_DIRNAME = "mod";
const BACKUP_DIRNAME = "_advancedutilitydrones-backup";
const REQUIRED_FILES = Object.freeze([
  path.join("server", "index.js"),
  path.join("server", "src", "services", "drone", "droneRuntime.js"),
]);
// Everything under the mod root that belongs to the development checkout only.
// The installer prunes these from an already-installed folder, so an installed
// mods\AdvancedUtilityDrones holds the payload and nothing else.
const DEV_ONLY_DIRECTORIES = Object.freeze(["installer", "node_modules", ".git"]);
// Development files at the mod root. The packaging step is gone (the GitHub
// repository is the distribution), so nothing needs listing here today.
const DEV_ONLY_FILES = Object.freeze([]);
const DOCKER_ENTRYPOINT = path.join("docker", "entrypoint.sh");
// The native entry point. Deliberately not server/package.json: that file is
// an input to the image's dependency layer, so editing it forces npm ci to
// re-run on the next Docker build.
const NATIVE_START_SERVER = "StartServer.bat";

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch (_error) {
    return false;
  }
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch (_error) {
    return false;
  }
}

function isEveJsRoot(dir) {
  if (!dir) return false;
  return REQUIRED_FILES.every((relative) => isFile(path.join(dir, relative)));
}

function readText(file) {
  return fs.readFileSync(file, "utf8");
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function ensureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function childrenOf(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch (_error) {
    return [];
  }
}

function ancestor(dir, levels) {
  let current = path.resolve(dir);
  for (let level = 0; level < levels; level += 1) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

// The first tier asks only about each starting point and its siblings, so an
// installer unpacked next to (or inside) the EveJS root it targets resolves to
// exactly one candidate and never wanders into unrelated trees.
function findEveJsRoots(startDirs) {
  const ordered = [];
  const seen = new Set();
  const push = (dir) => {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    ordered.push(resolved);
  };

  for (const start of startDirs) {
    push(start);
    for (const sibling of childrenOf(path.dirname(start))) push(sibling);
  }
  return ordered.filter((dir) => isEveJsRoot(dir));
}

// Used only when the first tier finds nothing: an installer living deep inside
// an install (mods/<mod>/installer/) has to walk up before it can see the root.
function findDeeperEveJsRoots(startDirs, levels = 4) {
  const ordered = [];
  const seen = new Set();
  const push = (dir) => {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    ordered.push(resolved);
  };

  for (const start of startDirs) {
    for (let level = 1; level <= levels; level += 1) {
      const base = ancestor(start, level);
      push(base);
      for (const child of childrenOf(base)) push(child);
    }
  }
  return ordered.filter((dir) => isEveJsRoot(dir));
}

// Folder names that never hold a game server, or hold so many of them that
// walking them would cost more than the answer is worth. Folders whose name
// starts with a dot are skipped for the same reason.
const SCAN_SKIP = Object.freeze([
  "windows",
  "program files",
  "program files (x86)",
  "programdata",
  "appdata",
  "application data",
  "node_modules",
  "system volume information",
  "$recycle.bin",
  "$winreagent",
  "recovery",
  "perflogs",
  "temp",
  "tmp",
]);
const SCAN_MAX_DEPTH = 2;
const SCAN_BUDGET = 4000;

// The bases the sweep starts from. Windows is asked which drives actually
// exist, so an empty optical or card-reader letter is never touched; the
// known locations are added on top for the platforms where fsutil is absent.
// EVEJS_ADVANCED_UTILITY_DRONES_SEARCH_BASES (a ";"-separated list) replaces the
// whole list, which is how the test suite points the sweep at a sandbox.
function localDriveRoots() {
  const roots = [];
  const add = (value) => {
    if (!value) return;
    let root = "";
    try {
      root = path.parse(path.resolve(value.trim())).root;
    } catch (_error) {
      return;
    }
    if (root && !roots.includes(root)) roots.push(root);
  };

  // The override names the directories to sweep *as given*: it is a testing and
  // troubleshooting knob, so collapsing a path to its drive root would silently
  // ignore everything the caller asked for.
  const override = (process.env.EVEJS_ADVANCED_UTILITY_DRONES_SEARCH_BASES || "").trim();
  if (override) {
    for (const part of override.split(";")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      let resolved = "";
      try {
        resolved = path.resolve(trimmed);
      } catch (_error) {
        continue;
      }
      if (!roots.includes(resolved)) roots.push(resolved);
    }
    return roots;
  }

  if (process.platform === "win32") {
    try {
      const { execFileSync } = require("node:child_process");
      const listed = execFileSync("fsutil", ["fsinfo", "drives"], {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      });
      for (const drive of listed.match(/[A-Za-z]:[\\/]/g) || []) add(drive);
    } catch (_error) {
      // fsutil is missing or blocked; the known locations below still apply.
    }
  }
  add(process.env.SystemDrive);
  add(process.cwd());
  add(__dirname);
  return roots;
}

// Last resort, used only when nothing near the installer is an EveJS root:
// sweep the local drives for a folder that looks like one. Bounded by a depth
// limit and a visit budget, breadth-first so the shallowest answer wins, and
// a folder that is itself a root is never descended into. This is what makes a
// package that was unpacked into Downloads install without typing a path.
function findLocalEveJsRoots(options = {}) {
  const bases = options.bases || localDriveRoots();
  const maxDepth = options.maxDepth === undefined ? SCAN_MAX_DEPTH : options.maxDepth;
  const isRoot = options.isRoot || isEveJsRoot;
  const skipped = new Set(SCAN_SKIP);
  let budget = options.budget === undefined ? SCAN_BUDGET : options.budget;
  const seen = new Set();
  const found = [];
  const queue = bases.map((base) => ({ dir: path.resolve(base), depth: 0 }));

  while (queue.length > 0 && budget > 0) {
    const { dir, depth } = queue.shift();
    if (seen.has(dir)) continue;
    seen.add(dir);
    budget -= 1;
    if (isRoot(dir)) {
      found.push(dir);
      continue;
    }
    if (depth >= maxDepth) continue;
    for (const child of childrenOf(dir)) {
      const name = path.basename(child).toLowerCase();
      if (skipped.has(name) || name.startsWith(".")) continue;
      const resolved = path.resolve(child);
      if (!seen.has(resolved)) queue.push({ dir: resolved, depth: depth + 1 });
    }
  }
  return found;
}

function detectDeployments(root) {
  const entrypoint = path.join(root, DOCKER_ENTRYPOINT);
  const startServerBat = path.join(root, NATIVE_START_SERVER);
  return {
    docker: { name: "docker", entrypoint, present: isFile(entrypoint) },
    native: { name: "native", startServerBat, present: isFile(startServerBat) },
  };
}

// Every mod folder that carries a loader.js is one the deployments are supposed
// to preload. A folder that no chain mentions is installed and completely inert,
// and nothing in EveJS says so - which is why the status command says it here.
function installedLoaderMods(root) {
  const modsDir = path.join(root, "mods");
  let entries = [];
  try {
    entries = fs.readdirSync(modsDir, { withFileTypes: true });
  } catch (_error) {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && isFile(path.join(modsDir, entry.name, "loader.js")))
    .map((entry) => entry.name)
    .sort();
}

function timestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

// Archives a file or directory under <EveJS root>/_advancedutilitydrones-backup/ so
// uninstall.bat can always restore something by hand, even after a later mod
// rewrites the same lines again.
function archivePath(root, sourcePath, backupRoot) {
  const target = path.join(backupRoot, path.relative(root, sourcePath));
  ensureDirectory(path.dirname(target));
  fs.cpSync(sourcePath, target, { recursive: true, force: true });
  return target;
}

function digestTree(dir) {
  const hash = crypto.createHash("sha256");
  const walk = (current) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_error) {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d:${path.relative(dir, full)}\n`);
        walk(full);
      } else if (entry.isFile()) {
        hash.update(`f:${path.relative(dir, full)}\n`);
        hash.update(fs.readFileSync(full));
      }
    }
  };
  walk(dir);
  return hash.digest("hex");
}

function copyTree(source, target) {
  ensureDirectory(target);
  fs.cpSync(source, target, { recursive: true, force: true });
}

// Two spellings of one directory: the installer run from the folder it is about
// to install into. `path.resolve` is not enough on Windows, where the same
// folder can be typed in any case, so the real path is asked for when it exists.
function sameDirectory(left, right) {
  let first = path.resolve(left);
  let second = path.resolve(right);
  try {
    first = fs.realpathSync.native(path.resolve(left));
    second = fs.realpathSync.native(path.resolve(right));
  } catch (_error) {
    // A path that does not exist yet keeps its resolved spelling.
  }
  if (process.platform === "win32") return first.toLowerCase() === second.toLowerCase();
  return first === second;
}

module.exports = {
  BACKUP_DIRNAME,
  DEV_ONLY_DIRECTORIES,
  DEV_ONLY_FILES,
  DOCKER_ENTRYPOINT,
  MOD_ID,
  NATIVE_START_SERVER,
  PAYLOAD_DIRNAME,
  REQUIRED_FILES,
  archivePath,
  copyTree,
  detectDeployments,
  digestTree,
  ensureDirectory,
  findDeeperEveJsRoots,
  findEveJsRoots,
  findLocalEveJsRoots,
  localDriveRoots,
  installedLoaderMods,
  isDirectory,
  isEveJsRoot,
  isFile,
  readText,
  sameDirectory,
  timestamp,
  writeText,
};