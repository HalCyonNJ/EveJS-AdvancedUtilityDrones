"use strict";

/**
 * Advanced Utility Drones - configuration migration.
 *
 * config/advancedUtilityDrones.json is seeded once and then owned by the
 * operator: the installer never overwrites it, which is also why a setting a
 * later release added is simply absent from a file written by an earlier one.
 * The mod copes - an absent key falls back to the built-in default - but the
 * file then hides a switch that exists, and nothing tells the operator it is
 * there. This module closes that gap on every install and update.
 *
 * Two rules keep it safe:
 *
 *   - A value that is already in the file is never rewritten. The only thing
 *     this writes is whole lines for keys that are missing, just before the
 *     closing brace, plus the "configVersion" stamp.
 *   - The key set and the values inserted come from the packaged
 *     config.example.json, so the defaults live in one place. This module only
 *     knows which release added which key, to be able to say what it moved from.
 *
 * Detection is by key, not by a remembered version: a file that already holds
 * every key of the release being installed is left alone, whatever its
 * "configVersion" says, and a hand-trimmed file is brought back up to date the
 * same way. "from" is the newest release whose own keys are all present, which
 * is what the keys can actually prove.
 */

// The release this module brings a file up to. Bump it with the mod version.
const CURRENT_VERSION = "1.0.0-alpha";

// Which release added which setting, oldest first. Append only: a key that was
// already in the 1.2.1 file is never listed, and a release that only changed
// behaviour adds an entry with no keys.
const RELEASES = Object.freeze([
  Object.freeze({ version: "1.2.2", added: Object.freeze(["allowPlayerCopy"]) }),
  Object.freeze({ version: "1.2.8", added: Object.freeze(["chatTrigger"]) }),
  Object.freeze({ version: "1.2.9", added: Object.freeze(["filterGrade"]) }),
  Object.freeze({ version: "1.3.0", added: Object.freeze([]) }),
  // The rename to Advanced Utility Drones, and the first release that flies
  // salvage drones: three keys, all of them about the salvage squadron. The
  // version is unreleased, so its entry is still the release being written
  // rather than a record of one that shipped - a key retired before the tag
  // goes on simply never appears here.
  Object.freeze({
    version: "1.0.0-alpha",
    added: Object.freeze([
      "salvageEnabled",
      "salvageTargetMode",
      "salvageDistance",
    ]),
  }),
]);

// The release the shape of a file falls back to when even the first entry above
// is missing a key: the one every key in this list did not exist yet for.
const OLDEST_VERSION = "1.2.1";

// "_comment" and friends: documentation the operator may have edited, and never
// part of the key set this module maintains.
const DOCUMENTATION_KEY = /^_/u;
const VERSION_KEY = "configVersion";

function parseObject(text) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { value: null, error: "not a JSON object" };
    }
    return { value, error: null };
  } catch (error) {
    return { value: null, error: `not valid JSON (${error && error.message})` };
  }
}

// The settings config.example.json carries, in its own order: the key set a file
// is brought up to, and the values a key it is missing is given.
function exampleSettings(exampleText) {
  const parsed = parseObject(exampleText || "");
  if (parsed.error) {
    return null;
  }
  const keys = Object.keys(parsed.value).filter(
    (key) => !DOCUMENTATION_KEY.test(key) && key !== VERSION_KEY,
  );
  return { keys, value: parsed.value };
}

// The newest release whose own keys are all present: what the keys of a file
// prove about when it was written.
function versionOf(keys) {
  let version = OLDEST_VERSION;
  for (const release of RELEASES) {
    if (release.added.length === 0) {
      continue;
    }
    if (!release.added.every((key) => keys.includes(key))) {
      break;
    }
    version = release.version;
  }
  return version;
}

// Adds the missing lines just before the closing brace of the top-level object.
// Everything else in the file - every other line, its indentation, its line
// endings and its own key order - comes out byte for byte as it went in.
function insertLines(text, entries) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/u);
  let closeAt = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() === "}") {
      closeAt = index;
      break;
    }
  }
  if (closeAt < 0) {
    return null;
  }
  let previous = closeAt - 1;
  while (previous >= 0 && lines[previous].trim() === "") {
    previous -= 1;
  }
  if (previous >= 0 && !lines[previous].trimEnd().endsWith(",")) {
    lines[previous] = `${lines[previous].trimEnd()},`;
  }
  const block = entries.map(({ key, value }) => {
    const body = JSON.stringify(value, null, 2).split("\n").join(`${eol}  `);
    return `  ${JSON.stringify(key)}: ${body}`;
  });
  // Every line but the last carries the comma its successor needs; the closing
  // brace follows the last one directly, because a trailing comma is not JSON.
  for (let index = 0; index < block.length - 1; index += 1) {
    block[index] = `${block[index]},`;
  }
  lines.splice(closeAt, 0, ...block);
  return lines.join(eol);
}

// What one run does with one file. options.exampleText is the packaged
// config.example.json; without it nothing can be recognised and the file is
// left alone.
function migrate(text, options = {}) {
  const example = exampleSettings(options.exampleText);
  if (!example) {
    return { changed: false, error: "the packaged configuration could not be read" };
  }
  const parsed = parseObject(text);
  if (parsed.error) {
    return { changed: false, error: parsed.error };
  }
  const keys = Object.keys(parsed.value);
  const from = versionOf(keys);
  const stamped = String(parsed.value[VERSION_KEY] || "").trim();
  const missing = example.keys.filter((key) => !keys.includes(key));
  if (missing.length === 0 && stamped === CURRENT_VERSION) {
    return { changed: false, version: CURRENT_VERSION, from, added: [], missing: [] };
  }
  const entries = missing.map((key) => ({ key, value: example.value[key] }));
  entries.push({ key: VERSION_KEY, value: CURRENT_VERSION });
  const next = insertLines(text, entries);
  if (next === null) {
    return {
      changed: false,
      error: "the file does not end in a line holding the closing brace, so no key was added",
    };
  }
  return {
    changed: true,
    text: next,
    version: CURRENT_VERSION,
    from,
    added: missing,
    missing,
  };
}

module.exports = {
  CURRENT_VERSION,
  OLDEST_VERSION,
  RELEASES,
  VERSION_KEY,
  migrate,
  versionOf,
};