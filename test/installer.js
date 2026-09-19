"use strict";

// Installer coverage: the registration transforms are pure, so they are
// asserted against fixture text first, and the end-to-end pass then drives
// install.js/uninstall.js against a throwaway EveJS tree.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MOD_ID = "AlternateMiningDrones";

const ENTRYPOINT_FIXTURE = [
  "#!/usr/bin/env bash",
  "set -Eeuo pipefail",
  "",
  "build_database() {",
  "  node --max-old-space-size=8192 /app/tools/DatabaseCreator/database-creator.js \\",
  "    --sde-dir /sde \\",
  "    --out /out",
  "}",
  "",
  "run_server() {",
  "  cd /app/server",
  "  exec node \\",
  "    --require /app/mods/fourModeAsteroidBelts/loader.js \\",
  "    --report-on-fatalerror \\",
  "    --max-old-space-size=8192 \\",
  "    .",
  "}",
  "",
  "run_all() {",
  "  build_database",
  "  (cd /app/server && exec node \\",
  "    --report-on-fatalerror \\",
  "    .) &",
  "}",
  "",
  'case "${1:-all}" in',
  "  server) run_server ;;",
  "  all) run_all ;;",
  "esac",
  "",
].join("\n");

// Modelled on the real launcher: the anchor line is the one both npm start
// branches inherit their environment from.
const START_SERVER_FIXTURE = [
  "@echo off",
  "setlocal EnableDelayedExpansion",
  'title EvEJS - Start Server',
  'for %%I in ("%~dp0.") do set "EVEJS_REPO_ROOT=%%~fI"',
  'set "EVEJS_PROXY_LOCAL_INTERCEPT=1"',
  'if not exist "%EVEJS_REPO_ROOT%\\server\\logs\\node-reports" mkdir "%EVEJS_REPO_ROOT%\\server\\logs\\node-reports" >nul 2>&1',
  'pushd "%EVEJS_REPO_ROOT%\\server"',
  "call npm start",
  "popd",
  "",
].join("\r\n");

// The live launcher already preloads another loader mod using the
// `if not defined NODE_OPTIONS` idiom, immediately after the same anchor.
const START_SERVER_WITH_OTHER_MOD = [
  "@echo off",
  "setlocal EnableDelayedExpansion",
  'set "EVEJS_PROXY_LOCAL_INTERCEPT=1"',
  "rem --- otherMod: preload the server-side loader ---",
  'if not defined NODE_OPTIONS if exist "%EVEJS_REPO_ROOT%\\mods\\otherMod\\loader.js" set "NODE_OPTIONS=--require="%EVEJS_REPO_ROOT:\\=/%/mods/otherMod/loader.js""',
  "rem --- otherMod: end otherMod preload ---",
  'if not exist "%EVEJS_REPO_ROOT%\\server\\logs" mkdir "%EVEJS_REPO_ROOT%\\server\\logs" >nul 2>&1',
  "call npm start",
  "",
].join("\r\n");
// autopilotJumpZero's current registration shape: a bare (unmarked) multi-line
// `if exist` group. Judged by its first line alone it looks like one line, and a
// naive installer drops its own block *inside* the group - which silently hands
// the neighbour's `set` the last word.
const START_SERVER_WITH_UNMARKED_BLOCK = [
  "@echo off",
  "setlocal EnableDelayedExpansion",
  'set "EVEJS_PROXY_LOCAL_INTERCEPT=1"',
  'if exist "%EVEJS_REPO_ROOT%\\mods\\autopilotJumpZero\\loader.js" (',
  "  if defined NODE_OPTIONS (",
  '    set "NODE_OPTIONS=%NODE_OPTIONS% --require="%EVEJS_REPO_ROOT:\\=/%/mods/autopilotJumpZero/loader.js""',
  "  ) else (",
  '    set "NODE_OPTIONS=--require="%EVEJS_REPO_ROOT:\\=/%/mods/autopilotJumpZero/loader.js""',
  "  )",
  ")",
  'if not exist "%EVEJS_REPO_ROOT%\\server\\logs" mkdir "%EVEJS_REPO_ROOT%\\server\\logs" >nul 2>&1',
  "call npm start",
  "",
].join("\r\n");

