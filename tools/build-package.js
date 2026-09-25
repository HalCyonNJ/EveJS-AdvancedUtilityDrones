"use strict";

// Builds the ZIP that is handed out on Discord, and nothing else.
//
// The repository IS the mod folder, so the published artifact is GitHub's own
// per-tag "Source code (zip)" and there is nothing to keep in sync. Some players
// would rather take a file from Discord than follow a link, so every release
// also gets one archive here: dist/AdvancedUtilityDrones-<version>.zip,
// produced with git archive of the release ref and prefixed with the folder
// name - i.e. the same content the GitHub download hands out.
//
// dist/ is git-ignored: the ZIP stays on the machine that builds it and is
// pasted into Discord. It is never pushed and never attached to a Release.
//
// Usage:  node tools/build-package.js [ref]
//         ref defaults to v<MOD_VERSION> from loader.js. The working tree has
//         to be clean, so the ZIP cannot disagree with the tag it names.

const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MOD_ROOT = path.resolve(__dirname, "..");
const MOD_ID = "AdvancedUtilityDrones";
const DIST_DIR = path.join(MOD_ROOT, "dist");

function fail(message) {
  console.error("[build-package] " + message);
  process.exitCode = 1;
}

function git(args) {
  return execFileSync("git", args, { cwd: MOD_ROOT, encoding: "utf8" }).trim();
}

function readVersion() {
  const text = fs.readFileSync(path.join(MOD_ROOT, "loader.js"), "utf8");
  const match = /const MOD_VERSION = "([^"]+)"/u.exec(text);
  if (!match) {
    throw new Error("loader.js does not declare MOD_VERSION");
  }
  return match[1];
}

function tagExists(ref) {
  try {
    git(["rev-parse", "--verify", "--quiet", "refs/tags/" + ref]);
    return true;
  } catch (_error) {
    return false;
  }
}

function main() {
  let version;
  try {
    version = readVersion();
  } catch (error) {
    fail(error.message);
    return;
  }
  const ref = process.argv[2] || "v" + version;

  if (git(["status", "--porcelain"])) {
    fail("the working tree has uncommitted changes - commit them first, so the ZIP matches the tag it names");
    return;
  }
  if (ref.startsWith("v") && !tagExists(ref)) {
    fail(ref + " is not a tag in this repository");
    return;
  }

  const commit = git(["rev-parse", ref]);
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const target = path.join(DIST_DIR, MOD_ID + "-" + version + ".zip");
  fs.rmSync(target, { force: true });

  const relative = path.relative(MOD_ROOT, target).split(path.sep).join("/");
  execFileSync(
    "git",
    ["archive", "--format=zip", "--prefix=" + MOD_ID + "/", "-o", relative, ref],
    { cwd: MOD_ROOT, stdio: "inherit" },
  );

  const bytes = fs.readFileSync(target);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const files = git(["ls-tree", "-r", "--name-only", ref]).split("\n").filter(Boolean);
  console.log("[build-package] " + relative);
  console.log("[build-package] ref " + ref + " = " + commit);
  console.log("[build-package] " + bytes.length + " bytes, " + files.length + " files, sha256 " + sha256);
}

main();
