"use strict";

// Replays what each deployment does to its loader list, because `--require`
// order *is* `Module._load` hook order and both lists fail silently:
//
//   native      StartServer.bat builds NODE_OPTIONS out of append/claim blocks.
//               A block that assigns the variable outright erases every loader
//               registered before it, and cmd.exe says nothing.
//   container   docker/entrypoint.sh passes one --require per line. Nothing can
//               be erased here, but a position can be wrong: a mod that
//               compiles a target into fresh exports must sit before the mods
//               that wrap those exports, or the wrapper is discarded.
//
// The native half is not a shell. It understands the shapes the launcher and
// loader mods emit - marker-delimited blocks, `if exist ( ... )`, `if defined
// NODE_OPTIONS ( ... ) else ( ... )`, `if not defined NODE_OPTIONS ... set
// "..."` - and it errs towards silence: a condition it cannot read keeps its
// branch enabled rather than inventing a drop. What it will not do is stay
// quiet about a block that assigns NODE_OPTIONS outright while a value is
// already there.

const BEGIN_MARKER = /^rem --- (.+): preload the server-side loader ---$/u;
const END_MARKER = /^rem --- (.+): end .+ preload ---$/u;
// Both guarded idioms claim the variable only when nobody has yet.
const GUARDED_ASSIGN = /^if not defined NODE_OPTIONS (?:if exist .* )?set "NODE_OPTIONS=(.*)"$/u;
const ASSIGN = /^set "NODE_OPTIONS=(.*)"$/u;
const APPEND_PREFIX = /^%NODE_OPTIONS% ?(.*)$/u;
const DEFINED_GROUP = /^if defined NODE_OPTIONS \($/u;
const ELSE_GROUP = /^\) else \($/u;
const CLOSE_GROUP = /^\)$/u;
const OPEN_GROUP = /^if\b.*\($/u;
const REQUIRE_PATH = /--require[= ]"?([^"\s]+?)"?$/u;
const LOADER_IN_PATH = /[/\\]mods[/\\]([^/\\"]+)[/\\]loader\.js/u;

const NODE_LAUNCH = /^([ \t]*)(.*\bnode[ \t]+)\\$/u;
const CONTINUES = /[ \t]\\[ \t]*$/u;
const SERVER_LAUNCH_FLAG = "--report-on-fatalerror";
const REQUIRE_ENTRY = /^--require[ \t]+(\S+)[ \t]*\\?$/u;
const FUNCTION_HEAD = /^([A-Za-z_][\w]*)[ \t]*\(\)[ \t]*\{$/u;

function stripCarriageReturn(line) {
  return String(line).replace(/\r$/u, "");
}

function requirePathsIn(value) {
  const found = [];
  for (const chunk of String(value || "").split(/\s+--require[= ]/u)) {
    const match = REQUIRE_PATH.exec(chunk.startsWith("--require") ? chunk : `--require=${chunk}`);
    if (match) found.push(match[1]);
  }
  return found;
}

function loaderIdOf(requirePath) {
  const match = LOADER_IN_PATH.exec(String(requirePath || ""));
  return match ? match[1] : null;
}

function loaderIdsIn(value) {
  const ids = [];
  for (const requirePath of requirePathsIn(value)) {
    const id = loaderIdOf(requirePath) || requirePath;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function auditStartServerPreloads(text) {
  const lines = String(text).split("\n");
  const blocks = [];
  const events = [];
  const warnings = [];
  const frames = [];
  let current = null;
  let value = null;

  const executing = () => frames.every((frame) => frame.active);
  const uncertainFrames = () => frames.filter((frame) => frame.uncertain && !frame.reported);
  const record = (line, kind, detail) => {
    const owner = current ? current.label : `line ${line}`;
    events.push({ line, owner, kind, detail });
    return owner;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const bare = stripCarriageReturn(lines[index]).trim();
    const line = index + 1;
    if (bare === "") continue;

    let match = BEGIN_MARKER.exec(bare);
    if (match) {
      current = { label: match[1], begin: line, end: null, mode: "none", requires: [] };
      continue;
    }

    match = END_MARKER.exec(bare);
    if (match) {
      if (!current) {
        warnings.push(`line ${line}: an end marker with no begin marker above it`);
        continue;
      }
      current.end = line;
      blocks.push(current);
      current = null;
      continue;
    }

    match = GUARDED_ASSIGN.exec(bare);
    if (match) {
      if (current && current.mode === "none") current.mode = "guarded";
      if (value === null) {
        value = match[1];
        record(line, "claim", match[1]);
      } else {
        record(line, "dropped", match[1]);
        // First writer wins: a guard that arrives second does nothing at all.
        // Name the mod it would have loaded instead of letting it vanish.
        const absent = requirePathsIn(match[1]).filter((path) => !String(value).includes(path));
        if (absent.length > 0) {
          const lost = absent.map((path) => loaderIdOf(path) || path).join(", ");
          warnings.push(
            `line ${line}: a first-writer-wins guard had no effect because NODE_OPTIONS was ` +
              `already set, so ${lost} would not load`,
          );
        }
      }
      continue;
    }

    match = ASSIGN.exec(bare);
    if (match) {
      const rhs = match[1];
      const append = APPEND_PREFIX.exec(rhs);
      // The mode describes the block's shape, not which branch ran: an
      // appending block stays safe even when its "unset" branch is the one that
      // fires, and a claiming block is worth flagging even if it was skipped.
      if (current && (append || current.mode === "none")) {
        current.mode = append ? "append" : "claim";
      }
      if (!executing()) continue;
      for (const frame of uncertainFrames()) {
        frame.reported = true;
        warnings.push(
          `line ${line}: inside an if/else branch this audit cannot read, so whether this write ran is a guess`,
        );
      }
      if (append) {
        if (current) current.requires.push(...requirePathsIn(append[1]));
        value = value === null || value === "" ? append[1] : `${value} ${append[1]}`;
        record(line, "append", append[1]);
      } else {
        if (value !== null) {
          const erased = loaderIdsIn(value);
          record(line, "erase", rhs);
          warnings.push(
            `line ${line} (${current ? current.label : "unmarked block"}): assigns NODE_OPTIONS outright, ` +
              `erasing ${erased.length > 0 ? erased.join(", ") : "an earlier value"}`,
          );
        } else {
          record(line, "claim", rhs);
        }
        if (current) current.requires.push(...requirePathsIn(rhs));
        value = rhs;
      }
      continue;
    }

    if (DEFINED_GROUP.test(bare)) {
      frames.push({ active: value !== null, defined: true });
      continue;
    }
    if (ELSE_GROUP.test(bare)) {
      const top = frames[frames.length - 1];
      if (top && top.defined) top.active = !top.active;
      // Not a NODE_OPTIONS guard: the launcher has plenty of unrelated if/else
      // blocks, so the uncertainty is only worth reporting if one of them turns
      // out to write NODE_OPTIONS.
      else if (top) top.uncertain = true;
      continue;
    }
    if (CLOSE_GROUP.test(bare)) {
      if (frames.length > 0) frames.pop();
      continue;
    }
    if (OPEN_GROUP.test(bare)) {
      frames.push({ active: true, defined: false });
      continue;
    }
  }

  if (current) {
    warnings.push(`line ${current.begin} (${current.label}): the begin marker has no end marker; the block is unterminated`);
    current.end = lines.length;
    blocks.push(current);
  }

  const loadedIds = loaderIdsIn(value);
  const droppedBlocks = [];
  for (const block of blocks) {
    // A block counts as loaded when the final value still carries the path it
    // wrote. That survives every shape, including one that wrote twice.
    const expected = block.requires;
    const loaded =
      expected.length > 0
        ? expected.some((requirePath) => String(value || "").includes(requirePath))
        : loadedIds.includes(block.label);
    block.loaded = loaded;
    if (!loaded) droppedBlocks.push(block.label);
  }

  return { blocks, events, warnings, effectiveValue: value, loadedIds, droppedBlocks };
}

// The chain reads left to right, and the LAST entry is the outermost hook: it
// is required last, so it wraps every Module._load hook installed before it.
function formatStartServerAudit(audit, options = {}) {
  const indent = options.indent || "  ";
  const lines = [];
  const chain = audit.loadedIds.length > 0 ? audit.loadedIds.join(" -> ") : "(nothing registered)";
  lines.push(`${indent}Native loader chain : ${chain}`);
  if (audit.loadedIds.length > 1) {
    lines.push(`${indent}                      (${audit.loadedIds[audit.loadedIds.length - 1]} is required last, so it owns the outermost hook)`);
  }
  if (audit.droppedBlocks.length > 0) {
    lines.push(`${indent}[WARN] dropped by a later block: ${audit.droppedBlocks.join(", ")}`);
  } else if (audit.blocks.length > 0) {
    lines.push(`${indent}                      no loader block is dropped`);
  }
  for (const warning of audit.warnings) lines.push(`${indent}[WARN] ${warning}`);
  return lines;
}

// Which function a line sits in, so a launch is reported by name rather than by
// line number: run_server and run_all in the shipped entrypoint.
function enclosingFunction(lines, index) {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const match = FUNCTION_HEAD.exec(stripCarriageReturn(lines[cursor]));
    if (match) return match[1];
  }
  return null;
}

// Same question for the container, different failure. Nothing here can be
// erased - the list is fixed at build time - but the order still decides
// whether a wrapper sees the exports it is supposed to wrap.
function auditEntrypointPreloads(text, options = {}) {
  const lines = String(text).split("\n");
  const launches = [];
  const warnings = [];
  const notes = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!NODE_LAUNCH.test(stripCarriageReturn(lines[index]))) continue;
    const start = index;
    let end = index;
    while (end < lines.length - 1 && CONTINUES.test(stripCarriageReturn(lines[end]))) end += 1;
    const body = lines.slice(start + 1, end + 1).map(stripCarriageReturn);
    index = end;
    // The launcher runs other node commands too; only the server launches take
    // preloads, and this flag is the one they all carry.
    if (!body.some((line) => line.includes(SERVER_LAUNCH_FLAG))) continue;

    const entries = [];
    for (const line of body) {
      const bare = line.trim();
      // The module path ends the invocation; flags after it are not preloads.
      if (bare === "." || bare.startsWith(".) ")) break;
      const match = REQUIRE_ENTRY.exec(bare);
      if (match) entries.push(match[1]);
    }
    launches.push({
      line: start + 1,
      name: enclosingFunction(lines, start),
      entries,
      ids: entries.map((entry) => loaderIdOf(entry) || entry),
    });
  }

  const seenEverywhere = new Set();
  for (const launch of launches) {
    const seen = new Set();
    for (const id of launch.ids) {
      seenEverywhere.add(id);
      if (seen.has(id)) {
        warnings.push(`line ${launch.line} (${launch.name || "launch"}): ${id} is preloaded more than once`);
      }
      seen.add(id);
    }
  }

  const modId = options.modId;
  if (modId && launches.length > 0) {
    const carried = launches.filter((launch) => launch.ids.includes(modId));
    if (carried.length === 0) {
      warnings.push(`${modId} is not preloaded by any server launch`);
    } else {
      if (carried.length !== launches.length) {
        warnings.push(`${modId} is preloaded by ${carried.length} of ${launches.length} server launches`);
      }
      const followers = [...new Set(carried.flatMap((launch) => launch.ids.slice(launch.ids.indexOf(modId) + 1)))];
      if (followers.length > 0) {
        notes.push(
          `${followers.join(", ")} required after ${modId}: fine unless one of them replaces a file ${modId} wraps`,
        );
      }
    }
  }

  return { launches, warnings, notes, chain: launches.length > 0 ? launches[0].ids : [] };
}

function formatEntrypointAudit(audit, options = {}) {
  const indent = options.indent || "  ";
  const lines = [`${indent}Docker launch chain (--require order; the last entry owns the outermost hook)`];
  if (audit.launches.length === 0) lines.push(`${indent}  (no server launch found)`);
  for (const launch of audit.launches) {
    const label = (launch.name || `line ${launch.line}`).padEnd(10);
    lines.push(`${indent}  ${label} : ${launch.ids.length > 0 ? launch.ids.join(" -> ") : "(no preloads)"}`);
  }
  for (const note of audit.notes) lines.push(`${indent}[note] ${note}`);
  for (const warning of audit.warnings) lines.push(`${indent}[WARN] ${warning}`);
  return lines;
}

module.exports = {
  auditEntrypointPreloads,
  auditStartServerPreloads,
  formatEntrypointAudit,
  formatStartServerAudit,
  loaderIdOf,
  loaderIdsIn,
  requirePathsIn,
};