function buildFixtureRoot(base) {
  const root = path.join(base, "EveJS");
  const write = (relative, text) => {
    const file = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, "utf8");
  };
  write("server/index.js", '"use strict";\n');
  write("server/src/services/drone/droneRuntime.js", "// seam fixture\n");
  write("docker/entrypoint.sh", ENTRYPOINT_FIXTURE);
  write("StartServer.bat", START_SERVER_FIXTURE);
  write(
    "server/package.json",
    `${JSON.stringify(
      {
        name: "eve.js",
        version: "0.12.8",
        scripts: {
          start:
            "node --report-on-fatalerror --report-uncaught-exception " +
            "--report-dir=./logs/node-reports --max-old-space-size=8192 .",
        },
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

// The installer sources sit beside the mod in the development tree and beside
// the mod payload in the installer package. A mod folder copied straight into
// mods/ has neither, and then this suite steps aside instead of failing.
function resolveInstaller(modDir) {
  const candidates = [
    {
      installerDir: path.join(modDir, "installer"),
      registerLib: path.join(modDir, "installer/lib/register"),
      auditLib: path.join(modDir, "installer/lib/loaderAudit"),
      deploymentLib: path.join(modDir, "installer/lib/deployment"),
    },
    {
      installerDir: path.resolve(modDir, ".."),
      registerLib: path.resolve(modDir, "../lib/register"),
      auditLib: path.resolve(modDir, "../lib/loaderAudit"),
      deploymentLib: path.resolve(modDir, "../lib/deployment"),
    },
  ];
  for (const candidate of candidates) {
    try {
      return {
        installerDir: candidate.installerDir,
        registerLib: require(candidate.registerLib),
        auditLib: require(candidate.auditLib),
        deploymentLib: require(candidate.deploymentLib),
      };
    } catch (_error) {
      // Keep looking; the next layout may be the one in use.
    }
  }
  return null;
}

// The installer half plus the payload half, laid out exactly as the ZIP ships
// them. The no-argument tests need this: they must prove that a package which
// was unpacked somewhere unrelated can still find the server by itself.
function buildInstallerPackage(installerDir, modDir, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(installerDir, "install.js"), path.join(dest, "install.js"));
  fs.copyFileSync(path.join(installerDir, "uninstall.js"), path.join(dest, "uninstall.js"));
  fs.copyFileSync(path.join(installerDir, "update.js"), path.join(dest, "update.js"));
  fs.cpSync(path.join(installerDir, "lib"), path.join(dest, "lib"), { recursive: true });
  const skip = new Set(["installer", "tools", "dist", "node_modules", ".git"]);
  fs.cpSync(modDir, path.join(dest, MOD_ID), {
    recursive: true,
    filter: (source) => !skip.has(path.basename(source)),
  });
  return dest;
}

function writeEveJsRoot(root) {
  const write = (relative, content) => {
    const target = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  };
  write("server/index.js", '"use strict";\n');
  write("server/src/services/drone/droneRuntime.js", "// sweep fixture\n");
  write("docker/entrypoint.sh", ENTRYPOINT_FIXTURE);
  write("StartServer.bat", START_SERVER_FIXTURE);
  return root;
}

function register(harness) {
  const { test, modDir } = harness;
  const resolved = resolveInstaller(modDir);
  if (!resolved) {
    test("installer: suite available", () => {
      console.log("     SKIP installer sources are not shipped beside this mod");
    });
    return;
  }
  const { installerDir, registerLib, auditLib, deploymentLib } = resolved;
  const containerPath = registerLib.containerRequirePath(MOD_ID);
  const nativePath = registerLib.nativeRequirePath(MOD_ID);
  const nativeExist = registerLib.nativeExistPath(MOD_ID);

  test("installer: docker preload is added to every server launch", () => {
    const result = registerLib.applyEntrypointPreload(ENTRYPOINT_FIXTURE, { requirePath: containerPath });
    assert.ok(result.ok, result.reason || "expected the fixture entrypoint to be recognised");
    assert.strictEqual(result.launches, 2, "run_server and run_all must both be found");
    assert.strictEqual(result.insertions, 2, "both launches must gain the preload");
    const lines = result.text.split("\n");
    assert.deepStrictEqual(
      lines.filter((line) => line.includes(containerPath)).map((line) => line.trim()),
      [`--require ${containerPath} \\`, `--require ${containerPath} \\`],
    );
    // The two-space block indent plus one level keeps the vendor indentation.
    assert.ok(lines.includes(`    --require ${containerPath} \\`), "preload keeps the vendor indent");
    assert.ok(
      lines.includes("  node --max-old-space-size=8192 /app/tools/DatabaseCreator/database-creator.js \\"),
      "the database builder must not gain a preload",
    );
    // Require order is hook order: the preload has to land after every mod that
    // was already registered so this loader owns the outermost Module._load.
    assert.deepStrictEqual(
      lines.filter((line) => line.includes("--require")).map((line) => line.trim()),
      [
        "--require /app/mods/fourModeAsteroidBelts/loader.js \\",
        `--require ${containerPath} \\`,
        `--require ${containerPath} \\`,
      ],
      "the preload must be appended after the mods already in the list",
    );
  });

  test("installer: docker preload insertion is idempotent", () => {
    const once = registerLib.applyEntrypointPreload(ENTRYPOINT_FIXTURE, { requirePath: containerPath });
    const twice = registerLib.applyEntrypointPreload(once.text, { requirePath: containerPath });
    assert.strictEqual(twice.changed, false);
    assert.strictEqual(twice.text, once.text);
    assert.ok(registerLib.hasEntrypointPreload(twice.text, { requirePath: containerPath }));
    // Both launches own the preload now, and neither gained a duplicate.
    assert.deepStrictEqual(
      registerLib.describeEntrypointPreloads(twice.text).filter((entry) => entry.includes(MOD_ID)),
      [containerPath, containerPath],
    );
  });

  test("installer: docker preload removal restores the fixture byte for byte", () => {
    const applied = registerLib.applyEntrypointPreload(ENTRYPOINT_FIXTURE, { requirePath: containerPath });
    const removed = registerLib.removeEntrypointPreload(applied.text, { requirePath: containerPath });
    assert.strictEqual(removed.removals, 2);
    assert.strictEqual(removed.text, ENTRYPOINT_FIXTURE);
    assert.strictEqual(registerLib.hasEntrypointPreload(removed.text, { requirePath: containerPath }), false);
  });

  test("installer: docker preload is refused when no server launch exists", () => {
    const result = registerLib.applyEntrypointPreload("#!/usr/bin/env bash\necho hi\n", { requirePath: containerPath });
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, /no server launch/u);
  });

  test("installer: native preload is added to StartServer.bat", () => {
    // Node's NODE_OPTIONS parser consumes backslashes, so the value it receives
    // must be forward-slashed or it collapses to 'D:Eve...'.
    assert.strictEqual(nativePath, `%EVEJS_REPO_ROOT:\\=/%/mods/${MOD_ID}/loader.js`);
    assert.strictEqual(nativeExist, `%EVEJS_REPO_ROOT%\\mods\\${MOD_ID}\\loader.js`);
    const result = registerLib.applyStartServerPreload(START_SERVER_FIXTURE, {
      requirePath: nativePath,
      existPath: nativeExist,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.changed, true);
    const lines = result.text.split("\r\n");
    assert.ok(registerLib.hasStartServerPreload(result.text));
    // NODE_OPTIONS is a list and another loader mod may already own it, so the
    // block APPENDS and only assigns outright when the variable is unset.
    assert.deepStrictEqual(
      lines.filter((line) => line.includes("AlternateMiningDrones")).map((line) => line.trim()),
      [
        registerLib.START_SERVER_BEGIN,
        `if exist "${nativeExist}" (`,
        `set "NODE_OPTIONS=%NODE_OPTIONS% --require="${nativePath}""`,
        `set "NODE_OPTIONS=--require="${nativePath}""`,
        registerLib.START_SERVER_END,
      ],
    );
    assert.ok(result.text.includes("if defined NODE_OPTIONS ("), "the append branch must be present");
    assert.ok(result.text.includes(") else ("), "the unset branch must be present");
    assert.strictEqual(result.insertions, 9, "the block is nine lines long");
    // The block belongs right after the launcher's own environment setup, and
    // the pre-existing lines must be untouched, CRLF included.
    const anchor = lines.findIndex((line) => line.trim() === registerLib.START_SERVER_ANCHOR);
    assert.strictEqual(lines[anchor + 1].trim(), registerLib.START_SERVER_BEGIN);
    assert.strictEqual(result.text.replace(/\r\n/gu, "\n").endsWith("call npm start\npopd\n"), true);
    assert.strictEqual(
      registerLib.applyStartServerPreload(result.text, { requirePath: nativePath, existPath: nativeExist }).changed,
      false,
      "a second install must not stack a duplicate block",
    );
    assert.strictEqual(registerLib.removeStartServerPreload(result.text).text, START_SERVER_FIXTURE);
  });

  test("installer: native preload appends after an existing loader mod", () => {
    const options = { requirePath: nativePath, existPath: nativeExist };
    const result = registerLib.applyStartServerPreload(START_SERVER_WITH_OTHER_MOD, options);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.changed, true);
    const lines = result.text.split("\r\n");
    const anchor = lines.findIndex((line) => line.trim() === registerLib.START_SERVER_ANCHOR);
    const otherEnd = lines.findIndex((line) => line.trim() === "rem --- otherMod: end otherMod preload ---");
    assert.ok(otherEnd > anchor, "the fixture must register the other mod after the anchor");
    // Ours lands after the other mod so it observes (and extends) whatever
    // NODE_OPTIONS that mod produced, instead of pre-empting its guard.
    assert.strictEqual(lines[otherEnd + 1].trim(), registerLib.START_SERVER_BEGIN);
    assert.strictEqual(
      lines.filter((line) => line.includes("%NODE_OPTIONS% --require=")).length,
      1,
      "the block must append to NODE_OPTIONS instead of replacing it",
    );
    assert.ok(
      lines.some((line) => line.includes("otherMod") && line.includes("if not defined NODE_OPTIONS")),
      "the other mod's own registration must survive untouched",
    );
    assert.strictEqual(registerLib.applyStartServerPreload(result.text, options).changed, false);
    assert.strictEqual(registerLib.removeStartServerPreload(result.text).text, START_SERVER_WITH_OTHER_MOD);
  });

  test("installer: a neighbour installed later takes the anchor slot, never ours", () => {
    const options = { requirePath: nativePath, existPath: nativeExist };
    const ours = registerLib.applyStartServerPreload(START_SERVER_FIXTURE, options).text;
    // What a separate author's installer does: write its own block directly
    // after the anchor. Ours is already sitting there, so the newcomer lands
    // in front of ours - and because both append, both still load.
    const neighbourLines = [
      "rem --- otherMod: preload the server-side loader ---",
      'if exist "%EVEJS_REPO_ROOT%\\mods\\otherMod\\loader.js" (',
      "  if defined NODE_OPTIONS (",
      '    set "NODE_OPTIONS=%NODE_OPTIONS% --require="%EVEJS_REPO_ROOT:\\=/%/mods/otherMod/loader.js""',
      "  ) else (",
      '    set "NODE_OPTIONS=--require="%EVEJS_REPO_ROOT:\\=/%/mods/otherMod/loader.js""',
      "  )",
      ")",
      "rem --- otherMod: end otherMod preload ---",
    ];
    const lines = ours.split("\r\n");
    const anchor = lines.findIndex((line) => line.trim() === registerLib.START_SERVER_ANCHOR);
    const both = [...lines.slice(0, anchor + 1), ...neighbourLines, ...lines.slice(anchor + 1)].join("\r\n");
    const audit = auditLib.auditStartServerPreloads(both);
    assert.deepStrictEqual(audit.loadedIds, ["otherMod", MOD_ID], "both hooks must still be installed");
    assert.deepStrictEqual(audit.droppedBlocks, [], "neither block may swallow the other");
    assert.deepStrictEqual(audit.warnings, []);
    assert.ok(
      both.lastIndexOf(registerLib.START_SERVER_BEGIN) > both.indexOf("otherMod"),
      "the wrapping hook must stay behind the neighbour, whichever installer ran first",
    );
    // And the other order really is the same file: re-running our installer
    // puts the block back where it belongs without touching the neighbour.
    const repaired = registerLib.applyStartServerPreload(both, options);
    assert.strictEqual(repaired.changed, false, "our block is already in place, so nothing moves");
    assert.strictEqual(repaired.text, both);
  });
  test("installer: native preload steps over an unmarked multi-line loader block", () => {
    const options = { requirePath: nativePath, existPath: nativeExist };
    const result = registerLib.applyStartServerPreload(START_SERVER_WITH_UNMARKED_BLOCK, options);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.changed, true);
    const lines = result.text.split("\r\n");
    const anchor = lines.findIndex((line) => line.trim() === registerLib.START_SERVER_ANCHOR);
    // The neighbour's group closes on a bare ")", so that line is the block's
    // last one no matter how much if/else plumbing sits above it.
    const groupEnd = lines.findIndex((line, index) => index > anchor && line === ")");
    assert.ok(groupEnd > anchor, "the fixture must open a multi-line group after the anchor");
    assert.strictEqual(lines[groupEnd + 1].trim(), registerLib.START_SERVER_BEGIN);
    assert.ok(
      lines.findIndex((line) => line.includes("autopilotJumpZero/loader.js")) <
        lines.findIndex((line) => line.includes(`mods/${MOD_ID}/loader.js`)),
      "the wrapping loader must be required after the neighbour, never inside its group",
    );
    assert.strictEqual(
      lines.filter((line) => line.includes("%NODE_OPTIONS% --require=")).length,
      2,
      "both blocks must append; neither may claim the variable outright",
    );
    assert.strictEqual(registerLib.applyStartServerPreload(result.text, options).changed, false);
    assert.strictEqual(registerLib.removeStartServerPreload(result.text).text, START_SERVER_WITH_UNMARKED_BLOCK);
  });

  test("installer: a bare NODE_OPTIONS writer is stepped over too", () => {
    const options = { requirePath: nativePath, existPath: nativeExist };
    // Not every neighbour wraps its claim in an if. One line that assigns
    // outright still gets the last word if this mod is placed in front of it.
    const fixture = START_SERVER_FIXTURE.replace(
      `${registerLib.START_SERVER_ANCHOR}\r\n`,
      `${registerLib.START_SERVER_ANCHOR}\r\n` +
        `set "NODE_OPTIONS=--require=%EVEJS_REPO_ROOT:\\=/%/mods/lateComer/loader.js"\r\n`,
    );
    const result = registerLib.applyStartServerPreload(fixture, options);
    assert.strictEqual(result.ok, true);
    const lines = result.text.split("\r\n");
    const late = lines.findIndex((line) => line.includes("lateComer"));
    const ours = lines.findIndex((line) => line.trim() === registerLib.START_SERVER_BEGIN);
    assert.ok(late > 0, "the fixture must carry the bare writer");
    assert.ok(ours > late, "this mod's block must land after the bare writer");
    assert.strictEqual(registerLib.removeStartServerPreload(result.text).text, fixture);
  });
  test("installer: a reinstall repairs a block an older installer misplaced", () => {
    const options = { requirePath: nativePath, existPath: nativeExist };
    const fresh = registerLib.applyStartServerPreload(START_SERVER_WITH_UNMARKED_BLOCK, options).text;
    // Reproduce the broken layout: our block inserted straight after the anchor,
    // with the neighbour's group pushed after it. Require order is hook order, so
    // this is the arrangement that leaves the wrapping hook on the inside.
    const lines = START_SERVER_WITH_UNMARKED_BLOCK.split("\r\n");
    const anchor = lines.findIndex((line) => line.trim() === registerLib.START_SERVER_ANCHOR);
    const misplaced = [
      ...lines.slice(0, anchor + 1),
      registerLib.START_SERVER_BEGIN,
      `if exist "${nativeExist}" (`,
      "  if defined NODE_OPTIONS (",
      `    set "NODE_OPTIONS=%NODE_OPTIONS% --require="${nativePath}""`,
      "  ) else (",
      `    set "NODE_OPTIONS=--require="${nativePath}""`,
      "  )",
      ")",
      registerLib.START_SERVER_END,
      ...lines.slice(anchor + 1),
    ].join("\r\n");
    assert.ok(
      misplaced.indexOf("autopilotJumpZero/loader.js") > misplaced.indexOf(registerLib.START_SERVER_BEGIN),
      "the fixture must start out with this mod in front of the neighbour",
    );
    const healed = registerLib.applyStartServerPreload(misplaced, options);
    assert.strictEqual(healed.ok, true);
    assert.strictEqual(healed.changed, true);
    assert.strictEqual(healed.moved, true, "an existing block that changes place is reported as moved");
    assert.strictEqual(healed.text, fresh, "healing must land on exactly the text a fresh install produces");
    assert.strictEqual(registerLib.removeStartServerPreload(healed.text).text, START_SERVER_WITH_UNMARKED_BLOCK);
  });

  test("installer: the audit reports the loader chain and names anything it drops", () => {
    const options = { requirePath: nativePath, existPath: nativeExist };

    // An unmarked neighbour still shows up: the chain is read out of the value
    // NODE_OPTIONS finally holds, not out of the markers a block carries.
    const unmarked = registerLib.applyStartServerPreload(START_SERVER_WITH_UNMARKED_BLOCK, options).text;
    const unmarkedAudit = auditLib.auditStartServerPreloads(unmarked);
    assert.deepStrictEqual(unmarkedAudit.loadedIds, ["autopilotJumpZero", MOD_ID]);
    assert.deepStrictEqual(unmarkedAudit.droppedBlocks, []);
    assert.deepStrictEqual(unmarkedAudit.warnings, []);
    assert.match(
      auditLib.formatStartServerAudit(unmarkedAudit).join("\n"),
      /autopilotJumpZero -> AlternateMiningDrones/u,
      "the chain line must read left to right, innermost first",
    );

    const healthy = registerLib.applyStartServerPreload(START_SERVER_WITH_OTHER_MOD, options).text;
    const healthyAudit = auditLib.auditStartServerPreloads(healthy);
    assert.deepStrictEqual(healthyAudit.loadedIds, ["otherMod", MOD_ID]);
    assert.deepStrictEqual(healthyAudit.droppedBlocks, []);
    assert.match(auditLib.formatStartServerAudit(healthyAudit).join("\n"), /no loader block is dropped/u);

    // The failure the report described: a later block assigning NODE_OPTIONS
    // outright erases every loader registered before it, and cmd.exe says
    // nothing about it.
    const hostile = healthy.replace(
      "call npm start",
      `set "NODE_OPTIONS=--require=%EVEJS_REPO_ROOT:\\=/%/mods/lateComer/loader.js"\r\ncall npm start`,
    );
    const erased = auditLib.auditStartServerPreloads(hostile);
    assert.deepStrictEqual(erased.loadedIds, ["lateComer"]);
    assert.deepStrictEqual(erased.droppedBlocks, ["otherMod", MOD_ID]);
    assert.ok(
      erased.warnings.some((warning) =>
        /assigns NODE_OPTIONS outright, erasing otherMod, AlternateMiningDrones/u.test(warning),
      ),
      `expected an erasure warning, got ${JSON.stringify(erased.warnings)}`,
    );
    assert.match(auditLib.formatStartServerAudit(erased).join("\n"), /\[WARN\] dropped by a later block/u);

    // First-writer-wins is just as quiet: a guard that arrives second does
    // nothing, so the audit has to name the mod it would have loaded.
    const guarded = healthy.replace(
      "call npm start",
      `if not defined NODE_OPTIONS set "NODE_OPTIONS=--require=%EVEJS_REPO_ROOT:\\=/%/mods/lateComer/loader.js"\r\ncall npm start`,
    );
    const loser = auditLib.auditStartServerPreloads(guarded);
    assert.deepStrictEqual(loser.loadedIds, ["otherMod", MOD_ID]);
    assert.deepStrictEqual(loser.droppedBlocks, []);
    assert.ok(
      loser.warnings.some(
        (warning) => /first-writer-wins guard had no effect/u.test(warning) && warning.includes("lateComer"),
      ),
      `expected a guard warning, got ${JSON.stringify(loser.warnings)}`,
    );
  });
  test("installer: the container audit reads the --require list per launch", () => {
    const applied = registerLib.applyEntrypointPreload(ENTRYPOINT_FIXTURE, { requirePath: containerPath });
    const audit = auditLib.auditEntrypointPreloads(applied.text, { modId: MOD_ID });
    assert.strictEqual(audit.launches.length, 2, "run_server and run_all are both server launches");
    assert.deepStrictEqual(
      audit.launches.map((launch) => launch.name),
      ["run_server", "run_all"],
      "a launch is reported by the function it sits in",
    );
    assert.deepStrictEqual(audit.launches.map((launch) => launch.ids), [
      ["fourModeAsteroidBelts", MOD_ID],
      [MOD_ID],
    ]);
    assert.deepStrictEqual(audit.warnings, []);
    assert.deepStrictEqual(audit.notes, []);
    assert.match(
      auditLib.formatEntrypointAudit(audit).join("\n"),
      /run_server : fourModeAsteroidBelts -> AlternateMiningDrones/u,
    );
    // The database builder is a node invocation too, and it must not be read as
    // a launch: nothing preloads into it.
    assert.ok(
      !auditLib.auditEntrypointPreloads(ENTRYPOINT_FIXTURE, {}).launches.some((launch) =>
        launch.entries.some((entry) => entry.includes("DatabaseCreator")),
      ),
      "the database builder must never be reported as a server launch",
    );
  });

  test("installer: the container audit names a mod that is missing, split or doubled", () => {
    const ONE_LAUNCH = [
      "run_server() {",
      "  exec node \\",
      `    --require ${containerPath} \\`,
      "    --report-on-fatalerror \\",
      "    .",
      "}",
      "",
      "run_all() {",
      "  (cd /app/server && exec node \\",
      "    --report-on-fatalerror \\",
      "    .) &",
      "}",
      "",
    ].join("\n");
    const FLAG = "    --report-on-fatalerror \\";

    // Absent everywhere: the mod folder can be perfectly installed and still
    // never load, which is the whole reason this audit exists.
    const absent = auditLib.auditEntrypointPreloads(ENTRYPOINT_FIXTURE, { modId: MOD_ID });
    assert.ok(
      absent.warnings.some((warning) => warning.includes("not preloaded by any server launch")),
      `expected a missing warning, got ${JSON.stringify(absent.warnings)}`,
    );

    // Present in one launch only: the shape you get after patching one of the
    // two launcher branches by hand.
    const split = auditLib.auditEntrypointPreloads(ONE_LAUNCH, { modId: MOD_ID });
    assert.ok(
      split.warnings.some((warning) => /preloaded by 1 of 2 server launches/u.test(warning)),
      `expected a partial warning, got ${JSON.stringify(split.warnings)}`,
    );

    // Twice in the same launch: node would install the hook twice.
    const doubled = auditLib.auditEntrypointPreloads(ONE_LAUNCH.replace(FLAG, `${FLAG}\n    --require ${containerPath} \\`), {
      modId: MOD_ID,
    });
    assert.ok(
      doubled.warnings.some((warning) => warning.includes(`${MOD_ID} is preloaded more than once`)),
      `expected a duplicate warning, got ${JSON.stringify(doubled.warnings)}`,
    );

    // Anything required after a wrapping mod is worth pointing at, because a
    // replacement hook that lands there would discard the wrapper.
    const followed = auditLib.auditEntrypointPreloads(
      ONE_LAUNCH.replace(FLAG, `${FLAG}\n    --require /app/mods/someReplacer/loader.js \\`),
      { modId: MOD_ID },
    );
    // Only the partial-registration warning applies here; the follower itself
    // is worth a note, never a warning - the mod may not touch the same files.
    assert.deepStrictEqual(followed.warnings, [`${MOD_ID} is preloaded by 1 of 2 server launches`]);
    assert.ok(
      followed.notes.some((note) => /someReplacer required after AlternateMiningDrones/u.test(note)),
      `expected a follower note, got ${JSON.stringify(followed.notes)}`,
    );
  });
  test("installer: native preload refuses a launcher without the anchor", () => {
    const result = registerLib.applyStartServerPreload("@echo off\r\ncall npm start\r\n", { requirePath: nativePath });
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, /EVEJS_PROXY_LOCAL_INTERCEPT/u);
  });

  test("installer: end to end install, reinstall, and uninstall", () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "alternateminingdrones-"));
    try {
      const root = buildFixtureRoot(workdir);
      const entrypoint = path.join(root, "docker", "entrypoint.sh");
      const startServer = path.join(root, "StartServer.bat");
      const packageJson = path.join(root, "server", "package.json");
      const read = (file) => fs.readFileSync(file, "utf8");
      const before = {
        entrypoint: read(entrypoint),
        startServer: read(startServer),
        packageJson: read(packageJson),
      };
      const run = (script, args) => {
        const result = spawnSync(
          process.execPath,
          [path.join(installerDir, script), "--server", root, ...args],
          { encoding: "utf8", timeout: 60000 },
        );
        assert.strictEqual(result.status, 0, `${script} failed:\n${result.stdout}\n${result.stderr}`);
        return result.stdout;
      };

      const installOutput = run("install.js", []);
      assert.ok(fs.existsSync(path.join(root, "mods", MOD_ID, "loader.js")), "loader.js must land in mods/");
      assert.ok(
        !fs.existsSync(path.join(root, "mods", MOD_ID, "installer")),
        "installer scaffolding must not be copied into the runtime mod folder",
      );
      assert.strictEqual(read(entrypoint).split(containerPath).length - 1, 2, "both docker launches must preload");
      assert.ok(registerLib.hasStartServerPreload(read(startServer)), "StartServer.bat must preload the loader");
      assert.strictEqual(
        read(packageJson),
        before.packageJson,
        "server/package.json must stay untouched: it is a Docker dependency-layer input",
      );
      assert.match(installOutput, /docker \+ native/u, "both deployments must be detected");
      assert.strictEqual(fs.readdirSync(path.join(root, "_alternateminingdrones-backup")).length, 1, "one backup per run");

      const afterFirst = { entrypoint: read(entrypoint), startServer: read(startServer) };
      run("install.js", []);
      assert.deepStrictEqual(
        { entrypoint: read(entrypoint), startServer: read(startServer) },
        afterFirst,
        "a reinstall must not stack a second registration",
      );

      // A neighbour sitting in mods/ without a registration loads nothing at
      // all, and nothing else in the tree reports it: only the status command can.
      fs.mkdirSync(path.join(root, "mods", "neighbourMod"), { recursive: true });
      fs.writeFileSync(path.join(root, "mods", "neighbourMod", "loader.js"), "// neighbour\n", "utf8");
      const status = run("install.js", ["--status"]);
      assert.match(
        status,
        /\[note\] Native: in mods\/ but not preloaded by this launcher: neighbourMod/u,
        "an installed but unregistered mod must be named by the native status",
      );
      // The container list is checked separately: it carries different mods.
      assert.match(
        status,
        /\[note\] Docker: in mods\/ but not preloaded by this launcher: neighbourMod/u,
        "an installed but unregistered mod must be named by the container status",
      );
      const dryRun = spawnSync(
        process.execPath,
        [path.join(installerDir, "install.js"), "--server", root, "--dry-run"],
        { encoding: "utf8", timeout: 60000 },
      );
      assert.strictEqual(dryRun.status, 0, dryRun.stderr);
      assert.strictEqual(read(entrypoint), afterFirst.entrypoint, "--dry-run must not write");

      run("uninstall.js", []);
      assert.strictEqual(read(entrypoint), before.entrypoint, "entrypoint must be restored");
      assert.strictEqual(read(startServer), before.startServer, "StartServer.bat must be restored");
      assert.strictEqual(read(packageJson), before.packageJson, "package.json must never have been touched");
      assert.strictEqual(fs.existsSync(path.join(root, "mods", MOD_ID)), false, "mod folder must be retired");
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("installer: the mod's configuration is seeded once and retired on uninstall", () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "amd-config-"));
    try {
      const root = buildFixtureRoot(workdir);
      const serverConfig = path.join(root, "config", "alternateMiningDrones.json");
      const playersConfig = path.join(root, "config", "alternateMiningDrones.players.json");
      const run = (script, args = []) => spawnSync(
        process.execPath,
        [path.join(installerDir, script), "--server", root, ...args],
        { encoding: "utf8", timeout: 60000 },
      );

      const first = run("install.js");
      assert.strictEqual(first.status, 0, first.stderr);
      assert.ok(fs.existsSync(serverConfig), "the server-wide config must be seeded");
      assert.ok(fs.existsSync(playersConfig), "the per-character config must be seeded");
      assert.deepStrictEqual(
        JSON.parse(fs.readFileSync(playersConfig, "utf8")).characters,
        {},
        "the seeded players file starts empty",
      );

      // An operator's edit survives a reinstall untouched. This one is a one-line
      // object, which the migration cannot add keys to line by line - it says so
      // and leaves the file exactly as it is.
      fs.writeFileSync(serverConfig, JSON.stringify({ targetMode: "focus" }), "utf8");
      const again = run("install.js");
      assert.strictEqual(again.status, 0, again.stderr);
      assert.deepStrictEqual(
        JSON.parse(fs.readFileSync(serverConfig, "utf8")),
        { targetMode: "focus" },
        "a reinstall must never overwrite configuration",
      );
      assert.match(
        again.stdout,
        /\[WARN\] config\/alternateMiningDrones\.json: the file does not end in a line/,
      );

      // A file written one key per line - what the installer seeds, and what an
      // operator edits - is brought up to this release's key set: the keys it is
      // missing are added, and not one value that is there is touched.
      fs.writeFileSync(
        serverConfig,
        [
          "{",
          '  "_comment": "an older release wrote this",',
          '  "targetMode": "focus",',
          '  "rangeMeters": 30000',
          "}",
          "",
        ].join("\n"),
        "utf8",
      );
      const migrated = run("install.js");
      assert.strictEqual(migrated.status, 0, migrated.stderr);
      assert.match(
        migrated.stdout,
        /\[ OK \] config\/alternateMiningDrones\.json: updated, v1\.2\.1 shape -> v1\.3\.0 \(added /,
      );
      const config = JSON.parse(fs.readFileSync(serverConfig, "utf8"));
      assert.equal(config.targetMode, "focus", "the operator's own value is untouched");
      assert.equal(config.rangeMeters, 30000);
      assert.equal(config._comment, "an older release wrote this",
        "the operator's own comment stays as it is");
      assert.equal(config.filterGrade, false, "a key this release added arrives with its default");
      assert.equal(config.allowPlayerCopy, true);
      assert.equal(config.configVersion, "1.3.0");
      assert.ok(
        fs.readdirSync(path.join(root, "_alternateminingdrones-backup")).length >= 1,
        "the file is archived before it is updated",
      );

      // Adding the keys is a one-time thing: the next run finds the file current.
      const settled = run("install.js");
      assert.strictEqual(settled.status, 0, settled.stderr);
      assert.match(
        settled.stdout,
        /\[SKIP\] config\/alternateMiningDrones\.json: already at the v1\.3\.0 key set/,
      );

      // --keep-config leaves both files behind.
      const kept = run("uninstall.js", ["--keep-config"]);
      assert.strictEqual(kept.status, 0, kept.stderr);
      assert.ok(fs.existsSync(serverConfig) && fs.existsSync(playersConfig));

      const clean = run("uninstall.js");
      assert.strictEqual(clean.status, 0, clean.stderr);
      assert.ok(!fs.existsSync(serverConfig), "uninstall must retire the server config");
      assert.ok(!fs.existsSync(playersConfig), "uninstall must retire the players file");
      assert.ok(
        fs.readdirSync(path.join(root, "_alternateminingdrones-backup")).length >= 1,
        "removed configuration must be archived first",
      );
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });
  test("installer: update refreshes the mod in place and keeps everything the operator owns", () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "amd-update-"));
    try {
      const root = buildFixtureRoot(workdir);
      const run = (script, args = []) => spawnSync(
        process.execPath,
        [path.join(installerDir, script), "--server", root, ...args],
        { encoding: "utf8", timeout: 60000 },
      );

      const first = run("install.js");
      assert.strictEqual(first.status, 0, first.stderr);

      const modDirPath = path.join(root, "mods", MOD_ID);
      const manifestPath = path.join(modDirPath, "evejs-launcher.mod.json");
      const shipping = JSON.parse(fs.readFileSync(manifestPath, "utf8")).version;
      // Pretend the tree already carries the previous release.
      fs.writeFileSync(
        manifestPath,
        `${JSON.stringify({ name: MOD_ID, version: "0.9.9" }, null, 2)}\n`,
        "utf8",
      );
      const envPath = path.join(modDirPath, ".env");
      fs.writeFileSync(envPath, "EVEJS_ALT_MINING_DRONES_TARGET_MODE=focus\n", "utf8");
      const serverConfig = path.join(root, "config", "alternateMiningDrones.json");
      fs.writeFileSync(serverConfig, JSON.stringify({ targetMode: "focus" }), "utf8");

      const update = run("update.js");
      assert.strictEqual(update.status, 0, update.stderr);
      assert.match(update.stdout, /Updater/u, "the run must say what it is");
      assert.match(update.stdout, /Installed {2}: v0\.9\.9/u, "the version being replaced must be reported");
      assert.match(
        update.stdout,
        new RegExp(`Updating to: v${shipping.replace(/\./gu, "\\.")}`, "u"),
        "the version being installed must be reported",
      );
      assert.strictEqual(
        JSON.parse(fs.readFileSync(manifestPath, "utf8")).version,
        shipping,
        "the installed tree must now carry the shipped release",
      );
      assert.strictEqual(
        fs.readFileSync(envPath, "utf8"),
        "EVEJS_ALT_MINING_DRONES_TARGET_MODE=focus\n",
        "a local .env is the operator's configuration and must survive an update",
      );
      assert.deepStrictEqual(
        JSON.parse(fs.readFileSync(serverConfig, "utf8")),
        { targetMode: "focus" },
        "an update must never overwrite configuration",
      );
      assert.ok(
        registerLib.hasStartServerPreload(fs.readFileSync(path.join(root, "StartServer.bat"), "utf8")),
        "the preload must still be registered after an update",
      );

      // The folder that was replaced is archived first, so the old release can
      // always be recovered by hand.
      const backupRoot = path.join(root, "_alternateminingdrones-backup");
      const archivedOldVersion = fs.readdirSync(backupRoot).some((stamp) => {
        const archived = path.join(backupRoot, stamp, "mods", MOD_ID, "evejs-launcher.mod.json");
        if (!fs.existsSync(archived)) return false;
        return JSON.parse(fs.readFileSync(archived, "utf8")).version === "0.9.9";
      });
      assert.ok(archivedOldVersion, "the folder being replaced must be archived before it is overwritten");
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("installer: the seeded players file is the loader's own text, not a second copy", () => {
    const settingsPath = path.join(modDir, "lib", "playerSettings.js");
    if (!fs.existsSync(settingsPath)) {
      console.log("     SKIP the payload is not in this tree");
      return;
    }
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "amd-seed-"));
    try {
      const root = buildFixtureRoot(workdir);
      const result = spawnSync(
        process.execPath,
        [path.join(installerDir, "install.js"), "--server", root],
        { encoding: "utf8", timeout: 60000 },
      );
      assert.strictEqual(result.status, 0, result.stderr);
      // The installer documents the file with the loader's own strings, so
      // there is exactly one place that can go stale when a setting is added.
      const payloadSettings = require(settingsPath);
      const seeded = JSON.parse(
        fs.readFileSync(path.join(root, "config", "alternateMiningDrones.players.json"), "utf8"),
      );
      assert.strictEqual(seeded._comment, payloadSettings.FILE_COMMENT);
      assert.strictEqual(seeded._help, payloadSettings.FILE_HELP);
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("installer: every module the entry points require sits beside them", () => {
    // No archive is built any more, so the installer runs straight out of this
    // folder - a require() naming a module that is not here would fail the
    // moment anyone ran it, which is exactly what this catches.
    for (const entry of ["install.js", "uninstall.js", "update.js"]) {
      const text = fs.readFileSync(path.join(installerDir, entry), "utf8");
      for (const match of text.matchAll(/require\("(\.\/[^"]+)"\)/gu)) {
        const relative = `${match[1].slice(2)}.js`;
        assert.ok(
          fs.existsSync(path.join(installerDir, ...relative.split("/"))),
          `${entry} requires ${relative}, which is not beside it`,
        );
      }
    }
  });
  test("installer: --docker-only and --native-only restrain the install and the report", () => {
    // A user runs one deployment, not both. Whichever they pick, the other
    // entry point must stay byte-identical and stay out of the report.
    for (const [flag, expectDocker, expectNative] of [
      ["--docker-only", true, false],
      ["--native-only", false, true],
    ]) {
      const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "amd-oneway-"));
      try {
        const root = buildFixtureRoot(workdir);
        const entrypoint = path.join(root, "docker", "entrypoint.sh");
        const startServer = path.join(root, "StartServer.bat");
        const before = { entrypoint: fs.readFileSync(entrypoint, "utf8"), startServer: fs.readFileSync(startServer, "utf8") };

        const install = spawnSync(process.execPath, [path.join(installerDir, "install.js"), "--server", root, flag], {
          encoding: "utf8",
          timeout: 60000,
        });
        assert.strictEqual(install.status, 0, `${flag} failed:\n${install.stdout}\n${install.stderr}`);
        assert.deepStrictEqual(
          {
            docker: fs.readFileSync(entrypoint, "utf8") !== before.entrypoint,
            native: fs.readFileSync(startServer, "utf8") !== before.startServer,
          },
          { docker: expectDocker, native: expectNative },
          `${flag} must patch exactly one entry point`,
        );

        const status = spawnSync(
          process.execPath,
          [path.join(installerDir, "install.js"), "--server", root, "--status", flag],
          { encoding: "utf8", timeout: 60000 },
        );
        assert.strictEqual(status.status, 0, status.stderr);
        assert.strictEqual(/^Docker     :/mu.test(status.stdout), expectDocker, `${flag} must report one deployment`);
        assert.strictEqual(/^Native     :/mu.test(status.stdout), expectNative, `${flag} must report one deployment`);
        assert.ok(!/NOT registered/u.test(status.stdout), `${flag}: the selected deployment must be registered`);

        const clean = spawnSync(process.execPath, [path.join(installerDir, "uninstall.js"), "--server", root, flag], {
          encoding: "utf8",
          timeout: 60000,
        });
        assert.strictEqual(clean.status, 0, clean.stderr);
        assert.strictEqual(fs.readFileSync(entrypoint, "utf8"), before.entrypoint, `${flag}: docker side must round-trip`);
        assert.strictEqual(fs.readFileSync(startServer, "utf8"), before.startServer, `${flag}: native side must round-trip`);
      } finally {
        fs.rmSync(workdir, { recursive: true, force: true });
      }
    }
  });
  test("installer: live tree exposes both docker launches", () => {
    // Same probe as test/run.js: the tree is either this mod's grandparent
    // (installed) or the EveJS checkout beside it (development).
    const runtimeRoot = path.resolve(modDir, "../..");
    const candidates = [
      process.env.EVEJS_ALT_MINING_DRONES_TREE,
      runtimeRoot,
      path.join(runtimeRoot, "EveJS"),
    ].filter(Boolean);
    const liveRoot = candidates.find((candidate) => fs.existsSync(path.join(candidate, "docker", "entrypoint.sh")));
    if (!liveRoot) {
      console.log("     SKIP no EveJS tree found next to this mod");
      return;
    }
    const entrypoint = path.join(liveRoot, "docker", "entrypoint.sh");
    const text = fs.readFileSync(entrypoint, "utf8");
    const result = registerLib.applyEntrypointPreload(text, { requirePath: containerPath });
    assert.ok(result.ok, result.reason || "the live entrypoint must expose a server launch");
    assert.strictEqual(result.launches, 2, "run_server and run_all must both be patchable");
    const present = text.split(containerPath).length - 1;
    assert.strictEqual(
      result.insertions,
      result.launches - present,
      "every launch that still lacks the preload must gain exactly one",
    );
    const reapplied = registerLib.applyEntrypointPreload(result.text, { requirePath: containerPath });
    assert.strictEqual(reapplied.changed, false, "the live entrypoint must be idempotent under the install rule");
    const launcher = path.join(liveRoot, "StartServer.bat");
    if (fs.existsSync(launcher)) {
      const launcherText = fs.readFileSync(launcher, "utf8");
      const options = { requirePath: nativePath, existPath: nativeExist };
      const launcherResult = registerLib.applyStartServerPreload(launcherText, options);
      assert.ok(launcherResult.ok, launcherResult.reason || "the live launcher must expose its anchor line");
      // Round-trip on whatever state the live launcher happens to be in.
      const stripped = registerLib.removeStartServerPreload(launcherText).text;
      assert.ok(!stripped.includes(MOD_ID), "removal must drop every injected line, not just the markers");
      const reapplied = registerLib.applyStartServerPreload(stripped, options);
      assert.ok(reapplied.ok);
      assert.strictEqual(reapplied.changed, true, "the block must be back after a re-apply");
      assert.strictEqual(
        registerLib.removeStartServerPreload(reapplied.text).text,
        stripped,
        "removal must restore exactly the text it was handed",
      );
    }
  });
  test("installer: the drive sweep reaches two levels down and no further", () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "amd-sweep-"));
    try {
      const shallow = writeEveJsRoot(path.join(sandbox, "Eve", "EveJS"));
      // Both of these must stay invisible: one is inside a skipped folder,
      // the other sits one level below the depth limit. A sweep that found
      // them would be an unbounded walk of the whole machine.
      writeEveJsRoot(path.join(sandbox, "Windows", "EveJS"));
      writeEveJsRoot(path.join(sandbox, "a", "b", "c", "EveJS"));
      const found = deploymentLib.findLocalEveJsRoots({ bases: [sandbox] });
      assert.deepStrictEqual(found, [shallow], "only the shallow, unskipped root may be reported");
      assert.deepStrictEqual(
        deploymentLib.findLocalEveJsRoots({ bases: [] }),
        [],
        "no bases means no sweep, never a guess",
      );
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("installer: an unfolded package finds the server with no arguments", () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "alternateminingdrones-pkg-"));
    try {
      // Nothing near the package is a server, which is the case that used to
      // end in "pass --server". The sweep stands in for the local drives.
      const root = writeEveJsRoot(path.join(workdir, "server-farm", "EveJS"));
      const pkg = buildInstallerPackage(installerDir, modDir, path.join(workdir, "Downloads", "AlternateMiningDrones-0.0.0"));
      const result = spawnSync(process.execPath, [path.join(pkg, "install.js")], {
        cwd: pkg,
        encoding: "utf8",
        timeout: 60000,
        env: { ...process.env, EVEJS_ALT_MINING_DRONES_SEARCH_BASES: path.join(workdir, "server-farm") },
      });
      assert.strictEqual(result.status, 0, `install.js failed:\n${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /EveJS root\s*:\s*\S/u, "the chosen root must be reported");
      assert.ok(
        fs.existsSync(path.join(root, "mods", MOD_ID, "loader.js")),
        "the payload must land in the root the sweep found",
      );
      assert.strictEqual(
        fs.readFileSync(path.join(root, "docker", "entrypoint.sh"), "utf8").split(containerPath).length - 1,
        2,
        "both launches of the discovered root must be patched",
      );
      assert.ok(
        registerLib.hasStartServerPreload(fs.readFileSync(path.join(root, "StartServer.bat"), "utf8")),
        "the launcher of the discovered root must be patched",
      );
      assert.ok(
        !fs.existsSync(path.join(workdir, "Downloads", "EveJS")),
        "nothing may be written beside the package",
      );
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("installer: a package unfolded inside mods\\ resolves its own tree", () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "alternateminingdrones-inmods-"));
    try {
      const root = writeEveJsRoot(path.join(workdir, "EveJS"));
      const pkg = buildInstallerPackage(installerDir, modDir, path.join(root, "mods", "AlternateMiningDrones-0.0.0"));
      const result = spawnSync(process.execPath, [path.join(pkg, "install.js")], {
        cwd: pkg,
        encoding: "utf8",
        timeout: 60000,
        // Pointed at an empty sandbox on purpose: this path must be answered by
        // the ancestor walk, without the sweep ever running.
        env: { ...process.env, EVEJS_ALT_MINING_DRONES_SEARCH_BASES: path.join(workdir, "nothing-here") },
      });
      assert.strictEqual(result.status, 0, `install.js failed:\n${result.stdout}\n${result.stderr}`);
      assert.ok(
        fs.existsSync(path.join(root, "mods", MOD_ID, "loader.js")),
        "a package unpacked inside <root>\\mods\\ must install into that root",
      );
      const uninstall = spawnSync(process.execPath, [path.join(pkg, "uninstall.js")], {
        cwd: pkg,
        encoding: "utf8",
        timeout: 60000,
        env: { ...process.env, EVEJS_ALT_MINING_DRONES_SEARCH_BASES: path.join(workdir, "nothing-here") },
      });
      assert.strictEqual(uninstall.status, 0, `uninstall.js failed:\n${uninstall.stdout}\n${uninstall.stderr}`);
      assert.strictEqual(
        fs.existsSync(path.join(root, "mods", MOD_ID)),
        false,
        "and the uninstall must find the same tree without being told",
      );
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });
  test("installer: a configuration older than this release is brought up to its key set", () => {
    const migration = require(path.join(installerDir, "lib", "configMigration.js"));
    const exampleText = fs.readFileSync(path.join(modDir, "config.example.json"), "utf8");

    // The shape a 1.2.1 file had: the settings of that release, and none of the
    // ones a later release added.
    const old = [
      "{",
      '  "_comment": "hand written",',
      '  "enabled": true,',
      '  "targetMode": "focus",',
      '  "rangeMeters": 30000,',
      '  "playersFile": ""',
      "}",
      "",
    ].join("\n");
    const result = migration.migrate(old, { exampleText });
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.from, "1.2.1");
    assert.strictEqual(result.version, "1.3.0");
    assert.ok(result.added.includes("filterGrade"), "the grade switch is what 1.2.9 added");
    assert.ok(result.added.includes("allowPlayerCopy"));
    assert.ok(result.added.includes("chatTrigger"));
    assert.ok(result.added.includes("filterFallback"), "the key the example was missing is added too");
    const migrated = JSON.parse(result.text);
    assert.strictEqual(migrated.targetMode, "focus", "no value in the file is rewritten");
    assert.strictEqual(migrated.rangeMeters, 30000);
    assert.strictEqual(migrated._comment, "hand written", "the operator's own comment stays");
    assert.strictEqual(migrated.configVersion, "1.3.0");
    assert.strictEqual(migrated.filterGrade, false, "a missing key arrives with its packaged default");
    assert.strictEqual(migrated.playersFile, "");
    assert.strictEqual(result.text.endsWith("\n"), true, "a trailing newline stays");

    // Every line the file already had comes out byte for byte as it went in, so
    // an update is a small diff and never a reformat of what the operator wrote.
    const after = result.text.split("\n");
    for (const line of old.split("\n").filter((entry) => entry.trim() !== "")) {
      // The one line that changes is the last entry, which gains the comma the
      // inserted block needs; everything else is there exactly as it was typed.
      assert.ok(
        after.includes(line) || after.includes(`${line},`),
        `${JSON.stringify(line)} must survive the update`,
      );
    }

    // Running it a second time is a no-op: the keys are there and the stamp says so.
    const second = migration.migrate(result.text, { exampleText });
    assert.strictEqual(second.changed, false);
    assert.strictEqual(second.version, "1.3.0");

    // The line endings are the file's own choice and are kept.
    assert.strictEqual(
      migration.migrate(old.split("\n").join("\r\n"), { exampleText }).text.includes("\r\n"),
      true,
    );

    // A file the migration cannot read is refused rather than rewritten: the
    // installer says so and the mod falls back to its defaults for what is absent.
    assert.ok(migration.migrate("{ not json", { exampleText }).error);
    assert.ok(
      migration.migrate('{ "targetMode": "focus" }', { exampleText }).error,
      "a one-line object has no closing-brace line to insert whole keys before",
    );
  });
}

module.exports = register;
